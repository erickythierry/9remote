import net from "net";
import { TRUSTED_CIDRS } from "../cli/config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** BlockList from "a.b.c.d/nn" entries; throws on a malformed entry so a typo fails boot, not admission. */
export function buildTrustedList(cidrs) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [addr, bits] = cidr.split("/");
    const family = net.isIPv6(addr) ? "ipv6" : "ipv4";
    const prefix = Number(bits ?? (family === "ipv6" ? 128 : 32));
    if (!net.isIP(addr) || !Number.isInteger(prefix)) throw new Error(`Invalid NREMOTE_TRUSTED_CIDRS entry: ${cidr}`);
    list.addSubnet(addr, prefix, family);
  }
  return list;
}

const trusted = buildTrustedList(TRUSTED_CIDRS);

/** Peer inside a self-hosted VPN range. Never true when TRUSTED_CIDRS is empty. */
export function isTrustedVpnAddress(addr, list = trusted) {
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (net.isIPv4(v4)) return list.check(v4, "ipv4");
  return net.isIPv6(addr) ? list.check(addr, "ipv6") : false;
}

/** Self-hosted listens on all interfaces; only loopback and VPN peers may open a connection. */
export function isAllowedPeer(addr, list = trusted) {
  return LOOPBACK.has(addr) || isTrustedVpnAddress(addr, list);
}
