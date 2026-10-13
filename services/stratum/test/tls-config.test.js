import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTlsPair, tlsConfigFromEnv, watchTlsCertificate } from "../src/tls-config.js";

const dir = mkdtempSync(join(tmpdir(), "xeldash-tls-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A self-signed certificate and key, named `name`; false when openssl is not installed. @param {string} name */
function makeCertificate(name) {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "90",
      "-subj", `/CN=${name}`, "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const skip = makeCertificate("a") && makeCertificate("b") ? false : "openssl is not installed";
const quiet = { warn: () => {}, info: () => {} };

test("settings: off unless enabled; empty file settings mean the defaults", () => {
  assert.equal(tlsConfigFromEnv({}), null);
  assert.deepEqual(tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "true", STRATUM_TLS_CERT_FILE: "" }), { port: 3334, certFile: "/tls/cert.pem", keyFile: "/tls/key.pem" });
  assert.throws(() => tlsConfigFromEnv({ STRATUM_TLS_ENABLED: "true", STRATUM_TLS_PORT: "70000" }), /STRATUM_TLS_PORT/);
});

test("a certificate and a key that do not belong together are refused", { skip }, () => {
  assert.ok(loadTlsPair({ certFile: join(dir, "a.crt"), keyFile: join(dir, "a.key") }).validTo > new Date());
  assert.throws(() => loadTlsPair({ certFile: join(dir, "a.crt"), keyFile: join(dir, "b.key") }), /usable pair/);
});

test("waits for a certificate that is not there yet, then takes it, and takes a renewed one", { skip }, async () => {
  const config = { port: 3334, certFile: join(dir, "live.crt"), keyFile: join(dir, "live.key") };
  /** @type {{ subject: string, first: boolean }[]} */
  const loads = [];
  const warnings = [];
  const watch = watchTlsCertificate({
    config, intervalMs: 20, waitIntervalMs: 20, logger: { ...quiet, warn: (m) => warnings.push(m) },
    onLoad: (pair, first) => loads.push({ subject: pair.cert.toString().slice(0, 64), first }),
  });
  try {
    assert.equal(loads.length, 0, "nothing to load yet, and no error");
    assert.match(warnings[0], /waits for its certificate/);
    copyFileSync(join(dir, "a.crt"), config.certFile);
    copyFileSync(join(dir, "a.key"), config.keyFile);
    await waitFor(() => loads.length === 1);
    assert.equal(loads[0].first, true);
    // A renewal: new files (and a later modification time, as a copy may keep the size).
    copyFileSync(join(dir, "b.crt"), config.certFile);
    copyFileSync(join(dir, "b.key"), config.keyFile);
    const later = new Date(Date.now() + 5_000);
    utimesSync(config.certFile, later, later);
    await waitFor(() => loads.length === 2);
    assert.equal(loads[1].first, false);
    assert.notEqual(loads[1].subject, loads[0].subject);
    // Half a renewal (a new certificate, the old key) is not used.
    copyFileSync(join(dir, "a.crt"), config.certFile);
    const later2 = new Date(Date.now() + 10_000);
    utimesSync(config.certFile, later2, later2);
    await waitFor(() => warnings.some((w) => /keeping the certificate in use/.test(w)));
    assert.equal(loads.length, 2);
  } finally {
    watch.stop();
  }
});

test("a certificate that is there but unusable at start is an error, as before", { skip }, () => {
  assert.throws(() => watchTlsCertificate({ config: { port: 3334, certFile: join(dir, "a.crt"), keyFile: join(dir, "b.key") }, onLoad: () => {}, logger: quiet }), /usable pair/);
});

/** @param {() => boolean} condition */
async function waitFor(condition, ms = 3_000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
