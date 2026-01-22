import { createDatabase, runMigrations } from "@hyperfleet/worker/database";
import { createApp } from "./app";
import { parseProxyPort, startReverseProxy } from "./proxy";

const DB_PATH = process.env.DATABASE_PATH ?? "./hyperfleet.db";
const PORT = process.env.PORT ?? 3000;
const PROXY_PORT = parseProxyPort(process.env.PROXY_PORT);
const PROXY_PREFIX = process.env.PROXY_PREFIX ?? "/proxy";
const PROXY_HOST_SUFFIX = process.env.PROXY_HOST_SUFFIX;
const PROXY_EXPOSED_PORT_POLL_INTERVAL_MS = process.env.PROXY_EXPOSED_PORT_POLL_INTERVAL_MS;

async function main() {
  if (PROXY_PORT.isErr()) {
    console.error("Invalid proxy configuration:", PROXY_PORT.error.message);
    process.exit(1);
  }

  let exposedPortPollIntervalMs: number | undefined;
  if (PROXY_EXPOSED_PORT_POLL_INTERVAL_MS) {
    const parsed = Number(PROXY_EXPOSED_PORT_POLL_INTERVAL_MS);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error("Invalid proxy configuration: PROXY_EXPOSED_PORT_POLL_INTERVAL_MS must be >= 0");
      process.exit(1);
    }
    exposedPortPollIntervalMs = parsed;
  }

  // Initialize database
  console.log(`Initializing database at ${DB_PATH}...`);
  const db = createDatabase({ filename: DB_PATH });

  // Run migrations
  console.log("Running migrations...");
  await runMigrations(db);

  // Create and start the app
  const app = createApp({ db });

  app.listen(PORT, () => {
    console.log(`Hyperfleet API running at http://localhost:${PORT}`);
  });

  const proxyServer = startReverseProxy({
    db,
    port: PROXY_PORT.unwrap(),
    prefix: PROXY_PREFIX,
    hostSuffix: PROXY_HOST_SUFFIX,
    exposedPortPollIntervalMs,
  });
  console.log(`Hyperfleet proxy running at http://localhost:${proxyServer.port}${PROXY_PREFIX}`);
  if (PROXY_HOST_SUFFIX) {
    console.log(`Hyperfleet proxy host routing enabled for *.${PROXY_HOST_SUFFIX}`);
  }
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
