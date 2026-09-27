// Smoothing and curve helpers for the hashrate chart.

/** Smoothing levels offered on the chart, with the kernel width as a share of the range. */
export const SMOOTHING = /** @type {const} */ ([
  ["raw", "Raw"],
  ["light", "Light"],
  ["strong", "Strong"],
]);
const SIGMA = { raw: 0, light: 1 / 64, strong: 1 / 20 };

/**
 * Gaussian-weighted moving average. Hashrate estimated from shares is noisy (shares arrive
 * at random), so a bucket on its own over- or under-shoots; averaging with its neighbours
 * shows the rate the rig actually ran at. At the edges only existing buckets count, so the
 * latest value is not dragged toward zero.
 * @param {number[]} values @param {"raw" | "light" | "strong"} level
 */
export function smooth(values, level) {
  const sigma = level === "raw" ? 0 : Math.max(level === "light" ? 1 : 2, values.length * SIGMA[level]);
  if (sigma === 0 || values.length < 3) return values;
  const reach = Math.ceil(sigma * 3);
  const weights = Array.from({ length: reach + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  return values.map((_, i) => {
    let sum = 0;
    let total = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      const w = weights[Math.abs(k)];
      sum += values[j] * w;
      total += w;
    }
    return sum / total;
  });
}

/**
 * SVG path through the points with a monotone cubic curve (Fritsch-Carlson): smooth, but it
 * never overshoots, so a curve through zeros stays at zero and peaks are not exaggerated.
 * @param {number[]} xs @param {number[]} ys
 */
export function monotonePath(xs, ys) {
  const n = xs.length;
  if (n === 0) return "";
  if (n < 3) return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join("");
  const dx = xs.slice(1).map((x, i) => x - xs[i]);
  const slope = ys.slice(1).map((y, i) => (y - ys[i]) / (dx[i] || 1));
  const tangent = xs.map((_, i) => {
    if (i === 0) return slope[0];
    if (i === n - 1) return slope[n - 2];
    const a = slope[i - 1];
    const b = slope[i];
    return a * b <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b);
  });
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(xs[i] + h).toFixed(1)},${(ys[i] + tangent[i] * h).toFixed(1)} ${(xs[i + 1] - h).toFixed(1)},${(ys[i + 1] - tangent[i + 1] * h).toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  return d;
}
