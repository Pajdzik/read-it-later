import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupBasename } from "../src/articles/identity.ts";
import { MAX_BACKUP_BYTES, splitImportBatches, validateBackupEnvelope, type BackupArticle, type BackupEnvelope } from "./archive-backup.ts";
import { parseGitHubMarkdown } from "./github-convert.ts";
import { normalizeSourceUrl } from "./obsidian-convert.ts";
import { createShortIdMapper, isShortArticleId } from "./short-id.ts";

type MarkdownFile = { path: string; bytes: Buffer; item: BackupArticle; normalizedUrl: string };
type Identity = { normalizedUrl: string; sourcePaths: string[] };
const timestamp = (date: Date) => date.toISOString();
function fail(message: string): never { throw new Error(message); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function inside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readRegularFile(file: string, maximumBytes: number, sizeError: string): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) fail("source_must_be_regular_file");
  if (before.size > maximumBytes) fail(sizeError);
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("source_must_be_regular_file");
    if (info.size > maximumBytes) fail(sizeError);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > maximumBytes) fail(sizeError);
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

async function markdownFiles(root: string): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = [];
  let consumedBytes = 0;
  let candidateCount = 0;
  async function visit(directory: string): Promise<void> {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail("unsafe_github_source_directory");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!entry.name.startsWith(".")) await visit(file); continue; }
      if (!entry.isFile() || !/\.(?:md|markdown)$/i.test(entry.name)) continue;
      candidateCount++;
      if (candidateCount > 10_000) fail("github_source_limits_exceeded");
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) fail("unsafe_github_source_file");
      if (fileInfo.size > 1024 * 1024) fail("github_source_file_too_large");
      const bytes = await readRegularFile(file, 1024 * 1024, "github_source_file_too_large");
      consumedBytes += bytes.byteLength;
      if (consumedBytes > 64 * 1024 * 1024) fail("github_source_limits_exceeded");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/^---\r?\npotem_backup_version: 1(?:\r?\n|$)/.test(text.replace(/^\uFEFF/, ""))) continue;
      const parsed = parseGitHubMarkdown(bytes);
      const normalizedUrl = normalizeSourceUrl(parsed.item.url).normalizedUrl;
      files.push({ path: path.relative(root, file).split(path.sep).join("/"), bytes, item: parsed.item, normalizedUrl });
    }
  }
  await visit(root);
  return files;
}

function replaceId(bytes: Buffer, id: string): Buffer {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const prefix = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = prefix ? text.slice(1) : text;
  const opening = /^---(?:\r\n|\n)/.exec(source);
  if (!opening) fail("invalid_frontmatter");
  const start = opening[0].length;
  const separator = /^(?:---)(?:\r?\n|$)/gm;
  separator.lastIndex = start;
  const match = separator.exec(source);
  if (!match) fail("unterminated_frontmatter");
  const header = source.slice(start, match.index);
  const existing = /^id: (.+)$/m.exec(header);
  if (!existing) fail("missing_id_field");
  const replaced = header.replace(/^id: .+$/m, `id: ${JSON.stringify(id)}`);
  return Buffer.from(prefix + source.slice(0, start) + replaced + source.slice(match.index), "utf8");
}

function allocatePath(title: string, used: Set<string>): string {
  const basename = backupBasename(title);
  for (let index = 1; index <= 100; index++) {
    const candidate = `${basename}${index === 1 ? "" : `-${index}`}.md`;
    const key = candidate.toLowerCase();
    if (!used.has(key)) { used.add(key); return candidate; }
  }
  fail("markdown_filename_candidates_exhausted");
}

export type BackupMigrationResult = {
  articleCount: number;
  markdownCount: number;
  markdownOnlyReadStateUnavailable: boolean;
  batchCount: number;
  idMappings: Array<{ oldId: string; newId: string; normalizedUrl: string; sourcePaths: string[] }>;
  markdownPaths: Array<{ oldPath: string; newPath: string; id: string }>;
};

export async function migrateBackups({ jsonPath, githubDirectory, outputPath }: { jsonPath?: string; githubDirectory?: string; outputPath: string }): Promise<BackupMigrationResult> {
  if ((!jsonPath && !githubDirectory) || !path.isAbsolute(outputPath) || (jsonPath && !path.isAbsolute(jsonPath)) || (githubDirectory && !path.isAbsolute(githubDirectory))) fail("usage: pnpm backup:migrate --output /absolute/new-directory [--json /absolute/backup.json] [--github-dir /absolute/Articles]");
  const records: BackupArticle[] = [];
  if (jsonPath) {
    const inputBytes = await readRegularFile(jsonPath, MAX_BACKUP_BYTES, "backup_too_large");
    if (inputBytes.byteLength > MAX_BACKUP_BYTES) fail("backup_too_large");
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)); } catch { fail("invalid_json_backup"); }
    const envelope = validateBackupEnvelope(input);
    records.push(...envelope.articles.map(article => ({ ...article, ...(article.copy ? { copy: { ...article.copy } } : {}) })));
  }
  let markdown: MarkdownFile[] = [];
  if (githubDirectory) {
    const source = await realpath(githubDirectory);
    if (!(await stat(source)).isDirectory()) fail("github_source_must_be_directory");
    markdown = await markdownFiles(source);
  }

  const identities = new Map<string, Identity>();
  const idsByUrl = new Map<string, string>();
  const allRecords = [
    ...records.map((item, index) => ({ id: item.id, url: item.url, path: jsonPath ? `${path.basename(jsonPath)}#articles[${index}]` : "json", format: "json" as const })),
    ...markdown.map(file => ({ id: file.item.id, url: file.item.url, path: file.path, format: "markdown" as const })),
  ];
  const markdownIds = new Set<string>();
  for (const record of allRecords) {
    const normalizedUrl = normalizeSourceUrl(record.url).normalizedUrl;
    if (record.format === "markdown" && markdownIds.has(record.id)) fail("duplicate_markdown_article_id");
    if (record.format === "markdown") markdownIds.add(record.id);
    const urlId = idsByUrl.get(normalizedUrl);
    if (urlId && urlId !== record.id) fail("conflicting_normalized_url_identity");
    idsByUrl.set(normalizedUrl, record.id);
    const prior = identities.get(record.id);
    if (prior && prior.normalizedUrl !== normalizedUrl) fail("conflicting_identity");
    if (prior) prior.sourcePaths.push(record.path);
    else identities.set(record.id, { normalizedUrl, sourcePaths: [record.path] });
  }
  const mapId = createShortIdMapper([...identities.keys()].filter(isShortArticleId));
  for (const record of allRecords) mapId(record.id);
  const idMappings = [...identities.entries()].map(([oldId, identity]) => ({ oldId, newId: mapId(oldId), normalizedUrl: identity.normalizedUrl, sourcePaths: identity.sourcePaths })).sort((a, b) => compare(a.oldId, b.oldId));
  const newIdFor = new Map(idMappings.map(entry => [entry.oldId, entry.newId]));
  const jsonIds = new Set(records.map(item => item.id));
  const convertedRecords = [
    ...records.map(item => ({ ...item, id: newIdFor.get(item.id)! })),
    ...markdown.filter(file => !jsonIds.has(file.item.id)).map(file => ({ ...file.item, id: newIdFor.get(file.item.id)! })),
  ];
  const exportedAt = timestamp(new Date());
  const envelope: BackupEnvelope = { version: 2, exportedAt, articles: convertedRecords };
  validateBackupEnvelope(envelope);
  const batches = splitImportBatches(envelope);

  const destinationInput = path.resolve(outputPath);
  const parent = await realpath(path.dirname(destinationInput));
  const destination = path.join(parent, path.basename(destinationInput));
  try { await lstat(destination); fail("output_destination_exists"); }
  catch (error) { if (error instanceof Error && error.message === "output_destination_exists") throw error; if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  const sourceRoots = [githubDirectory ? await realpath(githubDirectory) : undefined].filter((item): item is string => !!item);
  for (const source of sourceRoots) {
    if (inside(source, destination) || inside(destination, source)) fail("output_must_be_outside_sources");
  }
  await mkdir(destination, { mode: 0o700 });
  const markdownPaths: BackupMigrationResult["markdownPaths"] = [];
  const usedPaths = new Set<string>();
  try {
    for (let i = 0; i < batches.length; i++) await writeFile(path.join(destination, `import-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(batches[i]), { flag: "wx", mode: 0o600 });
    if (markdown.length) {
      const articlesDir = path.join(destination, "Articles");
      await mkdir(articlesDir, { mode: 0o700 });
      for (const file of markdown) {
        const id = newIdFor.get(file.item.id)!;
        const newPath = allocatePath(file.item.title, usedPaths);
        const converted = replaceId(file.bytes, id);
        const parsed = parseGitHubMarkdown(converted);
        if (parsed.item.id !== id || parsed.normalizedUrl !== file.normalizedUrl) fail("converted_markdown_validation_failed");
        await writeFile(path.join(articlesDir, newPath), converted, { flag: "wx", mode: 0o600 });
        markdownPaths.push({ oldPath: file.path, newPath: `Articles/${newPath}`, id });
      }
    }
    const result: BackupMigrationResult = { articleCount: convertedRecords.length, markdownCount: markdownPaths.length, markdownOnlyReadStateUnavailable: !jsonPath && markdownPaths.length > 0, batchCount: batches.length, idMappings, markdownPaths };
    await writeFile(path.join(destination, "migration-report.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return result;
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseArgs(args: string[]): { jsonPath?: string; githubDirectory?: string; outputPath: string } {
  const result: { jsonPath?: string; githubDirectory?: string; outputPath?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!value || !path.isAbsolute(value) || !["--json", "--github-dir", "--output"].includes(key) || Object.hasOwn(result, key === "--json" ? "jsonPath" : key === "--github-dir" ? "githubDirectory" : "outputPath")) fail("usage: pnpm backup:migrate --output /absolute/new-directory [--json /absolute/backup.json] [--github-dir /absolute/Articles]");
    if (key === "--json") result.jsonPath = value;
    else if (key === "--github-dir") result.githubDirectory = value;
    else result.outputPath = value;
  }
  if (!result.outputPath) fail("usage: pnpm backup:migrate --output /absolute/new-directory [--json /absolute/backup.json] [--github-dir /absolute/Articles]");
  return result as { jsonPath?: string; githubDirectory?: string; outputPath: string };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await migrateBackups(options);
    process.stdout.write(`${JSON.stringify({ articleCount: result.articleCount, markdownCount: result.markdownCount, batchCount: result.batchCount, report: path.join(path.resolve(options.outputPath), "migration-report.json") })}\n`);
  }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "backup_migration_failed"}\n`); process.exitCode = 1; }
}
