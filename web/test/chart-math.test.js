import test from "node:test";
import assert from "node:assert/strict";
import { SMOOTHING, monotonePath, pow10, smooth } from "../src/components/chart-math.js";

/** Every number in an SVG path, as [x, y] pairs in order. @param {string} d */
const pairs = (d) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

/** The cubic segments of a path: start, two control points, end. @param {string} d */
function segments(d) {
  const points = pairs(d);
  const out = [];
  for (let i = 0; i + 3 < points.length; i += 3) out.push(points.slice(i, i + 4));
  return out;
}

const noisy = [5, 9, 3, 8, 4, 10, 2, 7, 6, 9, 3, 8, 5, 7, 4, 9, 6, 8, 2, 10];

test("every smoothing level the chart offers is one smooth() knows", () => {
  for (const [level] of SMOOTHING) assert.equal(smooth(noisy, level).length, noisy.length, level);
});

test("raw, and series too short to smooth, come back unchanged", () => {
  assert.equal(smooth(noisy, "raw"), noisy);
  assert.deepEqual(smooth([4, 8], "strong"), [4, 8]);
  assert.deepEqual(smooth([], "light"), []);
});

test("a steady rate stays exactly steady, up to both edges", () => {
  // Only existing buckets count at the edges, so the latest value is not pulled toward zero.
  for (const level of /** @type {const} */ (["light", "strong"])) {
    for (const v of smooth(Array(40).fill(1000), level)) assert.ok(Math.abs(v - 1000) < 1e-9, level);
  }
});

test("smoothing stays within the data and calms the noise, strong more than light", () => {
  const spread = (/** @type {number[]} */ xs) => Math.max(...xs) - Math.min(...xs);
  const light = smooth(noisy, "light");
  const strong = smooth(noisy, "strong");
  for (const v of [...light, ...strong]) assert.ok(v >= Math.min(...noisy) && v <= Math.max(...noisy));
  assert.ok(spread(light) < spread(noisy));
  assert.ok(spread(strong) < spread(light));
});

test("a single spike is spread out evenly on both sides", () => {
  const values = Array(21).fill(0);
  values[10] = 100;
  const out = smooth(values, "light");
  assert.ok(out[10] < 100 && out[10] > out[9]);
  for (let k = 1; k <= 10; k++) assert.ok(Math.abs(out[10 - k] - out[10 + k]) < 1e-9, `offset ${k}`);
});

test("paths with fewer than three points are straight lines", () => {
  assert.equal(monotonePath([], []), "");
  assert.equal(monotonePath([0], [5]), "M0.0,5.0");
  assert.equal(monotonePath([0, 10], [5, 7.25]), "M0.0,5.0L10.0,7.3");
});

test("the curve passes through every point", () => {
  const xs = [0, 10, 20, 30, 40];
  const ys = [50, 20, 35, 10, 40];
  const segs = segments(monotonePath(xs, ys));
  assert.equal(segs.length, xs.length - 1);
  segs.forEach(([start, , , end], i) => {
    assert.deepEqual(start, [xs[i], ys[i]]);
    assert.deepEqual(end, [xs[i + 1], ys[i + 1]]);
  });
});

test("the curve never overshoots: control points stay between their segment's ends", () => {
  // Rising, falling, a peak, a plateau and a cliff: where cubic splines usually bulge.
  const ys = [0, 0, 0, 80, 100, 100, 100, 5, 60, 0, 0];
  const xs = ys.map((_, i) => i * 12);
  for (const [[, y0], [, c1], [, c2], [, y1]] of segments(monotonePath(xs, ys))) {
    const lo = Math.min(y0, y1) - 0.05;
    const hi = Math.max(y0, y1) + 0.05;
    assert.ok(c1 >= lo && c1 <= hi && c2 >= lo && c2 <= hi, `${y0} → ${y1} via ${c1}, ${c2}`);
  }
});

test("a run of zeros stays flat at zero, and a peak is not exaggerated", () => {
  const d = monotonePath([0, 10, 20, 30, 40], [0, 0, 0, 90, 0]);
  const segs = segments(d);
  for (const [, [, c1], [, c2]] of segs.slice(0, 2)) assert.deepEqual([c1, c2], [0, 0]);
  // The peak's tangent is flat, so the curve tops out at the data.
  assert.equal(segs[2][2][1], 90);
  assert.equal(segs[3][1][1], 90);
  assert.ok(Math.max(...pairs(d).map(([, y]) => y)) <= 90);
});

test("repeated x positions do not break the path", () => {
  const d = monotonePath([0, 0, 10, 20], [5, 6, 8, 9]);
  assert.doesNotMatch(d, /NaN|Infinity/);
});

test("powers of ten are exact for negative exponents too, on every engine", () => {
  // Literals are the nearest doubles; 10 ** -5 is not on Node 22.
  assert.deepEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3].map(pow10), [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1000]);
  assert.equal(String(pow10(-5)), "0.00001", "no float noise in a label");
});
