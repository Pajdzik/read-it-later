import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeAudio, hashAudioCapability, serveScopedAudio } from "../audio-capabilities";

const episodeId = "1c651e4e-812f-4804-8c2c-424fefb1052c";
const chunkKey = `audio/chunks/${episodeId}/0-3-57d7e1cc-089a-4c46-9c8c-5d019eb7fa1e.wav`;

test("scoped chunk capability is backed by D1 state, works across module contexts, and revokes", async () => {
  const cap = "c".repeat(64);
  let grant: { hash: string; episodeId: string; generation: number; expiresAt: string } | undefined = {
    hash: await hashAudioCapability(cap), episodeId, generation: 3, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let bucketReads = 0;
  const chunkRows = [{ chunkIndex: 0, objectKey: chunkKey, state: "succeeded", generation: 3 }];
  class Statement {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async all<T>() { return { results: chunkRows as T[] }; }
    async first<T>() {
      if (this.sql.includes("audio_assembly_grants g JOIN audio_episodes")) {
        const [index, hash] = this.values;
        if (grant && grant.hash === hash && grant.expiresAt > new Date().toISOString() && index === 0) return { objectKey: chunkKey } as T;
      }
      return null;
    }
    async run() {
      if (this.sql.startsWith("DELETE FROM audio_assembly_grants WHERE token_hash = ?")) {
        if (grant?.hash === this.values[0]) grant = undefined;
      }
      return { meta: { changes: 0 } };
    }
  }
  const env = {
    DB: { prepare: (sql: string) => new Statement(sql) },
    AUDIO_BUCKET: { async get(key: string) { bucketReads++; assert.equal(key, chunkKey); return { body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); controller.close(); } }), size: 3 }; } },
  } as never;

  assert.deepEqual(await authorizeAudio({ version: 1, episodeId, chunkKeys: [chunkKey] }, env), { keys: [chunkKey], generation: 3 });
  assert.equal(await authorizeAudio({ version: 1, episodeId, chunkKeys: [`${chunkKey}.other`] }, env), null);
  chunkRows[0].state = "running";
  assert.equal(await authorizeAudio({ version: 1, episodeId, chunkKeys: [chunkKey] }, env), null);
  chunkRows[0].state = "succeeded";

  // A separately initialized handler can resolve the persisted hash grant without any module-local state.
  const audio = await serveScopedAudio(new Request(`http://potem.audio/${cap}/0`), env);
  assert.equal(audio.status, 200);
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3]);
  assert.equal(bucketReads, 1);
  assert.equal((await serveScopedAudio(new Request(`http://potem.audio/${cap}/revoke`, { method: "DELETE" }), env)).status, 204);
  assert.equal((await serveScopedAudio(new Request(`http://potem.audio/${cap}/0`), env)).status, 404);
  assert.equal(bucketReads, 1);
});
