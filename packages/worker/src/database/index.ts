// Database client
export { createDatabase, createInMemoryDatabase } from "./client";
export type { DatabaseConfig } from "./client";
export type { Kysely } from "kysely";

// Schema types
export type {
  Database,
  MachinesTable,
  Machine,
  NewMachine,
  MachineUpdate,
  MachineStatus,
  RuntimeType,
  ApiKeysTable,
  ApiKey,
  NewApiKey,
} from "./schema";

// Migrations
export { runMigrations, rollbackMigration } from "./migrations";
