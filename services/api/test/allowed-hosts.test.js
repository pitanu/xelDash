// The API answers only to host names that belong here (src/allowed-hosts.js): its port is published on this computer, where a
// website could otherwise reach it by DNS rebinding and read the operator's view. The rules themselves are checked against the web
// container's nginx map in test/web-hosts.test.js, and the live feed's in live.test.js; this checks the API applies them to requests.
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let base;
let server;
let port;

test.before(async () => {
  // Settings are read when the API is imported. The database is never reached: a refused host is answered before anything else.
  Object.assign(process.env, {
    DATABASE_URL: "postgres://xeldash:none@127.0.0.1:1/none", XELIS_NETWORK: "devnet", XELDASH_VERSION_CHECK: "off", XELDASH_PRICE: "off",
    XELDASH_ALLOWED_HOSTS: "dash.example.org", CONFIG_DIR: await mkdtemp(join(tmpdir(), "xeldash-hosts-")),
  });
  ({ server } = await import("../src/server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  base = `http://127.0.0.1:${port}`;
});
test.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));

/** A GET with a given Host header. @param {string} path @param {string} host */
function get(path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a request naming another website's domain gets 421, with nothing from the API", async () => {
  for (const host of ["evil.example", `rebind.attacker.com:${port}`, "192.168.1.20.nip.io"]) {
    const r = /** @type {{ status: number, body: string }} */ (await get("/api/v1/miners", host));
    assert.equal(r.status, 421, host);
    assert.match(r.body, /unknown_host/);
  }
});

test("addresses, local names and the configured names reach the API", async () => {
  for (const host of [`127.0.0.1:${port}`, "localhost", "web", "pc.local", "dash.example.org"]) {
    const r = /** @type {{ status: number }} */ (await get("/api/v1/nope", host));
    assert.notEqual(r.status, 421, host);
  }
  assert.ok(base);
});

