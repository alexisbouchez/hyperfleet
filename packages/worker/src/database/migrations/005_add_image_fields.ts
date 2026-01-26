import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("machines")
    .addColumn("image_ref", "text")
    .execute();

  await db.schema
    .alterTable("machines")
    .addColumn("image_digest", "text")
    .execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support dropping columns easily
  // In production, you'd need to recreate the table
}
