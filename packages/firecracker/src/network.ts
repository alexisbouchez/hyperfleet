/**
 * Network configuration for Firecracker microVMs
 */

import type { NetworkInterface, RateLimiter } from "./models";

export interface IPConfiguration {
  ipAddr: string;
  gateway: string;
  nameservers?: string[];
}

export interface StaticNetworkConfiguration {
  hostDevName: string;
  macAddress?: string;
  ipConfig?: IPConfiguration;
}

export interface NetworkInterfaceConfig {
  ifaceId: string;
  staticConfig?: StaticNetworkConfiguration;
  rxRateLimiter?: RateLimiter;
  txRateLimiter?: RateLimiter;
  allowMmdsRequests?: boolean;
}

export type NetworkInterfaceOpt = (
  config: NetworkInterfaceConfig
) => NetworkInterfaceConfig;

export function withMacAddress(mac: string): NetworkInterfaceOpt {
  return (config) => ({
    ...config,
    staticConfig: {
      ...config.staticConfig!,
      macAddress: mac,
    },
  });
}

export function withIPConfig(ipConfig: IPConfiguration): NetworkInterfaceOpt {
  return (config) => ({
    ...config,
    staticConfig: {
      ...config.staticConfig!,
      ipConfig,
    },
  });
}

export function withRxRateLimiter(rateLimiter: RateLimiter): NetworkInterfaceOpt {
  return (config) => ({
    ...config,
    rxRateLimiter: rateLimiter,
  });
}

export function withTxRateLimiter(rateLimiter: RateLimiter): NetworkInterfaceOpt {
  return (config) => ({
    ...config,
    txRateLimiter: rateLimiter,
  });
}

export function withMmdsAccess(): NetworkInterfaceOpt {
  return (config) => ({
    ...config,
    allowMmdsRequests: true,
  });
}

export class NetworkBuilder {
  private interfaces: NetworkInterfaceConfig[] = [];

  addInterface(
    ifaceId: string,
    hostDevName: string,
    ...opts: NetworkInterfaceOpt[]
  ): this {
    let config: NetworkInterfaceConfig = {
      ifaceId,
      staticConfig: { hostDevName },
    };

    for (const opt of opts) {
      config = opt(config);
    }

    this.interfaces.push(config);
    return this;
  }

  build(): NetworkInterface[] {
    return this.interfaces.map((config) => ({
      iface_id: config.ifaceId,
      host_dev_name: config.staticConfig!.hostDevName,
      guest_mac: config.staticConfig?.macAddress,
      rx_rate_limiter: config.rxRateLimiter,
      tx_rate_limiter: config.txRateLimiter,
    }));
  }

  getKernelBootArgs(): string[] {
    const args: string[] = [];

    for (const config of this.interfaces) {
      if (config.staticConfig?.ipConfig) {
        const { ipAddr, gateway } = config.staticConfig.ipConfig;
        // Format: ip=<client-ip>:<server-ip>:<gw-ip>:<netmask>:<hostname>:<device>:<autoconf>
        const [ip, cidr] = ipAddr.split("/");
        const netmask = cidrToNetmask(parseInt(cidr || "24", 10));
        args.push(`ip=${ip}::${gateway}:${netmask}::eth0:off`);
      }
    }

    return args;
  }
}

function cidrToNetmask(cidr: number): string {
  const mask = ~(2 ** (32 - cidr) - 1);
  return [
    (mask >>> 24) & 255,
    (mask >>> 16) & 255,
    (mask >>> 8) & 255,
    mask & 255,
  ].join(".");
}

/**
 * Generate a random MAC address with the locally administered bit set
 */
export function generateMacAddress(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  // Set locally administered bit and clear multicast bit
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}
