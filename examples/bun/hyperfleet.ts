// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

/**
 * Hyperfleet TypeScript client for Bun
 */

export interface Machine {
  id: string;
  parent_id?: string;
  vcpu_count: number;
  memory_mb: number;
  volume_size_mb: number;
  volume_mount_path: string;
  env: Record<string, string>;
  status: "stopped" | "starting" | "running" | "stopping" | "failed";
  created_at: number;
  updated_at: number;
}

export interface MachineConfig {
  vcpu_count?: number;
  memory_mb?: number;
  volume_size_mb?: number;
  volume_mount_path?: string;
  env?: Record<string, string>;
}

export interface ExecRequest {
  cmd: string[];
  env?: Record<string, string>;
  timeout_seconds?: number;
}

export interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface Gateway {
  machine_id: string;
  port: number;
  subdomain: string;
  created_at: number;
}

export class HyperfleetClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl ?? process.env.HYPERFLEET_API_URL ?? "http://localhost:8080";
    this.apiKey = apiKey ?? process.env.HYPERFLEET_API_KEY ?? "unsecure";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private async requestBytes(
    method: string,
    path: string,
    body?: Uint8Array
  ): Promise<Uint8Array> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  // Machine operations
  async listMachines(): Promise<Machine[]> {
    return this.request("GET", "/v1/machines");
  }

  async createMachine(config?: MachineConfig): Promise<Machine> {
    return this.request("POST", "/v1/machines", config ?? {});
  }

  async getMachine(id: string): Promise<Machine> {
    return this.request("GET", `/v1/machines/${id}`);
  }

  async deleteMachine(id: string): Promise<void> {
    return this.request("DELETE", `/v1/machines/${id}`);
  }

  async startMachine(id: string): Promise<Machine> {
    return this.request("POST", `/v1/machines/${id}/start`);
  }

  async stopMachine(id: string): Promise<Machine> {
    return this.request("POST", `/v1/machines/${id}/stop`);
  }

  // Exec
  async exec(id: string, cmd: string[], options?: { env?: Record<string, string>; timeout?: number }): Promise<ExecResponse> {
    const request: ExecRequest = {
      cmd,
      env: options?.env,
      timeout_seconds: options?.timeout ?? 30,
    };
    return this.request("POST", `/v1/machines/${id}/exec`, request);
  }

  // File operations
  async listFiles(id: string, path: string): Promise<string[]> {
    const encodedPath = encodeURIComponent(path);
    return this.request("GET", `/v1/machines/${id}/files?path=${encodedPath}`);
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    const encodedPath = encodeURIComponent(path);
    return this.requestBytes("GET", `/v1/machines/${id}/files/content?path=${encodedPath}`);
  }

  async writeFile(id: string, path: string, content: string | Uint8Array): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.requestBytes("PUT", `/v1/machines/${id}/files/content?path=${encodedPath}`, body);
  }

  async deleteFile(id: string, path: string): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    return this.request("DELETE", `/v1/machines/${id}/files?path=${encodedPath}`);
  }

  async mkdir(id: string, path: string): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    return this.request("POST", `/v1/machines/${id}/files/mkdir?path=${encodedPath}`);
  }

  // Gateway operations
  async listGateways(id: string): Promise<Gateway[]> {
    return this.request("GET", `/v1/machines/${id}/gateways`);
  }

  async createGateway(id: string, port: number): Promise<Gateway> {
    return this.request("POST", `/v1/machines/${id}/gateways`, { port });
  }

  async deleteGateway(id: string, port: number): Promise<void> {
    return this.request("DELETE", `/v1/machines/${id}/gateways/${port}`);
  }

  // Utility methods
  async waitForStatus(id: string, status: Machine["status"], timeoutMs = 30000): Promise<Machine> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const machine = await this.getMachine(id);
      if (machine.status === status) {
        return machine;
      }
      if (machine.status === "failed") {
        throw new Error(`Machine ${id} failed`);
      }
      await Bun.sleep(500);
    }
    throw new Error(`Timeout waiting for machine ${id} to reach status ${status}`);
  }
}
