import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("api_keys")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("key_hash", "text", (col) => col.notNull().unique())
    .addColumn("key_prefix", "text", (col) => col.notNull())
    .addColumn("scopes", "text", (col) => col.notNull().defaultTo("[]"))
    .addColumn("expires_at", "text")
    .addColumn("last_used_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`)
    )
    .addColumn("revoked_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_api_keys_key_hash")
    .on("api_keys")
    .column("key_hash")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("api_keys").execute();
}
