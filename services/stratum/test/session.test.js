import test from "node:test";
import assert from "node:assert/strict";
import { DaemonRpcError } from "../src/daemon-client.js";
import { STRATUM_ERRORS } from "../src/protocol.js";
import { StratumSession } from "../src/session.js";

const ADDRESS = `xet:${"a".repeat(40)}`;
const PUBLIC_KEY = "ab".repeat(32);
const quiet = { warn() {} };

/** A session with a fake socket and fake collaborators; `lines()` is what the miner was sent. */
function harness(over = {}) {
  const written = [];
  const events = { submissions: [], problems: [], stale: [], authorized: 0, hashrates: [], jobRequests: [], shares: [] };
  const socket = { remoteAddress: "10.0.0.5", destroyed: false, write: (data) => { written.push(JSON.parse(data)); } };
  let jobCounter = 0;
  const state = { height: 100, networkDifficulty: "1000000", nodeId: 0, header: "11".repeat(32), canMine: null, shareResult: { accepted: true } };
  const makeJob = ({ shareDifficulty, extraNonce, publicKey }) => ({
    jobId: `job${++jobCounter}`, template: "t", timestampHex: "0000000000000064", headerWorkHash: state.header, algorithm: "xel/v3",
    networkDifficulty: state.networkDifficulty, height: state.height, topoheight: state.height, nodeId: state.nodeId, shareDifficulty,
    extraNonce: Buffer.from(extraNonce, "hex"), publicKey: Buffer.from(publicKey, "hex"), buildMinerWork: () => Buffer.alloc(112),
  });
  const session = new StratumSession({
    socket,
    authorizeAddress: async ({ address, workerName }) => ({ minerId: 1n, workerId: BigInt(workerName.length), address, publicKey: PUBLIC_KEY }),
    createJob: async (input) => { events.jobRequests.push(input); return makeJob(input); },
    submitShare: async (input) => { events.shares.push(input); return state.shareResult; },
    onHashrate: (h) => events.hashrates.push(h),
    onAuthorized: () => { events.authorized += 1; },
    onSubmission: (valid) => events.submissions.push(valid),
    onProblem: (p) => events.problems.push(p),
    onStale: (s) => events.stale.push(s),
    canMine: () => state.canMine,
    vardiff: { startDifficulty: 1000, minDifficulty: 100, targetShareSeconds: 10, retargetSeconds: 60, retargetShares: 20 },
    defaultAddress: "",
    staleGraceMs: 1500,
    logger: quiet,
    ...over,
  });
  const send = (message) => session.handleLine(typeof message === "string" ? message : JSON.stringify(message));
  const reply = (id) => written.findLast((m) => m.id === id);
  const methods = () => written.filter((m) => m.method).map((m) => m.method);
  return { session, send, written, events, state, reply, methods, makeJob };
}

const subscribe = (h, params = ["rig/1.0", ["xel/v3"]]) => h.send({ id: 1, method: "mining.subscribe", params });
const authorize = (h, params = [ADDRESS, "rig1", ""], id = 2) => h.send({ id, method: "mining.authorize", params });
async function login(h, params) { await subscribe(h); await authorize(h, params); }
const NONCE = "0123456789abcdef";

test("subscribe: gives the extranonce, and only xel/v3 is accepted", async () => {
  const h = harness();
  await subscribe(h);
  const [id, extranonce, size] = h.reply(1).result;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(extranonce, h.session.extranonce);
  assert.equal(size, 32);
  const old = harness();
  await subscribe(old, ["x", ["xel/v1"]]);
  assert.match(old.reply(1).error.message, /xel\/v3/);
  const bad = harness();
  await subscribe(bad, [5, "nope"]);
  assert.equal(bad.reply(1).error.code, -32602);
});

test("authorize needs a subscription first, and a node that can mine", async () => {
  const h = harness();
  await authorize(h);
  assert.equal(h.reply(2).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  const paused = harness();
  paused.state.canMine = "the node is syncing";
  await subscribe(paused);
  await authorize(paused);
  assert.equal(paused.reply(2).error.message, "the node is syncing");
  assert.deepEqual(paused.events.problems, [{ reason: "node_not_ready", detail: "the node is syncing" }]);
  assert.equal(paused.events.authorized, 0);
});

test("a login gets true, then the extranonce, difficulty and the first job", async () => {
  const h = harness();
  await login(h);
  assert.equal(h.reply(2).result, true);
  assert.deepEqual(h.methods(), ["mining.set_extranonce", "mining.set_difficulty", "mining.notify"]);
  const notify = h.written.find((m) => m.method === "mining.notify");
  assert.equal(notify.params[4], true, "the first job is clean");
  assert.equal(h.written.find((m) => m.method === "mining.set_difficulty").params[0], 1000, "the starting difficulty");
  assert.equal(h.events.authorized, 1);
  assert.equal(h.events.jobRequests[0].address, ADDRESS);
  h.session.close();
});

test("login styles: [address, worker, password], address.worker, options in the password slot, and the default address", async () => {
  const a = harness(); await login(a, [ADDRESS, "rig1", "x"]);
  assert.deepEqual([...a.session.authorizedWorkers.keys()], ["rig1"]);
  const b = harness(); await login(b, [`${ADDRESS}.farm1`, "x"]);
  assert.deepEqual([...b.session.authorizedWorkers.keys()], ["farm1"]);
  const c = harness(); await login(c, [`${ADDRESS}.farm1`]);
  assert.deepEqual([...c.session.authorizedWorkers.keys()], ["farm1"]);
  const d = harness(); await login(d, [ADDRESS, "d=5000"]);
  assert.deepEqual([...d.session.authorizedWorkers.keys()], ["default"]);
  assert.equal(d.session.vardiff.difficulty, 5000, "d= in the password fixes the difficulty");
  const e = harness({ defaultAddress: ADDRESS }); await login(e, []);
  assert.equal(e.reply(2).result, true, "a miner that sends no address mines to the default one");
  assert.equal(e.session.miningAddress, ADDRESS);
  const f = harness(); await login(f, []);
  assert.equal(f.reply(2).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  assert.deepEqual(f.events.problems, [{ reason: "no_address" }]);
  for (const s of [a, b, c, d, e]) s.session.close();
});

test("bad login parameters are refused and counted against the miner", async () => {
  for (const params of [[ADDRESS, ""], [ADDRESS, "w".repeat(129)], [ADDRESS, "bad\nname"], [ADDRESS, "bad\u001b[31m"], [ADDRESS, "w", 5], [42, "w"]]) {
    const h = harness();
    await login(h, params);
    assert.equal(h.reply(2).error.code, -32602, JSON.stringify(params));
    assert.deepEqual(h.events.submissions, [false]);
    assert.equal(h.events.problems[0].reason, "bad_login");
  }
});

test("one connection mines for one address, and has at most 32 workers", async () => {
  const h = harness();
  await login(h);
  await authorize(h, ["xet:" + "b".repeat(40), "rig2"], 3);
  assert.match(h.reply(3).error.message, /only one mining address/);
  assert.equal(h.events.problems.at(-1).reason, "second_address");
  for (let i = 0; i < 31; i++) await authorize(h, [ADDRESS, `w${i}`], 10 + i);
  assert.equal(h.session.authorizedWorkers.size, 32);
  await authorize(h, [ADDRESS, "one-too-many"], 99);
  assert.match(h.reply(99).error.message, /At most 32/);
  await authorize(h, [ADDRESS, "w0"], 100);
  assert.equal(h.reply(100).result, true, "logging in again as a known worker is harmless");
  assert.equal(h.events.jobRequests.length, 1, "only the first login fetches a template");
  h.session.close();
});

test("an address the node refuses is an invalid login; a node failure is not the miner's fault", async () => {
  const refused = harness({ authorizeAddress: async () => { throw new DaemonRpcError("bad address"); } });
  await login(refused);
  assert.equal(refused.reply(2).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  assert.deepEqual(refused.events.submissions, [false]);
  assert.equal(refused.events.problems[0].reason, "invalid_address");
  const broken = harness({ authorizeAddress: async () => { throw new Error("socket hang up"); } });
  await login(broken);
  assert.equal(broken.reply(2).error.message, "Request failed");
  assert.deepEqual(broken.events.submissions, [], "not counted toward a ban");
  const none = harness({ authorizeAddress: async () => null });
  await login(none);
  assert.equal(none.reply(2).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  const provisional = harness({ authorizeAddress: async ({ address }) => ({ minerId: null, workerId: null, provisional: true, address, publicKey: PUBLIC_KEY }) });
  await login(provisional);
  assert.equal(provisional.reply(2).result, true, "a worker not yet in the database may mine (it is recorded when the database is back)");
  provisional.session.close();
  const badKey = harness({ authorizeAddress: async ({ address }) => ({ minerId: 1n, workerId: 1n, address, publicKey: "zz" }) });
  await login(badKey);
  assert.equal(badKey.reply(2).error.message, "Request failed", "a malformed key from the validator is a server fault");
});

test("unparseable and unknown requests get an answer under their own id", async () => {
  const h = harness();
  await h.send("{not json");
  assert.equal(h.written[0].error.code, -32600);
  await h.send({ id: 7, method: 5 });
  assert.equal(h.reply(7).error.code, -32600);
  assert.deepEqual(h.events.problems.map((p) => p.reason), ["bad_request", "bad_request"]);
  assert.deepEqual(h.events.submissions, [false, false]);
  await h.send({ id: 8, method: "mining.nonsense" });
  assert.equal(h.reply(8).error.code, -32601);
  const before = h.written.length;
  await h.send({ method: "mining.nonsense" });
  await h.send({ method: "mining.pong" });
  assert.equal(h.written.length, before, "a notification gets no reply");
});

const submit = (h, params, id = 50) => h.send({ id, method: "mining.submit", params });

test("shares: accepted, low difficulty, duplicate, stale and unknown are told apart", async () => {
  const h = harness();
  await login(h);
  const job = [...h.session.jobs.values()][0];
  await submit(h, ["rig1", job.jobId, NONCE]);
  assert.equal(h.reply(50).result, true);
  assert.deepEqual(h.events.submissions, [true]);
  assert.equal(h.events.shares[0].nonce, NONCE);
  h.state.shareResult = { error: { code: STRATUM_ERRORS.LOW_DIFFICULTY, message: "Low difficulty share" } };
  await submit(h, ["rig1", job.jobId, "fedcba9876543210"], 51);
  assert.equal(h.reply(51).error.code, STRATUM_ERRORS.LOW_DIFFICULTY);
  h.state.shareResult = { error: { code: STRATUM_ERRORS.DUPLICATE_SHARE, message: "Duplicate share" } };
  await submit(h, ["rig1", job.jobId, "fedcba9876543211"], 52);
  assert.deepEqual(h.events.submissions, [true, false, false]);
  await submit(h, ["rig1", "no-such-job", NONCE], 53);
  assert.equal(h.reply(53).error.code, STRATUM_ERRORS.STALE_JOB);
  assert.equal(h.events.stale.length, 1, "a late share is recorded as stale");
  assert.deepEqual(h.events.submissions, [true, false, false], "and not held against the miner");
  h.session.close();
});

test("a submit is checked for shape and for the worker that sends it", async () => {
  const h = harness();
  await login(h);
  const job = [...h.session.jobs.values()][0];
  for (const params of [["rig1", job.jobId], ["rig1", job.jobId, "short"], ["rig1", job.jobId, "zzzzzzzzzzzzzzzz"], [5, job.jobId, NONCE], ["rig1", 5, NONCE]]) {
    await submit(h, params);
    assert.equal(h.reply(50).error.code, -32602, JSON.stringify(params));
  }
  await submit(h, ["someone-else", job.jobId, NONCE]);
  assert.equal(h.reply(50).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  assert.equal(h.events.shares.length, 0, "nothing reached the share checker");
  h.session.close();
});

test("classic miners submit under address.worker", async () => {
  const h = harness();
  await login(h, [`${ADDRESS}.farm1`, "x"]);
  const job = [...h.session.jobs.values()][0];
  await submit(h, [`${ADDRESS}.farm1`, job.jobId, NONCE]);
  assert.equal(h.reply(50).result, true);
  assert.equal(h.events.shares[0].workerName, "farm1");
  h.session.close();
});

test("a new block: the old job is still accepted for the grace period, then it is stale", async () => {
  const h = harness();
  await login(h);
  const oldJob = [...h.session.jobs.values()][0];
  h.state.height = 101;
  h.state.header = "22".repeat(32);
  await h.session.refreshJob();
  assert.equal(h.written.filter((m) => m.method === "mining.notify").at(-1).params[4], true, "a new height is a clean job");
  assert.equal(h.session.jobs.has(oldJob.jobId), false);
  await submit(h, ["rig1", oldJob.jobId, NONCE]);
  assert.equal(h.reply(50).result, true, "within the grace window");
  h.session.graceJobs.get(oldJob.jobId).until = Date.now() - 1;
  await submit(h, ["rig1", oldJob.jobId, "fedcba9876543210"], 51);
  assert.equal(h.reply(51).error.code, STRATUM_ERRORS.STALE_JOB, "after it");
  h.session.close();
});

test("new transactions at the same height do not restart the miner; an unchanged template sends nothing", async () => {
  const h = harness();
  await login(h);
  h.state.header = "33".repeat(32);
  await h.session.refreshJob();
  assert.equal(h.written.filter((m) => m.method === "mining.notify").at(-1).params[4], false);
  const count = h.written.length;
  await h.session.refreshJob();
  assert.equal(h.written.length, count, "nothing changed, nothing sent");
  await h.session.refreshJob(true);
  assert.equal(h.written.filter((m) => m.method === "mining.notify").at(-1).params[4], true, "forced after a node switch");
  h.session.close();
});

test("work is not refreshed while the node cannot mine", async () => {
  const h = harness();
  await login(h);
  h.state.canMine = "syncing";
  h.state.height = 200;
  const count = h.written.length;
  await h.session.refreshJob();
  assert.equal(h.written.length, count);
  h.session.close();
});

test("vardiff: a fast miner is moved to a higher difficulty after a window of shares, announced after the reply", async () => {
  const h = harness();
  await login(h);
  const job = [...h.session.jobs.values()][0];
  const start = Date.now();
  h.session.vardiff.windowStart = start - 20_000; // 20 shares in 20 s at difficulty 1000
  for (let i = 0; i < 20; i++) await submit(h, ["rig1", job.jobId, i.toString(16).padStart(16, "0")], 100 + i);
  assert.equal(h.session.vardiff.difficulty, 2000);
  const last = h.written.filter((m) => m.method === "mining.set_difficulty").at(-1);
  assert.equal(last.params[0], 2000);
  assert.ok(h.written.indexOf(last) > h.written.indexOf(h.reply(119)), "the new difficulty comes after the reply to the share");
  h.session.close();
});

test("hashrate reports: numbers and numeric strings, for every worker; nonsense is refused", async () => {
  const h = harness();
  await login(h);
  await h.send({ id: 60, method: "mining.hashrate", params: [1234] });
  await h.send({ id: 61, method: "mining.hashrate", params: ["5678.5"] });
  assert.deepEqual(h.events.hashrates.map((x) => x.hashrate), [1234, 5678.5]);
  for (const [i, bad] of [-1, "abc", null, Number.POSITIVE_INFINITY].entries()) {
    await h.send({ id: 70 + i, method: "mining.hashrate", params: [bad] });
    assert.equal(h.reply(70 + i).error.code, -32602, String(bad));
  }
  h.session.close();
});

/** 112 bytes of work as a getwork miner would send it back. */
function minerWork(job, over = {}) {
  const work = Buffer.alloc(112);
  Buffer.from(job.headerWorkHash, "hex").copy(work, 0);
  work.writeBigUInt64BE(over.timestamp ?? BigInt(`0x${job.timestampHex}`), 32);
  job.extraNonce.subarray(0, 30).copy(work, 48);
  (over.publicKey ?? job.publicKey).copy(work, 80);
  return work;
}

test("getwork: work must match a job this session was given; stale work is not held against the miner", async () => {
  const h = harness();
  await login(h);
  const job = [...h.session.jobs.values()][0];
  const ok = await h.session.submitWork("rig1", minerWork(job).toString("hex"));
  assert.equal(ok.accepted, true);
  assert.equal(h.events.shares.at(-1).minerWork.length, 112);
  const strangerKey = await h.session.submitWork("rig1", minerWork(job, { publicKey: Buffer.alloc(32, 9) }).toString("hex"));
  assert.equal(strangerKey.error.code, -32602, "another wallet's key");
  const early = await h.session.submitWork("rig1", minerWork(job, { timestamp: 1n }).toString("hex"));
  assert.equal(early.error.code, -32602, "a timestamp before the job was issued");
  const future = await h.session.submitWork("rig1", minerWork(job, { timestamp: BigInt(Date.now() + 3_600_000) }).toString("hex"));
  assert.equal(future.error.code, -32602, "a timestamp far in the future");
  const unknown = Buffer.alloc(112, 7).toString("hex");
  const stale = await h.session.submitWork("rig1", unknown);
  assert.equal(stale.stale, true);
  assert.equal(h.events.stale.length, 1);
  assert.equal((await h.session.submitWork("rig1", "xyz")).error.code, -32602);
  assert.equal((await h.session.submitWork("nobody", minerWork(job).toString("hex"))).error.code, STRATUM_ERRORS.UNAUTHORIZED);
  assert.deepEqual(h.events.submissions, [true, false, false, false, false, false]);
  h.session.close();
});
