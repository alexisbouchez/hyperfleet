/**
 * API Integration Tests with Docker Runtime
 *
 * These tests run the full API with real Docker containers.
 * Requirements:
 * - Docker daemon running
 * - Network access to pull images
 *
 * Run with: bun test apps/api/src/__tests__/integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createApp, AuthService } from "../../app";
import { createInMemoryDatabase, runMigrations, type Kysely, type Database } from "@hyperfleet/worker/database";
import { DockerClient } from "@hyperfleet/docker";

interface MachineResponse {
  id: string;
  name: string;
  status: string;
  runtime_type: string;
  image?: string;
  container_id?: string;
}

interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}

interface ErrorResponse {
  error: string;
  message: string;
}

// Check if Docker is available
async function isDockerAvailable(): Promise<boolean> {
  const client = new DockerClient();
  return client.ping();
}

describe("API Integration Tests (Docker Runtime)", () => {
  let db: Kysely<Database>;
  let app: ReturnType<typeof createApp>;
  let dockerAvailable: boolean;
  let apiKey: string;
  const createdMachineIds: string[] = [];

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();

    if (!dockerAvailable) {
      console.warn("Docker daemon not available - skipping API integration tests");
      return;
    }

    // Pre-pull the test image
    const client = new DockerClient();
    await client.pullImage("alpine:3.19");
  });

  beforeEach(async () => {
    if (!dockerAvailable) return;

    // Create fresh database for each test
    db = createInMemoryDatabase();
    await runMigrations(db);

    // Create app with auth disabled for testing
    app = createApp({ db, disableAuth: true });

    // Create an API key for tests that need it
    const authService = new AuthService(db);
    const keyResult = await authService.createApiKey("Test Key", ["machines:read", "machines:write"]);
    apiKey = keyResult.key;
  });

  afterAll(async () => {
    if (!dockerAvailable) return;

    // Cleanup any remaining containers
    const client = new DockerClient();
    for (const id of createdMachineIds) {
      try {
        // Find container by label
        const containers = await client.listContainers(true);
        if (containers.isOk()) {
          for (const c of containers.unwrap()) {
            if (c.Names.includes(`hyperfleet-${id}`)) {
              await client.removeContainer(c.ID, true, true);
            }
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    await db?.destroy();
  });

  describe("Health Check", () => {
    it("should return healthy status", async () => {
      if (!dockerAvailable) return;

      const response = await app.handle(new Request("http://localhost/health"));
      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  describe("Machine Lifecycle", () => {
    it("should create a Docker machine", async () => {
      if (!dockerAvailable) return;

      const response = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-docker-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "", // Not used for Docker
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      expect(response.status).toBe(201);

      const machine = (await response.json()) as MachineResponse;
      expect(machine.id).toBeDefined();
      expect(machine.name).toBe("test-docker-machine");
      expect(machine.runtime_type).toBe("docker");
      expect(machine.status).toBe("pending");
      expect(machine.image).toBe("alpine:3.19");

      createdMachineIds.push(machine.id);
    });

    it("should start a Docker machine", async () => {
      if (!dockerAvailable) return;

      // Create machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-start-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start machine
      const startResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      expect(startResponse.status).toBe(200);

      const startedMachine = (await startResponse.json()) as MachineResponse;
      expect(startedMachine.status).toBe("running");
      expect(startedMachine.container_id).toBeDefined();
    });

    it("should stop a running Docker machine", async () => {
      if (!dockerAvailable) return;

      // Create and start machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-stop-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Stop
      const stopResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/stop`, {
          method: "POST",
        })
      );

      expect(stopResponse.status).toBe(200);

      const stoppedMachine = (await stopResponse.json()) as MachineResponse;
      expect(stoppedMachine.status).toBe("stopped");
    });

    it("should restart a Docker machine", async () => {
      if (!dockerAvailable) return;

      // Create and start machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-restart-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Restart
      const restartResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/restart`, {
          method: "POST",
        })
      );

      expect(restartResponse.status).toBe(200);

      const restartedMachine = (await restartResponse.json()) as MachineResponse;
      expect(restartedMachine.status).toBe("running");
    });

    it("should delete a Docker machine", async () => {
      if (!dockerAvailable) return;

      // Create machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-delete-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Delete (should stop first)
      const deleteResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}`, {
          method: "DELETE",
        })
      );

      expect(deleteResponse.status).toBe(204);

      // Verify it's gone
      const getResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}`)
      );

      expect(getResponse.status).toBe(404);
    });
  });

  describe("Command Execution", () => {
    it("should execute commands in a running container", async () => {
      if (!dockerAvailable) return;

      // Create and start machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-exec-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Execute command
      const execResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd: ["echo", "hello from container"],
          }),
        })
      );

      expect(execResponse.status).toBe(200);

      const execResult = (await execResponse.json()) as ExecResponse;
      expect(execResult.exit_code).toBe(0);
      expect(execResult.stdout.trim()).toBe("hello from container");
    });

    it("should return non-zero exit code for failed commands", async () => {
      if (!dockerAvailable) return;

      // Create and start machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-exec-fail",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Execute failing command
      const execResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd: ["sh", "-c", "exit 42"],
          }),
        })
      );

      expect(execResponse.status).toBe(200);

      const execResult = (await execResponse.json()) as ExecResponse;
      expect(execResult.exit_code).toBe(42);
    });
  });

  describe("Machine Listing and Filtering", () => {
    it("should list all machines", async () => {
      if (!dockerAvailable) return;

      // Create two machines
      for (let i = 0; i < 2; i++) {
        const response = await app.handle(
          new Request("http://localhost/machines", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `test-list-machine-${i}`,
              runtime_type: "docker",
              vcpu_count: 1,
              mem_size_mib: 64,
              kernel_image_path: "",
              image: "alpine:3.19",
              cmd: ["sleep", "300"],
            }),
          })
        );

        const machine = (await response.json()) as MachineResponse;
        createdMachineIds.push(machine.id);
      }

      // List machines
      const listResponse = await app.handle(
        new Request("http://localhost/machines")
      );

      expect(listResponse.status).toBe(200);

      const machines = (await listResponse.json()) as MachineResponse[];
      expect(Array.isArray(machines)).toBe(true);
      expect(machines.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter machines by status", async () => {
      if (!dockerAvailable) return;

      // Create and start a machine
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-filter-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start it
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Filter by running status
      const runningResponse = await app.handle(
        new Request("http://localhost/machines?status=running")
      );

      expect(runningResponse.status).toBe(200);

      const runningMachines = (await runningResponse.json()) as MachineResponse[];
      expect(runningMachines.every((m) => m.status === "running")).toBe(true);
    });

    it("should filter machines by runtime type", async () => {
      if (!dockerAvailable) return;

      // Create a Docker machine
      const response = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-runtime-filter",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await response.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Filter by Docker runtime
      const dockerResponse = await app.handle(
        new Request("http://localhost/machines?runtime_type=docker")
      );

      expect(dockerResponse.status).toBe(200);

      const dockerMachines = (await dockerResponse.json()) as MachineResponse[];
      expect(dockerMachines.every((m) => m.runtime_type === "docker")).toBe(true);
    });
  });

  describe("Machine with Environment Variables", () => {
    it("should pass environment variables to container", async () => {
      if (!dockerAvailable) return;

      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-env-machine",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
            env: {
              MY_VAR: "test_value",
              ANOTHER_VAR: "another_value",
            },
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Start
      await app.handle(
        new Request(`http://localhost/machines/${machine.id}/start`, {
          method: "POST",
        })
      );

      // Check environment variable
      const execResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd: ["sh", "-c", "echo $MY_VAR"],
          }),
        })
      );

      const execResult = (await execResponse.json()) as ExecResponse;
      expect(execResult.stdout.trim()).toBe("test_value");
    });
  });

  describe("Error Handling", () => {
    it("should return 404 for non-existent machine", async () => {
      if (!dockerAvailable) return;

      const response = await app.handle(
        new Request("http://localhost/machines/non-existent-id")
      );

      expect(response.status).toBe(404);

      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("not_found");
    });

    it("should return error when starting non-existent machine", async () => {
      if (!dockerAvailable) return;

      const response = await app.handle(
        new Request("http://localhost/machines/non-existent-id/start", {
          method: "POST",
        })
      );

      expect(response.status).toBe(404);
    });

    it("should return error when exec on stopped machine", async () => {
      if (!dockerAvailable) return;

      // Create machine but don't start it
      const createResponse = await app.handle(
        new Request("http://localhost/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-exec-stopped",
            runtime_type: "docker",
            vcpu_count: 1,
            mem_size_mib: 64,
            kernel_image_path: "",
            image: "alpine:3.19",
            cmd: ["sleep", "300"],
          }),
        })
      );

      const machine = (await createResponse.json()) as MachineResponse;
      createdMachineIds.push(machine.id);

      // Try to exec (should fail)
      const execResponse = await app.handle(
        new Request(`http://localhost/machines/${machine.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd: ["echo", "test"],
          }),
        })
      );

      // Should return an error (exact status depends on implementation)
      expect(execResponse.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("Authentication (when enabled)", () => {
    it("should require authentication when auth is enabled", async () => {
      if (!dockerAvailable) return;

      // Create app with auth enabled
      const authApp = createApp({ db, disableAuth: false });

      const response = await authApp.handle(
        new Request("http://localhost/machines")
      );

      expect(response.status).toBe(401);
    });

    it("should accept valid API key", async () => {
      if (!dockerAvailable) return;

      // Create app with auth enabled
      const authApp = createApp({ db, disableAuth: false });

      const response = await authApp.handle(
        new Request("http://localhost/machines", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        })
      );

      expect(response.status).toBe(200);
    });

    it("should reject invalid API key", async () => {
      if (!dockerAvailable) return;

      // Create app with auth enabled
      const authApp = createApp({ db, disableAuth: false });

      const response = await authApp.handle(
        new Request("http://localhost/machines", {
          headers: {
            Authorization: "Bearer invalid_key",
          },
        })
      );

      expect(response.status).toBe(401);
    });
  });
});
