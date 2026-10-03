// The documentation matches the project: links and headings exist, and every setting the docs name is real. Also the other way:
// every setting a Compose file reads is explained somewhere.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

const markdown = [
  "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md",
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ...["services/stratum", "services/api", "services/node-admin", "web", "docker/daemon", "docker/keepalived", "docker/standby-web", "docker/frontdoor", "docker/stratum-tls", "docker/hostdisk"]
    .map((d) => `${d}/README.md`),
].filter((f) => existsSync(join(root, f)));

const slug = (heading) => heading.toLowerCase().replace(/[`*_]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const headingsOf = (file) => new Set([...read(file).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));

test("every link in the docs points at a file and heading that exist", () => {
  const problems = [];
  for (const file of markdown) {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#$)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const resolved = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
      if (path && !existsSync(join(root, resolved))) { problems.push(`${file}: missing file ${target}`); continue; }
      if (anchor && resolved.endsWith(".md") && !headingsOf(resolved).has(anchor)) problems.push(`${file}: no heading #${anchor} in ${resolved}`);
    }
  }
  assert.deepEqual(problems, []);
});

/** All source text that could mention a setting. */
function sourceText() {
  const parts = ["docker-compose.yml", "docker-compose.cluster.yml", "docker-compose.standby.yml", "docker-compose.frontdoor.yml", ".env.example", "xeldash.sh", "xeldash.ps1"].map(read);
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "target", ".git", "notes", "backups"].includes(entry.name)) return [];
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(js|jsx|sh|conf|template|html|yml)$/.test(entry.name) ? [read(path)] : [];
  });
  return [...parts, ...walk("services"), ...walk("packages"), ...walk("docker"), ...walk("web/src")].join("\n");
}

const SETTING = "(?:XELDASH|STRATUM|XELIS|ALERT|RETENTION|BACKUP|FRONTDOOR|GETWORK)_[A-Z0-9_]+";

test("every setting the docs name exists in the code", () => {
  const code = sourceText();
  const missing = new Set();
  for (const file of markdown) {
    for (const [, name] of read(file).matchAll(new RegExp("`(" + SETTING + ")`", "g"))) if (!code.includes(name)) missing.add(`${name} (in ${file})`);
  }
  assert.deepEqual([...missing], []);
});

test("every setting a Compose file reads is explained in .env.example or the docs", () => {
  const compose = readdirSync(root).filter((f) => /^docker-compose.*\.yml$/.test(f));
  const documented = [".env.example", ...markdown].map(read).join("\n");
  const undocumented = new Set();
  for (const file of compose) {
    for (const [, name] of read(file).matchAll(new RegExp("\\$\\{(" + SETTING + ")[:}?-]", "g"))) if (!documented.includes(name)) undocumented.add(`${name} (${file})`);
  }
  assert.deepEqual([...undocumented], []);
});

test("the documented version of the daemon is the one the compose files use", () => {
  const versions = new Set();
  for (const file of readdirSync(root).filter((f) => /^docker-compose.*\.yml$/.test(f))) {
    for (const [, v] of read(file).matchAll(/xelis\/daemon:(\d+\.\d+\.\d+)/g)) versions.add(v);
  }
  assert.equal(versions.size, 1, `one daemon version everywhere, found: ${[...versions].join(", ")}`);
});
