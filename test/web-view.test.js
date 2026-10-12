// docker/web/41-view.sh: which view a web container gives. In public mode every web container except the operator's admin web
// must give the public view: no route to node administration, and X-Xeldash-View: public on every request to the API.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../docker/web/41-view.sh", import.meta.url));
const skip = spawnSync("sh", ["-c", "true"]).status === 0 ? false : "needs sh";

/** @param {Record<string, string>} env */
function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "xeldash-view-"));
  const r = spawnSync("sh", [script.replace(/\\/g, "/")], { env: { PATH: process.env.PATH ?? "", ...env, XELDASH_NGINX_SNIPPETS: dir.replace(/\\/g, "/") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { view: readFileSync(join(dir, "view.conf"), "utf8"), route: readFileSync(join(dir, "node-route.conf"), "utf8") };
}

test("a normal dashboard gives the operator view, with node administration", { skip }, () => {
  for (const env of [{}, { XELDASH_PUBLIC_MODE: "false" }, { XELDASH_PUBLIC_MODE: "no" }]) {
    const { view, route } = run(env);
    assert.match(view, /set \$xeldash_view "admin";/);
    assert.match(route, /proxy_pass \$admin_upstream;/);
    assert.match(route, /proxy_set_header X-Xeldash-View \$xeldash_view;/);
  }
});

test("in public mode the dashboard gives the public view: node administration is a 404", { skip }, () => {
  for (const env of [{ XELDASH_PUBLIC_MODE: "true" }, { XELDASH_PUBLIC_MODE: "TRUE" }, { XELDASH_PUBLIC_MODE: "1" },
    { XELDASH_PUBLIC_MODE: "true", XELDASH_WEB_VIEW: "Admin" }, { XELDASH_PUBLIC_MODE: "true", XELDASH_WEB_VIEW: "operator" }]) {
    const { view, route } = run(env);
    assert.match(view, /set \$xeldash_view "public";/, JSON.stringify(env));
    assert.match(route, /return 404;/, JSON.stringify(env));
    assert.doesNotMatch(route, /proxy_pass/, JSON.stringify(env));
  }
});

test("in public mode only the admin web (XELDASH_WEB_VIEW=admin) gives the operator view", { skip }, () => {
  const { view, route } = run({ XELDASH_PUBLIC_MODE: "true", XELDASH_WEB_VIEW: "admin" });
  assert.match(view, /set \$xeldash_view "admin";/);
  assert.match(route, /proxy_pass \$admin_upstream;/);
});

test("the dashboard's nginx config uses the view on every route to the API", () => {
  const conf = readFileSync(fileURLToPath(new URL("../web/nginx.conf", import.meta.url)), "utf8");
  assert.match(conf, /include \/etc\/nginx\/snippets\/view\.conf;/);
  assert.match(conf, /include \/etc\/nginx\/snippets\/node-route\.conf;/);
  const apiLocations = conf.split(/\n\s*location /).filter((block) => /proxy_pass \$api_upstream/.test(block));
  assert.ok(apiLocations.length >= 2);
  for (const block of apiLocations) assert.match(block, /proxy_set_header X-Xeldash-View \$xeldash_view;/, block.slice(0, 80));
  assert.doesNotMatch(conf, /proxy_pass \$admin_upstream/, "node administration is only routed through the generated node-route.conf");
});

test("the public view limits requests per visitor and trusts only its own Docker networks to name the visitor", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "xeldash-route-"));
  const route = join(dir, "route");
  // eth0 on 172.22.0.0/16, and a default route through 172.22.0.1.
  writeFileSync(route, "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n"
    + "eth0\t00000000\t010016AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000016AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n");
  const pub = run({ XELDASH_PUBLIC_MODE: "true", XELDASH_ROUTE_FILE: route.replace(/\\/g, "/") }).view;
  assert.match(pub, /set \$limit_ip \$binary_remote_addr;/);
  assert.match(pub, /set \$limit_all "all";/);
  assert.match(pub, /set_real_ip_from 172\.22\.0\.0\/16;/);
  assert.doesNotMatch(pub, /set_real_ip_from 0\.0\.0\.0/, "never the default route: anyone could name an address then");
  assert.match(pub, /limit_conn conn_per_ip 20;/);
  assert.match(pub, /client_header_timeout 10s;/);
  for (const env of [{}, { XELDASH_PUBLIC_MODE: "true", XELDASH_WEB_VIEW: "admin" }]) {
    const view = run({ ...env, XELDASH_ROUTE_FILE: route.replace(/\\/g, "/") }).view;
    assert.match(view, /set \$limit_ip "";/, "no limits for a normal dashboard or the operator");
    assert.doesNotMatch(view, /set_real_ip_from|limit_conn/);
  }
});

test("every route of the dashboard is limited by the public view's keys", () => {
  const conf = readFileSync(fileURLToPath(new URL("../web/nginx.conf", import.meta.url)), "utf8");
  for (const zone of ["api_per_ip", "csv_per_ip", "page_per_ip", "api_all"]) assert.match(conf, new RegExp(`limit_req_zone \\$limit_(ip|all) zone=${zone}:`));
  const locations = conf.split(/\n\s*location /).slice(1);
  for (const block of locations) assert.match(block, /limit_(req|conn) /, `unlimited location: ${block.slice(0, 40)}`);
});
