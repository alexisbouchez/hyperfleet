import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createInMemoryDatabase } from "../../database/client";
import { runMigrations } from "../../database/migrations";
import type { Kysely } from "kysely";
import type { Database } from "../../database/schema";

describe("Database Client", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("createInMemoryDatabase", () => {
    it("creates a working database instance", async () => {
      // Should be able to query the database
      const result = await db.selectFrom("machines").selectAll().execute();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("CRUD operations", () => {
    it("inserts and retrieves a machine", async () => {
      await db
        .insertInto("machines")
        .values({
          id: "test-123",
          name: "test-machine",
          status: "pending",
          runtime_type: "firecracker",
          vcpu_count: 2,
          mem_size_mib: 512,
          kernel_image_path: "/path/to/kernel",
          kernel_args: "console=ttyS0",
          rootfs_path: "/path/to/rootfs",
          socket_path: "/tmp/test.sock",
          tap_device: null,
          tap_ip: null,
          guest_ip: null,
          guest_mac: null,
          image: null,
          container_id: null,
          config_json: "{}",
        })
        .execute();

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "test-123")
        .executeTakeFirst();

      expect(machine).toBeDefined();
      expect(machine?.name).toBe("test-machine");
      expect(machine?.vcpu_count).toBe(2);
      expect(machine?.mem_size_mib).toBe(512);
      expect(machine?.status).toBe("pending");
    });

    it("updates a machine", async () => {
      await db
        .insertInto("machines")
        .values({
          id: "update-test",
          name: "original-name",
          status: "pending",
          runtime_type: "docker",
          vcpu_count: 1,
          mem_size_mib: 256,
          kernel_image_path: "",
          socket_path: "",
          image: "nginx:latest",
          config_json: "{}",
        })
        .execute();

      await db
        .updateTable("machines")
        .set({ status: "running", name: "updated-name" })
        .where("id", "=", "update-test")
        .execute();

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "update-test")
        .executeTakeFirst();

      expect(machine?.status).toBe("running");
      expect(machine?.name).toBe("updated-name");
    });

    it("deletes a machine", async () => {
      await db
        .insertInto("machines")
        .values({
          id: "delete-test",
          name: "to-delete",
          status: "stopped",
          runtime_type: "firecracker",
          vcpu_count: 1,
          mem_size_mib: 128,
          kernel_image_path: "/kernel",
          socket_path: "/sock",
          config_json: "{}",
        })
        .execute();

      const result = await db
        .deleteFrom("machines")
        .where("id", "=", "delete-test")
        .executeTakeFirst();

      expect(result.numDeletedRows).toBe(1n);

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "delete-test")
        .executeTakeFirst();

      expect(machine).toBeUndefined();
    });

    it("queries with filters", async () => {
      await db
        .insertInto("machines")
        .values([
          {
            id: "fc-1",
            name: "firecracker-1",
            status: "running",
            runtime_type: "firecracker",
            vcpu_count: 2,
            mem_size_mib: 512,
            kernel_image_path: "/kernel",
            socket_path: "/sock",
            config_json: "{}",
          },
          {
            id: "docker-1",
            name: "docker-1",
            status: "running",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 256,
            kernel_image_path: "",
            socket_path: "",
            image: "nginx",
            config_json: "{}",
          },
          {
            id: "fc-2",
            name: "firecracker-2",
            status: "stopped",
            runtime_type: "firecracker",
            vcpu_count: 4,
            mem_size_mib: 1024,
            kernel_image_path: "/kernel",
            socket_path: "/sock",
            config_json: "{}",
          },
        ])
        .execute();

      // Filter by runtime type
      const firecrackerMachines = await db
        .selectFrom("machines")
        .selectAll()
        .where("runtime_type", "=", "firecracker")
        .execute();

      expect(firecrackerMachines.length).toBe(2);

      // Filter by status
      const runningMachines = await db
        .selectFrom("machines")
        .selectAll()
        .where("status", "=", "running")
        .execute();

      expect(runningMachines.length).toBe(2);

      // Combined filter
      const runningFirecracker = await db
        .selectFrom("machines")
        .selectAll()
        .where("runtime_type", "=", "firecracker")
        .where("status", "=", "running")
        .execute();

      expect(runningFirecracker.length).toBe(1);
    });
  });

  describe("API Keys", () => {
    it("creates and retrieves an API key", async () => {
      await db
        .insertInto("api_keys")
        .values({
          id: "key-123",
          name: "Test Key",
          key_hash: "hashed_key_value",
          key_prefix: "hf_test",
          scopes: JSON.stringify(["machines:read", "machines:write"]),
          expires_at: null,
        })
        .execute();

      const key = await db
        .selectFrom("api_keys")
        .selectAll()
        .where("id", "=", "key-123")
        .executeTakeFirst();

      expect(key).toBeDefined();
      expect(key?.name).toBe("Test Key");
      expect(key?.key_prefix).toBe("hf_test");
      expect(JSON.parse(key?.scopes ?? "[]")).toContain("machines:read");
    });

    it("queries by key hash", async () => {
      await db
        .insertInto("api_keys")
        .values({
          id: "key-hash-test",
          name: "Hash Test Key",
          key_hash: "unique_hash_value",
          key_prefix: "hf_hash",
          scopes: "[]",
        })
        .execute();

      const key = await db
        .selectFrom("api_keys")
        .selectAll()
        .where("key_hash", "=", "unique_hash_value")
        .executeTakeFirst();

      expect(key).toBeDefined();
      expect(key?.id).toBe("key-hash-test");
    });
  });

  describe("Transactions", () => {
    it("commits transaction on success", async () => {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("machines")
          .values({
            id: "tx-success",
            name: "transaction-test",
            status: "pending",
            runtime_type: "firecracker",
            vcpu_count: 1,
            mem_size_mib: 128,
            kernel_image_path: "/kernel",
            socket_path: "/sock",
            config_json: "{}",
          })
          .execute();
      });

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "tx-success")
        .executeTakeFirst();

      expect(machine).toBeDefined();
    });

    it("rolls back transaction on error", async () => {
      try {
        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto("machines")
            .values({
              id: "tx-rollback",
              name: "rollback-test",
              status: "pending",
              runtime_type: "firecracker",
              vcpu_count: 1,
              mem_size_mib: 128,
              kernel_image_path: "/kernel",
              socket_path: "/sock",
              config_json: "{}",
            })
            .execute();

          throw new Error("Simulated failure");
        });
      } catch {
        // Expected
      }

      const machine = await db
        .selectFrom("machines")
        .selectAll()
        .where("id", "=", "tx-rollback")
        .executeTakeFirst();

      expect(machine).toBeUndefined();
    });
  });
});
