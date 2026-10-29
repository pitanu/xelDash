// A database of its own for one test file, so the database tests never see each other's rows, whether they run in parallel or again
// on a server kept between runs. TEST_DATABASE_URL names the server to create them on (any database it can connect to, usually
// "postgres"); each file gets an empty database there, named xeldash_test_<time>_<random>, and drops it when it is done. One left
// behind by a run that was killed is dropped by a later run once it is an hour old.
import { randomBytes } from "node:crypto";
import pg from "pg";

const PREFIX = "xeldash_test_";
const STALE_MS = 60 * 60_000;

/** @param {string} url @param {(client: pg.Client) => Promise<void>} work */
async function onServer(url, work) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

/**
 * An empty database for this test file, or null without TEST_DATABASE_URL (the tests are then skipped).
 * @returns {Promise<{ url: string, drop: () => Promise<void> } | null>}
 */
export async function testDatabase() {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return null;
  const name = `${PREFIX}${Date.now()}_${randomBytes(4).toString("hex")}`;
  await onServer(server, async (client) => {
    const { rows } = await client.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${PREFIX}%`]);
    for (const { datname } of rows) {
      const made = Number(datname.slice(PREFIX.length).split("_")[0]);
      if (Date.now() - made > STALE_MS) await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await client.query(`CREATE DATABASE "${name}"`);
  });
  const url = new URL(server);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    // WITH (FORCE): a server under test may still hold a connection.
    drop: () => onServer(server, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).then(() => undefined)),
  };
}
