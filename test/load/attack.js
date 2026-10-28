// Attacks for the capacity test (test/load/run.js, LOAD_ATTACK=...), run beside the honest rigs to see they are not affected.
// Runs inside Docker on the stack's network; each attacker container has its own IP address, so the per-IP limits apply as they
// would to a real attacker with several addresses. Prints one JSON line of counts every 10 seconds.
//
//   node attack.js idle    HOST PORT ADDRESS CONNECTIONS   log in, then never send a share; reconnect whenever closed (fills connection limits)
//   node attack.js invalid HOST PORT ADDRESS CONNECTIONS   send well-formed shares that are almost never valid, as fast as answered: each is a hash
//   node attack.js churn   HOST PORT ADDRESS CONNECTIONS   connect, log in as the same worker and disconnect, in CONNECTIONS loops at once
import net from "node:net";

const [mode, host, portText, address, connectionsText = "100"] = process.argv.slice(2);
const PORT = Number(portText);
const CONNECTIONS = Number(connectionsText);
if (!["idle", "invalid", "churn"].includes(mode)) throw new Error(`unknown mode ${mode}`);

const counts = { mode, open: 0, opened: 0, closedByServer: 0, connectFailed: 0, loggedIn: 0, loginRefused: 0, submitted: 0, answered: 0, accepted: 0, refused: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// invalid: every connection logs in first, then all send at once (or after 20 s, with those that got in): the most shares in flight
// before the first result can lead to a ban.
let fire = () => {};
const ready = new Promise((resolve) => { fire = resolve; });
setTimeout(() => fire(undefined), 20_000).unref();
const nonce = () => Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, "0") + Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");

/**
 * One connection: subscribe and log in; then what the mode does. Resolves when it closes.
 * @param {number} index @param {{ closeAfterLogin?: boolean }} [options]
 */
function connection(index, { closeAfterLogin = false } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, host);
    let buffer = "";
    let jobId = null;
    let open = false;
    let nextId = 10;
    const worker = mode === "churn" ? "churn" : `${mode}-${index}`;
    // A share difficulty so high that a share is (almost) never good enough: every one is checked, and fails.
    const password = mode === "invalid" ? "d=100000000000" : "";
    const send = (id, method, params) => { if (socket.writable) socket.write(`${JSON.stringify({ id, method, params })}\n`); };
    const submit = () => {
      if (!jobId || !socket.writable) return;
      counts.submitted += 1;
      send(nextId++, "mining.submit", [worker, jobId, nonce()]);
    };
    socket.setNoDelay(true);
    socket.on("connect", () => {
      open = true;
      counts.open += 1;
      counts.opened += 1;
      send(1, "mining.subscribe", [`attack/${mode}`, ["xel/v3"]]);
      send(2, "mining.authorize", [address, worker, password]);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.method === "mining.notify") {
          const first = jobId === null;
          jobId = m.params[0];
          if (first && mode === "invalid") void ready.then(submit);
        } else if (m.id === 2) {
          if (m.result === true) {
            counts.loggedIn += 1;
            if (counts.loggedIn >= CONNECTIONS) fire(undefined);
            if (closeAfterLogin) socket.destroy();
          } else {
            counts.loginRefused += 1;
            socket.destroy();
          }
        } else if (typeof m.id === "number" && m.id >= 10) {
          counts.answered += 1;
          if (m.result === true) counts.accepted += 1;
          else {
            const key = m.error ? `${m.error.code}:${String(m.error.message).slice(0, 40)}` : "refused";
            counts.refused[key] = (counts.refused[key] ?? 0) + 1;
          }
          // One in flight per connection, the next as soon as this one is answered.
          if (mode === "invalid") submit();
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!open) counts.connectFailed += 1;
      else {
        counts.open -= 1;
        if (!closeAfterLogin) counts.closedByServer += 1;
      }
      resolve(undefined);
    });
  });
}

/** Keep a connection going: open it again whenever it closes (after a short pause, as a real client retrying). @param {number} index */
async function keep(index) {
  for (;;) {
    await connection(index);
    await sleep(1_000 + Math.random() * 1_000);
  }
}

/** Connect, log in and close, again and again. */
async function churn() {
  for (;;) {
    await connection(0, { closeAfterLogin: true });
  }
}

setInterval(() => console.log(JSON.stringify({ ...counts, at: Date.now() })), 10_000).unref();
for (let i = 0; i < CONNECTIONS; i++) {
  void (mode === "churn" ? churn() : keep(i));
  // A burst, but not a single instant: 50 connections a second.
  if (mode !== "churn" && i % 5 === 4) await sleep(100);
}
await new Promise(() => {});
