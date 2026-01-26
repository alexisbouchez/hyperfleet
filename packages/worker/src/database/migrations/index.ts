import { Migrator, type Kysely, type Migration, type MigrationProvider } from "kysely";
import * as migration001 from "./001_create_machines";
import * as migration002 from "./002_add_rootfs_and_network";
import * as migration003 from "./003_add_runtime_type";
import * as migration004 from "./004_create_api_keys";
import * as migration005 from "./005_add_image_fields";

/**
 * Custom migration provider that bundles migrations inline
 * This avoids filesystem dependencies and works well with bundlers
 */
class InlineMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_create_machines": migration001,
      "002_add_rootfs_and_network": migration002,
      "003_add_runtime_type": migration003,
      "004_create_api_keys": migration004,
      "005_add_image_fields": migration005,
    };
  }
}

/**
 * Run all pending migrations
 */
export async function runMigrations<DB>(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new InlineMigrationProvider(),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((result) => {
    if (result.status === "Success") {
      console.log(`Migration "${result.migrationName}" completed successfully`);
    } else if (result.status === "Error") {
      console.error(`Migration "${result.migrationName}" failed`);
    }
  });

  if (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

/**
 * Rollback the last migration
 */
export async function rollbackMigration<DB>(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new InlineMigrationProvider(),
  });

  const { error, results } = await migrator.migrateDown();

  results?.forEach((result) => {
    if (result.status === "Success") {
      console.log(`Rollback "${result.migrationName}" completed successfully`);
    } else if (result.status === "Error") {
      console.error(`Rollback "${result.migrationName}" failed`);
    }
  });

  if (error) {
    console.error("Rollback failed:", error);
    throw error;
  }
}
