import { createServer } from "node:net";
import { createPool } from "../../../packages/db/src/index.js";
import { createWorkerAuthorizer } from "./authorize-worker.js";
import { DaemonClient } from "./daemon-client.js";
import { LineFramer } from "./line-framer.js";
import { StratumSession } from "./session.js";

const host = process.env.STRATUM_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.STRATUM_PORT ?? "3333", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("STRATUM_PORT must be an integer from 1 to 65535");
}

const pool = createPool();
const daemon = new DaemonClient();
const authorizeAddress = createWorkerAuthorizer({ daemon, pool });

const server = createServer((socket) => {
  const framer = new LineFramer();
  const session = new StratumSession({ socket, authorizeAddress });
  let queue = Promise.resolve();

  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    try {
      for (const line of framer.push(chunk)) {
        queue = queue.then(() => session.handleLine(line)).catch((error) => {
          console.warn("Closing Stratum connection after request failure:", error.message);
          socket.destroy();
        });
      }
    } catch (error) {
      console.warn("Closing malformed Stratum connection:", error.message);
      socket.destroy();
    }
  });
  socket.on("error", (error) => console.warn("Stratum socket error:", error.message));
});

server.listen(port, host, () => {
  console.info(`xelDash Stratum scaffold listening on ${host}:${port}`);
  console.warn("No active job provider is configured; submitted shares are rejected as stale.");
});

async function shutdown() {
  server.close();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
