# xelDash launcher for Windows: set it up, start it, stop it, update it.
# Easiest: double-click xeldash.cmd. From a PowerShell window:
#
#   .\xeldash.cmd            first time: guided setup; afterwards: shows what is running
#   .\xeldash.cmd install    guided setup (creates .env, starts xelDash, opens the dashboard)
#   .\xeldash.cmd start | stop | restart | status | logs [service] | open | token
#   .\xeldash.cmd lan on|off|status    let other computers on your network use xelDash
#   .\xeldash.cmd update     get the newest xelDash and restart it
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
        }
        "off" { Assert-Docker; Disable-Lan; docker compose up -d | Out-Null; Ok "Restarted with the new setting." }
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

function Invoke-Install([string[]]$Rest) {
    $network = ""; $address = ""; $lan = ""; $yes = $false; $noStart = $false
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
        if (-not (Enable-Lan "")) { Warn "Continuing without network access. Try later: xeldash lan on" }
    }
    foreach ($kv in $sets) {
        if ($kv -notmatch '^[A-Za-z0-9_]+=') { Die "--set needs KEY=VALUE, got: $kv" }
        $idx = $kv.IndexOf("=")
        Set-EnvValue $kv.Substring(0, $idx) $kv.Substring($idx + 1)
    }
    Ok "Settings saved to .env (with a new random password and admin token)."

    if ($noStart) { Say "Not starting, as asked. Start later with: xeldash start"; return }
    Invoke-Start $true
}

function Invoke-Update {
    if (-not (Test-Path -LiteralPath $envPath)) { Die "xelDash is not set up yet. Double-click xeldash.cmd first." }
    Assert-Docker
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

function Show-Usage {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 16 | Select-Object -Skip 1 | ForEach-Object { Say ($_ -replace '^# ?', '') }
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
    "update" { Invoke-Update }
    { $_ -in @("help", "-h", "--help") } { Show-Usage }
    default { Say "Unknown command: $cmd"; Show-Usage; exit 1 }
}
