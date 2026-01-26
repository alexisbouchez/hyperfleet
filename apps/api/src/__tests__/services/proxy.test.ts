import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createInMemoryDatabase, runMigrations } from "@hyperfleet/worker/database";
import type { Kysely } from "@hyperfleet/worker/database";
import type { Database } from "@hyperfleet/worker/database";
import { createReverseProxyHandler } from "../../proxy";

describe("Reverse proxy", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("proxies host-based requests to exposed VM ports", async () => {
    const upstreamCalls: string[] = [];
    const handler = createReverseProxyHandler({
      db,
      hostSuffix: "palmframe.com",
      fetchFn: async (request) => {
        upstreamCalls.push(request.url);
        const url = new URL(request.url);
        return new Response(
          JSON.stringify({
            path: url.pathname,
            query: url.searchParams.get("foo"),
            method: request.method,
          }),
          { headers: { "content-type": "application/json" } }
        );
      },
    });

    const machineId = "machine-proxy-1";
    await db
      .insertInto("machines")
      .values({
        id: machineId,
        name: "proxy-machine",
        status: "running",
        runtime_type: "firecracker",
        vcpu_count: 1,
        mem_size_mib: 128,
        kernel_image_path: "vmlinuz",
        kernel_args: null,
        rootfs_path: null,
        socket_path: "/tmp/firecracker.sock",
        tap_device: null,
        tap_ip: null,
        guest_ip: "172.16.0.2",
        guest_mac: null,
        config_json: JSON.stringify({
          exposedPorts: [8080],
        }),
        pid: null,
        error_message: null,
      })
      .execute();

    const response = await handler(
      new Request(`http://${machineId}.palmframe.com:8080/hello?foo=bar`)
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      path: string;
      query: string | null;
      method: string;
    };
    expect(payload.path).toBe("/hello");
    expect(payload.query).toBe("bar");
    expect(payload.method).toBe("GET");
    expect(upstreamCalls[0]).toBe("http://172.16.0.2:8080/hello?foo=bar");
  });

  it("returns a validation error when VM port is not exposed", async () => {
    const machineId = "machine-proxy-2";
    await db
      .insertInto("machines")
      .values({
        id: machineId,
        name: "proxy-machine",
        status: "running",
        runtime_type: "firecracker",
        vcpu_count: 1,
        mem_size_mib: 128,
        kernel_image_path: "vmlinuz",
        kernel_args: null,
        rootfs_path: null,
        socket_path: "/tmp/firecracker.sock",
        tap_device: null,
        tap_ip: null,
        guest_ip: "172.16.0.3",
        guest_mac: null,
        config_json: JSON.stringify({
          exposedPorts: [8080],
        }),
        pid: null,
        error_message: null,
      })
      .execute();

    const handler = createReverseProxyHandler({ db, hostSuffix: "palmframe.com" });
    const response = await handler(
      new Request(`http://${machineId}.palmframe.com:9090/`)
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("ValidationError");
  });

  it("proxies path-based requests to firecracker VMs", async () => {
    const upstreamCalls: string[] = [];
    const handler = createReverseProxyHandler({
      db,
      fetchFn: async (request) => {
        upstreamCalls.push(request.url);
        const url = new URL(request.url);
        return new Response(
          JSON.stringify({
            path: url.pathname,
            query: url.searchParams.get("foo"),
            method: request.method,
          }),
          { headers: { "content-type": "application/json" } }
        );
      },
    });

    const machineId = "machine-proxy-3";
    await db
      .insertInto("machines")
      .values({
        id: machineId,
        name: "proxy-machine",
        status: "running",
        runtime_type: "firecracker",
        vcpu_count: 1,
        mem_size_mib: 128,
        kernel_image_path: "vmlinuz",
        kernel_args: null,
        rootfs_path: null,
        socket_path: "/tmp/firecracker.sock",
        tap_device: null,
        tap_ip: null,
        guest_ip: "172.16.0.4",
        guest_mac: null,
        config_json: JSON.stringify({
          exposedPorts: [8080],
        }),
        pid: null,
        error_message: null,
      })
      .execute();

    const response = await handler(
      new Request(`http://proxy.local/proxy/${machineId}/hello?port=8080&foo=bar`)
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      path: string;
      query: string | null;
      method: string;
    };
    expect(payload.path).toBe("/hello");
    expect(payload.query).toBe("bar");
    expect(payload.method).toBe("GET");
    expect(upstreamCalls[0]).toBe("http://172.16.0.4:8080/hello?foo=bar");
  });

  it("returns a validation error when machine has no guest IP", async () => {
    const machineId = "machine-proxy-4";
    await db
      .insertInto("machines")
      .values({
        id: machineId,
        name: "proxy-machine",
        status: "running",
        runtime_type: "firecracker",
        vcpu_count: 1,
        mem_size_mib: 128,
        kernel_image_path: "vmlinuz",
        kernel_args: null,
        rootfs_path: null,
        socket_path: "/tmp/firecracker.sock",
        tap_device: null,
        tap_ip: null,
        guest_ip: null,
        guest_mac: null,
        config_json: JSON.stringify({}),
        pid: null,
        error_message: null,
      })
      .execute();

    const handler = createReverseProxyHandler({ db });
    const response = await handler(new Request(`http://proxy.local/proxy/${machineId}/`));
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("ValidationError");
  });
});
