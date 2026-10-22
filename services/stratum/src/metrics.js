import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

// Prometheus metrics for Stratum (docs/OPERATIONS.md#metrics). Off by default: then nothing listens and every recorder below is a
// no-op, so a server that does not use them pays nothing.
//
// Totals only: no miner address, worker name or IP address is ever a label, in any mode, so the numbers say how the server is doing
// without saying who mines on it. Per-worker counters exist as their own opt-in (XELDASH_METRICS_PER_WORKER) for a home server, and
// are left out of every answer while public mode is on.

/** @typedef {Record<string, string>} Labels */
/** @typedef {{ labels?: Labels, value: number }} Sample */
/** @typedef {{ name: string, help: string, type: "counter" | "gauge", samples: Sample[] }} Family */

/** Per-worker series kept at most, so a stream of made-up worker names cannot grow them without end. */
const MAX_WORKER_SERIES = 2_000;

/** @param {string} value */
const escapeLabel = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** @param {Labels | undefined} labels */
function labelText(labels) {
  if (!labels) return "";
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(String(value))}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

/** @param {number} value */
const number = (value) => (Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN");

const NOOP_COUNTER = { inc() {} };
const NOOP_HISTOGRAM = { observe() {} };

/** What the share path and the store record into, whether metrics are on or not. */
export const noMetrics = {
  enabled: false,
  /** @param {string} _name @param {string} _help @param {{ perWorker?: boolean, maxSeries?: number }} [_options] */
  counter: (_name, _help, _options) => NOOP_COUNTER,
  /** @param {string} _name @param {string} _help @param {number[]} _buckets */
  histogram: (_name, _help, _buckets) => NOOP_HISTOGRAM,
  /** @param {() => Family[]} _collect */
  collect: (_collect) => {},
};

export class Metrics {
  enabled = true;

  constructor() {
    /** @type {{ name: string, help: string, perWorker: boolean, maxSeries: number, series: Map<string, { labels?: Labels, value: number }> }[]} */
    this.counters = [];
    /** @type {{ name: string, help: string, buckets: number[], counts: number[], sum: number, count: number }[]} */
    this.histograms = [];
    /** @type {(() => Family[])[]} */
    this.collectors = [];
  }

  /**
   * A counter, optionally by labels. `perWorker` marks a family that names miners: it is left out of answers in public mode.
   * @param {string} name @param {string} help @param {{ perWorker?: boolean, maxSeries?: number }} [options]
   */
  counter(name, help, { perWorker = false, maxSeries = perWorker ? MAX_WORKER_SERIES : 1_000 } = {}) {
    const family = { name, help, perWorker, maxSeries, series: new Map() };
    this.counters.push(family);
    return {
      /** @param {Labels} [labels] @param {number} [by] */
      inc(labels, by = 1) {
        const key = labels ? JSON.stringify(labels) : "";
        const series = family.series.get(key);
        if (series) series.value += by;
        else if (family.series.size < family.maxSeries) family.series.set(key, { labels, value: by });
      },
    };
  }

  /** @param {string} name @param {string} help @param {number[]} buckets upper bounds, in seconds */
  histogram(name, help, buckets) {
    const family = { name, help, buckets: [...buckets].sort((a, b) => a - b), counts: buckets.map(() => 0), sum: 0, count: 0 };
    this.histograms.push(family);
    return {
      /** @param {number} value */
      observe(value) {
        family.sum += value;
        family.count += 1;
        for (let i = 0; i < family.buckets.length; i++) if (value <= family.buckets[i]) family.counts[i] += 1;
      },
    };
  }

  /** Values read when the metrics are asked for (connections, node state...), so the hot paths do not keep them. @param {() => Family[]} collect */
  collect(collect) {
    this.collectors.push(collect);
  }

  /** The Prometheus text format. @param {{ perWorker?: boolean }} [options] */
  render({ perWorker = false } = {}) {
    /** @type {string[]} */
    const lines = [];
    /** @param {string} name @param {string} help @param {string} type */
    const head = (name, help, type) => lines.push(`# HELP ${name} ${help.replace(/\n/g, " ")}`, `# TYPE ${name} ${type}`);
    for (const family of this.counters) {
      if (family.perWorker && !perWorker) continue;
      head(family.name, family.help, "counter");
      if (family.series.size === 0 && !family.perWorker) lines.push(`${family.name} 0`);
      for (const { labels, value } of family.series.values()) lines.push(`${family.name}${labelText(labels)} ${number(value)}`);
    }
    for (const family of this.histograms) {
      head(family.name, family.help, "histogram");
      family.buckets.forEach((bound, i) => lines.push(`${family.name}_bucket{le="${bound}"} ${family.counts[i]}`));
      lines.push(`${family.name}_bucket{le="+Inf"} ${family.count}`, `${family.name}_sum ${number(family.sum)}`, `${family.name}_count ${family.count}`);
    }
    for (const collect of this.collectors) {
      for (const family of collect()) {
        head(family.name, family.help, family.type);
        for (const { labels, value } of family.samples) lines.push(`${family.name}${labelText(labels)} ${number(value)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The process's own figures: processor time, memory and how late the event loop runs (busy main thread). @param {Metrics} metrics */
export function collectProcessMetrics(metrics) {
  // Node measures with a timer every RESOLUTION_MS and reports the whole wait, timer included: the delay is what is left over.
  const RESOLUTION_MS = 10;
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  const late = (/** @type {number} */ nanoseconds) => Math.max(0, nanoseconds / 1e9 - RESOLUTION_MS / 1000);
  delay.enable();
  metrics.collect(() => {
    const cpu = process.cpuUsage();
    const families = /** @type {Family[]} */ ([
      { name: "process_cpu_seconds_total", help: "Processor time used by Stratum, user and system.", type: "counter",
        samples: [{ value: (cpu.user + cpu.system) / 1e6 }] },
      { name: "process_resident_memory_bytes", help: "Memory held by Stratum.", type: "gauge", samples: [{ value: process.memoryUsage.rss() }] },
      { name: "xeldash_event_loop_delay_seconds", help: "How late Stratum's main thread ran its work since the last scrape: p50, p99 and max.",
        type: "gauge", samples: [
          { labels: { quantile: "0.5" }, value: late(delay.percentile(50)) },
          { labels: { quantile: "0.99" }, value: late(delay.percentile(99)) },
          { labels: { quantile: "1" }, value: late(delay.max) },
        ] },
    ]);
    delay.reset();
    return families;
  });
}

/** Whether an address stays on this computer. @param {string} ip */
export function isLoopback(ip) {
  const value = ip.trim().toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || /^127(\.\d{1,3}){3}$/.test(value);
}

/**
 * @typedef {{ enabled: boolean, port: number, bindIp: string, exposed: boolean, token: string, perWorker: boolean }} MetricsConfig
 * @param {Partial<Record<string, string | undefined>>} env
 * @returns {MetricsConfig}
 */
export function metricsConfigFromEnv(env) {
  const on = (/** @type {string | undefined} */ v) => /^(on|true|1|yes)$/i.test((v ?? "").trim());
  // The `metrics` Compose profile publishes the port; it also turns the listener on, so one setting does both.
  const profiles = (env.COMPOSE_PROFILES ?? "").split(",").map((p) => p.trim());
  const enabled = on(env.XELDASH_METRICS) || profiles.includes("metrics");
  const port = Number(env.STRATUM_METRICS_PORT ?? 9464);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("STRATUM_METRICS_PORT must be an integer from 1 to 65535");
  const token = (env.XELDASH_METRICS_TOKEN ?? "").trim();
  if (token && token.length < 16) throw new Error("XELDASH_METRICS_TOKEN must be at least 16 characters");
  const bindIp = (env.XELDASH_METRICS_BIND_IP ?? "").trim() || "127.0.0.1";
  return { enabled, port, bindIp, exposed: !isLoopback(bindIp), token, perWorker: on(env.XELDASH_METRICS_PER_WORKER) };
}

/** @param {string} header @param {string} token */
function tokenMatches(header, token) {
  const sent = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const wanted = Buffer.from(token);
  return sent.length === wanted.length && timingSafeEqual(sent, wanted);
}

/**
 * Serves GET /metrics. On a public server whose metrics port reaches beyond this computer, it answers only with a token: without
 * XELDASH_METRICS_TOKEN it refuses (503) and says why in the log. Public mode can switch on while Stratum runs (a standby follows its
 * main server), so this is decided on every request.
 * @param {{ metrics: Metrics, config: MetricsConfig, isPublic: () => boolean, host?: string, logger?: Pick<Console, "info" | "warn"> }} options
 */
export function startMetricsServer({ metrics, config, isPublic, host = "0.0.0.0", logger = console }) {
  let warnedAt = 0;
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (request.method !== "GET" || path !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    const pub = isPublic();
    if (pub && config.exposed && !config.token) {
      if (Date.now() - warnedAt > 3_600_000) {
        warnedAt = Date.now();
        logger.warn?.(`Metrics refused: public mode is on and the metrics port is published on ${config.bindIp}, beyond this computer. `
          + "Set XELDASH_METRICS_TOKEN, or publish it on 127.0.0.1 (XELDASH_METRICS_BIND_IP). See docs/OPERATIONS.md#metrics.");
      }
      response.writeHead(503, { "content-type": "text/plain" }).end("metrics refused: public mode needs XELDASH_METRICS_TOKEN on this port\n");
      return;
    }
    if (config.token && !tokenMatches(String(request.headers.authorization ?? ""), config.token)) {
      response.writeHead(401, { "www-authenticate": "Bearer", "content-type": "text/plain" }).end("unauthorized\n");
      return;
    }
    const body = metrics.render({ perWorker: config.perWorker && !pub });
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    response.end(body);
  });
  /** The port it listens on, once it does (port 0 picks a free one). @type {Promise<number>} */
  const listening = new Promise((resolve, reject) => {
    server.once("listening", () => resolve(/** @type {import("node:net").AddressInfo} */ (server.address()).port));
    server.once("error", reject);
  });
  listening.catch(() => {});
  server.listen(config.port, host, () => logger.info?.(`xelDash metrics listening on ${host}:${config.port}${config.token ? " (token required)" : ""}`));
  return { listening, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
