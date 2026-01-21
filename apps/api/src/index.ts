import { createDatabase, runMigrations } from "@hyperfleet/worker/database";
import { createApp } from "./app";

const DB_PATH = process.env.DATABASE_PATH ?? "./hyperfleet.db";
const PORT = process.env.PORT ?? 3000;

async function main() {
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
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
