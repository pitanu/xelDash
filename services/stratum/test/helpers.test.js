import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDefaultGateway } from "../src/gateway.js";
import { capShareDifficulty, reissueJob } from "../src/job-provider.js";
import { requestedDifficulty } from "../src/session.js";
import { tlsConfigFromEnv } from "../src/tls-config.js";
import { watchDefaultAddress } from "../src/default-address.js";

test("a fixed difficulty in the password: d=, diff=, among other options, never nonsense", () => {
  assert.equal(requestedDifficulty("d=50000"), 50000);
  assert.equal(requestedDifficulty("diff=1234"), 1234);
  assert.equal(requestedDifficulty("x,d=50000"), 50000);
  assert.equal(requestedDifficulty("x;D=7 y"), 7);
  for (const bad of ["", "x", "d=", "d=0", "d=-5", "d=abc", "d=1.5", "dd=5", "xd=5", "d=99999999999999999999"]) assert.equal(requestedDifficulty(bad), null, bad);
});

test("share difficulty never exceeds the network's, and a reissued job gets a new id", () => {
  assert.equal(capShareDifficulty(1000, "5000"), 1000);
  assert.equal(capShareDifficulty(9000, "5000"), 5000);
  assert.equal(capShareDifficulty(5000, "5000"), 5000);
  const job = { jobId: "a", networkDifficulty: "300", shareDifficulty: 100, template: "t" };
  const again = reissueJob(job, 1000);
  assert.notEqual(again.jobId, "a");
  assert.equal(again.shareDifficulty, 300);
  assert.equal(again.template, "t");
});

// share-submitter.js loads the native hashing addon, which exists only after it has been built (cargo); without it this is skipped.
const submitter = await import("../src/share-submitter.js").catch(() => null);

test("the block hash is the BLAKE3 of the 112-byte work, and other sizes are refused", { skip: submitter ? false : "the native hashing addon is not built" }, () => {
  const { blockHashFromMinerWork } = submitter;
  assert.match(blockHashFromMinerWork(Buffer.alloc(112)), /^[0-9a-f]{64}$/);
  assert.notEqual(blockHashFromMinerWork(Buffer.alloc(112)), blockHashFromMinerWork(Buffer.alloc(112, 1)));
  assert.throws(() => blockHashFromMinerWork(Buffer.alloc(111)), TypeError);
});

test("the default gateway is read from the kernel's routing table (little-endian hex)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "route-"));
  const file = join(dir, "route");
  await writeFile(file, "Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0116A8C0\t0003\neth0\t0016A8C0\t00000000\t0001\n");
  assert.equal(readDefaultGateway(file), "192.168.22.1");
  await writeFile(file, "Iface\tDestination\tGateway\tFlags\neth0\t0016A8C0\t00000000\t0001\n");
  assert.equal(readDefaultGateway(file), null, "no default route");
  assert.equal(readDefaultGateway(join(dir, "missing")), null);
  await rm(dir, { recursive: true, force: true });
});

test("TLS is off unless enabled, and a missing certificate is an error, not a silent fallback", async () => {
  assert.equal(tlsConfigFromEnv({}), null);
  assert.equal(tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "false" }), null);
  assert.throws(() => tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "true", STRATUM_TLS_CERT_FILE: "/no/such/cert.pem" }), /cannot be read/);
  assert.throws(() => tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "true", STRATUM_TLS_PORT: "99999" }), /STRATUM_TLS_PORT/);
  const dir = await mkdtemp(join(tmpdir(), "tls-"));
  await writeFile(join(dir, "c.pem"), "CERT");
  await writeFile(join(dir, "k.pem"), "KEY");
  const config = tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "TRUE", STRATUM_TLS_CERT_FILE: join(dir, "c.pem"), STRATUM_TLS_KEY_FILE: join(dir, "k.pem"), STRATUM_TLS_PORT: "4444" });
  assert.equal(config.port, 4444);
  assert.equal(config.cert.toString(), "CERT");
  await rm(dir, { recursive: true, force: true });
});

test("the default mining address follows the saved file, else the fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "addr-"));
  const file = join(dir, "mining-address.json");
  const warnings = [];
  const w = watchDefaultAddress({ file, fallback: "xet:fallback", intervalMs: 30, logger: { warn: (m) => warnings.push(m) } });
  await w.ready;
  assert.equal(w.get(), "xet:fallback", "no file yet");
  await writeFile(file, JSON.stringify({ address: "xet:saved" }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.get(), "xet:saved");
  await writeFile(file, "{not json");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.get(), "xet:fallback", "an unreadable file falls back");
  assert.equal(warnings.length, 1, "and warns once, not every time");
  await writeFile(file, JSON.stringify({ address: "" }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.get(), "xet:fallback");
  w.stop();
  await rm(dir, { recursive: true, force: true });
});
