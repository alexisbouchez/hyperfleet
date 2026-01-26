/**
 * Bridge Management Module
 *
 * Manages Linux bridge devices for connecting TAP interfaces.
 * Uses shell commands (ip link) for simplicity and reliability.
 */

import { Result } from "better-result";

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = "BridgeError";
  }

  static is(error: unknown): error is BridgeError {
    return error instanceof BridgeError;
  }
}

/**
 * Run a shell command and return the result
 */
async function runCommand(
  cmd: string,
  args: string[]
): Promise<Result<string, BridgeError>> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    return Result.err(
      new BridgeError(`Command failed: ${cmd} ${args.join(" ")}: ${stderr}`, exitCode)
    );
  }

  return Result.ok(stdout);
}

/**
 * Check if a bridge exists
 */
export async function bridgeExists(name: string): Promise<boolean> {
  const result = await runCommand("ip", ["link", "show", name]);
  if (result.isErr()) {
    return false;
  }
  return result.unwrap().includes("master") || result.unwrap().includes(name);
}

/**
 * Create a new bridge device
 */
export async function createBridge(name: string): Promise<Result<void, BridgeError>> {
  // Check if bridge already exists
  const exists = await bridgeExists(name);
  if (exists) {
    return Result.ok(undefined);
  }

  // Create the bridge
  const createResult = await runCommand("ip", ["link", "add", name, "type", "bridge"]);
  if (createResult.isErr()) {
    // Check if it's because the bridge already exists
    if (createResult.error.message.includes("File exists")) {
      return Result.ok(undefined);
    }
    return Result.err(createResult.error);
  }

  // Set the bridge up
  const upResult = await runCommand("ip", ["link", "set", name, "up"]);
  if (upResult.isErr()) {
    return Result.err(upResult.error);
  }

  return Result.ok(undefined);
}

/**
 * Delete a bridge device
 */
export async function deleteBridge(name: string): Promise<Result<void, BridgeError>> {
  // Set the bridge down first
  await runCommand("ip", ["link", "set", name, "down"]);

  // Delete the bridge
  const result = await runCommand("ip", ["link", "delete", name]);
  if (result.isErr()) {
    // Ignore "not found" errors
    if (result.error.message.includes("not found") ||
        result.error.message.includes("Cannot find")) {
      return Result.ok(undefined);
    }
    return Result.err(result.error);
  }

  return Result.ok(undefined);
}

/**
 * Add an interface to a bridge
 */
export async function addInterfaceToBridge(
  bridgeName: string,
  interfaceName: string
): Promise<Result<void, BridgeError>> {
  const result = await runCommand("ip", [
    "link",
    "set",
    interfaceName,
    "master",
    bridgeName,
  ]);

  if (result.isErr()) {
    // Check if already part of the bridge
    if (result.error.message.includes("already a member")) {
      return Result.ok(undefined);
    }
    return Result.err(result.error);
  }

  return Result.ok(undefined);
}

/**
 * Remove an interface from a bridge
 */
export async function removeInterfaceFromBridge(
  interfaceName: string
): Promise<Result<void, BridgeError>> {
  const result = await runCommand("ip", ["link", "set", interfaceName, "nomaster"]);
  if (result.isErr()) {
    return Result.err(result.error);
  }
  return Result.ok(undefined);
}

/**
 * Add an IP address to a bridge
 */
export async function addIPToBridge(
  bridgeName: string,
  ip: string,
  prefixLen: number
): Promise<Result<void, BridgeError>> {
  const result = await runCommand("ip", [
    "addr",
    "add",
    `${ip}/${prefixLen}`,
    "dev",
    bridgeName,
  ]);

  if (result.isErr()) {
    // Ignore if address already exists
    if (result.error.message.includes("File exists")) {
      return Result.ok(undefined);
    }
    return Result.err(result.error);
  }

  return Result.ok(undefined);
}

/**
 * Remove an IP address from a bridge
 */
export async function deleteIPFromBridge(
  bridgeName: string,
  ip: string,
  prefixLen: number
): Promise<Result<void, BridgeError>> {
  const result = await runCommand("ip", [
    "addr",
    "del",
    `${ip}/${prefixLen}`,
    "dev",
    bridgeName,
  ]);

  if (result.isErr()) {
    // Ignore if address doesn't exist
    if (result.error.message.includes("not found")) {
      return Result.ok(undefined);
    }
    return Result.err(result.error);
  }

  return Result.ok(undefined);
}
