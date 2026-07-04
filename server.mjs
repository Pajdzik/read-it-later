import { createReadStream, existsSync } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_ARTICLES_DIR =
  "/Users/kamil/Library/Mobile Documents/iCloud~md~obsidian/Documents/Kamilpedia/Articles";

const ARTICLES_DIR = path.resolve(process.env.ARTICLES_DIR || DEFAULT_ARTICLES_DIR);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3055);
const HOST = process.env.HOST || "0.0.0.0";
const STORAGE_MODE =
  process.env.STORAGE_MODE ||
  (process.env.GITHUB_OWNER || process.env.GITHUB_REPO || process.env.GITHUB_TOKEN ? "github" : "local");

const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_ARTICLES_PATH = cleanRepoPath(
  process.env.GITHUB_ARTICLES_PATH ?? process.env.ARTICLES_PATH ?? "Articles",
);
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

if (!["local", "github"].includes(STORAGE_MODE)) {
  throw new Error(`Unsupported STORAGE_MODE: ${STORAGE_MODE}`);
}

if (STORAGE_MODE === "github") {
  const missing = [
    ["GITHUB_OWNER", GITHUB_OWNER],
    ["GITHUB_REPO", GITHUB_REPO],
    ["GITHUB_TOKEN", GITHUB_TOKEN],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`GitHub storage is missing required env vars: ${missing.join(", ")}`);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Length": Buffer.byteLength(text),
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(text);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanRepoPath(value) {
  const cleaned = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned === "." ? "" : cleaned;
}

function normalizeRelativePath(value) {
  const normalized = path.posix.normalize(cleanRepoPath(value));
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error("Invalid article path");
  }
  return normalized;
}

function encodeRepoPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function articleId(relativePath) {
  return Buffer.from(normalizeRelativePath(relativePath), "utf8").toString("base64url");
}

function relativePathFromId(id) {
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  return normalizeRelativePath(decoded);
}

function articlePathFromId(id) {
  const relativePath = relativePathFromId(id);
  const fullPath = path.resolve(ARTICLES_DIR, ...relativePath.split("/"));
  if (!isInside(ARTICLES_DIR, fullPath)) {
    throw new Error("Invalid article path");
  }
  return { fullPath, relativePath };
}

function repoPathFromRelative(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return GITHUB_ARTICLES_PATH ? `${GITHUB_ARTICLES_PATH}/${normalized}` : normalized;
}

function relativePathFromRepoPath(repoPath) {
  const normalized = normalizeRelativePath(repoPath);
  if (!GITHUB_ARTICLES_PATH) return normalized;

  if (normalized === GITHUB_ARTICLES_PATH || normalized.startsWith(`${GITHUB_ARTICLES_PATH}/`)) {
    return normalized.slice(GITHUB_ARTICLES_PATH.length).replace(/^\/+/, "");
  }

  throw new Error("Repository path is outside the articles folder");
}

async function walkMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0] !== "---") {
    return { content: normalized, frontmatter: "", hasFrontmatter: false };
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { content: normalized, frontmatter: "", hasFrontmatter: false };
  }

  return {
    content: lines.slice(end + 1).join("\n").trimStart(),
    frontmatter: lines.slice(1, end).join("\n"),
    hasFrontmatter: true,
  };
}

function cleanScalar(value) {
  let result = String(value || "").trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function parseFrontmatter(frontmatter) {
  const result = {};
  let currentKey = null;

  for (const line of frontmatter.split("\n")) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue) {
      const [, key, rawValue] = keyValue;
      currentKey = key;
      result[key] = rawValue.trim() ? cleanScalar(rawValue) : [];
      continue;
    }

    const listItem = line.match(/^\s*-\s*(.*)$/);
    if (currentKey && listItem) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(cleanScalar(listItem[1]));
    }
  }

  return result;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function booleanFromYaml(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ["true", "yes", "1"].includes(cleanScalar(value).toLowerCase());
}

function nullableScalar(value) {
  const scalar = cleanScalar(firstValue(value));
  if (!scalar || scalar.toLowerCase() === "null") return null;
  return scalar;
}

function normalizeWikiLink(value) {
  return String(value || "")
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")
    .pop()
    .trim();
}

function dateFromString(value) {
  if (!value) return null;
  const text = String(value);
  const isoDate = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function dateFromFilename(filename) {
  return filename.match(/^(\d{4}-\d{2}-\d{2})\./)?.[1] || null;
}

function titleFromContent(content) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

function titleFromFilename(filename) {
  return path
    .posix.basename(filename, path.posix.extname(filename))
    .replace(/^\d{4}-\d{2}-\d{2}\.\s*/, "")
    .trim();
}

function sourceFromContent(content) {
  return content.match(/https?:\/\/[^\s)<>\]]+/)?.[0] || null;
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, label) => label || page)
    .replace(/[#>*_`~|[\]()-]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(markdown, description) {
  const preferred = cleanScalar(description || "");
  const text = preferred || stripMarkdown(markdown);
  if (text.length <= 260) return text;
  return `${text.slice(0, 257).trim()}...`;
}

function readingStats(markdown) {
  const text = stripMarkdown(markdown);
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return {
    readingMinutes: Math.max(1, Math.ceil(words / 220)),
    wordCount: words,
  };
}

function articleSummaryFromRaw(raw, relativePath, fileInfo = {}) {
  const id = articleId(relativePath);
  const { content, frontmatter } = splitFrontmatter(raw);
  const metadata = parseFrontmatter(frontmatter);
  const fallbackTimestamp = fileInfo.addedTimestamp ?? Date.now();
  const fallbackDate = new Date(fallbackTimestamp).toISOString().slice(0, 10);
  const filenameDate = dateFromFilename(path.posix.basename(relativePath));
  const created = dateFromString(firstValue(metadata.created)) || filenameDate;
  const published = dateFromString(firstValue(metadata.published)) || filenameDate;
  const added = created || fallbackDate;
  const categoryPath = path.posix.dirname(relativePath);
  const category = categoryPath === "." ? "Uncategorized" : categoryPath.split("/").join(" / ");
  const stats = readingStats(content);
  const source = cleanScalar(firstValue(metadata.source) || sourceFromContent(content) || "");

  return {
    added,
    addedTimestamp: Date.parse(added) || fallbackTimestamp,
    author: Array.isArray(metadata.author)
      ? metadata.author.map(normalizeWikiLink).filter(Boolean)
      : normalizeWikiLink(metadata.author || ""),
    category,
    created,
    excerpt: summarize(content, metadata.description),
    id,
    modifiedAt: fileInfo.modifiedAt || null,
    published,
    publishedTimestamp: Date.parse(published) || 0,
    read: booleanFromYaml(metadata.read),
    readAt: nullableScalar(metadata.readAt),
    relativePath,
    source,
    title: cleanScalar(firstValue(metadata.title)) || titleFromContent(content) || titleFromFilename(relativePath),
    ...stats,
  };
}

async function localArticleSummary(filePath) {
  const raw = await readFile(filePath, "utf8");
  const fileStat = await stat(filePath);
  const relativePath = cleanRepoPath(path.relative(ARTICLES_DIR, filePath));
  return articleSummaryFromRaw(raw, relativePath, {
    addedTimestamp: fileStat.birthtimeMs,
    modifiedAt: fileStat.mtime.toISOString(),
  });
}

class GitHubRequestError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
    this.data = data;
  }
}

function githubHeaders(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "read-it-later",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...extra,
  };
}

async function githubRequest(apiPath, options = {}) {
  const response = await fetch(`${GITHUB_API}${apiPath}`, {
    ...options,
    headers: githubHeaders(options.headers),
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === "object" && data?.message ? data.message : response.statusText;
    throw new GitHubRequestError(`GitHub API ${response.status}: ${message}`, response.status, data);
  }

  return data;
}

async function githubRawRequest(apiPath) {
  const response = await fetch(`${GITHUB_API}${apiPath}`, {
    headers: githubHeaders({ Accept: "application/vnd.github.raw" }),
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = await response.json();
      message = data?.message || message;
    } catch {
      message = await response.text();
    }
    throw new GitHubRequestError(`GitHub API ${response.status}: ${message}`, response.status);
  }

  return Buffer.from(await response.arrayBuffer());
}

function githubContentsPath(repoPath) {
  const encodedPath = encodeRepoPath(repoPath);
  return `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}`;
}

async function getGitHubFile(repoPath) {
  const pathWithRef = `${githubContentsPath(repoPath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const file = await githubRequest(pathWithRef);

  if (file.type !== "file" || !file.content) {
    throw new Error(`GitHub file content is unavailable for ${repoPath}`);
  }

  return {
    raw: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
    sha: file.sha,
  };
}

function isMarkdownArticlePath(relativePath) {
  return (
    relativePath.toLowerCase().endsWith(".md") &&
    !relativePath.split("/").some((segment) => segment.startsWith("."))
  );
}

async function listGitHubArticles() {
  const tree = await githubRequest(
    `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/trees/${encodeURIComponent(
      GITHUB_BRANCH,
    )}?recursive=1`,
  );

  if (tree.truncated) {
    throw new Error("GitHub repository tree is truncated; narrow GITHUB_ARTICLES_PATH before listing articles");
  }

  const prefix = GITHUB_ARTICLES_PATH ? `${GITHUB_ARTICLES_PATH}/` : "";
  const repoPaths = tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
    .map((entry) => entry.path)
    .filter((repoPath) => isMarkdownArticlePath(relativePathFromRepoPath(repoPath)));

  const articles = await Promise.all(
    repoPaths.map(async (repoPath) => {
      const relativePath = relativePathFromRepoPath(repoPath);
      const { raw } = await getGitHubFile(repoPath);
      return articleSummaryFromRaw(raw, relativePath, { addedTimestamp: 0 });
    }),
  );

  articles.sort((a, b) => b.addedTimestamp - a.addedTimestamp || a.title.localeCompare(b.title));
  return articles;
}

async function getGitHubArticle(id) {
  const relativePath = relativePathFromId(id);
  const { raw } = await getGitHubFile(repoPathFromRelative(relativePath));
  const summary = articleSummaryFromRaw(raw, relativePath, { addedTimestamp: 0 });
  const { content } = splitFrontmatter(raw);
  return { ...summary, content };
}

async function listArticles() {
  if (STORAGE_MODE === "github") return listGitHubArticles();

  if (!existsSync(ARTICLES_DIR)) {
    throw new Error(`Articles directory does not exist: ${ARTICLES_DIR}`);
  }

  const files = await walkMarkdownFiles(ARTICLES_DIR);
  const articles = await Promise.all(files.map((filePath) => localArticleSummary(filePath)));

  articles.sort((a, b) => b.addedTimestamp - a.addedTimestamp || a.title.localeCompare(b.title));
  return articles;
}

async function getArticle(id) {
  if (STORAGE_MODE === "github") return getGitHubArticle(id);

  const { fullPath } = articlePathFromId(id);
  const raw = await readFile(fullPath, "utf8");
  const summary = await localArticleSummary(fullPath);
  const { content } = splitFrontmatter(raw);
  return { ...summary, content };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".webp": "image/webp",
  };
  return types[extension] || "application/octet-stream";
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);

  if (!isInside(PUBLIC_DIR, filePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": fileStat.size,
      "Content-Type": contentTypeFor(filePath),
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function serveArticleAsset(res, articleIdParam, assetPath) {
  if (!assetPath) {
    sendText(res, 400, "Missing asset path");
    return;
  }

  if (STORAGE_MODE === "github") {
    await serveGitHubArticleAsset(res, articleIdParam, assetPath);
    return;
  }

  const { fullPath: articlePath } = articlePathFromId(articleIdParam);
  const encodedAssetPath = assetPath.split(/[?#]/)[0];
  let cleanAssetPath = encodedAssetPath;
  try {
    cleanAssetPath = decodeURIComponent(encodedAssetPath);
  } catch {
    cleanAssetPath = encodedAssetPath;
  }
  const resolvedAssetPath = path.resolve(path.dirname(articlePath), cleanAssetPath);

  if (!isInside(path.dirname(articlePath), resolvedAssetPath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const fileStat = await stat(resolvedAssetPath);
    if (!fileStat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Cache-Control": "public, max-age=3600",
      "Content-Length": fileStat.size,
      "Content-Type": contentTypeFor(resolvedAssetPath),
    });
    createReadStream(resolvedAssetPath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function serveGitHubArticleAsset(res, articleIdParam, assetPath) {
  const articleRelativePath = relativePathFromId(articleIdParam);
  const encodedAssetPath = assetPath.split(/[?#]/)[0];
  let cleanAssetPath = encodedAssetPath;
  try {
    cleanAssetPath = decodeURIComponent(encodedAssetPath);
  } catch {
    cleanAssetPath = encodedAssetPath;
  }

  const assetRelativePath = normalizeRelativePath(
    path.posix.join(path.posix.dirname(articleRelativePath), cleanRepoPath(cleanAssetPath)),
  );
  const articleDir = path.posix.dirname(articleRelativePath);
  if (articleDir !== "." && !assetRelativePath.startsWith(`${articleDir}/`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const buffer = await githubRawRequest(
    `${githubContentsPath(repoPathFromRelative(assetRelativePath))}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
  );

  res.writeHead(200, {
    "Cache-Control": "public, max-age=3600",
    "Content-Length": buffer.length,
    "Content-Type": contentTypeFor(assetRelativePath),
  });
  res.end(buffer);
}

function yamlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return "null";
  return JSON.stringify(String(value));
}

function updateFrontmatter(frontmatter, updates) {
  const fields = new Set(Object.keys(updates));
  const lines = frontmatter ? frontmatter.split("\n") : [];
  const keptLines = [];
  let skippingField = false;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

    if (keyMatch) {
      skippingField = fields.has(keyMatch[1]);
      if (!skippingField) keptLines.push(line);
      continue;
    }

    if (skippingField) continue;
    keptLines.push(line);
  }

  while (keptLines.length && keptLines[keptLines.length - 1].trim() === "") {
    keptLines.pop();
  }

  for (const [key, value] of Object.entries(updates)) {
    keptLines.push(`${key}: ${yamlValue(value)}`);
  }

  return keptLines.join("\n");
}

function articleContentWithReadState(raw, read) {
  const { content, frontmatter } = splitFrontmatter(raw);
  const nextReadState = {
    read,
    readAt: read ? new Date().toISOString() : null,
  };
  const nextFrontmatter = updateFrontmatter(frontmatter, nextReadState);
  const nextContent = `---\n${nextFrontmatter}\n---\n${content}`;
  return { nextContent, nextReadState };
}

async function setLocalArticleRead(id, read) {
  const { fullPath } = articlePathFromId(id);
  const raw = await readFile(fullPath, "utf8");
  const { nextContent, nextReadState } = articleContentWithReadState(raw, read);
  const tempFile = `${fullPath}.${process.pid}.tmp`;

  await writeFile(tempFile, nextContent, "utf8");
  await rename(tempFile, fullPath);
  return nextReadState;
}

async function putGitHubFile(repoPath, content, sha, message) {
  await githubRequest(githubContentsPath(repoPath), {
    body: JSON.stringify({
      branch: GITHUB_BRANCH,
      content: Buffer.from(content, "utf8").toString("base64"),
      message,
      sha,
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
}

async function setGitHubArticleRead(id, read) {
  const relativePath = relativePathFromId(id);
  const repoPath = repoPathFromRelative(relativePath);
  const message = `${read ? "Mark read" : "Mark unread"}: ${relativePath}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { raw, sha } = await getGitHubFile(repoPath);
    const { nextContent, nextReadState } = articleContentWithReadState(raw, read);

    try {
      await putGitHubFile(repoPath, nextContent, sha, message);
      return nextReadState;
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 409 && attempt === 0) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Could not update GitHub file after retrying conflict");
}

async function setArticleRead(id, read) {
  if (STORAGE_MODE === "github") return setGitHubArticleRead(id, read);
  return setLocalArticleRead(id, read);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        articlesDir: ARTICLES_DIR,
        github:
          STORAGE_MODE === "github"
            ? {
                articlesPath: GITHUB_ARTICLES_PATH || ".",
                branch: GITHUB_BRANCH,
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
              }
            : null,
        ok: true,
        storageMode: STORAGE_MODE,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/articles") {
      sendJson(res, 200, { articles: await listArticles() });
      return;
    }

    const articleMatch = url.pathname.match(/^\/api\/articles\/([^/]+)$/);
    if (req.method === "GET" && articleMatch) {
      sendJson(res, 200, { article: await getArticle(articleMatch[1]) });
      return;
    }

    const assetMatch = url.pathname.match(/^\/api\/articles\/([^/]+)\/asset$/);
    if (req.method === "GET" && assetMatch) {
      await serveArticleAsset(res, assetMatch[1], url.searchParams.get("path"));
      return;
    }

    const readMatch = url.pathname.match(/^\/api\/articles\/([^/]+)\/read$/);
    if (req.method === "PATCH" && readMatch) {
      const body = await readJsonBody(req);
      if (typeof body.read !== "boolean") {
        sendJson(res, 400, { error: "Expected boolean read value" });
        return;
      }
      sendJson(res, 200, { state: await setArticleRead(readMatch[1], body.read) });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url);
      return;
    }

    sendText(res, 405, "Method not allowed");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

function lanUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

server.listen(PORT, HOST, () => {
  console.log(`Read It Later is running`);
  console.log(`Local:   http://localhost:${PORT}`);
  for (const url of lanUrls(PORT)) {
    console.log(`Phone:   ${url}`);
  }
  if (STORAGE_MODE === "github") {
    console.log(`Storage: GitHub ${GITHUB_OWNER}/${GITHUB_REPO}:${GITHUB_BRANCH}/${GITHUB_ARTICLES_PATH}`);
  } else {
    console.log(`Articles: ${ARTICLES_DIR}`);
  }
});
