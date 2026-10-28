import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render } from "../dom/render.js";
import ProblemsCard from "../../src/components/ProblemsCard.jsx";

afterEach(cleanup);

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
/** @param {Partial<{ reason: string, address: string | null, ip: string | null, masked: boolean, count: number, lastSeen: string }>} p */
const problem = (p) => ({ kind: "login", reason: "bad_login", address: null, detail: null, ip: "192.168.1.9", masked: false, count: 1, lastSeen: minutesAgo(1), ...p });

test("nothing is shown while no miner has been turned away", async () => {
  fakeApi({ "/api/v1/problems": { problems: [] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.equal(view.container.innerHTML, "");
});

test("nothing is shown, and nothing breaks, while the API cannot be reached", async () => {
  fakeApi({ "/api/v1/problems": "offline" });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.equal(view.container.innerHTML, "");
});

test("a login without an address says what happened and what to do", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "no_address", count: 3 })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.match(view.text(), /Connection problems/);
  assert.match(view.text(), /A computer at 192\.168\.1\.9 logged in without a wallet address\./);
  assert.match(view.text(), /3 times, last/);
  assert.match(view.text(), /as address.worker/);
  assert.match(view.text(), /default payout address in step 2/);
});

test("a hidden IP address is never shown, and the wording does not pretend to know it", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "banned", ip: "172.18.0.1", masked: true })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.doesNotMatch(view.text(), /172\.18\.0\.1/);
  assert.match(view.text(), /A computer on your network \(or this one\) was blocked for a while/);
});

test("an address for the other kind of network is called out as such", async () => {
  const testAddress = "xet:" + "q".repeat(58);
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "invalid_address", address: testAddress })] } });
  const mainnet = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.match(mainnet.text(), /which looks like a test-network address/);
  assert.match(mainnet.text(), /needs an address starting with xel:/);
  assert.doesNotMatch(mainnet.text(), new RegExp(testAddress), "the address is shortened");
});

test("a mistyped address on the right network asks for it to be copied again", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "invalid_address", address: "xet:typo" })] } });
  const view = await render(h(ProblemsCard, { network: "testnet" }));
  assert.match(view.text(), /which was refused/);
  assert.match(view.text(), /Addresses on testnet start with xet:/);
});

test("a worker name alone in the user field is called out, with the address.worker form", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "invalid_address", address: "rig1" })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.match(view.text(), /logged in as “rig1”, which is not an address/);
  assert.match(view.text(), /xel:….rig1/);
});

test("the example fix repeats only a worker-like name, never other text a connecting computer sent", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "invalid_address", address: "send XEL to me" })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.match(view.text(), /xel:….rig1\./, "a neutral example instead");
  assert.doesNotMatch(view.text(), /xel:….send/);
});

test("problems that read the same are merged, with their counts added and the latest time kept", async () => {
  fakeApi({ "/api/v1/problems": { problems: [
    problem({ reason: "bad_login", count: 2, lastSeen: minutesAgo(30) }),
    problem({ reason: "bad_request", count: 5, lastSeen: minutesAgo(2) }),
    problem({ reason: "too many connections", ip: "192.168.1.10" }),
  ] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  const items = [...view.container.querySelectorAll("li")].map((li) => li.textContent);
  assert.equal(items.length, 2);
  assert.match(items[0], /sent something xelDash could not understand/);
  assert.match(items[0], /7 times, last 2 min/);
  assert.match(items[1], /192\.168\.1\.10 opened too many connections/);
  assert.doesNotMatch(items[1], /times,/, "a single time has no count");
});

test("a reason the dashboard does not know yet is still shown, with no advice", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ reason: "something_new" })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  const item = view.container.querySelector("li");
  assert.match(item?.textContent ?? "", /could not connect \(something_new\)/);
  assert.equal(item?.querySelector("p"), null);
});

test("a client reconnecting too fast is told what usually causes it", async () => {
  fakeApi({ "/api/v1/problems": { problems: [problem({ kind: "connection_refused", reason: "connecting too often" })] } });
  const view = await render(h(ProblemsCard, { network: "mainnet" }));
  assert.match(view.text(), /opened new connections faster than this server allows/);
  assert.match(view.text(), /wrong pool address, port or password/);
});
