/**
 * IP Address Management (IPAM)
 *
 * Manages allocation of IP addresses from a subnet for microVMs.
 * Supports:
 * - Automatic IP allocation from a pool
 * - IP reservation and release
 * - Persistence of allocations
 * - Subnet management
 */

import { Result } from "better-result";

export class IPAMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IPAMError";
  }

  static is(error: unknown): error is IPAMError {
    return error instanceof IPAMError;
  }
}

/**
 * Parse a CIDR notation string (e.g., "172.16.0.0/24")
 */
export function parseCIDR(cidr: string): {
  network: number;
  prefixLen: number;
  mask: number;
} {
  const [ipStr, prefixStr] = cidr.split("/");
  const prefixLen = parseInt(prefixStr, 10);

  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`Invalid prefix length: ${prefixStr}`);
  }

  const parts = ipStr.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP address: ${ipStr}`);
  }

  const ip = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  const network = (ip & mask) >>> 0;

  return { network, prefixLen, mask };
}

/**
 * Convert a 32-bit number to an IP address string
 */
export function numToIP(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join(".");
}

/**
 * Convert an IP address string to a 32-bit number
 */
export function ipToNum(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Generate a MAC address based on an IP address
 * Uses a fixed OUI (AA:FC:00) + last 3 octets from IP-based hash
 */
export function generateMAC(ip: string, index: number = 0): string {
  const ipNum = ipToNum(ip);
  const hash = (ipNum + index) >>> 0;
  return [
    "AA", // Locally administered
    "FC", // Firecracker/Cloud-hypervisor
    ((hash >>> 24) & 0xff).toString(16).padStart(2, "0"),
    ((hash >>> 16) & 0xff).toString(16).padStart(2, "0"),
    ((hash >>> 8) & 0xff).toString(16).padStart(2, "0"),
    (hash & 0xff).toString(16).padStart(2, "0"),
  ]
    .join(":")
    .toUpperCase();
}

export interface IPAllocation {
  /** The allocated IP address */
  ip: string;
  /** The prefix length (e.g., 24 for /24) */
  prefixLen: number;
  /** The gateway IP (typically .1 of the subnet) */
  gateway: string;
  /** Generated MAC address */
  mac: string;
  /** The TAP device name */
  tapDevice: string;
  /** When the allocation was made */
  allocatedAt: Date;
  /** Optional machine ID this is allocated to */
  machineId?: string;
}

export interface SubnetConfig {
  /** CIDR notation (e.g., "172.16.0.0/24") */
  cidr: string;
  /** Gateway IP (defaults to .1) */
  gateway?: string;
  /** First usable IP offset from network (defaults to 2, leaving .1 for gateway) */
  startOffset?: number;
  /** Last usable IP offset from network (defaults to -2, leaving broadcast) */
  endOffset?: number;
  /** TAP device prefix (e.g., "tap" -> tap0, tap1, ...) */
  tapPrefix?: string;
}

/**
 * IP Address Manager
 *
 * Manages a pool of IP addresses for microVM allocation.
 */
export class IPAM {
  private readonly network: number;
  private readonly prefixLen: number;
  private readonly mask: number;
  private readonly gateway: string;
  private readonly startOffset: number;
  private readonly endOffset: number;
  private readonly tapPrefix: string;

  private allocations = new Map<string, IPAllocation>();
  private ipToMachine = new Map<string, string>();
  private machineToIp = new Map<string, string>();
  private nextTapIndex = 0;

  constructor(config: SubnetConfig) {
    const parsed = parseCIDR(config.cidr);
    this.network = parsed.network;
    this.prefixLen = parsed.prefixLen;
    this.mask = parsed.mask;

    // Calculate subnet size
    const subnetSize = Math.pow(2, 32 - this.prefixLen);

    // Default offsets: skip .0 (network) and .1 (gateway), end before broadcast
    this.startOffset = config.startOffset ?? 2;
    this.endOffset = config.endOffset ?? subnetSize - 2;

    // Gateway defaults to .1
    this.gateway = config.gateway ?? numToIP(this.network + 1);
    this.tapPrefix = config.tapPrefix ?? "tap";

    // Reserve the gateway address
    const gatewayAlloc: IPAllocation = {
      ip: this.gateway,
      prefixLen: this.prefixLen,
      gateway: this.gateway,
      mac: generateMAC(this.gateway, 0),
      tapDevice: `${this.tapPrefix}0`,
      allocatedAt: new Date(),
      machineId: "__gateway__",
    };
    this.allocations.set(this.gateway, gatewayAlloc);
    this.nextTapIndex = 1; // Start VMs at tap1
  }

  /**
   * Get the gateway configuration (for host-side TAP setup)
   */
  getGatewayConfig(): { ip: string; prefixLen: number; tapDevice: string } {
    return {
      ip: this.gateway,
      prefixLen: this.prefixLen,
      tapDevice: `${this.tapPrefix}0`,
    };
  }

  /**
   * Allocate an IP address for a machine
   */
  allocate(machineId: string): Result<IPAllocation, IPAMError> {
    // Check if machine already has an allocation
    const existingIp = this.machineToIp.get(machineId);
    if (existingIp) {
      const existing = this.allocations.get(existingIp);
      if (existing) {
        return Result.ok(existing);
      }
    }

    // Find the next available IP
    for (let offset = this.startOffset; offset <= this.endOffset; offset++) {
      const ipNum = (this.network + offset) >>> 0;
      const ip = numToIP(ipNum);

      if (!this.allocations.has(ip)) {
        const tapDevice = `${this.tapPrefix}${this.nextTapIndex++}`;

        const allocation: IPAllocation = {
          ip,
          prefixLen: this.prefixLen,
          gateway: this.gateway,
          mac: generateMAC(ip, offset),
          tapDevice,
          allocatedAt: new Date(),
          machineId,
        };

        this.allocations.set(ip, allocation);
        this.ipToMachine.set(ip, machineId);
        this.machineToIp.set(machineId, ip);

        return Result.ok(allocation);
      }
    }

    return Result.err(new IPAMError("No available IP addresses in pool"));
  }

  /**
   * Allocate a specific IP address
   */
  allocateSpecific(
    machineId: string,
    ip: string
  ): Result<IPAllocation, IPAMError> {
    // Verify IP is in our subnet
    const ipNum = ipToNum(ip);
    if ((ipNum & this.mask) !== this.network) {
      return Result.err(new IPAMError(`IP ${ip} is not in subnet ${numToIP(this.network)}/${this.prefixLen}`));
    }

    // Check if already allocated
    const existing = this.allocations.get(ip);
    if (existing) {
      if (existing.machineId === machineId) {
        return Result.ok(existing);
      }
      return Result.err(new IPAMError(`IP ${ip} is already allocated to ${existing.machineId}`));
    }

    const tapDevice = `${this.tapPrefix}${this.nextTapIndex++}`;

    const allocation: IPAllocation = {
      ip,
      prefixLen: this.prefixLen,
      gateway: this.gateway,
      mac: generateMAC(ip),
      tapDevice,
      allocatedAt: new Date(),
      machineId,
    };

    this.allocations.set(ip, allocation);
    this.ipToMachine.set(ip, machineId);
    this.machineToIp.set(machineId, ip);

    return Result.ok(allocation);
  }

  /**
   * Release an IP allocation
   */
  release(machineId: string): Result<void, IPAMError> {
    const ip = this.machineToIp.get(machineId);
    if (!ip) {
      return Result.ok(undefined); // Already released or never allocated
    }

    this.allocations.delete(ip);
    this.ipToMachine.delete(ip);
    this.machineToIp.delete(machineId);

    return Result.ok(undefined);
  }

  /**
   * Release by IP address
   */
  releaseIP(ip: string): Result<void, IPAMError> {
    const allocation = this.allocations.get(ip);
    if (!allocation) {
      return Result.ok(undefined);
    }

    if (allocation.machineId === "__gateway__") {
      return Result.err(new IPAMError("Cannot release gateway IP"));
    }

    if (allocation.machineId) {
      this.machineToIp.delete(allocation.machineId);
    }
    this.allocations.delete(ip);
    this.ipToMachine.delete(ip);

    return Result.ok(undefined);
  }

  /**
   * Get allocation for a machine
   */
  getAllocation(machineId: string): IPAllocation | undefined {
    const ip = this.machineToIp.get(machineId);
    return ip ? this.allocations.get(ip) : undefined;
  }

  /**
   * Get allocation by IP
   */
  getAllocationByIP(ip: string): IPAllocation | undefined {
    return this.allocations.get(ip);
  }

  /**
   * List all allocations
   */
  listAllocations(): IPAllocation[] {
    return Array.from(this.allocations.values()).filter(
      (a) => a.machineId !== "__gateway__"
    );
  }

  /**
   * Get statistics about the pool
   */
  getStats(): {
    total: number;
    allocated: number;
    available: number;
    subnet: string;
    gateway: string;
  } {
    const total = this.endOffset - this.startOffset + 1;
    const allocated = this.allocations.size - 1; // Exclude gateway
    return {
      total,
      allocated,
      available: total - allocated,
      subnet: `${numToIP(this.network)}/${this.prefixLen}`,
      gateway: this.gateway,
    };
  }

  /**
   * Export allocations for persistence
   */
  export(): { allocations: IPAllocation[]; nextTapIndex: number } {
    return {
      allocations: Array.from(this.allocations.values()),
      nextTapIndex: this.nextTapIndex,
    };
  }

  /**
   * Import allocations from persistence
   */
  import(data: { allocations: IPAllocation[]; nextTapIndex: number }): void {
    this.allocations.clear();
    this.ipToMachine.clear();
    this.machineToIp.clear();

    for (const alloc of data.allocations) {
      this.allocations.set(alloc.ip, alloc);
      if (alloc.machineId) {
        this.ipToMachine.set(alloc.ip, alloc.machineId);
        this.machineToIp.set(alloc.machineId, alloc.ip);
      }
    }

    this.nextTapIndex = data.nextTapIndex;
  }
}

/**
 * Default IPAM instance using 172.16.0.0/24
 */
export function createDefaultIPAM(): IPAM {
  return new IPAM({
    cidr: "172.16.0.0/24",
    gateway: "172.16.0.1",
    startOffset: 2, // Start at 172.16.0.2
    tapPrefix: "hf", // hf0, hf1, ...
  });
}
