/**
 * NAT (Network Address Translation) Configuration
 *
 * Configures NAT rules to allow microVMs to access the internet.
 * Uses nftables (modern) with iptables fallback.
 *
 * Required for:
 * - Masquerading outbound traffic from microVMs
 * - Forwarding traffic between TAP devices and external interface
 * - IP forwarding sysctl settings
 */

import { Result } from "better-result";
import { dlopen, FFIType, ptr } from "bun:ffi";

export class NATError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NATError";
  }

  static is(error: unknown): error is NATError {
    return error instanceof NATError;
  }
}

// sysctl paths
const IP_FORWARD_PATH = "/proc/sys/net/ipv4/ip_forward";

// Load libc for file operations
const libc = dlopen("libc.so.6", {
  open: {
    args: [FFIType.cstring, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  close: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  write: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  read: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
});

const O_RDONLY = 0;
const O_WRONLY = 1;

/**
 * Enable or disable IP forwarding
 */
export function setIPForwarding(enabled: boolean): Result<void, NATError> {
  const value = enabled ? "1" : "0";

  const fd = libc.symbols.open(
    ptr(Buffer.from(IP_FORWARD_PATH + "\0")),
    O_WRONLY,
    0
  );

  if (fd < 0) {
    return Result.err(new NATError(`Failed to open ${IP_FORWARD_PATH}`));
  }

  try {
    const buf = Buffer.from(value + "\n");
    const written = libc.symbols.write(fd, ptr(buf), buf.length);
    if (written < 0) {
      return Result.err(new NATError("Failed to write to ip_forward"));
    }
    return Result.ok(undefined);
  } finally {
    libc.symbols.close(fd);
  }
}

/**
 * Check if IP forwarding is enabled
 */
export function isIPForwardingEnabled(): boolean {
  const fd = libc.symbols.open(
    ptr(Buffer.from(IP_FORWARD_PATH + "\0")),
    O_RDONLY,
    0
  );

  if (fd < 0) {
    return false;
  }

  try {
    const buf = new Uint8Array(2);
    const read = libc.symbols.read(fd, ptr(buf), 1);
    if (read < 0) {
      return false;
    }
    return buf[0] === 0x31; // ASCII '1'
  } finally {
    libc.symbols.close(fd);
  }
}

export interface NATConfig {
  /** The subnet in CIDR notation (e.g., "172.16.0.0/24") */
  subnet: string;
  /** The external interface to masquerade through (e.g., "eth0") */
  externalInterface: string;
  /** Table name for nftables (default: "hyperfleet") */
  tableName?: string;
}

/**
 * nftables configuration generator
 *
 * Generates nftables rules for NAT and forwarding.
 */
export class NFTablesConfig {
  private readonly subnet: string;
  private readonly extIface: string;
  private readonly tableName: string;

  constructor(config: NATConfig) {
    this.subnet = config.subnet;
    this.extIface = config.externalInterface;
    this.tableName = config.tableName ?? "hyperfleet";
  }

  /**
   * Generate the nftables configuration
   */
  generateConfig(): string {
    return `#!/usr/sbin/nft -f

# Hyperfleet NAT configuration
# Generated automatically - do not edit manually

table ip ${this.tableName} {
  # NAT chain for masquerading
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;

    # Masquerade traffic from microVM subnet going to external interface
    ip saddr ${this.subnet} oifname "${this.extIface}" masquerade
  }

  # Forward chain for routing
  chain forward {
    type filter hook forward priority filter; policy accept;

    # Allow established/related connections
    ct state established,related accept

    # Allow traffic from microVM subnet to external
    ip saddr ${this.subnet} oifname "${this.extIface}" accept

    # Allow traffic from external to microVM subnet (for responses)
    ip daddr ${this.subnet} iifname "${this.extIface}" accept
  }
}
`;
  }

  /**
   * Generate the flush command to remove our table
   */
  generateFlushCommand(): string {
    return `delete table ip ${this.tableName}`;
  }
}

/**
 * Apply nftables configuration using nft command
 *
 * This executes the nft binary to apply rules.
 * Requires root/sudo privileges.
 */
export async function applyNFTables(config: NFTablesConfig): Promise<Result<void, NATError>> {
  const nftConfig = config.generateConfig();

  // Write config to temp file and apply
  const tempFile = `/tmp/hyperfleet-nft-${Date.now()}.conf`;

  try {
    await Bun.write(tempFile, nftConfig);

    const proc = Bun.spawn(["nft", "-f", tempFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return Result.err(new NATError(`nft failed: ${stderr}`));
    }

    return Result.ok(undefined);
  } catch (error) {
    return Result.err(new NATError(`Failed to apply nftables: ${error}`));
  } finally {
    // Clean up temp file
    try {
      const exists = await Bun.file(tempFile).exists();
      if (exists) {
        Bun.spawn(["rm", "-f", tempFile]);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Remove nftables configuration
 */
export async function removeNFTables(tableName: string = "hyperfleet"): Promise<Result<void, NATError>> {
  const proc = Bun.spawn(["nft", "delete", "table", "ip", tableName], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  // Exit code 1 with "No such file or directory" is ok (table doesn't exist)
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    if (!stderr.includes("No such file or directory")) {
      return Result.err(new NATError(`nft delete failed: ${stderr}`));
    }
  }

  return Result.ok(undefined);
}

/**
 * Check if nftables is available
 */
export async function isNFTablesAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["nft", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: Apply iptables rules directly
 *
 * Used when nftables is not available.
 */
export async function applyIPTables(config: NATConfig): Promise<Result<void, NATError>> {
  const commands = [
    // Enable IP forwarding
    ["sysctl", "-w", "net.ipv4.ip_forward=1"],
    // NAT masquerade
    ["iptables", "-t", "nat", "-A", "POSTROUTING", "-s", config.subnet, "-o", config.externalInterface, "-j", "MASQUERADE"],
    // Allow forwarding of established connections
    ["iptables", "-A", "FORWARD", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
    // Allow forwarding from subnet to external
    ["iptables", "-A", "FORWARD", "-s", config.subnet, "-o", config.externalInterface, "-j", "ACCEPT"],
    // Allow forwarding from external to subnet
    ["iptables", "-A", "FORWARD", "-d", config.subnet, "-i", config.externalInterface, "-j", "ACCEPT"],
  ];

  for (const cmd of commands) {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      // Ignore "already exists" errors for iptables rules
      if (!stderr.includes("already exists")) {
        return Result.err(new NATError(`${cmd[0]} failed: ${stderr}`));
      }
    }
  }

  return Result.ok(undefined);
}

/**
 * Remove iptables rules
 */
export async function removeIPTables(config: NATConfig): Promise<Result<void, NATError>> {
  const commands = [
    ["iptables", "-t", "nat", "-D", "POSTROUTING", "-s", config.subnet, "-o", config.externalInterface, "-j", "MASQUERADE"],
    ["iptables", "-D", "FORWARD", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
    ["iptables", "-D", "FORWARD", "-s", config.subnet, "-o", config.externalInterface, "-j", "ACCEPT"],
    ["iptables", "-D", "FORWARD", "-d", config.subnet, "-i", config.externalInterface, "-j", "ACCEPT"],
  ];

  // Run all commands, ignoring errors (rules may not exist)
  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } catch {
      // Ignore errors
    }
  }

  return Result.ok(undefined);
}

/**
 * Detect the default external interface
 */
export async function detectExternalInterface(): Promise<string | null> {
  try {
    // Read default route to find external interface
    const proc = Bun.spawn(["ip", "route", "show", "default"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const match = stdout.match(/default via \S+ dev (\S+)/);
    return match ? match[1] : null;
  } catch {
    // Fallback: try common interface names
    const commonNames = ["eth0", "ens3", "enp0s3", "ens160", "enp0s1"];
    for (const name of commonNames) {
      try {
        const file = Bun.file(`/sys/class/net/${name}/operstate`);
        const state = await file.text();
        if (state.trim() === "up") {
          return name;
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}

/**
 * High-level NAT setup function
 *
 * Automatically detects available tools and applies configuration.
 */
export async function setupNAT(subnet: string): Promise<Result<void, NATError>> {
  // Detect external interface
  const extIface = await detectExternalInterface();
  if (!extIface) {
    return Result.err(new NATError("Could not detect external interface"));
  }

  const config: NATConfig = {
    subnet,
    externalInterface: extIface,
  };

  // Enable IP forwarding first
  const fwdResult = setIPForwarding(true);
  if (fwdResult.isErr()) {
    return Result.err(fwdResult.error);
  }

  // Try nftables first, fall back to iptables
  if (await isNFTablesAvailable()) {
    const nftConfig = new NFTablesConfig(config);
    return applyNFTables(nftConfig);
  } else {
    return applyIPTables(config);
  }
}

/**
 * High-level NAT teardown function
 */
export async function teardownNAT(subnet: string): Promise<Result<void, NATError>> {
  const extIface = await detectExternalInterface();
  if (!extIface) {
    // Can't detect interface, try to clean up anyway
    await removeNFTables();
    return Result.ok(undefined);
  }

  const config: NATConfig = {
    subnet,
    externalInterface: extIface,
  };

  if (await isNFTablesAvailable()) {
    return removeNFTables();
  } else {
    return removeIPTables(config);
  }
}
