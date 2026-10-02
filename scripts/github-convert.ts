import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSourceUrl } from "./obsidian-convert.ts";
import { MAX_BACKUP_BYTES, splitImportBatches, validateBackupEnvelope, type BackupArticle, type BackupEnvelope } from "./archive-backup.ts";

export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_READ_BYTES = 64 * 1024 * 1024;
export const MAX_CANDIDATE_FILES = 10_000;
export const MAX_COPY_BYTES = 256 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ITEMS = 1000;
const FIELDS = ["id", "title", "url", "author", "description", "savedAt", "capturedAt", "source", "revision"] as const;
const FIELD_SET: ReadonlySet<string> = new Set(FIELDS);
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

type Failure = Error & { fatal?: boolean; code?: string };
type Candidate = { absolute: string; relative: string };
type ParsedMarkdown = { item: BackupArticle; normalizedUrl: string };
type GithubOutcome = {
  path: string;
  outcome: "eligible" | "duplicate" | "excluded";
  reasons: string[];
  warnings: string[];
  winner?: string;
};
export type GithubConvertReport = {
  format: "potem-github-markdown-recovery";
  version: 1;
  createdAt: string;
  discovered: number;
  eligible: number;
  duplicates: number;
  excluded: number;
  copied: number;
  unread: number;
  batchCount: number;
  skippedSymlinks: string[];
  outcomes: GithubOutcome[];
};
type ConvertOptions = { now?: Date };
type ConvertResult = { report: GithubConvertReport; batches: BackupEnvelope[] };

function fail(message: string): never { throw new Error(message); }
function fatal(message: string): never { const error: Failure = new Error(message); error.fatal = true; throw error; }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function inside(parent: string, target: string): boolean {
  const rel = path.relative(parent, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function relativeName(value: string): string { return value.split(path.sep).join("/"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function failure(error: unknown): Failure | null { return error instanceof Error ? error as Failure : null; }
function reason(error: unknown): string { const message = failure(error)?.message; return message && /^[a-z][a-z0-9_]*$/.test(message) ? message : "invalid_frontmatter"; }
function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Parse only the frontmatter syntax emitted by articleMarkdown; retain the body verbatim. */
export function parseGitHubMarkdown(input: string | Uint8Array): ParsedMarkdown {
  let text: string;
  try { text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { fail("invalid_utf8"); }
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const opening = /^---(?:\r\n|\n)/.exec(source);
  if (!opening) fail("invalid_frontmatter");
  const headerStart = opening[0].length;
  let cursor = headerStart;
  let headerEnd = -1;
  let bodyStart = -1;
  while (cursor <= source.length) {
    const lf = source.indexOf("\n", cursor);
    const hasLf = lf !== -1;
    const end = hasLf ? lf : source.length;
    let line = source.slice(cursor, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "---") {
      headerEnd = cursor;
      bodyStart = hasLf ? end + 1 : end;
      break;
    }
    if (!hasLf) break;
    cursor = end + 1;
  }
  if (headerEnd < 0) fail("unterminated_frontmatter");
  const header = source.slice(headerStart, headerEnd).replace(/(?:\r\n|\n)$/, "");
  const lines = header ? header.split(/\r?\n/) : [];
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_]*): (.+)$/.exec(line);
    if (!match) fail("invalid_frontmatter");
    const key = match[1]!;
    const literal = match[2]!;
    if (key === "potem_backup_version") {
      if (Object.hasOwn(values, key)) fail("duplicate_frontmatter_field");
      if (literal !== "1") fail("unsupported_backup_version");
      values[key] = 1;
      continue;
    }
    if (!FIELD_SET.has(key)) fail("unknown_frontmatter_field");
    if (Object.hasOwn(values, key)) fail("duplicate_frontmatter_field");
    let value: unknown;
    try { value = JSON.parse(literal); } catch { fail("invalid_frontmatter_scalar"); }
    if (!(value === null || typeof value === "string")) fail("invalid_frontmatter_scalar");
    values[key] = value;
  }
  if (!Object.hasOwn(values, "potem_backup_version")) fail("missing_backup_version");
  for (const field of FIELDS) if (!Object.hasOwn(values, field)) {
    const code = field === "savedAt" ? "saved_at" : field === "capturedAt" ? "captured_at" : field;
    fail(`missing_${code}`);
  }
  const body = source.slice(bodyStart);
  if (typeof values.id !== "string" || !values.id || values.id.length > 128) fail("invalid_id");
  if (typeof values.title !== "string" || !values.title.trim() || values.title.length > 500) fail("invalid_title");
  if (typeof values.url !== "string" || !values.url || values.url !== values.url.trim() || byteLength(values.url) > 8192) fail("invalid_url");
  if (!(values.author === null || (typeof values.author === "string" && !!values.author.trim() && values.author.length <= 200))) fail("invalid_author");
  if (!(values.description === null || (typeof values.description === "string" && !!values.description.trim() && values.description.length <= 500))) fail("invalid_description");
  if (!validTimestamp(values.savedAt)) fail("invalid_saved_at");
  if (!validTimestamp(values.capturedAt)) fail("invalid_captured_at");
  if (!(values.source === "paste" || values.source === "upload")) fail("invalid_copy_source");
  if (typeof values.revision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(values.revision)) fail("invalid_revision");
  if (!body.trim()) fail("empty_copy_body");
  if (byteLength(body) > MAX_COPY_BYTES) fail("copy_body_too_large");
  let normalizedUrl: string;
  try { normalizedUrl = normalizeSourceUrl(values.url).normalizedUrl; } catch { fail("invalid_url"); }
  return {
    item: {
      id: values.id, url: values.url, title: values.title, author: values.author, description: values.description,
      createdAt: values.savedAt, updatedAt: values.savedAt, readAt: null,
      copy: { markdown: body, capturedAt: values.capturedAt, source: values.source, revision: values.revision },
    },
    normalizedUrl,
  };
}

async function discover(root: string): Promise<{ candidates: Candidate[]; symlinks: string[] }> {
  const candidates: Candidate[] = [];
  const symlinks: string[] = [];
  async function visit(directory: string): Promise<void> {
    let info;
    try { info = await lstat(directory); } catch { fatal("source_discovery_failed"); }
    if (info.isSymbolicLink() || !info.isDirectory()) fatal("source_directory_changed");
    let resolved;
    try { resolved = await realpath(directory); } catch { fatal("source_discovery_failed"); }
    if (!inside(root, resolved)) fatal("source_directory_escaped_tree");
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { fatal("source_discovery_failed"); }
    entries.sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeName(path.relative(root, absolute));
      if (entry.isSymbolicLink()) { symlinks.push(relative); continue; }
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|markdown)$/i.test(entry.name)) continue;
      let info;
      try { info = await lstat(absolute); } catch { fatal("source_discovery_failed"); }
      if (info.isSymbolicLink() || !info.isFile()) fatal("source_changed_during_discovery");
      candidates.push({ absolute, relative });
      if (candidates.length > MAX_CANDIDATE_FILES) fatal("candidate_file_limit_exceeded");
    }
  }
  await visit(root);
  candidates.sort((a, b) => compare(a.relative, b.relative));
  symlinks.sort(compare);
  return { candidates, symlinks };
}

async function readCandidate(root: string, candidate: Candidate, consumed: { bytes: number }): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parts = path.relative(root, candidate.absolute).split(path.sep);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      let parentInfo;
      try { parentInfo = await lstat(parent); } catch { fatal("source_read_failed"); }
      if (parentInfo.isSymbolicLink()) fatal("source_parent_symlinked");
    }
    let resolved;
    try { resolved = await realpath(candidate.absolute); } catch { fatal("source_read_failed"); }
    if (!inside(root, resolved)) fatal("source_file_escaped_tree");
    try { handle = await open(candidate.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch { fatal("source_read_failed"); }
    const info = await handle.stat();
    if (!info.isFile()) fatal("source_changed_during_read");
    if (info.size > MAX_SOURCE_FILE_BYTES) fail("source_file_too_large");
    const buffer = Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > MAX_SOURCE_FILE_BYTES) fail("source_file_too_large");
    consumed.bytes += count;
    if (consumed.bytes > MAX_SOURCE_READ_BYTES) fatal("aggregate_source_size_limit_exceeded");
    return buffer.subarray(0, count);
  } catch (error) { const caught = failure(error); if (caught?.fatal || caught?.message === "source_file_too_large") throw error; fatal("source_read_failed"); }
  finally { if (handle) await handle.close().catch(() => fatal("source_read_failed")); }
  return fatal("source_read_failed");
}

function validateItem(parsed: ParsedMarkdown, exportedAt: string): void {
  const one = { version: 2, exportedAt, articles: [parsed.item] };
  try { validateBackupEnvelope(one); }
  catch { fail("invalid_portable_record"); }
  try { splitImportBatches(one, { maxBytes: MAX_IMPORT_BYTES, maxItems: MAX_IMPORT_ITEMS }); }
  catch { fail("import_record_too_large"); }
}

export async function convertGitHubMarkdown(sourcePath: string, outputPath: string, { now = new Date() }: ConvertOptions = {}): Promise<ConvertResult> {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath)) fail("source_and_output_must_be_absolute");
  let source;
  try { source = await realpath(sourcePath); } catch { fatal("source_unavailable"); }
  try { if (!(await stat(source)).isDirectory()) fail("source_must_be_directory"); }
  catch (error) { const caught = failure(error); if (caught?.fatal || caught?.message === "source_must_be_directory") throw error; fatal("source_unavailable"); }
  let outputStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try { outputStat = await lstat(outputPath); } catch (error) { if (failure(error)?.code !== "ENOENT") fail("unsafe_output_destination"); }
  if (outputStat) fail("output_destination_exists");
  const resolvedParent = await realpath(path.dirname(path.resolve(outputPath))).catch(() => fail("output_parent_must_exist"));
  try { if (!(await stat(resolvedParent)).isDirectory()) fail("output_parent_must_be_directory"); }
  catch (error) { if (failure(error)?.message === "output_parent_must_be_directory") throw error; fatal("output_parent_must_be_directory"); }
  const destination = path.join(resolvedParent, path.basename(path.resolve(outputPath)));
  if (inside(source, destination) || inside(destination, source)) fail("output_must_be_outside_source_tree");
  const exportedAt = now.toISOString();
  if (!validTimestamp(exportedAt)) fail("invalid_conversion_time");
  const scan = await discover(source);
  const outcomes: GithubOutcome[] = [];
  const eligible: BackupArticle[] = [];
  const urlWinners = new Map<string, string>();
  const idWinners = new Map<string, { path: string; normalizedUrl: string }>();
  const consumed = { bytes: 0 };
  for (const candidate of scan.candidates) {
    let parsed: ParsedMarkdown;
    try {
      const bytes = await readCandidate(source, candidate, consumed);
      parsed = parseGitHubMarkdown(bytes);
      validateItem(parsed, exportedAt);
    } catch (error) {
      if (failure(error)?.fatal) throw error;
      outcomes.push({ path: candidate.relative, outcome: "excluded", reasons: [reason(error)], warnings: [] });
      continue;
    }
    const urlWinner = urlWinners.get(parsed.normalizedUrl);
    if (urlWinner) {
      outcomes.push({ path: candidate.relative, outcome: "duplicate", reasons: ["duplicate_normalized_url"], warnings: ["read_state_not_backed_up"], winner: urlWinner });
      continue;
    }
    const idWinner = idWinners.get(parsed.item.id);
    if (idWinner) {
      outcomes.push({ path: candidate.relative, outcome: "excluded", reasons: ["conflicting_article_id"], warnings: ["read_state_not_backed_up"], winner: idWinner.path });
      continue;
    }
    urlWinners.set(parsed.normalizedUrl, candidate.relative);
    idWinners.set(parsed.item.id, { path: candidate.relative, normalizedUrl: parsed.normalizedUrl });
    eligible.push(parsed.item);
    outcomes.push({ path: candidate.relative, outcome: "eligible", reasons: [], warnings: ["read_state_not_backed_up"] });
  }
  const envelope: BackupEnvelope = { version: 2, exportedAt, articles: eligible };
  validateBackupEnvelope(envelope);
  if (byteLength(JSON.stringify(envelope)) > MAX_BACKUP_BYTES) fail("portable_backup_size_limit_exceeded");
  const batches = splitImportBatches(envelope, { maxBytes: MAX_IMPORT_BYTES, maxItems: MAX_IMPORT_ITEMS });
  const report: GithubConvertReport = {
    format: "potem-github-markdown-recovery", version: 1, createdAt: exportedAt,
    discovered: scan.candidates.length, eligible: eligible.length,
    duplicates: outcomes.filter(item => item.outcome === "duplicate").length,
    excluded: outcomes.filter(item => item.outcome === "excluded").length,
    copied: eligible.length, unread: eligible.length, batchCount: batches.length,
    skippedSymlinks: scan.symlinks, outcomes,
  };
  try { await mkdir(destination, { mode: 0o700 }); } catch { fatal("output_create_failed"); }
  try {
    for (let i = 0; i < batches.length; i++) {
      const name = `import-${String(i + 1).padStart(3, "0")}.json`;
      await writeFile(path.join(destination, name), JSON.stringify(batches[i]), { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { await rm(destination, { recursive: true, force: true }).catch(() => {}); fatal("output_write_failed"); }
  return { report, batches };
}

function parseArgs(args: string[]): { source: string; output: string } {
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output" || typeof args[1] !== "string" || typeof args[3] !== "string" || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) {
    fail("usage: pnpm github:convert --source /absolute/Articles --output /absolute/new-directory");
  }
  return { source: args[1], output: args[3] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { source, output } = parseArgs(process.argv.slice(2));
    const { report } = await convertGitHubMarkdown(source, output);
    process.stdout.write(`${JSON.stringify({ discovered: report.discovered, eligible: report.eligible, duplicates: report.duplicates, excluded: report.excluded, copied: report.copied, unread: report.unread, batchCount: report.batchCount })}\n`);
  } catch (error) {
    const message = failure(error)?.message?.startsWith("usage:") ? failure(error)!.message : reason(error);
    process.stderr.write(`${message}\n`); process.exitCode = 1;
  }
}
