import net from "node:net";
import { Result } from "better-result";
import type { Kysely, Database } from "@hyperfleet/worker/database";
import type { Logger } from "@hyperfleet/logger";
import { NotFoundError, ValidationError, VsockError, type HyperfleetError } from "@hyperfleet/errors";

// Default timeout for file operations (1 minute)
const DEFAULT_FILE_TIMEOUT_MS = parseInt(process.env.HYPERFLEET_FILE_TRANSFER_TIMEOUT ?? "60000", 10);

// Maximum file size (100MB)
const MAX_FILE_SIZE = parseInt(process.env.HYPERFLEET_FILE_MAX_SIZE ?? "104857600", 10);

// Vsock port used by the init system
const VSOCK_GUEST_PORT = 52;

/**
 * File stat information
 */
export interface FileStat {
  path: string;
  size: number;
  mode: string;
  mod_time: string;
  is_dir: boolean;
}

/**
 * Request payload for the guest agent
 */
interface AgentRequest {
  operation: "file_read" | "file_write" | "file_stat" | "file_delete" | "ping";
  path?: string;
  content?: string; // Base64 encoded for file_write
}

/**
 * Response from the guest agent
 */
interface AgentResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

interface FileReadData {
  content: string;
  size: number;
}

interface FileWriteData {
  bytes_written: number;
}

type MachineConfig = {
  vsock?: {
    uds_path?: string;
    guest_cid?: number;
  };
};

/**
 * FileService provides file transfer capabilities to VMs via vsock
 */
export class FileService {
  constructor(
    private db: Kysely<Database>,
    private logger?: Logger
  ) {}

  /**
   * Upload a file to a running VM
   */
  async uploadFile(
    machineId: string,
    remotePath: string,
    content: Buffer
  ): Promise<Result<{ bytes_written: number }, HyperfleetError>> {
    // Validate file size
    if (content.length > MAX_FILE_SIZE) {
      return Result.err(
        new ValidationError({
          message: `File too large: ${content.length} bytes (max ${MAX_FILE_SIZE})`,
        })
      );
    }

    // Validate path
    if (!remotePath.startsWith("/")) {
      return Result.err(
        new ValidationError({
          message: "Remote path must be absolute",
        })
      );
    }

    // Get machine and vsock path
    const vsockResult = await this.getVsockPath(machineId);
    if (vsockResult.isErr()) {
      return Result.err(vsockResult.error);
    }

    const udsPath = vsockResult.unwrap();

    // Encode content as base64
    const base64Content = content.toString("base64");

    // Send file write request to agent
    const request: AgentRequest = {
      operation: "file_write",
      path: remotePath,
      content: base64Content,
    };

    const response = await this.sendAgentRequest(udsPath, request);
    if (response.isErr()) {
      return Result.err(response.error);
    }

    const agentResp = response.unwrap();
    if (!agentResp.success) {
      return Result.err(
        new VsockError({
          message: agentResp.error ?? "Failed to write file",
        })
      );
    }

    const data = agentResp.data as FileWriteData;
    this.logger?.info("File uploaded successfully", {
      machineId,
      path: remotePath,
      bytesWritten: data.bytes_written,
    });

    return Result.ok({ bytes_written: data.bytes_written });
  }

  /**
   * Download a file from a running VM
   */
  async downloadFile(
    machineId: string,
    remotePath: string
  ): Promise<Result<Buffer, HyperfleetError>> {
    // Validate path
    if (!remotePath.startsWith("/")) {
      return Result.err(
        new ValidationError({
          message: "Remote path must be absolute",
        })
      );
    }

    // Get machine and vsock path
    const vsockResult = await this.getVsockPath(machineId);
    if (vsockResult.isErr()) {
      return Result.err(vsockResult.error);
    }

    const udsPath = vsockResult.unwrap();

    // Send file read request to agent
    const request: AgentRequest = {
      operation: "file_read",
      path: remotePath,
    };

    const response = await this.sendAgentRequest(udsPath, request);
    if (response.isErr()) {
      return Result.err(response.error);
    }

    const agentResp = response.unwrap();
    if (!agentResp.success) {
      return Result.err(
        new VsockError({
          message: agentResp.error ?? "Failed to read file",
        })
      );
    }

    const data = agentResp.data as FileReadData;
    const content = Buffer.from(data.content, "base64");

    this.logger?.info("File downloaded successfully", {
      machineId,
      path: remotePath,
      size: content.length,
    });

    return Result.ok(content);
  }

  /**
   * Get file information from a running VM
   */
  async statFile(
    machineId: string,
    remotePath: string
  ): Promise<Result<FileStat, HyperfleetError>> {
    // Validate path
    if (!remotePath.startsWith("/")) {
      return Result.err(
        new ValidationError({
          message: "Remote path must be absolute",
        })
      );
    }

    // Get machine and vsock path
    const vsockResult = await this.getVsockPath(machineId);
    if (vsockResult.isErr()) {
      return Result.err(vsockResult.error);
    }

    const udsPath = vsockResult.unwrap();

    // Send file stat request to agent
    const request: AgentRequest = {
      operation: "file_stat",
      path: remotePath,
    };

    const response = await this.sendAgentRequest(udsPath, request);
    if (response.isErr()) {
      return Result.err(response.error);
    }

    const agentResp = response.unwrap();
    if (!agentResp.success) {
      return Result.err(
        new VsockError({
          message: agentResp.error ?? "Failed to stat file",
        })
      );
    }

    return Result.ok(agentResp.data as FileStat);
  }

  /**
   * Delete a file from a running VM
   */
  async deleteFile(
    machineId: string,
    remotePath: string
  ): Promise<Result<void, HyperfleetError>> {
    // Validate path
    if (!remotePath.startsWith("/")) {
      return Result.err(
        new ValidationError({
          message: "Remote path must be absolute",
        })
      );
    }

    // Get machine and vsock path
    const vsockResult = await this.getVsockPath(machineId);
    if (vsockResult.isErr()) {
      return Result.err(vsockResult.error);
    }

    const udsPath = vsockResult.unwrap();

    // Send file delete request to agent
    const request: AgentRequest = {
      operation: "file_delete",
      path: remotePath,
    };

    const response = await this.sendAgentRequest(udsPath, request);
    if (response.isErr()) {
      return Result.err(response.error);
    }

    const agentResp = response.unwrap();
    if (!agentResp.success) {
      return Result.err(
        new VsockError({
          message: agentResp.error ?? "Failed to delete file",
        })
      );
    }

    this.logger?.info("File deleted successfully", {
      machineId,
      path: remotePath,
    });

    return Result.ok(undefined);
  }

  /**
   * Get the vsock UDS path for a machine
   */
  private async getVsockPath(machineId: string): Promise<Result<string, HyperfleetError>> {
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", machineId)
      .executeTakeFirst();

    if (!machine) {
      return Result.err(new NotFoundError({ message: "Machine not found" }));
    }

    if (machine.status !== "running") {
      return Result.err(
        new ValidationError({
          message: "Machine must be running for file operations",
        })
      );
    }

    // Parse config to get vsock path
    const configResult = Result.try(() => JSON.parse(machine.config_json) as MachineConfig);
    const config = configResult.unwrapOr(null);
    const udsPath = config?.vsock?.uds_path;

    if (!udsPath) {
      return Result.err(
        new VsockError({
          message: "Vsock not configured for this machine",
        })
      );
    }

    return Result.ok(udsPath);
  }

  /**
   * Send a request to the guest agent and wait for response
   */
  private sendAgentRequest(
    udsPath: string,
    request: AgentRequest
  ): Promise<Result<AgentResponse, VsockError>> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ path: udsPath });
      let settled = false;
      let buffer = "";
      let connected = false; // Track if we've completed the CONNECT handshake

      const finish = (err?: VsockError, response?: AgentResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();

        if (err) {
          resolve(Result.err(err));
        } else if (response) {
          resolve(Result.ok(response));
        } else {
          resolve(Result.err(new VsockError({ message: "Empty response from agent" })));
        }
      };

      const timer = setTimeout(() => {
        socket.destroy();
        finish(new VsockError({ message: "File operation timed out" }));
      }, DEFAULT_FILE_TIMEOUT_MS);

      socket.setEncoding("utf8");

      socket.on("connect", () => {
        // Firecracker vsock protocol: send CONNECT <port>\n first
        socket.write(`CONNECT ${VSOCK_GUEST_PORT}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk;

        // If we haven't completed the CONNECT handshake yet
        if (!connected) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.startsWith("OK ")) {
              // Connection established, now send the actual request
              connected = true;
              socket.write(`${JSON.stringify(request)}\n`);
            } else {
              finish(new VsockError({ message: `Vsock connection failed: ${line}` }));
            }
          }
          return;
        }

        // After connection is established, look for the response
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          try {
            const response = JSON.parse(line) as AgentResponse;
            finish(undefined, response);
          } catch {
            finish(new VsockError({ message: "Invalid JSON response from agent" }));
          }
        }
      });

      socket.on("end", () => {
        const remaining = buffer.trim();
        if (!remaining) {
          finish(new VsockError({ message: "Empty response from agent" }));
          return;
        }
        try {
          const response = JSON.parse(remaining) as AgentResponse;
          finish(undefined, response);
        } catch {
          finish(new VsockError({ message: "Invalid JSON response from agent" }));
        }
      });

      socket.on("error", (err) => {
        finish(new VsockError({ message: `Agent connection error: ${err.message}` }));
      });
    });
  }
}
