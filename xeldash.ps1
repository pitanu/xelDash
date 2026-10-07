# xelDash launcher for Windows: set it up, start it, stop it, update it.
# Easiest: double-click xeldash.cmd. From a PowerShell window:
#
#   .\xeldash.cmd            first time: guided setup; afterwards: shows what is running
#   .\xeldash.cmd install    guided setup (creates .env, starts xelDash, opens the dashboard)
#   .\xeldash.cmd start | stop | restart | status | logs [service] | open | token
#   .\xeldash.cmd lan on|off|status    let other computers on your network use xelDash
#   .\xeldash.cmd update     get the newest xelDash and restart it
#   .\xeldash.cmd backup     save a copy of your statistics to the backups folder
#   .\xeldash.cmd cluster   two Linux servers sharing one address (not on Windows: see docs)
#   .\xeldash.cmd frontdoor setup|status|off   a Linux box miners connect to, in front of this computer
#   .\xeldash.cmd restore FILE   put a backup back (replaces the current statistics)
#
# Options for install (all optional; without them it asks):
#   --address xel:...   your wallet address (or add it later in the dashboard)
#   --lan yes|no        allow other computers on your home network
#   --network mainnet|testnet|devnet   (default mainnet)
#   --yes               do not ask anything; use defaults
#   --no-start          write .env only
#   --set KEY=VALUE     set any .env value (repeatable)
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$envPath = Join-Path $PSScriptRoot ".env"

function Say([string]$Text = "") { Write-Host $Text }
function Ok([string]$Text) { Write-Host "OK  $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "!   $Text" -ForegroundColor Yellow }
function Die([string]$Text) { Write-Host "ERROR  $Text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- .env helpers

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $envPath)) { return "" }
    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
        if ($line -match ("^" + [regex]::Escape($Key) + "=(.*)$")) { return $Matches[1] }
    }
    return ""
}

# Replaces the first "KEY=" (or commented "# KEY=") line, else appends. UTF-8 without a byte order mark.
function Set-EnvValue([string]$Key, [string]$Value) {
    $done = $false
    $out = New-Object System.Collections.Generic.List[string]
    $k = [regex]::Escape($Key)
    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
        if (-not $done -and ($line -match ("^" + $k + "=") -or $line -match ("^# ?" + $k + "="))) {
            $out.Add("$Key=$Value"); $done = $true
        } else { $out.Add($line) }
    }
    if (-not $done) { $out.Add("$Key=$Value") }
    [System.IO.File]::WriteAllText($envPath, (($out -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

function New-RandomHex([int]$Bytes) {
    $b = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($b)
    $rng.Dispose()
    return (-join ($b | ForEach-Object { $_.ToString("x2") }))
}

# ---------------------------------------------------------------- checks

function Test-Native([string]$CommandLine) {
    cmd /c "$CommandLine >nul 2>&1"
    return ($LASTEXITCODE -eq 0)
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Say ""
        Say "xelDash needs Docker, and it is not installed yet."
        Say "1. Install Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/"
        Say "   (it may ask to turn on WSL 2: say yes, and restart Windows if it asks)"
        Say "2. Open Docker Desktop once and wait until it says it is running."
        Say "3. Double-click xeldash.cmd again."
        exit 1
    }
    if (-not (Test-Native "docker compose version")) {
        Die "Docker is installed, but not Docker Compose (version 2). Update Docker Desktop: https://www.docker.com/products/docker-desktop/"
    }
    if (-not (Test-Native "docker info")) {
        Die "Docker is installed, but not running. Open Docker Desktop from the Start menu, wait until it says it is running, and try again."
    }
}

function Test-Http([string]$Url) {
    try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3; return $true } catch { return $false }
}

# This computer's address on the home network, or "" when it cannot be told.
function Get-LanIp {
    try {
        $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
        $ip = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1
        return [string]$ip.IPAddress
    } catch { return "" }
}
function Test-PrivateIp([string]$Ip) { return ($Ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)') }

function Get-WebPort { $p = Get-EnvValue "XELDASH_WEB_PORT"; if ($p) { return $p } else { return "8088" } }

# ---------------------------------------------------------------- firewall

# Docker Desktop hides who is really connecting, so xelDash cannot tell your network from the
# internet on its own. Windows Firewall can: it sees the real address. These rules let your home
# network reach xelDash's ports and turn away every address that is not on a private network
# (block rules win over allow rules), so port forwarding by mistake cannot expose it.
$FirewallGroup = "xelDash"
# Every IPv4 address outside the private ranges (10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
# 192.168/16), plus IPv6 global addresses.
$InternetRanges = @(
    "0.0.0.0-9.255.255.255", "11.0.0.0-100.63.255.255", "100.128.0.0-126.255.255.255",
    "128.0.0.0-169.253.255.255", "169.255.0.0-172.15.255.255", "172.32.0.0-192.167.255.255",
    "192.169.0.0-255.255.255.255", "2000::/3"
)

function Test-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The ports xelDash opens beyond this computer: dashboard, Stratum, Stratum over TLS, getwork.
function Get-FirewallPorts {
    $ports = @()
    foreach ($pair in @(@("XELDASH_WEB_PORT", "8088"), @("XELDASH_STRATUM_PORT", "3333"), @("XELDASH_STRATUM_TLS_PORT", "3334"), @("XELDASH_GETWORK_PORT", "8090"))) {
        $v = Get-EnvValue $pair[0]
        if (-not $v) { $v = $pair[1] }
        $ports += $v
    }
    return $ports
}

# Adds (or with -Remove takes away) the rules. Needs an administrator. -Preview only shows them.
function Set-FirewallRules([switch]$Remove, [switch]$Preview) {
    if (-not $Preview) { Remove-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue }
    if ($Remove) { return }
    $ports = Get-FirewallPorts
    $extra = @{}
    if ($Preview) { $extra["WhatIf"] = $true }
    New-NetFirewallRule -DisplayName "xelDash: home network may use the dashboard and mining ports" -Group $FirewallGroup `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ports -Profile Private, Domain -RemoteAddress LocalSubnet @extra | Out-Null
    New-NetFirewallRule -DisplayName "xelDash: block the internet from the dashboard and mining ports" -Group $FirewallGroup `
        -Direction Inbound -Action Block -Protocol TCP -LocalPort $ports -Profile Any -RemoteAddress $InternetRanges @extra | Out-Null
}

# Runs one xeldash command in a window that asks Windows for administrator permission.
function Invoke-Elevated([string]$Arguments) {
    try {
        $p = Start-Process -FilePath "powershell" -Verb RunAs -Wait -PassThru -ArgumentList ("-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" " + $Arguments)
        return ($p.ExitCode -eq 0)
    } catch { return $false }
}

function Enable-Firewall {
    Say "Windows will ask for permission to add a firewall rule. Say yes: it keeps xelDash to your own network."
    if (Invoke-Elevated "firewall apply") { Ok "Windows Firewall: your home network may connect, the internet is blocked." }
    else { Warn "The firewall rule was not added. xelDash still works on your network, but nothing blocks the internet at this computer: never forward its ports on your router. Try again: xeldash firewall on" }
}
function Disable-Firewall {
    if (@(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue).Count -eq 0) { return }
    if (Invoke-Elevated "firewall remove") { Ok "Windows Firewall rules for xelDash removed." }
    else { Warn "The firewall rules could not be removed (permission was not given). Remove them later: xeldash firewall off" }
}

function Invoke-Firewall([string[]]$Rest) {
    $sub = "status"; if ($Rest.Count -gt 0) { $sub = $Rest[0] }
    switch ($sub) {
        "on" { Enable-Firewall }
        "off" { Disable-Firewall }
        "apply" { if (-not (Test-Admin)) { Die "Run this as administrator, or use: xeldash firewall on" }; Set-FirewallRules }
        "remove" { if (-not (Test-Admin)) { Die "Run this as administrator, or use: xeldash firewall off" }; Set-FirewallRules -Remove }
        "preview" { Set-FirewallRules -Preview }
        "status" {
            $rules = @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
            if ($rules.Count -eq 0) { Say "No xelDash firewall rules. Add them with: xeldash firewall on" }
            else { $rules | ForEach-Object { Say ("  " + $_.DisplayName + "  [" + $_.Action + ", enabled: " + $_.Enabled + "]") } }
        }
        default { Die "Use: xeldash firewall on | off | status" }
    }
}

# ---------------------------------------------------------------- lan

function Enable-Lan([string]$Ip) {
    if (-not $Ip) { $Ip = Get-LanIp }
    if (-not $Ip) {
        Warn "Could not find this computer's address on your network. Run: xeldash lan on 192.168.1.20 (use your own address)."
        return $false
    }
    if (-not (Test-PrivateIp $Ip)) {
        Warn "This computer's address ($Ip) is not a home-network address, so opening xelDash to the network could expose it to the internet. If you are sure, set XELDASH_WEB_BIND_IP, XELDASH_STRATUM_BIND_IP and XELDASH_PUBLIC_HOST in .env yourself."
        return $false
    }
    Set-EnvValue "XELDASH_WEB_BIND_IP" "0.0.0.0"
    Set-EnvValue "XELDASH_STRATUM_BIND_IP" "0.0.0.0"
    Set-EnvValue "XELDASH_PUBLIC_HOST" $Ip
    Ok "Other computers on your network can now use xelDash at http://${Ip}:$(Get-WebPort)"
    Say "    Windows may ask to allow Docker through the firewall for private networks: say yes."
    return $true
}
function Disable-Lan {
    Set-EnvValue "XELDASH_WEB_BIND_IP" "127.0.0.1"
    Set-EnvValue "XELDASH_STRATUM_BIND_IP" "127.0.0.1"
    Set-EnvValue "XELDASH_PUBLIC_HOST" ""
    Ok "xelDash now only answers on this computer."
}

function Invoke-Lan([string[]]$Rest) {
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    $sub = "status"; if ($Rest.Count -gt 0) { $sub = $Rest[0] }
    switch ($sub) {
        "on" {
            Assert-Docker
            $ip = ""; if ($Rest.Count -gt 1) { $ip = $Rest[1] }
            if (-not (Enable-Lan $ip)) { exit 1 }
            docker compose up -d | Out-Null
            Ok "Restarted with the new setting."
            Enable-Firewall
        }
        "off" { Assert-Docker; Disable-Lan; docker compose up -d | Out-Null; Ok "Restarted with the new setting."; Disable-Firewall }
        "status" {
            $bind = Get-EnvValue "XELDASH_STRATUM_BIND_IP"
            if (-not $bind -or $bind -eq "127.0.0.1") { Say "Only this computer can use xelDash. Allow your network with: xeldash lan on" }
            else { Say "Other computers on your network can use xelDash at http://$(Get-EnvValue 'XELDASH_PUBLIC_HOST'):$(Get-WebPort)" }
        }
        default { Die "Use: xeldash lan on | off | status" }
    }
}

# ---------------------------------------------------------------- run

# Runs docker compose with its noisy output in a log file and shows dots while it works.
function Invoke-ComposeUp {
    $log = Join-Path $PSScriptRoot ".xeldash-start.log"
    $version = Get-EnvValue "XELDASH_VERSION"
    if ($version -and $version -ne "local") {
        # A released version: download the ready-made images instead of building them.
        $pull = Start-Process -FilePath "docker" -ArgumentList @("compose", "pull") -NoNewWindow -PassThru -Wait -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        $upArgs = @("compose", "up", "-d")
    } else {
        $upArgs = @("compose", "up", "-d", "--build")
    }
    $p = Start-Process -FilePath "docker" -ArgumentList $upArgs -NoNewWindow -PassThru -RedirectStandardOutput "$log.up" -RedirectStandardError "$log.err"
    $null = $p.Handle
    Write-Host -NoNewline "Starting xelDash "
    while (-not $p.HasExited) { Write-Host -NoNewline "."; Start-Sleep -Seconds 3 }
    $p.WaitForExit()
    Write-Host ""
    if ($p.ExitCode -ne 0) {
        Say ""
        if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 25 | ForEach-Object { Say $_ } }
        Die "xelDash could not start. The last lines of the log are above (full log: $log.err)."
    }
}

function Invoke-Start([bool]$First = $false) {
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    Assert-Docker
    if ($First) {
        Say ""
        Say "Building xelDash. The first time this takes about 10 minutes and downloads a few hundred MB."
    }
    Invoke-ComposeUp
    $port = Get-WebPort
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) { if (Test-Http "http://127.0.0.1:$port/") { $up = $true } else { Start-Sleep -Seconds 2 } }
    if (-not $up) { Die "xelDash started, but the dashboard is not answering yet. Check: xeldash logs" }
    Ok "xelDash is running."
    $hostName = Get-EnvValue "XELDASH_PUBLIC_HOST"
    Say ""
    Say "  Dashboard:  http://localhost:$port"
    if ($hostName) { Say "  On your network:  http://${hostName}:$port" }
    if ($First) {
        $token = Get-EnvValue "XELDASH_ADMIN_TOKEN"
        Say "  Admin password:  $token"
        Say "    You need it to change settings in the dashboard. Show it again any time: xeldash token"
        Say ""
        Say "Opening the dashboard. It will guide you through the rest."
        if ((Get-EnvValue "XELIS_NETWORK") -eq "mainnet") { Say "The blockchain downloads in the background (about 10 GB): you can close this window." }
        # XELDASH_NO_BROWSER=1 skips opening a browser (servers, tests).
        if (-not $env:XELDASH_NO_BROWSER) { Start-Process "http://localhost:$port/#/setup?token=$token" }
    }
}

# ---------------------------------------------------------------- disk space

# Free space in GB (1024-based, like Explorer) on the drive that holds xelDash and its Docker data.
# XELDASH_TEST_FREE_GB overrides it for tests.
function Get-FreeDiskGb {
    if ($env:XELDASH_TEST_FREE_GB) { return [int]$env:XELDASH_TEST_FREE_GB }
    try {
        $drive = (Get-Item -LiteralPath $PSScriptRoot).PSDrive
        if ($drive -and $null -ne $drive.Free) { return [int][math]::Floor($drive.Free / 1GB) }
    } catch { }
    return $null
}

# The first start downloads the blockchain snapshot and unpacks it before deleting the download (about 21 GB at the
# peak, so 40 GB free is comfortable); syncing from other nodes instead needs about half that but takes much longer.
# Warns before anything is downloaded, and offers the slower start when only that fits.
function Test-DiskSpace([bool]$Yes) {
    if ($env:XELDASH_SKIP_DISK_CHECK) { return }
    if ((Get-EnvValue "XELIS_NETWORK") -ne "mainnet") { return }
    $free = Get-FreeDiskGb
    if ($null -eq $free) { return }
    $fast = 40; $slow = 25
    $snapshot = ((Get-EnvValue "XELIS_SNAPSHOT_AUTO") -eq "true")
    $need = $slow; if ($snapshot) { $need = $fast }
    if ($free -ge $need) { Ok "Free disk space: $free GB, enough."; return }
    Say ""
    Warn "Only $free GB of disk space is free where xelDash keeps its data."
    if ($snapshot -and $free -ge $slow) {
        Say "The fast start needs about $fast GB free: it downloads the blockchain (9 GB) and unpacks it (11 GB) before deleting the download."
        Say "A slower start needs only about $slow GB: the node syncs from other nodes instead, which takes much longer, but never holds both copies."
        $reply = "y"
        if (-not $Yes) { $reply = Read-Host "Use the slower start that fits? [Y/n]" }
        if ($reply -match '^(n|no)$') {
            Warn "Continuing with the fast start. It may run out of space; the dashboard warns you and you can free space meanwhile."
        } else {
            Set-EnvValue "XELIS_SNAPSHOT_AUTO" "false"
            Ok "Using the slower start. You can switch later on the Nodes page (Snapshots)."
        }
        return
    }
    Die "That is not enough: xelDash needs about $slow GB free even with the slower start (the blockchain is about 11 GB and grows). Free some space and run xeldash again. (Set XELDASH_SKIP_DISK_CHECK=1 to skip this check.)"
}

function Invoke-Install([string[]]$Rest) {
    $network = ""; $address = ""; $lan = ""; $yes = $false; $noStart = $false; $wantFirewall = $false
    $sets = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $Rest.Count; $i++) {
        switch ($Rest[$i]) {
            "--network" { $i++; $network = $Rest[$i] }
            "--address" { $i++; $address = $Rest[$i] }
            "--lan" { $i++; $lan = $Rest[$i] }
            "--yes" { $yes = $true }
            "-y" { $yes = $true }
            "--no-start" { $noStart = $true }
            "--set" { $i++; $sets.Add($Rest[$i]) }
            default { Die "Unknown option $($Rest[$i]). See the top of xeldash.ps1." }
        }
    }

    Say "xelDash setup"
    Say ""
    Assert-Docker
    Ok "Docker is ready."

    if (Test-Path -LiteralPath $envPath) {
        Ok "xelDash is already set up here (.env exists). Starting it."
        Invoke-Start $false
        return
    }
    if (-not (Test-Path ".env.example")) { Die "Run this from the xelDash folder (.env.example is missing)." }
    Copy-Item ".env.example" $envPath
    Use-ReleaseVersion

    if (-not $network) { $network = "mainnet" }
    if (@("mainnet", "testnet", "devnet") -notcontains $network) { Die "Network must be mainnet, testnet or devnet." }
    $prefix = "xel"; if ($network -ne "mainnet") { $prefix = "xet" }

    if (-not $address -and -not $yes) {
        Say ""
        Say "Your XELIS wallet address"
        Say "Rewards for blocks you find are paid straight to it. It starts with ${prefix}:"
        Say "No wallet yet? Create one free at https://wallet.xelis.io (write the recovery phrase down and never share it)."
        Say "Press Enter to add it later, in the dashboard."
        $address = Read-Host "Address"
    }
    $address = ("" + $address) -replace "\s", ""
    if ($address -and $address -notmatch ("^" + $prefix + ":[a-z0-9]{30,120}$")) {
        Warn "That does not look like a $network address, so it was skipped. You can add it in the dashboard."
        $address = ""
    }

    if (-not $lan -and -not $yes) {
        Say ""
        Say "Other computers"
        Say "Will you mine from other computers on your home network? (If it is only this computer, say no.)"
        $reply = Read-Host "Allow other computers? [y/N]"
        if ($reply -match '^(y|yes)$') { $lan = "yes" } else { $lan = "no" }
    }

    Set-EnvValue "POSTGRES_PASSWORD" (New-RandomHex 16)
    Set-EnvValue "XELDASH_ADMIN_TOKEN" (New-RandomHex 24)
    Set-EnvValue "XELIS_NETWORK" $network
    if ($network -eq "mainnet") { Set-EnvValue "XELIS_SNAPSHOT_AUTO" "true" }
    if ($address) { Set-EnvValue "XELIS_DEFAULT_ADDRESS" $address }
    if ($lan -match '^(y|yes)$') {
        if (-not (Enable-Lan "")) { Warn "Continuing without network access. Try later: xeldash lan on" } else { $wantFirewall = $true }
    }
    foreach ($kv in $sets) {
        if ($kv -notmatch '^[A-Za-z0-9_]+=') { Die "--set needs KEY=VALUE, got: $kv" }
        $idx = $kv.IndexOf("=")
        Set-EnvValue $kv.Substring(0, $idx) $kv.Substring($idx + 1)
    }
    Test-DiskSpace $yes
    Ok "Settings saved to .env (with a new random password and admin token)."

    if ($noStart) { Say "Not starting, as asked. Start later with: xeldash start"; return }
    Invoke-Start $true
    if ($wantFirewall) { Enable-Firewall }
}

# ---------------------------------------------------------------- release versions

# The VERSION file says which released images this copy of xelDash goes with. A downloaded release has its version number in it (for example
# 0.1.0-rc.6) and installs by pulling the ready-made images; a copy of the development branch has "local" and builds from source.
function Get-ReleaseVersion {
    $file = Join-Path $PSScriptRoot "VERSION"
    if (-not (Test-Path -LiteralPath $file)) { return "" }
    $v = ([System.IO.File]::ReadAllText($file)).Trim()
    if ($v -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { return $v }
    return ""
}

# A new .env for a release uses the release's images.
function Use-ReleaseVersion {
    $v = Get-ReleaseVersion
    if ($v) { Set-EnvValue "XELDASH_VERSION" $v }
}

# Whether version $A is newer than $B: 1.10.0 > 1.9.0, a release is newer than its pre-releases, 0.1.0-rc.10 > 0.1.0-rc.9.
function Test-VersionNewer([string]$A, [string]$B) {
    $pa = [regex]::Match($A, '^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$')
    $pb = [regex]::Match($B, '^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$')
    if (-not $pa.Success -or -not $pb.Success) { return $false }
    for ($i = 1; $i -le 3; $i++) {
        $x = [int64]$pa.Groups[$i].Value; $y = [int64]$pb.Groups[$i].Value
        if ($x -gt $y) { return $true }
        if ($x -lt $y) { return $false }
    }
    $ap = $pa.Groups[4].Value; $bp = $pb.Groups[4].Value
    if ($ap -eq $bp) { return $false }
    if (-not $ap) { return $true }
    if (-not $bp) { return $false }
    $xs = $ap.Split("."); $ys = $bp.Split(".")
    $n = [Math]::Max($xs.Count, $ys.Count)
    for ($i = 0; $i -lt $n; $i++) {
        if ($i -ge $xs.Count) { return $false }
        if ($i -ge $ys.Count) { return $true }
        $p = $xs[$i]; $q = $ys[$i]
        if ($p -ceq $q) { continue }
        $pn = $p -match '^\d+$'; $qn = $q -match '^\d+$'
        if ($pn -and $qn) { return ([int64]$p -gt [int64]$q) }
        if ($pn) { return $false }
        if ($qn) { return $true }
        return ([string]::CompareOrdinal($p, $q) -gt 0)
    }
    return $false
}

# The newest tag among GitHub's published releases (a tag whose images are not published yet has no release, so it is not offered).
# A pre-release counts only when the running version is one too.
function Get-NewestTag([object[]]$Releases, [string]$Current) {
    $best = ""
    foreach ($t in $Releases) {
        $name = [string]$t.tag_name
        if ($name -notmatch '^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { continue }
        if ($name.Contains("-") -and -not $Current.Contains("-")) { continue }
        if (-not $best -or (Test-VersionNewer $name.Substring(1) $best.Substring(1))) { $best = $name }
    }
    return $best
}

# Update a release install: find the newest release, download it, put its files over this folder (.env, backups and your data are not in it,
# so they stay) and start it with the new launcher.
function Update-Release([string]$Current) {
    $repo = Get-EnvValue "XELDASH_UPDATE_REPO"; if (-not $repo) { $repo = "pitanu/xelDash" }
    if ($repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { Die "XELDASH_UPDATE_REPO must look like owner/name." }
    $api = $env:XELDASH_RELEASE_API; if (-not $api) { $api = "https://api.github.com/repos/$repo" }
    Say "Looking for a newer release..."
    $tags = $null
    try { $tags = Invoke-RestMethod -Uri "$api/releases?per_page=100" -TimeoutSec 20 -Headers @{ accept = "application/vnd.github+json"; "user-agent" = "xelDash" } } catch { }
    $tag = ""
    if ($tags) { $tag = Get-NewestTag @($tags) $Current }
    if (-not $tag) { Die "Could not find a release to update to. Check your internet connection, or look at https://github.com/$repo/releases" }
    $version = $tag.Substring(1)
    if (-not (Test-VersionNewer $version $Current)) { Ok "You already have the newest release ($Current)."; return }
    Say "Updating $Current to $version..."
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("xeldash-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $url = $env:XELDASH_ARCHIVE_URL; if (-not $url) { $url = "https://github.com/$repo/archive/refs/tags/$tag.zip" }
        $zip = Join-Path $tmp "release.zip"
        try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600 } catch { Die "Could not download $url" }
        try { Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp "x") -Force } catch { Die "The download is damaged. Try again." }
        $dir = Get-ChildItem -LiteralPath (Join-Path $tmp "x") -Directory | Select-Object -First 1
        $versionFile = if ($dir) { Join-Path $dir.FullName "VERSION" } else { "" }
        $claimed = ""
        if ($versionFile -and (Test-Path -LiteralPath $versionFile)) { $claimed = ([System.IO.File]::ReadAllText($versionFile)).Trim() }
        if (-not $dir -or -not (Test-Path (Join-Path $dir.FullName "xeldash.ps1")) -or -not (Test-Path (Join-Path $dir.FullName "docker-compose.yml")) -or $claimed -ne $version) {
            Die "That download is not xelDash release $version. Nothing was changed."
        }
        # xeldash.cmd is what started this script, and Windows reads a batch file while it runs, so it is not replaced under it.
        Get-ChildItem -LiteralPath $dir.FullName -Force | Where-Object { $_.Name -ne "xeldash.cmd" } | Copy-Item -Destination $PSScriptRoot -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    Set-EnvValue "XELDASH_VERSION" $version
    # The launcher was just replaced: carry on with the new one.
    & $PSCommandPath "finish-update" $version
    exit $LASTEXITCODE
}

function Invoke-FinishUpdate([string[]]$Rest) {
    $v = "the new version"; if ($Rest -and $Rest.Count -gt 0) { $v = $Rest[0] }
    if ($env:XELDASH_UPDATE_NO_START) { Ok "Updated to $v (not started: XELDASH_UPDATE_NO_START)."; return }
    Assert-Docker
    Invoke-ComposeUp
    Ok "xelDash is updated to $v and running. Your settings and data were kept."
}

function Invoke-Update {
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    Assert-Docker
    # A release install (XELDASH_VERSION is a version number) updates to the newest release; a source install (local) pulls and rebuilds.
    $running = Get-EnvValue "XELDASH_VERSION"
    if ($running -and $running -ne "local") { Update-Release $running; return }
    if ((Test-Path ".git") -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Say "Getting the newest xelDash..."
        git pull --ff-only
        if ($LASTEXITCODE -ne 0) { Die "Could not update automatically (you may have changed files). Run: git status" }
    } else {
        Warn "This folder was not downloaded with git, so it cannot update itself. Download the newest release and copy your .env into it."
        exit 1
    }
    Invoke-ComposeUp
    Ok "xelDash is updated and running. Your settings and data were kept."
}

# Backups hold the statistics (miners, workers, blocks), not the blockchain or your wallet.
function Get-BackupDir { $d = Get-EnvValue "XELDASH_BACKUP_DIR"; if ($d) { $d } else { ".\backups" } }
function Get-DbUser { $u = Get-EnvValue "POSTGRES_USER"; if ($u) { $u } else { "xeldash" } }
function Get-DbName { $n = Get-EnvValue "POSTGRES_DB"; if ($n) { $n } else { "xeldash" } }

function Invoke-Backup {
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    Assert-Docker
    $dir = Get-BackupDir
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir ("xeldash-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".dump")
    # Dumped inside the database container and copied out: a PowerShell redirect would damage the binary file.
    docker compose exec -T postgres pg_dump -U (Get-DbUser) --format=custom --file=/tmp/xeldash-backup.dump (Get-DbName)
    if ($LASTEXITCODE -ne 0) { Die "The backup failed. Is xelDash running? Start it with: xeldash start" }
    docker compose cp postgres:/tmp/xeldash-backup.dump $file
    if ($LASTEXITCODE -ne 0) { Die "Could not copy the backup out of the database container." }
    docker compose exec -T postgres rm -f /tmp/xeldash-backup.dump | Out-Null
    Ok "Backup saved: $file"
    Say "It holds miner addresses and IP addresses: keep it private, and copy it off this computer too."
}

function Invoke-Restore([string[]]$Arguments) {
    $file = if ($Arguments.Count -ge 1) { $Arguments[0] } else { "" }
    if (-not $file) { Die "Say which backup to restore: xeldash restore backups\xeldash-....dump" }
    if (-not (Test-Path -LiteralPath $file)) { Die "No such file: $file" }
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    Assert-Docker
    if (-not ($Arguments -contains "--yes")) {
        Warn "This replaces your current statistics (miners, workers, blocks, events) with the ones in the backup."
        $reply = Read-Host "Type yes to continue"
        if ($reply -ne "yes") { Die "Cancelled. Nothing was changed." }
    }
    $full = (Resolve-Path -LiteralPath $file).Path
    docker compose stop stratum api
    docker compose cp $full postgres:/tmp/xeldash-restore.dump
    if ($LASTEXITCODE -ne 0) { Die "Could not copy the backup into the database container." }
    docker compose exec -T postgres pg_restore -U (Get-DbUser) -d (Get-DbName) --clean --if-exists /tmp/xeldash-restore.dump
    if ($LASTEXITCODE -ne 0) { Warn "pg_restore reported problems (some can be harmless). Check the dashboard." }
    docker compose exec -T postgres rm -f /tmp/xeldash-restore.dump | Out-Null
    Invoke-ComposeUp
    Ok "Backup restored and xelDash is running."
}

# ---------------------------------------------------------------- front door (a Linux box in front of this computer)

function Invoke-FrontDoor([string[]]$Rest) {
    $sub = "status"; if ($Rest -and $Rest.Count -gt 0) { $sub = $Rest[0] }
    switch ($sub) {
        "setup" {
            if (-not (Test-Path ".env")) { Die "xelDash is not set up yet. Run xeldash first, then come back." }
            Assert-Docker
            if (Get-EnvValue "STRATUM_PROXY_FROM") { Die "A front door is already set up. Show it with: xeldash frontdoor status" }
            $from = ""
            foreach ($a in $Rest) { if ($a -like "--from=*") { $from = $a.Substring(7) } }
            $ip = Get-LanIp
            if (-not $ip -or -not (Test-PrivateIp $ip)) { Die "Could not find this computer's address on your home network. Set it up with: xeldash lan on" }
            if (-not $from) {
                Say ""
                Say "The front door is a second, Linux computer that your miners connect to. What is its address on your home network?"
                Say "(Find it on that computer with: hostname -I)"
                $from = Read-Host "Front door's address"
            }
            if ($from -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or -not (Test-PrivateIp $from)) { Die "That is not a home-network address: $from" }
            if ($from -eq $ip) { Die "The front door must be a different computer than this one ($ip)." }
            $secret = Get-EnvValue "XELDASH_CLUSTER_SECRET"; if (-not $secret) { $secret = New-RandomHex 16 }
            $null = Enable-Lan $ip
            Set-EnvValue "XELDASH_CLUSTER_SECRET" $secret
            Set-EnvValue "XELDASH_SERVER_NAME" $env:COMPUTERNAME
            # Docker Desktop shows every outside computer as its gateway, so the gateway has to be trusted as well.
            Set-EnvValue "STRATUM_PROXY_FROM" "$from,gateway"
            Say "Restarting to accept the front door..."
            Invoke-ComposeUp
            $address = ""
            try { $address = [string](Invoke-RestMethod -Uri "http://127.0.0.1:$(Get-WebPort)/api/v1/node/mining-address" -TimeoutSec 3).address } catch { }
            $network = Get-EnvValue "XELIS_NETWORK"; if (-not $network) { $network = "mainnet" }
            $stratum = Get-EnvValue "XELDASH_STRATUM_PORT"; if (-not $stratum) { $stratum = "3333" }
            $getwork = Get-EnvValue "XELDASH_GETWORK_PORT"; if (-not $getwork) { $getwork = "8090" }
            $json = '{"v":1,"secret":"' + $secret + '","network":"' + $network + '","address":"' + $address + '","host":"' + $ip + '","webPort":' + (Get-WebPort) + ',"stratumPort":' + $stratum + ',"getworkPort":' + $getwork + ',"name":"' + $env:COMPUTERNAME + '"}'
            $code = "xelfront1:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
            Ok "This computer accepts the front door."
            Say ""
            Say "Now, on the Linux computer that will be the front door:"
            Say "  1. Download xelDash there, and run:   ./xeldash.sh frontdoor join $code"
            Say "  2. Wait for its node to sync (the first time it downloads the blockchain)."
            Say "  3. Point your miners at the front door's address (port 3333) instead of this computer."
            Say "Keep that code private: it holds the secret. Miners should connect only through the front door from now on."
        }
        "join" { Say "The front door must be a Linux computer with Docker Engine (Docker Desktop hides the miners' addresses). Run this on Linux: ./xeldash.sh frontdoor join CODE" }
        "off" {
            if (-not (Get-EnvValue "STRATUM_PROXY_FROM")) { Die "No front door is set up." }
            Assert-Docker
            Set-EnvValue "STRATUM_PROXY_FROM" ""
            Invoke-ComposeUp
            Ok "The front door is off. Point your miners back at this computer's own address."
        }
        "status" {
            $f = Get-EnvValue "STRATUM_PROXY_FROM"
            if ($f) { Say "This is the main server. It accepts a front door at: $f" } else { Say "No front door is set up. Set one up with: xeldash frontdoor setup" }
        }
        default { Die "Use: xeldash frontdoor setup | status | off  (the front door itself is set up on Linux: ./xeldash.sh frontdoor join CODE)" }
    }
}

function Show-Usage {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 20 | Select-Object -Skip 1 | ForEach-Object { Say ($_ -replace '^# ?', '') }
}

# ---------------------------------------------------------------- dispatch

$cmd = ""; $rest = @()
if ($CliArgs -and $CliArgs.Count -gt 0) {
    $cmd = $CliArgs[0]
    if ($CliArgs.Count -gt 1) { $rest = $CliArgs[1..($CliArgs.Count - 1)] }
}

switch ($cmd) {
    "" {
        if (Test-Path -LiteralPath $envPath) {
            Assert-Docker
            docker compose ps
            Say ""
            Say "Dashboard: http://localhost:$(Get-WebPort)   (more: xeldash help)"
        } else { Invoke-Install @() }
    }
    "install" { Invoke-Install $rest }
    "start" { Invoke-Start $false }
    "stop" { Assert-Docker; docker compose stop; Ok "xelDash is stopped. Your data is kept. Start again with: xeldash start" }
    "restart" { Assert-Docker; docker compose restart; Ok "Restarted." }
    "status" { Assert-Docker; docker compose ps }
    "logs" { Assert-Docker; docker compose logs -f --tail 100 @rest }
    "open" { if (-not $env:XELDASH_NO_BROWSER) { Start-Process "http://localhost:$(Get-WebPort)/" } }
    "token" {
        $t = Get-EnvValue "XELDASH_ADMIN_TOKEN"
        if ($t) { Say $t } else { Die "No admin password is set in .env." }
    }
    "lan" { Invoke-Lan $rest }
    "firewall" { Invoke-Firewall $rest }
    "update" { Invoke-Update }
    "finish-update" { Invoke-FinishUpdate $rest }
    "backup" { Invoke-Backup }
    "cluster" {
        Say "Redundancy between two servers needs Linux with Docker Engine: Docker Desktop on Windows cannot hold a shared address on your network."
        Say "A Windows computer can still be your main server; see docs/OPERATIONS.md#redundancy-two-servers for the options."
    }
    "frontdoor" { Invoke-FrontDoor $rest }
    "restore" { Invoke-Restore $rest }
    { $_ -in @("help", "-h", "--help") } { Show-Usage }
    default { Say "Unknown command: $cmd"; Show-Usage; exit 1 }
}
