import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add runtime_type column (firecracker or docker)
  await db.schema
    .alterTable("machines")
    .addColumn("runtime_type", "text", (col) => col.notNull().defaultTo("firecracker"))
    .execute();

  // Add container_id column for Docker containers
  await db.schema
    .alterTable("machines")
    .addColumn("container_id", "text")
    .execute();

  // Add image column for Docker containers
  await db.schema
    .alterTable("machines")
    .addColumn("image", "text")
    .execute();

  // Create index on runtime_type for filtering
  await db.schema
    .createIndex("idx_machines_runtime_type")
    .on("machines")
    .column("runtime_type")
    .execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support dropping columns easily
  // In production, you'd need to recreate the table
}
