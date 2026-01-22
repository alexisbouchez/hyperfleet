/**
 * Docker Runtime Integration Tests
 *
 * These tests run real Docker containers and require:
 * - Docker daemon running
 * - Network access to pull images (or images pre-pulled)
 *
 * Run with: bun test packages/docker/src/__tests__/integration
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { DockerClient } from "../../client";
import { Container } from "../../container";

// Skip tests if Docker is not available
async function isDockerAvailable(): Promise<boolean> {
  const client = new DockerClient();
  return client.ping();
}

describe("Docker Integration Tests", () => {
  let client: DockerClient;
  let dockerAvailable: boolean;
  const containersToCleanup: string[] = [];

  beforeAll(async () => {
    client = new DockerClient({ timeoutMs: 120000 });
    dockerAvailable = await isDockerAvailable();

    if (!dockerAvailable) {
      console.warn("Docker daemon not available - skipping integration tests");
    }
  });

  afterEach(async () => {
    // Clean up any containers created during tests
    for (const containerId of containersToCleanup) {
      try {
        await client.removeContainer(containerId, true, true);
      } catch {
        // Ignore cleanup errors
      }
    }
    containersToCleanup.length = 0;
  });

  afterAll(async () => {
    // Final cleanup
    for (const containerId of containersToCleanup) {
      try {
        await client.removeContainer(containerId, true, true);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("DockerClient", () => {
    it("should ping Docker daemon", async () => {
      if (!dockerAvailable) return;

      const result = await client.ping();
      expect(result).toBe(true);
    });

    it("should get Docker version", async () => {
      if (!dockerAvailable) return;

      const result = await client.version();
      expect(result.isOk()).toBe(true);

      const version = result.unwrap();
      expect(version.Client).toBeDefined();
      expect(version.Client.Version).toBeDefined();
    });

    it("should list containers", async () => {
      if (!dockerAvailable) return;

      const result = await client.listContainers(true);
      expect(result.isOk()).toBe(true);
      expect(Array.isArray(result.unwrap())).toBe(true);
    });

    it("should pull an image", async () => {
      if (!dockerAvailable) return;

      const result = await client.pullImage("alpine:3.19");
      expect(result.isOk()).toBe(true);
    });

    it("should check if image exists", async () => {
      if (!dockerAvailable) return;

      // Pull first to ensure it exists
      await client.pullImage("alpine:3.19");

      const exists = await client.imageExists("alpine:3.19");
      expect(exists).toBe(true);

      const notExists = await client.imageExists("nonexistent:image:12345");
      expect(notExists).toBe(false);
    });

    it("should create and remove a container", async () => {
      if (!dockerAvailable) return;

      const containerName = `hyperfleet-test-${Date.now()}`;
      const result = await client.createContainer({
        image: "alpine:3.19",
        name: containerName,
        cmd: ["echo", "hello"],
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      // Verify container was created
      const inspectResult = await client.inspectContainer(containerId);
      expect(inspectResult.isOk()).toBe(true);
      expect(inspectResult.unwrap().Name).toBe(`/${containerName}`);

      // Remove container
      const removeResult = await client.removeContainer(containerId, true);
      expect(removeResult.isOk()).toBe(true);

      // Remove from cleanup list since we already removed it
      containersToCleanup.pop();
    });

    it("should start and stop a container", async () => {
      if (!dockerAvailable) return;

      const result = await client.createContainer({
        image: "alpine:3.19",
        name: `hyperfleet-test-${Date.now()}`,
        cmd: ["sleep", "60"],
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      // Start container
      const startResult = await client.startContainer(containerId);
      expect(startResult.isOk()).toBe(true);

      // Verify it's running
      const inspectResult = await client.inspectContainer(containerId);
      expect(inspectResult.isOk()).toBe(true);
      expect(inspectResult.unwrap().State.Running).toBe(true);

      // Stop container (give more time in CI)
      const stopResult = await client.stopContainer(containerId, 10);
      expect(stopResult.isOk()).toBe(true);

      // Verify it's stopped
      const inspectResult2 = await client.inspectContainer(containerId);
      expect(inspectResult2.isOk()).toBe(true);
      expect(inspectResult2.unwrap().State.Running).toBe(false);
    }, 30000);

    it("should execute commands in a running container", async () => {
      if (!dockerAvailable) return;

      const result = await client.createContainer({
        image: "alpine:3.19",
        name: `hyperfleet-test-${Date.now()}`,
        cmd: ["sleep", "60"],
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      // Start container
      await client.startContainer(containerId);

      // Execute command
      const execResult = await client.execInContainer(containerId, ["echo", "hello world"]);
      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout.trim()).toBe("hello world");

      // Execute another command
      const execResult2 = await client.execInContainer(containerId, ["cat", "/etc/os-release"]);
      expect(execResult2.exitCode).toBe(0);
      expect(execResult2.stdout).toContain("Alpine");
    });

    it("should handle container with environment variables", async () => {
      if (!dockerAvailable) return;

      const result = await client.createContainer({
        image: "alpine:3.19",
        name: `hyperfleet-test-${Date.now()}`,
        cmd: ["sleep", "60"],
        env: {
          MY_VAR: "test_value",
          ANOTHER_VAR: "another_value",
        },
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      await client.startContainer(containerId);

      const execResult = await client.execInContainer(containerId, ["sh", "-c", "echo $MY_VAR"]);
      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout.trim()).toBe("test_value");
    });

    it("should pause and unpause a container", async () => {
      if (!dockerAvailable) return;

      const result = await client.createContainer({
        image: "alpine:3.19",
        name: `hyperfleet-test-${Date.now()}`,
        cmd: ["sleep", "60"],
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      await client.startContainer(containerId);

      // Pause
      const pauseResult = await client.pauseContainer(containerId);
      expect(pauseResult.isOk()).toBe(true);

      const inspectResult = await client.inspectContainer(containerId);
      expect(inspectResult.unwrap().State.Paused).toBe(true);

      // Unpause
      const unpauseResult = await client.unpauseContainer(containerId);
      expect(unpauseResult.isOk()).toBe(true);

      const inspectResult2 = await client.inspectContainer(containerId);
      expect(inspectResult2.unwrap().State.Paused).toBe(false);
    });

    it("should get container logs", async () => {
      if (!dockerAvailable) return;

      const result = await client.createContainer({
        image: "alpine:3.19",
        name: `hyperfleet-test-${Date.now()}`,
        cmd: ["sh", "-c", "echo 'line1' && echo 'line2' && echo 'line3'"],
      });

      expect(result.isOk()).toBe(true);
      const containerId = result.unwrap();
      containersToCleanup.push(containerId);

      await client.startContainer(containerId);

      // Wait for container to finish
      await client.waitContainer(containerId);

      // Get logs
      const logsResult = await client.getContainerLogs(containerId);
      expect(logsResult.isOk()).toBe(true);
      expect(logsResult.unwrap()).toContain("line1");
      expect(logsResult.unwrap()).toContain("line2");
      expect(logsResult.unwrap()).toContain("line3");
    });
  });

  describe("Container (Runtime interface)", () => {
    it("should implement full container lifecycle", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sleep", "60"],
      });

      // Start container
      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      expect(container.isRunning()).toBe(true);

      // Get info
      const info = await container.getInfo();
      expect(info.status).toBe("running");

      // Execute command
      const execResult = await container.exec(["echo", "test"]);
      expect(execResult.exit_code).toBe(0);
      expect(execResult.stdout.trim()).toBe("test");

      // Stop container
      await container.stop();
      expect(container.isRunning()).toBe(false);

      // Remove container
      await container.remove(true);
      containersToCleanup.pop();
    }, 30000);

    it("should handle pause and resume", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sleep", "60"],
      });

      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      await container.pause();
      const pausedInfo = await container.getInfo();
      expect(pausedInfo.status).toBe("paused");

      await container.resume();
      const resumedInfo = await container.getInfo();
      expect(resumedInfo.status).toBe("running");

      await container.remove(true);
      containersToCleanup.pop();
    });

    it("should handle graceful shutdown", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sleep", "60"],
      });

      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      // Graceful shutdown with 10 second timeout (more time for CI)
      await container.shutdown(10000);

      const info = await container.getInfo();
      expect(info.status).toBe("stopped");

      await container.remove(true);
      containersToCleanup.pop();
    }, 30000);

    it("should handle restart", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sleep", "60"],
      });

      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      // Get initial PID
      const initialInfo = await container.getInfo();
      const initialPid = initialInfo.pid;

      // Restart (give more time for CI)
      await container.restart(10);

      // Check it's running with a new PID
      const newInfo = await container.getInfo();
      expect(newInfo.status).toBe("running");
      expect(newInfo.pid).not.toBe(initialPid);

      await container.remove(true);
      containersToCleanup.pop();
    }, 30000);

    it("should handle container with resource limits", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sleep", "60"],
        cpus: 0.5,
        memoryMib: 64,
      });

      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      expect(container.isRunning()).toBe(true);

      await container.remove(true);
      containersToCleanup.pop();
    });

    it("should handle container logs", async () => {
      if (!dockerAvailable) return;

      const container = new Container({
        id: `test-${Date.now()}`,
        image: "alpine:3.19",
        cmd: ["sh", "-c", "echo 'test output' && sleep 5"],
      });

      await container.start();
      containersToCleanup.push(container.getContainerId()!);

      // Wait a bit for the output
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const logs = await container.logs({ tail: 10 });
      expect(logs).toContain("test output");

      await container.remove(true);
      containersToCleanup.pop();
    });
  });
});
