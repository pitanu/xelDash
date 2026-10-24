// The Linux/macOS launcher (xeldash.sh), run in a real bash. Only the parts that need no Docker: the .env helpers, and the checks a
// pasted cluster or front door code goes through before anything is written. Skipped where there is no bash.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../xeldash.sh", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const skip = hasBash ? false : "bash is not available";

const toPosix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const SECRET = "0123456789abcdef0123456789abcdef";
const ADDR = `xet:${"a".repeat(40)}`;

/** Run some bash with the launcher's own functions loaded, in a scratch folder with a .env. */
function bash(script, { env = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launcher-"));
  writeFileSync(join(dir, ".env"), env);
  const prelude = `
    cd '${toPosix(dir)}'
    say() { printf '%s\\n' "$*"; }; warn() { printf 'WARN: %s\\n' "$*"; }; die() { printf 'DIE: %s\\n' "$*"; exit 1; }
    L='${toPosix(LAUNCHER)}'
    for fn in get_env set_env is_private_ip json_get cluster_code_ok frontdoor_code_ok; do
      eval "$(sed -n "/^$fn() {/,/^}/p" "$L")"
    done
  `;
  const result = spawnSync("bash", ["-c", prelude + script], { encoding: "utf8" });
  const dotenv = readFileSync(join(dir, ".env"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim(), dotenv };
}

test(".env values are read, replaced, uncommented and appended; special characters survive", { skip }, () => {
  const r = bash(`
    set_env A one; set_env B 'two words'; set_env C 'a&b/c\\d$e'; set_env D ''
    set_env A uno
    echo "A=$(get_env A)|B=$(get_env B)|C=$(get_env C)|D=$(get_env D)|X=$(get_env X)"
  `, { env: "# A=old\nKEEP=1\n" });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "A=uno|B=two words|C=a&b/c\\d$e|D=|X=");
  assert.match(r.dotenv, /^A=uno$/m, "the commented line was replaced, not duplicated");
  assert.equal(r.dotenv.match(/^A=/gm).length, 1);
  assert.match(r.dotenv, /^KEEP=1$/m, "other lines are untouched");
});

test("home-network addresses are recognised", { skip }, () => {
  const yes = ["10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.9.9"];
  const no = ["8.8.8.8", "172.32.0.1", "11.0.0.1", "192.169.0.1", "100.64.0.1", ""];
  const r = bash([...yes.map((ip) => `is_private_ip '${ip}' && echo "yes ${ip}" || echo "NO ${ip}"`), ...no.map((ip) => `is_private_ip '${ip}' && echo "YES '${ip}'" || echo "no '${ip}'"`)].join("\n"));
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("NO ") || l.startsWith("YES ")).length, 0, r.out);
});

const clusterArgs = (over = {}) => {
  const a = { vip: "192.168.1.250/24", id: "7", secret: SECRET, network: "mainnet", address: "", primary: "http://192.168.1.10:8088", name: "pc-1", ...over };
  return [a.vip, a.id, a.secret, a.network, a.address, a.primary, a.name].map((v) => `'${v}'`).join(" ");
};
const accepted = (fn, args) => bash(`${fn} ${args} && echo ACCEPTED || echo REFUSED`).out.split("\n").pop() === "ACCEPTED";

test("a pasted cluster code is accepted only when every field is sane", { skip }, () => {
  assert.ok(accepted("cluster_code_ok", clusterArgs()));
  assert.ok(accepted("cluster_code_ok", clusterArgs({ address: ADDR, primary: "http://nas.local:8088" })));
  for (const bad of [
    { vip: "8.8.8.8/24" }, { vip: "192.168.1.250" }, { vip: "192.168.1.250/31" }, { id: "0" }, { id: "256" }, { id: "x" },
    { secret: "short" }, { secret: SECRET.toUpperCase() }, { network: "fakenet" }, { address: "xel:short" }, { address: "evil" },
    { primary: "http://8.8.8.8:8088" }, { primary: "https://192.168.1.10:8088" }, { primary: "http://192.168.1.10" }, { primary: "http://evil.example.com:8088" },
    { primary: "http://192.168.1.10:8088/path" }, { name: "a b" }, { name: "x;rm -rf /" }, { name: "" },
  ]) assert.ok(!accepted("cluster_code_ok", clusterArgs(bad)), JSON.stringify(bad));
});

const frontArgs = (over = {}) => {
  const a = { secret: SECRET, network: "mainnet", address: "", host: "192.168.1.10", web: "8088", stratum: "3333", getwork: "8090", name: "pc-1", ...over };
  return [a.secret, a.network, a.address, a.host, a.web, a.stratum, a.getwork, a.name].map((v) => `'${v}'`).join(" ");
};

test("a pasted front door code is accepted only when every field is sane", { skip }, () => {
  assert.ok(accepted("frontdoor_code_ok", frontArgs()));
  assert.ok(accepted("frontdoor_code_ok", frontArgs({ address: ADDR, network: "devnet" })));
  for (const bad of [
    { secret: "bad" }, { network: "fakenet" }, { address: "evil" }, { host: "8.8.8.8" }, { host: "nas.local" }, { host: "192.168.1.10; id" },
    { web: "99999" }, { web: "x" }, { stratum: "1" }, { getwork: "" }, { name: "a;b" },
  ]) assert.ok(!accepted("frontdoor_code_ok", frontArgs(bad)), JSON.stringify(bad));
});

test("json values are picked out of a code's contents", { skip }, () => {
  const r = bash(`echo '{"v":1,"secret":"abc","webPort":8088,"name":"pc-1"}' | json_get secret; echo '{"v":1,"secret":"abc","webPort":8088}' | json_get webPort; echo '{}' | json_get nothing`);
  assert.equal(r.out, "abc\n8088");
});

const b64 = (object) => Buffer.from(typeof object === "string" ? object : JSON.stringify(object)).toString("base64");

/** Run the whole launcher with an argument, in a scratch folder, with .env content. */
function launcher(args, env = "XELIS_NETWORK=mainnet\n") {
  const dir = mkdtempSync(join(tmpdir(), "launcher-run-"));
  copyFileSync(LAUNCHER, join(dir, "xeldash.sh"));
  writeFileSync(join(dir, ".env"), env);
  const result = spawnSync("bash", [join(dir, "xeldash.sh"), ...args], { encoding: "utf8", env: { ...process.env, TERM: "dumb" } });
  const dotenv = readFileSync(join(dir, ".env"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, text: `${result.stdout}${result.stderr}`, dotenv };
}

test("joining with a damaged, wrong or edited code is refused and writes nothing", { skip }, () => {
  const good = { v: 1, secret: SECRET, network: "mainnet", address: "", host: "192.168.1.10", webPort: 8088, stratumPort: 3333, getworkPort: 8090, name: "pc-1" };
  const cases = [
    [["frontdoor", "join"], /Say which server/],
    [["frontdoor", "join", "nope"], /not a front door code/],
    [["frontdoor", "join", "xelfront1:!!!not-base64!!!"], /damaged|incomplete/],
    [["frontdoor", "join", `xelfront1:${b64({ v: 1 })}`], /incomplete/],
    [["frontdoor", "join", `xelfront1:${b64({ ...good, host: "8.8.8.8" })}`], /refused/],
    [["frontdoor", "join", `xelfront1:${b64({ ...good, secret: "short" })}`], /refused/],
    [["frontdoor", "join", `xelfront1:${b64({ ...good, name: "x;touch pwned" })}`], /refused|incomplete/],
    [["cluster", "join", "nope"], /not a cluster code/],
    [["cluster", "join", `xelcluster1:${b64({ v: 1, vip: "8.8.8.8/24", id: 5, secret: SECRET, primary: "http://192.168.1.10:8088", name: "x" })}`], /refused/],
  ];
  for (const [args, expected] of cases) {
    const r = launcher(args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.text, expected, args.join(" "));
    assert.equal(r.dotenv, "XELIS_NETWORK=mainnet\n", `${args.join(" ")} must not touch .env`);
  }
});

test("help lists the commands, and an unknown command is refused", { skip }, () => {
  const help = launcher(["help"]);
  assert.equal(help.status, 0);
  for (const word of ["install", "update", "backup", "restore", "cluster", "frontdoor", "lan"]) assert.match(help.text, new RegExp(word));
  assert.notEqual(launcher(["frobnicate"]).status, 0);
});

test("a new setup stops when xelDash already has a database on this computer, and says where", { skip }, () => {
  // A stand-in for docker: project "xeldash" has a database, run from /home/me/xelDash; "empty" has a database but no containers left.
  const r = bash(`
    eval "$(sed -n "/^existing_install() {/,/^}/p" "$L")"
    docker() {
      case "$1 $2" in
        "volume inspect") [ "$3" = xeldash_postgres-data ] || [ "$3" = empty_postgres-data ] ;;
        "ps -a") case "$*" in *project=xeldash*) printf '/home/me/xelDash\n' ;; esac ;;
      esac
    }
    for p in xeldash empty xeldash2; do if where="$(existing_install "$p")"; then echo "$p: [$where]"; else echo "$p: none"; fi; done
  `);
  assert.deepEqual(r.out.split("\n"), ["xeldash: [/home/me/xelDash]", "empty: []", "xeldash2: none"], r.err);
});

// The line kept above the old setting when the new one is added from it.
const KEPT = "# Kept the same as XELDASH_CONNECT_HOST, for going back to xelDash 0.6.1 or older:\n";

test("XELDASH_CONNECT_HOST is added from the old XELDASH_PUBLIC_HOST, which stays for going back to an older version", { skip }, () => {
  const rename = (/** @type {string} */ env) => bash(`eval "$(sed -n "/^rename_old_settings() {/,/^}/p" "$L")"; rename_old_settings`, { env }).dotenv;
  assert.equal(rename("A=1\nXELDASH_PUBLIC_HOST=192.168.1.10\nB=2\n"), `A=1\nXELDASH_CONNECT_HOST=192.168.1.10\n${KEPT}XELDASH_PUBLIC_HOST=192.168.1.10\nB=2\n`);
  assert.equal(rename("XELDASH_PUBLIC_HOST=\n"), `XELDASH_CONNECT_HOST=\n${KEPT}XELDASH_PUBLIC_HOST=\n`, "an empty one too");
  assert.equal(rename(`XELDASH_CONNECT_HOST=a\n${KEPT}XELDASH_PUBLIC_HOST=a\n`), `XELDASH_CONNECT_HOST=a\n${KEPT}XELDASH_PUBLIC_HOST=a\n`, "only once");
  assert.equal(rename("XELDASH_PUBLIC_HOST=a\nXELDASH_CONNECT_HOST=b\n"), "XELDASH_PUBLIC_HOST=a\nXELDASH_CONNECT_HOST=b\n", "both there: left alone");
  assert.equal(rename("# XELDASH_PUBLIC_HOST=a\nC=3\n"), "# XELDASH_PUBLIC_HOST=a\nC=3\n", "a comment is not a setting");
});

test("lan on and off set the old XELDASH_PUBLIC_HOST too while .env has it, so it never falls back to a stale address", { skip }, () => {
  const set = (/** @type {string} */ env, /** @type {string} */ value) =>
    bash(`eval "$(sed -n "/^set_connect_host() {/,/^}/p" "$L")"; set_connect_host '${value}'`, { env }).dotenv;
  assert.equal(set(`XELDASH_CONNECT_HOST=a\n${KEPT}XELDASH_PUBLIC_HOST=a\n`, "192.168.1.20"), `XELDASH_CONNECT_HOST=192.168.1.20\n${KEPT}XELDASH_PUBLIC_HOST=192.168.1.20\n`);
  assert.equal(set(`XELDASH_CONNECT_HOST=a\n${KEPT}XELDASH_PUBLIC_HOST=a\n`, ""), `XELDASH_CONNECT_HOST=\n${KEPT}XELDASH_PUBLIC_HOST=\n`, "lan off empties both");
  assert.equal(set("XELDASH_CONNECT_HOST=a\n", "b"), "XELDASH_CONNECT_HOST=b\n", "a newer .env has only the new name");
});
