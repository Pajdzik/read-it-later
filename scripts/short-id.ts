import { createHash } from "node:crypto";

const ARTICLE_ID = /^[a-z0-9]{8}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SPACE = 36n ** 8n;

export function isShortArticleId(value: unknown): value is string {
  return typeof value === "string" && ARTICLE_ID.test(value);
}

function candidate(key: string, attempt: number): string {
  const digest = createHash("sha256").update(`potem-short-id-v1\0${key}\0${attempt}`).digest();
  let value = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`) % SPACE;
  let output = "";
  for (let index = 0; index < 8; index++) {
    output = ALPHABET[Number(value % 36n)] + output;
    value /= 36n;
  }
  return output;
}

/** Deterministic mapping for offline converters. Pre-reserve all supplied short IDs first. */
export function createShortIdMapper(reservedIds: Iterable<string> = []): (oldId: string) => string {
  const reserved = new Set([...reservedIds].filter(isShortArticleId));
  const mapped = new Map<string, string>();
  return oldId => {
    const existing = mapped.get(oldId);
    if (existing) return existing;
    if (isShortArticleId(oldId)) {
      if (reserved.has(oldId)) {
        mapped.set(oldId, oldId);
        return oldId;
      }
      reserved.add(oldId);
      mapped.set(oldId, oldId);
      return oldId;
    }
    for (let attempt = 0; attempt < 1000; attempt++) {
      const id = candidate(oldId, attempt);
      if (reserved.has(id)) continue;
      reserved.add(id);
      mapped.set(oldId, id);
      return id;
    }
    throw new Error("Unable to allocate a collision-free short article ID.");
  };
}
