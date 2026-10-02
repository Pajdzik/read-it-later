import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Alias, isAlias, isMap, parseDocument } from "yaml";
import { MAX_BACKUP_BYTES, splitImportBatches, validateBackupEnvelope, type BackupArticle, type BackupEnvelope } from "./archive-backup.ts";

export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_MARKDOWN_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_CANDIDATE_FILES = 10_000;
export const MAX_COPY_BYTES = 256 * 1024;
export const MAX_URL_BYTES = 8 * 1024;
export const MAX_TITLE_LENGTH = 500;
export const MAX_AUTHOR_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;

export type ObsidianOutcome = {
  path: string;
  outcome: "excluded" | "duplicate" | "eligible";
  reasons: string[];
  warnings: string[];
  dateSource: string | null;
  winner?: string;
};

export type ObsidianConversionReport = {
  version: 1;
  createdAt: string;
  discovered: number;
  eligible: number;
  duplicates: number;
  excluded: number;
  read: number;
  unread: number;
  copied: number;
  linkOnly: number;
  batchCount: number;
  skippedSymlinks: string[];
  outcomes: ObsidianOutcome[];
};

export type ObsidianConversionResult = { report: ObsidianConversionReport; batches: BackupEnvelope[] };
type SourceUrl = { url: string; normalizedUrl: string };
type ParsedMarkdown = { item: BackupArticle; normalizedUrl: string; dateSource: string; warnings: string[] };
type VaultCandidate = { absolute: string; relative: string };
type VaultScan = { candidates: VaultCandidate[]; symlinks: string[]; aggregateBytes: number };
type Frontmatter = { metadata: Record<string, unknown>; body: string };
type FatalError = Error & { fatal: true };

function isFatalError(error: unknown): error is FatalError {
  return error instanceof Error && "fatal" in error && error.fatal === true;
}

function fail(message: string): never { throw new Error(message); }
function fatal(message: string): never { const error = new Error(message) as FatalError; error.fatal = true; throw error; }
function utf8Length(value: string): number { return Buffer.byteLength(value, "utf8"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isInside(parent: string, target: string): boolean { const relative = path.relative(parent, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
function safePathName(file: string): string { return file.split(path.sep).join("/"); }
function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function reportReason(error: unknown): string { const message = error instanceof Error ? error.message : ""; return /^[a-z][a-z0-9_]*$/.test(message) ? message : "file_read_error"; }

export function normalizeSourceUrl(value: unknown): SourceUrl {
  if (typeof value !== "string" || !value.trim()) fail("missing_or_invalid_source_url");
  const url = value.trim();
  if (utf8Length(url) > MAX_URL_BYTES) fail("invalid_source_url");
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("invalid_source_url"); }
  if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname || parsed.username || parsed.password) fail("invalid_source_url");
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
  parsed.hash = "";
  const rawQuery = parsed.search.slice(1);
  const kept = (rawQuery ? rawQuery.split("&") : []).filter(part => {
    let key = part.split("=", 1)[0].replaceAll("+", " ");
    try { key = decodeURIComponent(key); } catch { /* retain malformed, URL-accepted data */ }
    const lower = key.toLowerCase();
    return !(lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid");
  });
  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}${kept.length ? `?${kept.join("&")}` : ""}`;
  return { url, normalizedUrl };
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseExplicitDate(value: unknown, { dateOnly = true }: { dateOnly?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const dateMatch = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value);
  if (dateMatch && dateOnly) {
    const [, y, m, d] = dateMatch.map(Number);
    if (!validCalendarDate(y, m, d)) return null;
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  }
  const timestampMatch = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/i.exec(value);
  if (!timestampMatch) return null;
  const [, ys, ms, ds, hs, mins, ss, , zone] = timestampMatch;
  const [year, month, day, hour, minute, second] = [ys, ms, ds, hs, mins, ss].map(Number);
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  if (zone.toUpperCase() !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  try { return new Date(time).toISOString(); } catch { return null; }
}

function yamlHasUnsupportedNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (isAlias(node) || node instanceof Alias) return true;
  const candidate = node as { tag?: unknown; items?: unknown[] };
  if (Object.hasOwn(candidate, "tag") && candidate.tag) return true;
  if (isMap(node)) return candidate.items?.some(pair => {
    if (!pair || typeof pair !== "object") return true;
    const mapping = pair as { key?: unknown; value?: unknown };
    return yamlHasUnsupportedNode(mapping.key) || yamlHasUnsupportedNode(mapping.value);
  }) ?? false;
  if (Array.isArray(candidate.items)) return candidate.items.some(yamlHasUnsupportedNode);
  return false;
}

function parseFrontmatter(text: string): Frontmatter {
  let source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n") && source !== "---") return { metadata: {}, body: text };
  let cursor = source.indexOf("\n");
  if (cursor < 0) fail("unterminated_frontmatter");
  cursor++;
  let yamlEnd = -1;
  let bodyStart = -1;
  while (cursor <= source.length) {
    let end = source.indexOf("\n", cursor);
    const hasLf = end >= 0;
    if (!hasLf) end = source.length;
    let line = source.slice(cursor, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "---" || line === "...") {
      yamlEnd = cursor;
      bodyStart = hasLf ? end + 1 : end;
      break;
    }
    if (!hasLf) break;
    cursor = end + 1;
  }
  if (yamlEnd < 0) fail("unterminated_frontmatter");
  const yamlText = source.slice(source.indexOf("\n") + 1, yamlEnd).replace(/\r$/, "");
  let doc: ReturnType<typeof parseDocument>;
  try { doc = parseDocument(yamlText, { version: "1.2", schema: "core", uniqueKeys: true, prettyErrors: false, strict: true }); }
  catch { fail("invalid_frontmatter_yaml"); }
  if (doc.errors.length || yamlHasUnsupportedNode(doc.contents)) fail("invalid_frontmatter_yaml");
  if (!doc.contents || !isMap(doc.contents)) fail("invalid_frontmatter_yaml");
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 0 }); } catch { fail("invalid_frontmatter_yaml"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_frontmatter_yaml");
  return { metadata: value as Record<string, unknown>, body: source.slice(bodyStart) };
}

function getScalarOrSingleSequence(value: unknown, reason: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  fail(reason);
}

function optionalScalar(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`invalid_${field}`);
  const result = value.trim();
  if (!result) return null;
  if (result.length > limit) fail(`${field}_too_long`);
  return result;
}

function normalizeWikiLink(value: string): string {
  return value.replace(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/, (_match, target, label) => (label || target).trim());
}

function optionalAuthors(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const authors: unknown[] = Array.isArray(value) ? value : [value];
  if (!authors.every((author): author is string => typeof author === "string")) fail("invalid_author");
  const result = authors.map(author => normalizeWikiLink(author.trim())).filter(Boolean).join(", ");
  if (!result) return null;
  if (result.length > MAX_AUTHOR_LENGTH) fail("author_too_long");
  return result;
}

function parseReadFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return null;
}

function dateSourceAndCreated(metadata: Record<string, unknown>, file: string, mtime: number): { createdAt: string; dateSource: string } {
  if (Object.hasOwn(metadata, "created") && metadata.created !== null) {
    const parsed = parseExplicitDate(metadata.created);
    if (!parsed) fail("invalid_created_date");
    return { createdAt: parsed, dateSource: "frontmatter_created" };
  }
  const base = path.basename(file);
  const prefix = /^(\d{4}-\d\d-\d\d)\./.exec(base);
  if (prefix) {
    const parsed = parseExplicitDate(prefix[1]);
    if (!parsed) fail("invalid_filename_date");
    return { createdAt: parsed, dateSource: "filename_date" };
  }
  if (!Number.isFinite(mtime)) fail("invalid_filesystem_date");
  return { createdAt: new Date(mtime).toISOString(), dateSource: "filesystem_mtime" };
}

function stripTitleHash(title: string): string { return title.replace(/^\s*#\s+/, "").trim(); }

function parseMarkdownFile(relativePath: string, bytes: Uint8Array, mtime: number): ParsedMarkdown {
  if (bytes.byteLength > MAX_SOURCE_FILE_BYTES) fail("source_file_too_large");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid_utf8"); }
  const { metadata, body } = parseFrontmatter(text);
  let urlInfo;
  if (!Object.hasOwn(metadata, "source") || metadata.source === null) fail("missing_source_url");
  try { urlInfo = normalizeSourceUrl(getScalarOrSingleSequence(metadata.source, "invalid_source_url")); }
  catch (error) { if (error instanceof Error && error.message === "missing_or_invalid_source_url") fail("invalid_source_url"); throw error; }
  const relativeBase = path.basename(relativePath).replace(/\.(?:md|markdown)$/i, "");
  const fileFallback = relativeBase.replace(/^\d{4}-\d\d-\d\d\.\s*/, "").trim() || relativeBase;
  let title = fileFallback;
  if (Object.hasOwn(metadata, "title") && metadata.title !== null && typeof metadata.title !== "string") fail("invalid_title");
  if (typeof metadata.title === "string" && metadata.title.trim()) title = metadata.title.trim();
  else {
    const heading = body.split(/\r?\n/).find(line => /^\s*#\s+\S/.test(line));
    if (heading) title = stripTitleHash(heading);
  }
  if (!title || title.length > MAX_TITLE_LENGTH) fail(title ? "title_too_long" : "missing_title");
  const author = optionalAuthors(metadata.author);
  const description = optionalScalar(metadata.description, "description", MAX_DESCRIPTION_LENGTH);
  const { createdAt, dateSource } = dateSourceAndCreated(metadata, relativeBase, mtime);
  const mtimeIso = Number.isFinite(mtime) ? new Date(mtime).toISOString() : createdAt;
  const updatedAt = Date.parse(mtimeIso) > Date.parse(createdAt) ? mtimeIso : createdAt;
  const read = Object.hasOwn(metadata, "read") ? parseReadFlag(metadata.read) : null;
  if (read === null) fail("unrecognized_read_flag");
  let readAt = null;
  if (read) {
    if (typeof metadata.readAt !== "string") fail("missing_or_invalid_read_date");
    readAt = parseExplicitDate(metadata.readAt, { dateOnly: false });
    if (!readAt) fail("missing_or_invalid_read_date");
  } else if (metadata.readAt !== undefined && metadata.readAt !== null && !(typeof metadata.readAt === "string" && !metadata.readAt.trim())) {
    fail("conflicting_read_date");
  }
  const bodyBytes = utf8Length(body);
  if (bodyBytes > MAX_COPY_BYTES) fail("copy_body_too_large");
  const id = `obsidian-${sha256(urlInfo.normalizedUrl)}`;
  const item: BackupArticle = {
    id, url: urlInfo.url, title, author, description, createdAt, updatedAt, readAt,
  };
  const warnings: string[] = [];
  if (body.trim()) {
    item.copy = { markdown: body, capturedAt: createdAt, source: "upload", revision: `sha256-${sha256(body)}` };
  } else {
    warnings.push("empty_body_link_only");
  }
  return { item, normalizedUrl: urlInfo.normalizedUrl, dateSource, warnings };
}

async function walkVault(root: string): Promise<VaultScan> {
  const candidates: VaultCandidate[] = [];
  const symlinks: string[] = [];
  let aggregateBytes = 0;
  async function visit(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) { symlinks.push(safePathName(path.relative(root, directory))); return; }
    if (!info.isDirectory()) return;
    const resolvedDirectory = await realpath(directory);
    if (!isInside(root, resolvedDirectory)) fatal("source_directory_escaped_vault");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = safePathName(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        if (/\.(?:md|markdown)$/i.test(entry.name) || !entry.isFile()) symlinks.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        const directoryInfo = await lstat(absolute);
        if (directoryInfo.isSymbolicLink()) { symlinks.push(relative); continue; }
        if (!directoryInfo.isDirectory()) continue;
        await visit(absolute);
      } else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) { symlinks.push(relative); continue; }
        if (!info.isFile()) continue;
        candidates.push({ absolute, relative });
        if (candidates.length > MAX_CANDIDATE_FILES) fail("candidate_file_limit_exceeded");
        aggregateBytes += info.size;
        if (aggregateBytes > MAX_MARKDOWN_TOTAL_BYTES) fail("aggregate_markdown_size_limit_exceeded");
      }
    }
  }
  await visit(root);
  candidates.sort((a, b) => comparePath(a.relative, b.relative));
  symlinks.sort(comparePath);
  return { candidates, symlinks, aggregateBytes };
}

export async function convertVault(sourcePath: string, outputPath: string, { now = new Date() }: { now?: Date } = {}): Promise<ObsidianConversionResult> {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath)) fail("source_and_output_must_be_absolute");
  const source = await realpath(sourcePath);
  if (!(await stat(source)).isDirectory()) fail("source_must_be_directory");
  let outputStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try { outputStat = await lstat(outputPath); } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") fail("unsafe_output_destination");
  }
  if (outputStat) fail("output_destination_exists");
  const parentInput = path.dirname(path.resolve(outputPath));
  let outputParent: string;
  try { outputParent = await realpath(parentInput); } catch { fail("output_parent_must_exist"); }
  if (!(await stat(outputParent)).isDirectory()) fail("output_parent_must_be_directory");
  const canonicalOutput = path.join(outputParent, path.basename(path.resolve(outputPath)));
  if (isInside(source, canonicalOutput) || isInside(canonicalOutput, source)) fail("output_must_be_outside_source_tree");
  const scan = await walkVault(source);
  const outcomes: ObsidianOutcome[] = [];
  const eligible: BackupArticle[] = [];
  const winners = new Map();
  let readCount = 0;
  let unreadCount = 0;
  let linkOnlyCount = 0;
  let copyCount = 0;
  let consumedBytes = 0;
  for (const candidate of scan.candidates) {
    let parsed: ParsedMarkdown;
    try {
      const relativeParts = path.relative(source, candidate.absolute).split(path.sep);
      let ancestor = source;
      for (const part of relativeParts.slice(0, -1)) {
        ancestor = path.join(ancestor, part);
        if ((await lstat(ancestor)).isSymbolicLink()) fail("source_file_symlinked_parent");
      }
      const resolvedCandidate = await realpath(candidate.absolute);
      if (!isInside(source, resolvedCandidate)) fail("source_file_escaped_vault");
      if ((await lstat(candidate.absolute)).isSymbolicLink()) fail("source_file_symlink");
      const handle = await open(candidate.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      let bytes: Buffer;
      let info: Awaited<ReturnType<typeof handle.stat>>;
      try {
        info = await handle.stat();
        if (!info.isFile()) fail("not_a_regular_file");
        if (info.size > MAX_SOURCE_FILE_BYTES) fail("source_file_too_large");
        const buffer = Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
          const read = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
          if (!read.bytesRead) break;
          bytesRead += read.bytesRead;
        }
        if (bytesRead > MAX_SOURCE_FILE_BYTES) fail("source_file_too_large");
        consumedBytes += bytesRead;
        if (consumedBytes > MAX_MARKDOWN_TOTAL_BYTES) fatal("aggregate_markdown_size_limit_exceeded");
        bytes = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      parsed = parseMarkdownFile(candidate.relative, bytes, info.mtimeMs);
    } catch (error) {
      if (isFatalError(error)) throw error;
      outcomes.push({ path: candidate.relative, outcome: "excluded", reasons: [reportReason(error)], warnings: [], dateSource: null });
      continue;
    }
    try {
      validateBackupEnvelope({ version: 2, exportedAt: now.toISOString(), articles: [parsed.item] });
    } catch { outcomes.push({ path: candidate.relative, outcome: "excluded", reasons: ["invalid_portable_record"], warnings: parsed.warnings, dateSource: parsed.dateSource }); continue; }
    try { splitImportBatches({ version: 2, exportedAt: now.toISOString(), articles: [parsed.item] }); }
    catch { outcomes.push({ path: candidate.relative, outcome: "excluded", reasons: ["import_record_too_large"], warnings: parsed.warnings, dateSource: parsed.dateSource }); continue; }
    const winner = winners.get(parsed.normalizedUrl);
    if (winner) {
      outcomes.push({ path: candidate.relative, outcome: "duplicate", reasons: ["duplicate_normalized_url"], warnings: parsed.warnings, dateSource: parsed.dateSource, winner });
      continue;
    }
    winners.set(parsed.normalizedUrl, candidate.relative);
    eligible.push(parsed.item);
    if (parsed.item.readAt) readCount++; else unreadCount++;
    if (parsed.item.copy) copyCount++; else linkOnlyCount++;
    outcomes.push({ path: candidate.relative, outcome: "eligible", reasons: [], warnings: parsed.warnings, dateSource: parsed.dateSource });
  }
  const envelope: BackupEnvelope = { version: 2, exportedAt: now.toISOString(), articles: eligible };
  validateBackupEnvelope(envelope);
  const portableBytes = utf8Length(JSON.stringify(envelope));
  if (portableBytes > MAX_BACKUP_BYTES) fail("portable_backup_size_limit_exceeded");
  const batches = splitImportBatches(envelope);
  const report: ObsidianConversionReport = {
    version: 1,
    createdAt: envelope.exportedAt,
    discovered: scan.candidates.length,
    eligible: eligible.length,
    duplicates: outcomes.filter(item => item.outcome === "duplicate").length,
    excluded: outcomes.filter(item => item.outcome === "excluded").length,
    read: readCount,
    unread: unreadCount,
    copied: copyCount,
    linkOnly: linkOnlyCount,
    batchCount: batches.length,
    skippedSymlinks: scan.symlinks,
    outcomes,
  };
  await mkdir(canonicalOutput, { mode: 0o700 });
  try {
    for (let index = 0; index < batches.length; index++) {
      const name = `import-${String(index + 1).padStart(3, "0")}.json`;
      await writeFile(path.join(canonicalOutput, name), JSON.stringify(batches[index]), { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(canonicalOutput, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(canonicalOutput, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { report, batches };
}

function parseArgs(args: string[]): { source: string; output: string } {
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output" || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) fail("usage: pnpm obsidian:convert --source /absolute/vault --output /absolute/new-directory");
  return { source: args[1], output: args[3] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { source, output } = parseArgs(process.argv.slice(2));
    const { report } = await convertVault(source, output);
    process.stdout.write(`${JSON.stringify({ discovered: report.discovered, eligible: report.eligible, duplicates: report.duplicates, excluded: report.excluded, read: report.read, unread: report.unread, copied: report.copied, linkOnly: report.linkOnly, batchCount: report.batchCount })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Conversion failed."}\n`);
    process.exitCode = 1;
  }
}
