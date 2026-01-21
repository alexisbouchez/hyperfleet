import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("machines")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("vcpu_count", "integer", (col) => col.notNull())
    .addColumn("mem_size_mib", "integer", (col) => col.notNull())
    .addColumn("kernel_image_path", "text", (col) => col.notNull())
    .addColumn("kernel_args", "text")
    .addColumn("socket_path", "text", (col) => col.notNull())
    .addColumn("pid", "integer")
    .addColumn("config_json", "text", (col) => col.notNull())
    .addColumn("error_message", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`)
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`)
    )
    .execute();

  // Create index on status for filtering
  await db.schema
    .createIndex("idx_machines_status")
    .on("machines")
    .column("status")
    .execute();

  // Create index on name for lookups
  await db.schema
    .createIndex("idx_machines_name")
    .on("machines")
    .column("name")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("machines").execute();
}
