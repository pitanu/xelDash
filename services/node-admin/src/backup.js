import { spawn } from "node:child_process";

// A backup of the statistics database, streamed to the browser as a PostgreSQL custom-format dump
// (the same file `xeldash backup` and the backup service write, restorable with `xeldash restore`).
// It holds miner addresses and IP addresses, so the route needs the admin token.

let running = false;

/**
 * Stream a pg_dump to an HTTP response. The connection settings come from the PG* environment
 * variables this service already has. Returns after the response has finished.
 * @param {import("node:http").ServerResponse} response
 * @param {{ onFinished?: (bytes: number) => void }} [options]
 */
export function streamBackup(response, { onFinished = () => {} } = {}) {
  if (running) {
    response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "A backup is already being made; try again in a moment." }));
    return Promise.resolve();
  }
  running = true;
  return new Promise((resolve) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const dump = spawn("pg_dump", ["--format=custom"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let sent = 0;
    let started = false;
    let errors = "";
    const finish = () => {
      running = false;
      resolve(undefined);
    };
    dump.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-2_000);
    });
    dump.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="xeldash-${stamp}.dump"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
      }
      sent += chunk.length;
      if (!response.write(chunk)) {
        dump.stdout.pause();
        response.once("drain", () => dump.stdout.resume());
      }
    });
    dump.on("error", (error) => {
      console.warn(`Backup could not start pg_dump: ${error.message}`);
      if (!started) response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "The backup tool is not available in this container." }));
      else response.destroy();
      finish();
    });
    dump.on("close", (code) => {
      if (code === 0 && started) {
        response.end();
        onFinished(sent);
      } else {
        console.warn(`Backup failed (pg_dump exit ${code}): ${errors.trim().slice(0, 300)}`);
        if (!started) response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "The backup failed. Check that the database is running." }));
        else response.destroy();
      }
      finish();
    });
    // A closed tab stops the dump instead of leaving it running.
    response.on("close", () => {
      if (dump.exitCode === null) dump.kill();
    });
  });
}
