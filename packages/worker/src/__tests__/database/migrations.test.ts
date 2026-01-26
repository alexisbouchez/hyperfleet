import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sql, type Kysely } from "kysely";
import { createInMemoryDatabase } from "../../database/client";
import { runMigrations, rollbackMigration } from "../../database/migrations";
import type { Database } from "../../database/schema";

describe("Migrations", () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("runMigrations", () => {
    it("creates machines table", async () => {
      await runMigrations(db);

      // Check if machines table exists by attempting a query
      const result = await db.selectFrom("machines").selectAll().execute();
      expect(Array.isArray(result)).toBe(true);
    });

    it("creates api_keys table", async () => {
      await runMigrations(db);

      const result = await db.selectFrom("api_keys").selectAll().execute();
      expect(Array.isArray(result)).toBe(true);
    });

    it("creates machines table with correct columns", async () => {
      await runMigrations(db);

      // Insert a machine with all expected columns to verify schema
      await db
        .insertInto("machines")
        .values({
          id: "schema-test",
          name: "Schema Test",
          status: "pending",
          runtime_type: "firecracker",
          vcpu_count: 2,
          mem_size_mib: 512,
          kernel_image_path: "/path/to/kernel",
          kernel_args: "console=ttyS0",
          rootfs_path: "/path/to/rootfs",
          socket_path: "/tmp/test.sock",
          tap_device: "tap0",
          tap_ip: "172.16.0.1",
          guest_ip: "172.16.0.2",
          guest_mac: "AA:BB:CC:DD:EE:FF",
          pid: 12345,
          config_json: JSON.stringify({ test: true }),
          error_message: null,
        })
        .execute();

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "schema-test")
        .executeTakeFirst();

      expect(machine).toBeDefined();
      expect(machine?.runtime_type).toBe("firecracker");
      expect(machine?.tap_device).toBe("tap0");
      expect(machine?.pid).toBe(12345);
      expect(machine?.created_at).toBeDefined();
      expect(machine?.updated_at).toBeDefined();
    });

    it("creates api_keys table with correct columns", async () => {
      await runMigrations(db);

      await db
        .insertInto("api_keys")
        .values({
          id: "api-key-test",
          name: "Test API Key",
          key_hash: "sha256_hash_here",
          key_prefix: "hf_prefix",
          scopes: JSON.stringify(["read", "write"]),
          expires_at: "2025-12-31T23:59:59Z",
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      const apiKey = await db
        .selectFrom("api_keys")
        .selectAll()
        .where("id", "=", "api-key-test")
        .executeTakeFirst();

      expect(apiKey).toBeDefined();
      expect(apiKey?.key_prefix).toBe("hf_prefix");
      expect(apiKey?.expires_at).toBe("2025-12-31T23:59:59Z");
    });

    it("is idempotent (running twice does not fail)", async () => {
      await runMigrations(db);
      await runMigrations(db); // Should not throw

      const result = await db.selectFrom("machines").selectAll().execute();
      expect(Array.isArray(result)).toBe(true);
    });

    it("creates indexes on machines table", async () => {
      await runMigrations(db);

      // Check indexes by querying sqlite_master
      const indexes = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='machines'
      `.execute(db);

      const indexNames = indexes.rows.map((r) => r.name);

      // Should have indexes for status, name, and runtime_type
      expect(indexNames.some((n) => n.includes("status"))).toBe(true);
      expect(indexNames.some((n) => n.includes("name"))).toBe(true);
      expect(indexNames.some((n) => n.includes("runtime_type"))).toBe(true);
    });

    it("creates index on api_keys key_hash", async () => {
      await runMigrations(db);

      const indexes = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='api_keys'
      `.execute(db);

      const indexNames = indexes.rows.map((r) => r.name);
      expect(indexNames.some((n) => n.includes("key_hash"))).toBe(true);
    });
  });

  describe("rollbackMigration", () => {
    it("rolls back the last migration", async () => {
      await runMigrations(db);

      // Verify api_keys exists (will be used to check rollback works)
      const beforeRollback = await db
        .selectFrom("api_keys")
        .selectAll()
        .execute();
      expect(Array.isArray(beforeRollback)).toBe(true);

      // Rollback should remove image_fields (migration 005)
      await rollbackMigration(db);

      // After rolling back 005, api_keys should still exist (it's migration 004)
      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'
      `.execute(db);

      expect(tables.rows.length).toBe(1);

      // Now rollback again to remove api_keys
      await rollbackMigration(db);

      const tablesAfter = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'
      `.execute(db);

      expect(tablesAfter.rows.length).toBe(0);
    });

    it("can rollback multiple times", async () => {
      await runMigrations(db);

      // Rollback all migrations one by one
      await rollbackMigration(db); // Remove image_fields (005)
      await rollbackMigration(db); // Remove api_keys (004)
      await rollbackMigration(db); // Remove runtime_type column changes (003)
      await rollbackMigration(db); // Remove rootfs and network columns (002)
      await rollbackMigration(db); // Remove machines table (001)

      // After all rollbacks, machines table should not exist
      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='machines'
      `.execute(db);

      expect(tables.rows.length).toBe(0);
    });
  });
});
