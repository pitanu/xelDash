// The host names the dashboard answers to (DNS rebinding): docker/web/42-allowed-hosts.sh makes nginx's map, and the API checks the
// same rules itself (services/api/src/allowed-hosts.js). Each name below must get the same answer from both.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAllowed, hostRulesFromEnv } from "../services/api/src/allowed-hosts.js";

const script = fileURLToPath(new URL("../docker/web/42-allowed-hosts.sh", import.meta.url));
const skip = spawnSync("sh", ["-c", "true"]).status === 0 ? false : "needs sh";

/** Run the script; returns nginx's answer for a $host (lower case, no port) the way its map works, or the script's failure. */
function nginxMap(/** @type {Record<string, string>} */ env) {
  const dir = mkdtempSync(join(tmpdir(), "xeldash-hosts-"));
  const r = spawnSync("sh", [script.replace(/\\/g, "/")], { env: { PATH: process.env.PATH ?? "", ...env, XELDASH_NGINX_SNIPPETS: dir.replace(/\\/g, "/") }, encoding: "utf8" });
  if (r.status !== 0) return { error: r.stderr };
  const text = readFileSync(join(dir, "allowed-hosts.conf"), "utf8");
  const def = /default (\d);/.exec(text)?.[1] === "1";
  const patterns = [...text.matchAll(/^\s+"~(.*)" 1;$/gm)].map((m) => new RegExp(m[1]));
  return { text, allowed: (/** @type {string} */ host) => patterns.some((p) => p.test(host)) || def };
}

const LOCAL = ["192.168.1.20", "127.0.0.1", "[::1]", "[fd00::1]", "localhost", "desktop-abc", "frontdoor", "web", "_",
  "pc.local", "rig.lan", "xeldash.home", "box.home.arpa", "host.docker.internal", "nas.tail1234.ts.net", "app.localhost"];
const FOREIGN = ["evil.example", "rebind.attacker.com", "192.168.1.20.nip.io", "localhost.evil.com", "lan.evil.com", "local.example"];

test("addresses, local names and local suffixes are answered; a website's own domain is not", { skip }, () => {
  const nginx = nginxMap({});
  assert.ok(nginx.allowed, nginx.error);
  const rules = hostRulesFromEnv({});
  for (const host of LOCAL) {
    assert.equal(nginx.allowed(host), true, `nginx: ${host}`);
    assert.equal(hostAllowed(host, rules), true, `api: ${host}`);
  }
  for (const host of FOREIGN) {
    assert.equal(nginx.allowed(host), false, `nginx: ${host}`);
    assert.equal(hostAllowed(host, rules), false, `api: ${host}`);
  }
  assert.equal(hostAllowed("192.168.1.20:8088", rules), true, "the API sees the port too");
  assert.equal(hostAllowed("evil.example:8088", rules), false);
  assert.equal(hostAllowed(undefined, rules), true, "no Host at all cannot be a rebinding page");
});

test("the names in .env are answered too, and XELDASH_ALLOWED_HOSTS=any turns the check off", { skip }, () => {
  const env = { XELDASH_CONNECT_HOST: "Solo.Example.org", XELDASH_PUBLIC_DOMAIN: "pool.example.net", XELDASH_PROXY_HOST: "dash.example.com:443",
    XELDASH_ALLOWED_HOSTS: "mine.example.io, *.corp.example" };
  const nginx = nginxMap(env);
  assert.ok(nginx.allowed, nginx.error);
  const rules = hostRulesFromEnv(env);
  for (const host of ["solo.example.org", "pool.example.net", "dash.example.com", "mine.example.io", "a.corp.example", "corp.example"]) {
    assert.equal(nginx.allowed(host), true, `nginx: ${host}`);
    assert.equal(hostAllowed(host, rules), true, `api: ${host}`);
  }
  for (const host of ["xsolo.example.org", "solo.example.org.evil.com", "example.org", "corpxexample"]) {
    assert.equal(hostAllowed(host, rules), host === "corpxexample", `api: ${host}`);
    assert.equal(nginx.allowed(host), host === "corpxexample", `nginx: ${host}`);
  }
  const old = nginxMap({ XELDASH_PUBLIC_HOST: "old.example.org" });
  assert.equal(old.allowed?.("old.example.org"), true, "the old name for the connect host still counts");
  const open = nginxMap({ XELDASH_ALLOWED_HOSTS: "any" });
  assert.equal(open.allowed?.("evil.example"), true);
  assert.equal(hostAllowed("evil.example", hostRulesFromEnv({ XELDASH_ALLOWED_HOSTS: "any" })), true);
});

test("a typo in XELDASH_ALLOWED_HOSTS stops the dashboard with a message, rather than answering everyone", { skip }, () => {
  for (const bad of ["dash/example.org", "*.", "a..b", "*.evil.com/x"]) {
    assert.match(nginxMap({ XELDASH_ALLOWED_HOSTS: bad }).error ?? "", /is not a host name/, bad);
  }
});

test("the dashboard answers 421 to a host name that is not its own, before anything else", () => {
  const conf = readFileSync(fileURLToPath(new URL("../web/nginx.conf", import.meta.url)), "utf8");
  assert.match(conf, /include \/etc\/nginx\/snippets\/allowed-hosts\.conf;/);
  assert.match(conf, /if \(\$xeldash_host_ok = 0\) \{\s*return 421;\s*\}/);
  const dockerfile = readFileSync(fileURLToPath(new URL("../web/Dockerfile", import.meta.url)), "utf8");
  assert.match(dockerfile, /42-allowed-hosts\.sh \/docker-entrypoint\.d\/42-allowed-hosts\.sh/);
});
