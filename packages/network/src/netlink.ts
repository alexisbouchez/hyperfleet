/**
 * Netlink Interface for Network Configuration
 *
 * Uses Linux netlink sockets (NETLINK_ROUTE) to configure:
 * - IP addresses on interfaces
 * - Routes
 * - Interface state (up/down)
 *
 * This avoids shelling out to `ip` commands and provides proper error handling.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { Result } from "better-result";

// Socket constants
const AF_NETLINK = 16;
const SOCK_DGRAM = 2;
const NETLINK_ROUTE = 0;

// Netlink message types (rtnetlink)
const RTM_NEWADDR = 20;
const RTM_DELADDR = 21;

// Netlink flags
const NLM_F_REQUEST = 0x01;
const NLM_F_ACK = 0x04;
const NLM_F_CREATE = 0x400;
const NLM_F_EXCL = 0x200;

// Address families
const AF_INET = 2;

// Interface flags
const IFF_UP = 0x1;
const IFF_RUNNING = 0x40;

// Attribute types for addresses
const IFA_LOCAL = 2;
const IFA_BROADCAST = 4;

// ioctl for getting/setting interface flags
const SIOCGIFFLAGS = 0x8913;
const SIOCSIFFLAGS = 0x8914;

// Load libc
const libc = dlopen("libc.so.6", {
  socket: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  close: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  bind: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  send: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32],
    returns: FFIType.i64,
  },
  recv: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32],
    returns: FFIType.i64,
  },
  ioctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  if_nametoindex: {
    args: [FFIType.cstring],
    returns: FFIType.u32,
  },
});

export class NetlinkError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = "NetlinkError";
  }

  static is(error: unknown): error is NetlinkError {
    return error instanceof NetlinkError;
  }
}

/**
 * Parse an IPv4 address string to a 4-byte array
 */
export function parseIPv4(ip: string): Uint8Array {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return new Uint8Array(parts);
}

/**
 * Format a 4-byte array as an IPv4 address string
 */
export function formatIPv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".");
}

/**
 * Calculate broadcast address from IP and prefix length
 */
export function calculateBroadcast(ip: string, prefixLen: number): string {
  const ipBytes = parseIPv4(ip);
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  const ipNum =
    (ipBytes[0] << 24) | (ipBytes[1] << 16) | (ipBytes[2] << 8) | ipBytes[3];
  const broadcast = (ipNum | ~mask) >>> 0;
  return [
    (broadcast >>> 24) & 0xff,
    (broadcast >>> 16) & 0xff,
    (broadcast >>> 8) & 0xff,
    broadcast & 0xff,
  ].join(".");
}

/**
 * Get the index of a network interface by name
 */
export function getInterfaceIndex(name: string): Result<number, NetlinkError> {
  const index = libc.symbols.if_nametoindex(ptr(Buffer.from(name + "\0")));
  if (index === 0) {
    return Result.err(new NetlinkError(`Interface not found: ${name}`));
  }
  return Result.ok(index);
}

/**
 * Build a netlink message header
 */
function buildNlmsghdr(
  len: number,
  type: number,
  flags: number,
  seq: number,
  pid: number
): Uint8Array {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  view.setUint32(0, len, true); // nlmsg_len
  view.setUint16(4, type, true); // nlmsg_type
  view.setUint16(6, flags, true); // nlmsg_flags
  view.setUint32(8, seq, true); // nlmsg_seq
  view.setUint32(12, pid, true); // nlmsg_pid
  return buf;
}

/**
 * Build an interface address message
 */
function buildIfaddrmsg(
  family: number,
  prefixLen: number,
  flags: number,
  scope: number,
  index: number
): Uint8Array {
  const buf = new Uint8Array(8);
  buf[0] = family; // ifa_family
  buf[1] = prefixLen; // ifa_prefixlen
  buf[2] = flags; // ifa_flags
  buf[3] = scope; // ifa_scope
  new DataView(buf.buffer).setInt32(4, index, true); // ifa_index
  return buf;
}

/**
 * Build an rtattr (route attribute)
 */
function buildRtattr(type: number, data: Uint8Array): Uint8Array {
  const len = 4 + data.length;
  const padLen = (len + 3) & ~3; // Align to 4 bytes
  const buf = new Uint8Array(padLen);
  const view = new DataView(buf.buffer);
  view.setUint16(0, len, true); // rta_len
  view.setUint16(2, type, true); // rta_type
  buf.set(data, 4);
  return buf;
}

/**
 * Build a sockaddr_nl structure
 */
function buildSockaddrNl(pid: number = 0, groups: number = 0): Uint8Array {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setUint16(0, AF_NETLINK, true); // nl_family
  view.setUint16(2, 0, true); // nl_pad
  view.setUint32(4, pid, true); // nl_pid
  view.setUint32(8, groups, true); // nl_groups
  return buf;
}

let seqCounter = 1;

/**
 * NetlinkSocket class for sending/receiving netlink messages
 */
export class NetlinkSocket {
  private fd: number = -1;

  constructor() {}

  /**
   * Open the netlink socket
   */
  open(): Result<void, NetlinkError> {
    this.fd = libc.symbols.socket(AF_NETLINK, SOCK_DGRAM, NETLINK_ROUTE);
    if (this.fd < 0) {
      return Result.err(new NetlinkError("Failed to create netlink socket", this.fd));
    }

    // Bind to kernel
    const addr = buildSockaddrNl(0, 0);
    const bindResult = libc.symbols.bind(this.fd, ptr(addr), addr.length);
    if (bindResult < 0) {
      libc.symbols.close(this.fd);
      this.fd = -1;
      return Result.err(new NetlinkError("Failed to bind netlink socket", bindResult));
    }

    return Result.ok(undefined);
  }

  /**
   * Close the netlink socket
   */
  close(): void {
    if (this.fd >= 0) {
      libc.symbols.close(this.fd);
      this.fd = -1;
    }
  }

  /**
   * Send a netlink message and wait for ACK
   */
  private sendAndWaitAck(msg: Uint8Array): Result<void, NetlinkError> {
    if (this.fd < 0) {
      return Result.err(new NetlinkError("Socket not open"));
    }

    // Send the message
    const sent = libc.symbols.send(this.fd, ptr(msg), msg.length, 0);
    if (sent < 0) {
      return Result.err(new NetlinkError("Failed to send netlink message", Number(sent)));
    }

    // Receive the response
    const recvBuf = new Uint8Array(4096);
    const recvLen = libc.symbols.recv(this.fd, ptr(recvBuf), recvBuf.length, 0);
    if (recvLen < 0) {
      return Result.err(new NetlinkError("Failed to receive netlink response", Number(recvLen)));
    }

    // Parse the response header
    if (recvLen >= 16) {
      const view = new DataView(recvBuf.buffer);
      const msgType = view.getUint16(4, true);

      if (msgType === 2) {
        // NLMSG_ERROR
        const errorCode = view.getInt32(16, true);
        if (errorCode < 0) {
          return Result.err(new NetlinkError(`Netlink error: ${-errorCode}`, errorCode));
        }
      }
    }

    return Result.ok(undefined);
  }

  /**
   * Add an IP address to an interface
   */
  addAddress(
    ifname: string,
    ip: string,
    prefixLen: number
  ): Result<void, NetlinkError> {
    const indexResult = getInterfaceIndex(ifname);
    if (indexResult.isErr()) {
      return Result.err(indexResult.error);
    }
    const ifindex = indexResult.unwrap();

    const ipBytes = parseIPv4(ip);
    const broadcast = calculateBroadcast(ip, prefixLen);
    const broadcastBytes = parseIPv4(broadcast);

    // Build attributes
    const addrAttr = buildRtattr(IFA_LOCAL, ipBytes);
    const bcastAttr = buildRtattr(IFA_BROADCAST, broadcastBytes);

    // Build ifaddrmsg
    const ifamsg = buildIfaddrmsg(AF_INET, prefixLen, 0, 0, ifindex);

    // Calculate total length
    const payloadLen = ifamsg.length + addrAttr.length + bcastAttr.length;
    const totalLen = 16 + payloadLen; // nlmsghdr + payload

    // Build the complete message
    const msg = new Uint8Array(totalLen);
    const hdr = buildNlmsghdr(
      totalLen,
      RTM_NEWADDR,
      NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
      seqCounter++,
      0
    );

    let offset = 0;
    msg.set(hdr, offset);
    offset += hdr.length;
    msg.set(ifamsg, offset);
    offset += ifamsg.length;
    msg.set(addrAttr, offset);
    offset += addrAttr.length;
    msg.set(bcastAttr, offset);

    return this.sendAndWaitAck(msg);
  }

  /**
   * Remove an IP address from an interface
   */
  deleteAddress(
    ifname: string,
    ip: string,
    prefixLen: number
  ): Result<void, NetlinkError> {
    const indexResult = getInterfaceIndex(ifname);
    if (indexResult.isErr()) {
      return Result.err(indexResult.error);
    }
    const ifindex = indexResult.unwrap();

    const ipBytes = parseIPv4(ip);
    const addrAttr = buildRtattr(IFA_LOCAL, ipBytes);
    const ifamsg = buildIfaddrmsg(AF_INET, prefixLen, 0, 0, ifindex);

    const payloadLen = ifamsg.length + addrAttr.length;
    const totalLen = 16 + payloadLen;

    const msg = new Uint8Array(totalLen);
    const hdr = buildNlmsghdr(totalLen, RTM_DELADDR, NLM_F_REQUEST | NLM_F_ACK, seqCounter++, 0);

    let offset = 0;
    msg.set(hdr, offset);
    offset += hdr.length;
    msg.set(ifamsg, offset);
    offset += ifamsg.length;
    msg.set(addrAttr, offset);

    return this.sendAndWaitAck(msg);
  }
}

/**
 * Set interface up/down using ioctl
 */
export function setInterfaceUp(ifname: string, up: boolean): Result<void, NetlinkError> {
  // Create a socket for ioctl
  const sock = libc.symbols.socket(AF_INET, SOCK_DGRAM, 0);
  if (sock < 0) {
    return Result.err(new NetlinkError("Failed to create socket for ioctl", sock));
  }

  try {
    // Build ifreq structure
    const ifreq = new Uint8Array(40);
    const nameBytes = new TextEncoder().encode(ifname);
    ifreq.set(nameBytes.subarray(0, Math.min(nameBytes.length, 15)), 0);

    // Get current flags
    const getResult = libc.symbols.ioctl(sock, SIOCGIFFLAGS, ptr(ifreq));
    if (getResult < 0) {
      return Result.err(new NetlinkError("Failed to get interface flags", getResult));
    }

    // Read current flags (at offset 16)
    const view = new DataView(ifreq.buffer);
    let flags = view.getInt16(16, true);

    // Modify flags
    if (up) {
      flags |= IFF_UP | IFF_RUNNING;
    } else {
      flags &= ~(IFF_UP | IFF_RUNNING);
    }

    // Write new flags
    view.setInt16(16, flags, true);

    // Set new flags
    const setResult = libc.symbols.ioctl(sock, SIOCSIFFLAGS, ptr(ifreq));
    if (setResult < 0) {
      return Result.err(new NetlinkError("Failed to set interface flags", setResult));
    }

    return Result.ok(undefined);
  } finally {
    libc.symbols.close(sock);
  }
}

/**
 * Convenience function to add an IP address to an interface
 */
export function addIPAddress(
  ifname: string,
  ip: string,
  prefixLen: number
): Result<void, NetlinkError> {
  const socket = new NetlinkSocket();

  const openResult = socket.open();
  if (openResult.isErr()) {
    return Result.err(openResult.error);
  }

  try {
    return socket.addAddress(ifname, ip, prefixLen);
  } finally {
    socket.close();
  }
}

/**
 * Convenience function to remove an IP address from an interface
 */
export function deleteIPAddress(
  ifname: string,
  ip: string,
  prefixLen: number
): Result<void, NetlinkError> {
  const socket = new NetlinkSocket();

  const openResult = socket.open();
  if (openResult.isErr()) {
    return Result.err(openResult.error);
  }

  try {
    return socket.deleteAddress(ifname, ip, prefixLen);
  } finally {
    socket.close();
  }
}
