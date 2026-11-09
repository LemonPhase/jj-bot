// Who a request comes from, for the sign-in and bearer rate limits: the
// socket's peer address, unless the peer is a trusted proxy
// (`JJ_TRUSTED_PROXIES`), whose `X-Forwarded-For` then names the client. The
// list is read right to left, skipping trusted proxies, so a client cannot
// pick its own address by sending the header itself.
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import type { Context } from "hono";

/** `JJ_TRUSTED_PROXIES` when unset. */
export const DEFAULT_TRUSTED_PROXIES = "loopback";

export interface TrustedProxies {
  /** Whether a peer at `address` may name the client in `X-Forwarded-For`. */
  trusts(address: string): boolean;
  /** The setting as given, for messages. */
  readonly setting: string;
}

/** A malformed `JJ_TRUSTED_PROXIES` entry. */
export class TrustedProxiesError extends Error {
  override readonly name = "TrustedProxiesError";
}

/** `::ffff:192.0.2.1` as `192.0.2.1`; anything else as it is, lowercased. */
export function normalizeAddress(address: string): string {
  const value = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return mapped ? (mapped[1] as string) : value;
}

const family = (address: string) =>
  isIP(address) === 6 ? ("ipv6" as const) : ("ipv4" as const);

function addSubnet(list: BlockList, address: string, prefix: number) {
  list.addSubnet(address, prefix, family(address));
}

/**
 * Parses `JJ_TRUSTED_PROXIES`: comma-separated addresses and CIDR ranges, and
 * the keywords `loopback` (127.0.0.0/8 and ::1) and `local-subnets` (the
 * subnets of this machine's own interfaces, read now: in a container, its
 * networks, where a proxy container such as the compose `https` profile's
 * Caddy sits). `none` trusts nobody.
 */
export function parseTrustedProxies(
  setting: string = DEFAULT_TRUSTED_PROXIES,
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): TrustedProxies {
  const list = new BlockList();
  const entries = setting
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === "none") continue;
    if (entry === "loopback") {
      addSubnet(list, "127.0.0.0", 8);
      list.addAddress("::1", "ipv6");
      continue;
    }
    if (entry === "local-subnets") {
      for (const infos of Object.values(interfaces()))
        for (const info of infos ?? []) {
          if (!info.cidr) continue;
          const [address, prefix] = info.cidr.split("/");
          const ip = normalizeAddress(address as string);
          // An address this machine names oddly (a zone id) is not a proxy's.
          if (isIP(ip) !== 0) addSubnet(list, ip, Number(prefix));
        }
      continue;
    }
    const [address, prefix, extra] = entry.split("/");
    const ip = normalizeAddress(address ?? "");
    const kind = isIP(ip);
    const bits =
      prefix === undefined ? (kind === 6 ? 128 : 32) : Number(prefix);
    if (
      kind === 0 ||
      extra !== undefined ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
      bits > (kind === 6 ? 128 : 32)
    )
      throw new TrustedProxiesError(
        `JJ_TRUSTED_PROXIES lists IP addresses and CIDR ranges, comma-separated, and the keywords loopback, local-subnets and none; "${entry}" is none of them.`,
      );
    addSubnet(list, ip, bits);
  }
  return {
    setting,
    trusts: (address) => {
      const ip = normalizeAddress(address);
      return isIP(ip) !== 0 && list.check(ip, family(ip));
    },
  };
}

/** The socket's peer address; "unknown" for an in-process request (tests). */
export function peerAddress(c: Context): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)
    ?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return address ? normalizeAddress(address) : "unknown";
}

/** The client a request counts against. */
export function clientAddress(c: Context, trusted: TrustedProxies): string {
  const peer = peerAddress(c);
  if (!trusted.trusts(peer)) return peer;
  const forwarded = (c.req.header("X-Forwarded-For") ?? "")
    .split(",")
    .map((entry) => normalizeAddress(entry))
    .filter(Boolean);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const hop = forwarded[index] as string;
    if (isIP(hop) === 0) return peer;
    if (!trusted.trusts(hop)) return hop;
  }
  return forwarded[0] ?? peer;
}
