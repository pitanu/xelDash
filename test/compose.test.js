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
