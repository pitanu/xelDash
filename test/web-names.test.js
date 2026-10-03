// A name used in the dashboard that is not defined anywhere is a ReferenceError that blanks the page when that code runs, and the
// build does not notice. TypeScript's "cannot find name" check finds them without any extra packages (the many other type errors
// that appear without React's type packages are ignored here).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const skip = existsSync(tsc) ? false : "typescript is not installed";

test("the dashboard uses no name that is not defined", { skip }, () => {
  const result = spawnSync(process.execPath, [tsc, "-p", "web/tsconfig.json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const undefinedNames = `${result.stdout}${result.stderr}`.split("\n").filter((line) => /error TS(2304|2552):/.test(line));
  assert.deepEqual(undefinedNames, []);
});
