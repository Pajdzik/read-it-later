import { isIP } from "node:net";

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inV4(address: number, base: string, bits: number): boolean {
  const b = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (b & mask);
}

export function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return false;
  const denied: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !denied.some(([base, bits]) => inV4(value, base, bits));
}

function ipv6Number(address: string): bigint | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;
  let input = address.toLowerCase();
  const dot = input.lastIndexOf(":");
  if (input.includes(".")) {
    const embedded = ipv4Number(input.slice(dot + 1));
    if (embedded === undefined) return undefined;
    input = `${input.slice(0, dot)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, zeros)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[\da-f]{1,4}$/.test(part))) return undefined;
  return groups.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}

function inV6(address: bigint, base: bigint, bits: number): boolean {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (address & mask) === (base & mask);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value === undefined) return false;
  const mapped = value >> 32n === 0xffffn;
  if (mapped) {
    const v4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
  }
  // Conservatively allow only global-unicast 2000::/3; exclude ranges with
  // transition, documentation, benchmarking, and special-purpose semantics.
  if (!inV6(value, 0x20000000000000000000000000000000n, 3)) return false;
  return !inV6(value, 0x20010000000000000000000000000000n, 23) &&
    !inV6(value, 0x20010db8000000000000000000000000n, 32) &&
    !inV6(value, 0x20020000000000000000000000000000n, 16) &&
    !inV6(value, 0x3fff0000000000000000000000000000n, 20);
}
