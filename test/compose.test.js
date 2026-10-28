// Every Compose file is valid on its own with the settings its launcher writes. Needs Docker with Compose; skipped without it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const hasCompose = spawnSync("docker", ["compose", "version"]).status === 0;
const skip = hasCompose ? false : "docker compose is not available";

const SECRET = "0123456789abcdef0123456789abcdef";
const BASE = { POSTGRES_PASSWORD: "ci-only" };
const SETS = {
  "docker-compose.yml": BASE,
  "docker-compose.yml:docker-compose.cluster.yml": { ...BASE, XELDASH_CLUSTER_SECRET: SECRET, XELDASH_VIP: "192.168.1.250/24", XELDASH_CLUSTER_ID: "7" },
  "docker-compose.standby.yml": { XELDASH_PRIMARY_URL: "http://192.168.1.10:8088", XELDASH_CLUSTER_SECRET: SECRET, XELDASH_VIP: "192.168.1.250/24", XELDASH_CLUSTER_ID: "7" },
  "docker-compose.frontdoor.yml": { XELDASH_PRIMARY_URL: "http://192.168.1.10:8088", XELDASH_CLUSTER_SECRET: SECRET, FRONTDOOR_MAIN_HOST: "192.168.1.10" },
};

for (const [files, env] of Object.entries(SETS)) {
  test(`compose: ${files}`, { skip }, () => {
    const r = spawnSync("docker", ["compose", "config", "--quiet"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env, COMPOSE_FILE: files, COMPOSE_PATH_SEPARATOR: ":" } });
    assert.equal(r.status, 0, r.stderr);
  });
}

test("the second server and the front door refuse to start without what the launcher writes", { skip }, () => {
  for (const [file, name] of [["docker-compose.standby.yml", "XELDASH_PRIMARY_URL"], ["docker-compose.frontdoor.yml", "FRONTDOOR_MAIN_HOST"]]) {
    const env = { ...process.env, COMPOSE_FILE: file, XELDASH_PRIMARY_URL: "http://192.168.1.10:8088", XELDASH_CLUSTER_SECRET: SECRET, FRONTDOOR_MAIN_HOST: "192.168.1.10", XELDASH_VIP: "192.168.1.250/24", XELDASH_CLUSTER_ID: "7" };
    delete env[name];
    const r = spawnSync("docker", ["compose", "config", "--quiet"], { cwd: root, encoding: "utf8", env });
    assert.notEqual(r.status, 0, `${file} without ${name}`);
  }
});

test("every Compose file in the project is covered above", () => {
  const covered = new Set(Object.keys(SETS).flatMap((k) => k.split(":")));
  const files = readdirSync(root).filter((f) => /^docker-compose.*\.yml$/.test(f) && f !== "docker-compose.dev.yml");
  assert.deepEqual(files.filter((f) => !covered.has(f)), [], "add new Compose files to SETS");
});

test("every container is started without a way to gain privileges, and ours with only the capabilities they need", { skip }, () => {
  // keepalived claims the cluster's address on the computer's own network card; it needs root's network capabilities.
  const exempt = new Set(["keepalived"]);
  for (const [files, env] of Object.entries(SETS)) {
    const r = spawnSync("docker", ["compose", "--profile", "*", "config", "--format", "json"], {
      cwd: root, encoding: "utf8", env: { ...process.env, ...env, COMPOSE_FILE: files, COMPOSE_PATH_SEPARATOR: ":" },
    });
    assert.equal(r.status, 0, r.stderr);
    for (const [name, service] of Object.entries(JSON.parse(r.stdout).services)) {
      if (exempt.has(name)) continue;
      assert.deepEqual(service.security_opt, ["no-new-privileges:true"], `${files}: ${name}`);
      if (["api", "migrate", "stratum", "node-admin"].includes(name)) {
        assert.deepEqual(service.cap_drop, ["ALL"], `${files}: ${name} drops every capability`);
        assert.equal(service.cap_add, undefined, `${files}: ${name} adds none back`);
        assert.equal(service.read_only, true, `${files}: ${name} writes only to its volumes`);
      }
    }
  }
});

test("the Connect page's address: XELDASH_CONNECT_HOST, or the old XELDASH_PUBLIC_HOST from an older .env", { skip }, () => {
  const connectHost = (/** @type {Record<string, string>} */ vars) => {
    const r = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: root, encoding: "utf8", env: { ...process.env, ...BASE, COMPOSE_FILE: "docker-compose.yml", XELDASH_CONNECT_HOST: "", XELDASH_PUBLIC_HOST: "", ...vars },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).services.api.environment.CONNECT_HOST;
  };
  assert.equal(connectHost({ XELDASH_CONNECT_HOST: "192.168.1.10" }), "192.168.1.10");
  assert.equal(connectHost({ XELDASH_PUBLIC_HOST: "192.168.1.11" }), "192.168.1.11", "the old name still works");
  assert.equal(connectHost({ XELDASH_CONNECT_HOST: "solo.example.org", XELDASH_PUBLIC_HOST: "192.168.1.11" }), "solo.example.org", "the new name wins");
});
