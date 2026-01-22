/**
 * @hyperfleet/network
 *
 * Network management for microVMs.
 *
 * Features:
 * - TAP device creation using ioctl (no shell commands)
 * - IP address allocation (IPAM)
 * - NAT configuration for internet access
 * - High-level NetworkManager API
 *
 * @example
 * ```typescript
 * import { NetworkManager } from "@hyperfleet/network";
 *
 * const manager = new NetworkManager();
 * await manager.initialize();
 *
 * // Allocate network for a VM
 * const result = await manager.allocateNetwork("vm-123");
 * if (result.isOk()) {
 *   const network = result.unwrap();
 *   console.log(`TAP: ${network.tapDevice}`);
 *   console.log(`IP: ${network.ip}/${network.prefixLen}`);
 *   console.log(`Gateway: ${network.gateway}`);
 *   console.log(`MAC: ${network.mac}`);
 *   console.log(`Kernel args: ${network.kernelArgs}`);
 * }
 *
 * // Use in Firecracker config:
 * // - network.tapDevice -> host_dev_name
 * // - network.mac -> guest_mac
 * // - network.kernelArgs -> append to kernel boot args
 *
 * // Release when done
 * await manager.releaseNetwork("vm-123");
 *
 * // Shutdown
 * await manager.shutdown();
 * ```
 */

// TAP device management (low-level)
export {
  createTapDevice,
  closeTapDevice,
  deleteTapDevice,
  tapDeviceExists,
  TapError,
  type TapDevice,
  type TapDeviceConfig,
} from "./tap";

// Netlink interface (low-level)
export {
  addIPAddress,
  deleteIPAddress,
  setInterfaceUp,
  getInterfaceIndex,
  parseIPv4,
  formatIPv4,
  calculateBroadcast,
  NetlinkSocket,
  NetlinkError,
} from "./netlink";

// IP Address Management
export {
  IPAM,
  createDefaultIPAM,
  parseCIDR,
  numToIP,
  ipToNum,
  generateMAC,
  IPAMError,
  type IPAllocation,
  type SubnetConfig,
} from "./ipam";

// NAT configuration
export {
  setupNAT,
  teardownNAT,
  setIPForwarding,
  isIPForwardingEnabled,
  detectExternalInterface,
  isNFTablesAvailable,
  applyNFTables,
  removeNFTables,
  applyIPTables,
  removeIPTables,
  NFTablesConfig,
  NATError,
  type NATConfig,
} from "./nat";

// High-level Network Manager
export {
  NetworkManager,
  getNetworkManager,
  setNetworkManager,
  type NetworkConfig,
  type VMNetworkConfig,
  type NetworkError,
} from "./manager";
