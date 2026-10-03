// Runs the end-to-end tests (npm run e2e). They start the real stack in Docker on a private devnet, mine real blocks through it and check
// what the dashboard's API says; they take several minutes and need Docker, so they are not part of `npm test`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const result = spawnSync(process.execPath, ["--test", "--test-timeout=1800000", `${here}stack.e2e.js`], {
  stdio: "inherit",
  env: { ...process.env, XELDASH_E2E: "1" },
});
process.exit(result.status ?? 1);
