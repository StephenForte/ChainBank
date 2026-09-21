import { BlockList, isIP } from 'node:net';
import { ChainBankError } from '../domain/errors.js';

/**
 * Private (RFC 1918), IPv4 loopback, and IPv6 unique-local ranges.
 *
 * This is a startup default for peers that may present a private address.
 * It is not a claim about any host's published proxy list. Confirm the
 * socket address observed on a hosted request before relying on it.
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,fc00::/7';

/** Node reports dual-stack IPv4 peers as dotted IPv4-mapped IPv6. */
const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

interface Cidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: 'ipv4' | 'ipv6';
}

/**
 * Parses a comma-separated proxy allowlist into canonical `address/prefix` entries.
 *
 * An empty list is rejected. Treating it as "trust every peer" would honour a
 * forged X-Forwarded-For from any caller. A prefix of 0 is the same failure.
 */
export function parseTrustedProxyCidrs(value: string): readonly string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'TRUSTED_PROXY_CIDRS must name at least one proxy address or CIDR. An empty list is rejected so it cannot be read as trust-all.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return entries.map((entry) => {
    const parsed = parseCidr(entry);
    return `${parsed.address}/${String(parsed.prefix)}`;
  });
}

/**
 * Trusts a peer only when `address` falls in the configured set.
 *
 * The hop index is intentionally unused. A predicate that ignores `address`
 * and keys only on hop count is the CVE-2026-16732 bypass: every direct
 * caller is treated as the trusted proxy.
 */
export function createTrustProxy(cidrs: readonly string[]): (address: string, hop: number) => boolean {
  if (cidrs.length === 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'TRUSTED_PROXY_CIDRS must name at least one proxy address or CIDR. An empty list is rejected so it cannot be read as trust-all.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    blockList.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }

  return (address, hop) => {
    // Fastify's callback includes the hop index. It must not decide trust:
    // a hop-only predicate is the CVE-2026-16732 bypass.
    void hop;
    const peer = classifyPeer(address);
    if (peer === undefined) {
      return false;
    }
    return blockList.check(peer.address, peer.family);
  };
}

function parseCidr(entry: string): Cidr {
  const slash = entry.lastIndexOf('/');
  const addressText = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);
  const mapped = IPV4_MAPPED_DOTTED.exec(addressText);

  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) {
    const mappedPrefix = readPrefix(entry, prefixText, 128);
    if (mappedPrefix < 96) {
      invalidCidr(entry, 'IPv4-mapped prefix must be between 96 and 128');
    }
    const prefix = mappedPrefix - 96;
    if (prefix === 0) {
      invalidCidr(entry, 'prefix 0 trusts every address of that family');
    }
    return { address: mapped[1], prefix, family: 'ipv4' };
  }

  const version = isIP(addressText);
  if (version === 0) {
    invalidCidr(entry, 'address is not a valid IP');
  }

  const family = version === 4 ? 'ipv4' : 'ipv6';
  const prefix = readPrefix(entry, prefixText, family === 'ipv4' ? 32 : 128);
  if (prefix === 0) {
    invalidCidr(entry, 'prefix 0 trusts every address of that family');
  }
  return { address: addressText, prefix, family };
}

function readPrefix(entry: string, prefixText: string | undefined, max: number): number {
  if (prefixText === undefined) {
    return max;
  }
  if (!/^\d+$/.test(prefixText)) {
    invalidCidr(entry, 'prefix must be an integer');
  }
  const prefix = Number.parseInt(prefixText, 10);
  if (!Number.isSafeInteger(prefix) || prefix > max) {
    invalidCidr(entry, `prefix must be between 0 and ${String(max)}`);
  }
  return prefix;
}

function classifyPeer(
  address: string,
): { readonly address: string; readonly family: 'ipv4' | 'ipv6' } | undefined {
  const mapped = IPV4_MAPPED_DOTTED.exec(address);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) {
    return { address: mapped[1], family: 'ipv4' };
  }
  const version = isIP(address);
  if (version === 4) {
    return { address, family: 'ipv4' };
  }
  if (version === 6) {
    return { address, family: 'ipv6' };
  }
  return undefined;
}

function invalidCidr(entry: string, reason: string): never {
  throw new ChainBankError(
    'INVALID_CONFIGURATION',
    `TRUSTED_PROXY_CIDRS entry "${entry}" is not a usable proxy address or CIDR: ${reason}.`,
    { publicMessage: 'The service is misconfigured.' },
  );
}
