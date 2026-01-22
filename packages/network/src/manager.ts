/**
 * Network Manager
 *
 * High-level API for managing microVM networking.
 * Coordinates TAP devices, IP allocation, and NAT configuration.
 *
 * Usage:
 *   const manager = new NetworkManager();
 *   await manager.initialize();
 *
 *   // Allocate network for a VM
 *   const network = await manager.allocateNetwork("vm-123");
 *
 *   // Use network.tapDevice, network.ip, network.gateway, network.mac
 *   // in your VM configuration
 *
 *   // When done
 *   await manager.releaseNetwork("vm-123");
 *
 *   // Cleanup on shutdown
 *   await manager.shutdown();
 */

import { Result } from "better-result";
import {
  createTapDevice,
  deleteTapDevice,
  closeTapDevice,
  type TapDevice,
  TapError,
} from "./tap";
import {
  addIPAddress,
  deleteIPAddress,
  setInterfaceUp,
  NetlinkError,
} from "./netlink";
import {
  IPAM,
  IPAMError,
} from "./ipam";
import {
  setupNAT,
  teardownNAT,
  setIPForwarding,
  detectExternalInterface,
  NATError,
} from "./nat";

export type NetworkError = TapError | NetlinkError | IPAMError | NATError;

export interface NetworkConfig {
  /** Subnet in CIDR notation (default: "172.16.0.0/24") */
  subnet?: string;
  /** Gateway IP (default: first IP in subnet, e.g., "172.16.0.1") */
  gateway?: string;
  /** TAP device prefix (default: "hf") */
  tapPrefix?: string;
  /** Enable NAT for internet access (default: true) */
  enableNAT?: boolean;
  /** External interface for NAT (auto-detected if not specified) */
  externalInterface?: string;
}

export interface VMNetworkConfig {
  /** The TAP device name for the VM */
  tapDevice: string;
  /** The TAP device file descriptor (for Firecracker) */
  tapFd: number;
  /** The IP address assigned to the VM */
  ip: string;
  /** The prefix length (e.g., 24) */
  prefixLen: number;
  /** The gateway IP */
  gateway: string;
  /** The MAC address for the VM */
  mac: string;
  /** The host-side TAP IP (same as gateway usually) */
  hostIp: string;
  /** Kernel boot arguments for static IP configuration */
  kernelArgs: string;
}

/**
 * Network Manager
 *
 * Manages networking for microVMs including:
 * - TAP device creation and lifecycle
 * - IP address allocation from a pool
 * - NAT configuration for internet access
 */
export class NetworkManager {
  private readonly config: Required<NetworkConfig>;
  private readonly ipam: IPAM;
  private initialized = false;
  private gatewayTap: TapDevice | null = null;
  private vmTaps = new Map<string, TapDevice>();
  private vmNetworks = new Map<string, VMNetworkConfig>();

  constructor(config: NetworkConfig = {}) {
    this.config = {
      subnet: config.subnet ?? "172.16.0.0/24",
      gateway: config.gateway ?? "172.16.0.1",
      tapPrefix: config.tapPrefix ?? "hf",
      enableNAT: config.enableNAT ?? true,
      externalInterface: config.externalInterface ?? "",
    };

    this.ipam = new IPAM({
      cidr: this.config.subnet,
      gateway: this.config.gateway,
      tapPrefix: this.config.tapPrefix,
    });
  }

  /**
   * Initialize the network manager
   *
   * This sets up:
   * - The gateway TAP device
   * - IP forwarding
   * - NAT rules
   */
  async initialize(): Promise<Result<void, NetworkError>> {
    if (this.initialized) {
      return Result.ok(undefined);
    }

    // Detect external interface if not specified
    if (!this.config.externalInterface) {
      const extIface = await detectExternalInterface();
      if (extIface) {
        this.config.externalInterface = extIface;
      }
    }

    // Get gateway config from IPAM
    const gwConfig = this.ipam.getGatewayConfig();

    // Create the gateway TAP device
    const tapResult = createTapDevice({
      name: gwConfig.tapDevice,
      persistent: true,
    });

    if (tapResult.isErr()) {
      return Result.err(tapResult.error);
    }

    this.gatewayTap = tapResult.unwrap();

    // Bring the interface up
    const upResult = setInterfaceUp(this.gatewayTap.name, true);
    if (upResult.isErr()) {
      // Cleanup
      closeTapDevice(this.gatewayTap.fd);
      deleteTapDevice(this.gatewayTap.name);
      this.gatewayTap = null;
      return Result.err(upResult.error);
    }

    // Assign IP address to the gateway TAP
    const ipResult = addIPAddress(
      this.gatewayTap.name,
      gwConfig.ip,
      gwConfig.prefixLen
    );

    if (ipResult.isErr()) {
      // Cleanup
      closeTapDevice(this.gatewayTap.fd);
      deleteTapDevice(this.gatewayTap.name);
      this.gatewayTap = null;
      return Result.err(ipResult.error);
    }

    // Enable IP forwarding
    const fwdResult = setIPForwarding(true);
    if (fwdResult.isErr()) {
      // Non-fatal, NAT won't work but local networking will
      console.warn("Failed to enable IP forwarding:", fwdResult.error.message);
    }

    // Setup NAT if enabled
    if (this.config.enableNAT && this.config.externalInterface) {
      const natResult = await setupNAT(this.config.subnet);
      if (natResult.isErr()) {
        // Non-fatal warning
        console.warn("Failed to setup NAT:", natResult.error.message);
      }
    }

    this.initialized = true;
    return Result.ok(undefined);
  }

  /**
   * Allocate network configuration for a VM
   *
   * Creates a TAP device, allocates an IP, and returns all
   * configuration needed to set up the VM's network.
   */
  async allocateNetwork(machineId: string): Promise<Result<VMNetworkConfig, NetworkError>> {
    if (!this.initialized) {
      const initResult = await this.initialize();
      if (initResult.isErr()) {
        return Result.err(initResult.error);
      }
    }

    // Check if already allocated
    const existing = this.vmNetworks.get(machineId);
    if (existing) {
      return Result.ok(existing);
    }

    // Allocate IP from pool
    const ipResult = this.ipam.allocate(machineId);
    if (ipResult.isErr()) {
      return Result.err(ipResult.error);
    }

    const allocation = ipResult.unwrap();

    // Create TAP device for the VM
    const tapResult = createTapDevice({
      name: allocation.tapDevice,
      persistent: true,
    });

    if (tapResult.isErr()) {
      // Release IP allocation
      this.ipam.release(machineId);
      return Result.err(tapResult.error);
    }

    const tap = tapResult.unwrap();

    // Bring the TAP interface up
    const upResult = setInterfaceUp(tap.name, true);
    if (upResult.isErr()) {
      // Cleanup
      closeTapDevice(tap.fd);
      deleteTapDevice(tap.name);
      this.ipam.release(machineId);
      return Result.err(upResult.error);
    }

    // Store TAP device
    this.vmTaps.set(machineId, tap);

    // Build kernel args for static IP configuration
    // Format: ip=<client-ip>:<server-ip>:<gw-ip>:<netmask>:<hostname>:<device>:<autoconf>
    const netmask = this.prefixToNetmask(allocation.prefixLen);
    const kernelArgs = `ip=${allocation.ip}::${allocation.gateway}:${netmask}::eth0:off`;

    const vmNetwork: VMNetworkConfig = {
      tapDevice: tap.name,
      tapFd: tap.fd,
      ip: allocation.ip,
      prefixLen: allocation.prefixLen,
      gateway: allocation.gateway,
      mac: allocation.mac,
      hostIp: this.config.gateway,
      kernelArgs,
    };

    this.vmNetworks.set(machineId, vmNetwork);

    return Result.ok(vmNetwork);
  }

  /**
   * Release network resources for a VM
   */
  async releaseNetwork(machineId: string): Promise<Result<void, NetworkError>> {
    // Get TAP device
    const tap = this.vmTaps.get(machineId);
    if (tap) {
      // Close and delete TAP device
      closeTapDevice(tap.fd);
      const deleteResult = deleteTapDevice(tap.name);
      if (deleteResult.isErr()) {
        console.warn(`Failed to delete TAP device ${tap.name}:`, deleteResult.error.message);
      }
      this.vmTaps.delete(machineId);
    }

    // Release IP allocation
    this.ipam.release(machineId);

    // Remove from networks map
    this.vmNetworks.delete(machineId);

    return Result.ok(undefined);
  }

  /**
   * Get network configuration for a VM (if allocated)
   */
  getNetwork(machineId: string): VMNetworkConfig | undefined {
    return this.vmNetworks.get(machineId);
  }

  /**
   * List all allocated networks
   */
  listNetworks(): VMNetworkConfig[] {
    return Array.from(this.vmNetworks.values());
  }

  /**
   * Get network statistics
   */
  getStats(): {
    initialized: boolean;
    subnet: string;
    gateway: string;
    allocated: number;
    available: number;
    externalInterface: string | null;
  } {
    const ipamStats = this.ipam.getStats();
    return {
      initialized: this.initialized,
      subnet: this.config.subnet,
      gateway: this.config.gateway,
      allocated: ipamStats.allocated,
      available: ipamStats.available,
      externalInterface: this.config.externalInterface || null,
    };
  }

  /**
   * Shutdown the network manager
   *
   * Releases all VM networks and cleans up gateway resources.
   */
  async shutdown(): Promise<Result<void, NetworkError>> {
    // Release all VM networks
    for (const machineId of this.vmNetworks.keys()) {
      await this.releaseNetwork(machineId);
    }

    // Remove NAT rules
    if (this.config.enableNAT) {
      await teardownNAT(this.config.subnet);
    }

    // Delete gateway IP
    if (this.gatewayTap) {
      const gwConfig = this.ipam.getGatewayConfig();
      deleteIPAddress(this.gatewayTap.name, gwConfig.ip, gwConfig.prefixLen);

      // Close and delete gateway TAP
      closeTapDevice(this.gatewayTap.fd);
      deleteTapDevice(this.gatewayTap.name);
      this.gatewayTap = null;
    }

    this.initialized = false;
    return Result.ok(undefined);
  }

  /**
   * Convert prefix length to netmask string
   */
  private prefixToNetmask(prefixLen: number): string {
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    return [
      (mask >>> 24) & 0xff,
      (mask >>> 16) & 0xff,
      (mask >>> 8) & 0xff,
      mask & 0xff,
    ].join(".");
  }
}

/**
 * Global network manager instance
 *
 * For applications that want a singleton manager.
 */
let globalManager: NetworkManager | null = null;

export function getNetworkManager(): NetworkManager {
  if (!globalManager) {
    globalManager = new NetworkManager();
  }
  return globalManager;
}

export function setNetworkManager(manager: NetworkManager): void {
  globalManager = manager;
}
