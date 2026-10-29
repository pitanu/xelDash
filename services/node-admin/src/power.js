import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Electricity, for cost and profit per rig: the price of a kilowatt-hour, in one of the currencies the XEL price comes in, and the
// power each worker draws. Entered on the dashboard, kept in power.json on the config volume, where the API reads it for the
// reports. Nothing here on a public server: its rigs are other people's.

/** The currencies the XEL price is offered in (services/api/src/price.js), but bitcoin: nobody pays for power in it. */
export const POWER_CURRENCIES = ["usd", "eur", "jpy", "gbp", "cny", "aud", "cad", "chf", "krw", "inr"];
const MAX_WATTS = 100_000;
const MAX_WORKERS = 1_000;

/** What was entered wrongly, in words a beginner can act on. */
export class PowerSettingsProblem extends Error {}

/** @param {string} address @param {string} worker */
const workerKey = (address, worker) => `${address}/${worker}`;

export class PowerSettings {
  /** @param {{ configDir: string, publicMode?: () => boolean }} options */
  constructor({ configDir, publicMode = () => false }) {
    this.configDir = configDir;
    this.file = join(configDir, "power.json");
    this.publicMode = publicMode;
  }

  /** @returns {Promise<{ currency: string | null, pricePerKwh: number | null, watts: Record<string, number> }>} */
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      return {
        currency: POWER_CURRENCIES.includes(saved.currency) ? saved.currency : null,
        pricePerKwh: Number.isFinite(saved.pricePerKwh) ? saved.pricePerKwh : null,
        watts: saved.watts && typeof saved.watts === "object" ? saved.watts : {},
      };
    } catch {
      return { currency: null, pricePerKwh: null, watts: {} };
    }
  }

  async status() {
    if (this.publicMode()) return { available: false, currency: null, pricePerKwh: null, watts: {}, currencies: POWER_CURRENCIES };
    return { available: true, ...(await this.read()), currencies: POWER_CURRENCIES };
  }

  /** The price: a currency and an amount per kWh, or both empty to remove it. @param {Record<string, unknown>} input */
  async setPrice(input) {
    this.#refuseOnPublic();
    const s = await this.read();
    if (input.pricePerKwh === null) {
      s.currency = null;
      s.pricePerKwh = null;
    } else {
      const price = input.pricePerKwh;
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 100) {
        throw new PowerSettingsProblem("The price per kWh is a number such as 0.25 (from 0 to 100).");
      }
      if (typeof input.currency !== "string" || !POWER_CURRENCIES.includes(input.currency)) {
        throw new PowerSettingsProblem(`Choose the currency: ${POWER_CURRENCIES.join(", ")}.`);
      }
      s.currency = input.currency;
      s.pricePerKwh = price;
    }
    await this.#write(s);
    return this.status();
  }

  /** One worker's power draw in watts, or null to remove it. @param {Record<string, unknown>} input */
  async setWorker(input) {
    this.#refuseOnPublic();
    const { address, worker, watts } = input;
    if (typeof address !== "string" || !/^xe[lt]:[a-z0-9]{10,120}$/.test(address) || typeof worker !== "string" || worker.length < 1 || worker.length > 128) {
      throw new PowerSettingsProblem("Unknown worker.");
    }
    const s = await this.read();
    const key = workerKey(address, worker);
    if (watts === null) {
      delete s.watts[key];
    } else {
      if (typeof watts !== "number" || !Number.isFinite(watts) || watts <= 0 || watts > MAX_WATTS) {
        throw new PowerSettingsProblem(`The power draw is in watts: a number from 1 to ${MAX_WATTS.toLocaleString("en")}, as a wall meter shows it.`);
      }
      if (!(key in s.watts) && Object.keys(s.watts).length >= MAX_WORKERS) throw new PowerSettingsProblem(`At most ${MAX_WORKERS} workers.`);
      s.watts[key] = Math.round(watts * 10) / 10;
    }
    await this.#write(s);
    return this.status();
  }

  #refuseOnPublic() {
    if (this.publicMode()) throw new PowerSettingsProblem("This is a public server: its rigs are other people's, so there is no electricity to set.");
  }

  /** @param {object} s */
  async #write(s) {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
  }
}
