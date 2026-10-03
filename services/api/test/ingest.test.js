import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { handleIngest } from "../src/ingest.js";

const SECRET = "s".repeat(24);

/** The ingest handler behind a real HTTP server, with a stand-in database that only knows the progress table. */
async function start({ secret = SECRET, rows = [] } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      return { rows: /ingest_progress WHERE/.test(sql) ? rows : [] };
    },
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://x").pathname;
    const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    const handled = await handleIngest({ request, response, pathname, pool, secret, alerts: async () => ({ events: ["cluster"] }), send, logger: { info() {}, warn() {} } });
    if (!handled) send(response, 404, { error: "elsewhere" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref(); // a failing test must not keep the run alive
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, queries, close: () => server.close() };
}

const call = (base, path, { method = "GET", secret = SECRET, body } = {}) =>
  fetch(base + path, { method, headers: { ...(secret ? { "x-cluster-secret": secret } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

test("without a long enough cluster secret the endpoints do not exist", async () => {
  for (const secret of [null, "", "short"]) {
    const s = await start({ secret });
    for (const path of ["/api/v1/ingest", "/api/v1/ingest/ping", "/api/v1/ingest/alerts"]) assert.equal((await call(s.base, path)).status, 404, `${secret} ${path}`);
    s.close();
  }
});

test("a wrong or missing secret is refused before anything is read", async () => {
  const s = await start();
  assert.equal((await call(s.base, "/api/v1/ingest/ping", { secret: "wrong" + SECRET })).status, 401);
  assert.equal((await call(s.base, "/api/v1/ingest/ping", { secret: null })).status, 401);
  assert.equal((await call(s.base, "/api/v1/ingest", { method: "POST", secret: SECRET.slice(1), body: { instance: "a", records: [] } })).status, 401);
  assert.equal(s.queries.length, 0, "the database was never asked");
  s.close();
});

test("ping says the database answers and gives the default mining address; alerts gives the alert settings", async () => {
  const s = await start();
  const ping = await call(s.base, "/api/v1/ingest/ping");
  assert.equal(ping.status, 200);
  const body = await ping.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.miningAddress, "string");
  assert.deepEqual(await (await call(s.base, "/api/v1/ingest/alerts")).json(), { events: ["cluster"] });
  s.close();
});

test("a batch must be a POST with an instance and at most 2000 records", async () => {
  const s = await start();
  assert.equal((await call(s.base, "/api/v1/ingest")).status, 405);
  assert.equal((await call(s.base, "/api/v1/ingest", { method: "POST", body: "{nope" })).status, 400);
  assert.equal((await call(s.base, "/api/v1/ingest", { method: "POST", body: { records: [] } })).status, 400);
  assert.equal((await call(s.base, "/api/v1/ingest", { method: "POST", body: { instance: "a", records: "x" } })).status, 400);
  assert.equal((await call(s.base, "/api/v1/ingest", { method: "POST", body: { instance: "a", records: new Array(2001).fill({}) } })).status, 400);
  s.close();
});

test("a body over 4 MB is refused as too large", async () => {
  const s = await start();
  const big = JSON.stringify({ instance: "a", records: [], pad: "x".repeat(4 * 1024 * 1024 + 10) });
  const r = await call(s.base, "/api/v1/ingest", { method: "POST", body: big });
  assert.equal(r.status, 413);
  s.close();
});

test("invalid records are counted as rejected and never applied; sequence numbers far ahead are refused", async () => {
  const s = await start();
  const now = Date.now();
  const records = [
    null, { t: "share" },
    { t: "event", s: (now + 10 * 86_400_000) * 1000, at: new Date().toISOString(), type: "x", payload: {} },
    { t: "nope", s: 5, at: new Date().toISOString() },
  ];
  const r = await call(s.base, "/api/v1/ingest", { method: "POST", body: { instance: "standby", records } });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.applied, 0);
  assert.equal(result.rejected, 4);
  assert.equal(result.lastSeq, 0, "a rejected record never moves the sequence forward");
  s.close();
});
