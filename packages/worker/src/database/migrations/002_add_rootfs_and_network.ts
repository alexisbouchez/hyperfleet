import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("machines")
    .addColumn("rootfs_path", "text")
    .execute();

  await db.schema
    .alterTable("machines")
    .addColumn("tap_device", "text")
    .execute();

  await db.schema
    .alterTable("machines")
    .addColumn("tap_ip", "text")
    .execute();

  await db.schema
    .alterTable("machines")
    .addColumn("guest_ip", "text")
    .execute();

  await db.schema
    .alterTable("machines")
    .addColumn("guest_mac", "text")
    .execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support dropping columns easily
  // In production, you'd need to recreate the table
}
