// Streaming, uncompressed ZIP64. PDFs are already compressed; storing entries avoids
// expensive recompression and lets restore read each file directly from disk.
const encoder = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array, crc = 0): number {
  crc ^= -1;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function buffer(size: number) { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; }
function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes;
}
export interface ZipFile { name: string; size: number; body: AsyncIterable<Uint8Array> }
export async function* zipFiles(files: AsyncIterable<ZipFile>): AsyncGenerator<Uint8Array> {
  const directory: Uint8Array[] = [];
  let offset = 0n;
  for await (const file of files) {
    const name = encoder.encode(file.name), start = offset;
    const h = buffer(30), extra = buffer(20);
    h.view.setUint32(0, 0x04034b50, true); h.view.setUint16(4, 45, true); h.view.setUint16(6, 0x808, true);
    h.view.setUint32(18, 0xffffffff, true); h.view.setUint32(22, 0xffffffff, true);
    h.view.setUint16(26, name.length, true); h.view.setUint16(28, 20, true);
    extra.view.setUint16(0, 1, true); extra.view.setUint16(2, 16, true);
    extra.view.setBigUint64(4, BigInt(file.size), true); extra.view.setBigUint64(12, BigInt(file.size), true);
    const header = join(h.bytes, name, extra.bytes); offset += BigInt(header.length); yield header;
    let crc = 0, size = 0;
    for await (const bytes of file.body) { size += bytes.length; if (size > file.size) throw new Error('archive_size_changed'); crc = crc32(bytes, crc); offset += BigInt(bytes.length); yield bytes; }
    if (size !== file.size) throw new Error('archive_file_incomplete');
    const descriptor = buffer(24);
    descriptor.view.setUint32(0, 0x08074b50, true); descriptor.view.setUint32(4, crc, true);
    descriptor.view.setBigUint64(8, BigInt(size), true); descriptor.view.setBigUint64(16, BigInt(size), true);
    offset += 24n; yield descriptor.bytes;
    const c = buffer(46), ce = buffer(28);
    c.view.setUint32(0, 0x02014b50, true); c.view.setUint16(4, 45, true); c.view.setUint16(6, 45, true); c.view.setUint16(8, 0x808, true);
    c.view.setUint32(16, crc, true); c.view.setUint32(20, 0xffffffff, true); c.view.setUint32(24, 0xffffffff, true);
    c.view.setUint16(28, name.length, true); c.view.setUint16(30, 28, true); c.view.setUint32(42, 0xffffffff, true);
    ce.view.setUint16(0, 1, true); ce.view.setUint16(2, 24, true);
    ce.view.setBigUint64(4, BigInt(size), true); ce.view.setBigUint64(12, BigInt(size), true); ce.view.setBigUint64(20, start, true);
    directory.push(join(c.bytes, name, ce.bytes));
  }
  const centralStart = offset;
  for (const entry of directory) { offset += BigInt(entry.length); yield entry; }
  const end = buffer(56), locator = buffer(20), legacy = buffer(22);
  end.view.setUint32(0, 0x06064b50, true); end.view.setBigUint64(4, 44n, true);
  end.view.setUint16(12, 45, true); end.view.setUint16(14, 45, true);
  end.view.setBigUint64(24, BigInt(directory.length), true); end.view.setBigUint64(32, BigInt(directory.length), true);
  end.view.setBigUint64(40, offset - centralStart, true); end.view.setBigUint64(48, centralStart, true);
  locator.view.setUint32(0, 0x07064b50, true); locator.view.setBigUint64(8, offset, true); locator.view.setUint32(16, 1, true);
  legacy.view.setUint32(0, 0x06054b50, true); legacy.view.setUint16(8, 65535, true); legacy.view.setUint16(10, 65535, true);
  legacy.view.setUint32(12, 0xffffffff, true); legacy.view.setUint32(16, 0xffffffff, true);
  yield join(end.bytes, locator.bytes, legacy.bytes);
}
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; yield value; } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function iteratorStream(iterator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) { try { const { done, value } = await iterator.next(); if (done) controller.close(); else controller.enqueue(value); } catch (error) { controller.error(error); await iterator.return(undefined); } },
    async cancel() { await iterator.return(undefined); },
  });
}
export interface ZipEntry { name: string; size: number; start: number; crc: number }
/** Read our ZIP64 central directory; no extraction paths or whole-archive buffering. */
export async function readZipDirectory(file: Blob): Promise<Map<string, ZipEntry>> {
  const bad = () => new Error('Invalid or unsupported complete archive');
  if (file.size < 98) throw bad();
  const tail = new DataView(await file.slice(file.size - 98).arrayBuffer());
  if (tail.getUint32(0, true) !== 0x06064b50 || tail.getUint32(56, true) !== 0x07064b50 || tail.getUint32(76, true) !== 0x06054b50) throw bad();
  const count = Number(tail.getBigUint64(32, true)), size = Number(tail.getBigUint64(40, true)), offset = Number(tail.getBigUint64(48, true));
  if (count > 100_002 || size > 32 * 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0 || offset + size !== file.size - 98) throw bad();
  const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()), view = new DataView(bytes.buffer);
  const entries = new Map<string, ZipEntry>(), intervals: Array<[number, number]> = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || view.getUint32(cursor, true) !== 0x02014b50 || view.getUint16(cursor + 10, true) !== 0 || (view.getUint16(cursor + 8, true) & 1)) throw bad();
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const e = cursor + 46 + nameLength;
    if (e + extraLength + commentLength > size || extraLength !== 28 || view.getUint16(e, true) !== 1) throw bad();
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, e));
    if (!(name === 'library.json' || name === 'manifest.json' || /^pdf\/[a-f0-9-]{36}\.pdf$/.test(name)) || entries.has(name)) throw bad();
    const length = Number(view.getBigUint64(e + 4, true)), compressed = Number(view.getBigUint64(e + 12, true)), start = Number(view.getBigUint64(e + 20, true));
    const limit = name === 'library.json' ? 64 * 1024 * 1024 : name === 'manifest.json' ? 16 * 1024 * 1024 : 20 * 1024 * 1024;
    if (length !== compressed || length < 0 || length > limit || !Number.isSafeInteger(start) || start < 0) throw bad();
    const local = new Uint8Array(await file.slice(start, start + 30 + nameLength + 20).arrayBuffer());
    const lv = new DataView(local.buffer);
    if (local.length < 30 || lv.getUint32(0, true) !== 0x04034b50 || lv.getUint16(8, true) !== 0 || lv.getUint16(26, true) !== nameLength || lv.getUint16(28, true) !== 20 || new TextDecoder().decode(local.subarray(30, 30 + nameLength)) !== name) throw bad();
    const bodyStart = start + local.length;
    if (bodyStart + length + 24 > offset) throw bad();
    intervals.push([start, bodyStart + length + 24]);
    entries.set(name, { name, size: length, start: bodyStart, crc: view.getUint32(cursor + 16, true) });
    cursor = e + extraLength + commentLength;
  }
  intervals.sort((a, b) => a[0] - b[0]);
  if (cursor !== size || intervals.some((item, i) => i > 0 && item[0] < intervals[i - 1][1])) throw bad();
  if (!entries.has('library.json') || !entries.has('manifest.json')) throw bad();
  return entries;
}
export async function readZipEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(await file.slice(entry.start, entry.start + entry.size).arrayBuffer());
  if (crc32(bytes) !== entry.crc) throw new Error('Archive checksum mismatch');
  return bytes;
}
