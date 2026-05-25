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

function articleId(relativePath) {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function relativePathFromId(id) {
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  const normalized = path.normalize(decoded);
  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error("Invalid article id");
  }
  return normalized;
}

function articlePathFromId(id) {
  const relativePath = relativePathFromId(id);
  const fullPath = path.resolve(ARTICLES_DIR, relativePath);
  if (!isInside(ARTICLES_DIR, fullPath)) {
    throw new Error("Invalid article path");
  }
  return { fullPath, relativePath };
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
    .basename(filename, path.extname(filename))
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

async function articleSummary(filePath) {
  const raw = await readFile(filePath, "utf8");
  const fileStat = await stat(filePath);
  const relativePath = path.relative(ARTICLES_DIR, filePath);
  const id = articleId(relativePath);
  const { content, frontmatter } = splitFrontmatter(raw);
  const metadata = parseFrontmatter(frontmatter);
  const filenameDate = dateFromFilename(path.basename(filePath));
  const created = dateFromString(firstValue(metadata.created)) || filenameDate;
  const published = dateFromString(firstValue(metadata.published)) || filenameDate;
  const added = created || fileStat.birthtime.toISOString().slice(0, 10);
  const categoryPath = path.dirname(relativePath);
  const category = categoryPath === "." ? "Uncategorized" : categoryPath.split(path.sep).join(" / ");
  const stats = readingStats(content);
  const source = cleanScalar(firstValue(metadata.source) || sourceFromContent(content) || "");

  return {
    added,
    addedTimestamp: Date.parse(added) || fileStat.birthtimeMs,
    author: Array.isArray(metadata.author)
      ? metadata.author.map(normalizeWikiLink).filter(Boolean)
      : normalizeWikiLink(metadata.author || ""),
    category,
    created,
    excerpt: summarize(content, metadata.description),
    id,
    modifiedAt: fileStat.mtime.toISOString(),
    published,
    publishedTimestamp: Date.parse(published) || 0,
    read: booleanFromYaml(metadata.read),
    readAt: nullableScalar(metadata.readAt),
    relativePath,
    source,
    title: cleanScalar(firstValue(metadata.title)) || titleFromContent(content) || titleFromFilename(filePath),
    ...stats,
  };
}

async function listArticles() {
  if (!existsSync(ARTICLES_DIR)) {
    throw new Error(`Articles directory does not exist: ${ARTICLES_DIR}`);
  }

  const files = await walkMarkdownFiles(ARTICLES_DIR);
  const articles = await Promise.all(files.map((filePath) => articleSummary(filePath)));

  articles.sort((a, b) => b.addedTimestamp - a.addedTimestamp || a.title.localeCompare(b.title));
  return articles;
}

async function getArticle(id) {
  const { fullPath } = articlePathFromId(id);
  const raw = await readFile(fullPath, "utf8");
  const summary = await articleSummary(fullPath);
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

async function setArticleRead(id, read) {
  const { fullPath } = articlePathFromId(id);
  const raw = await readFile(fullPath, "utf8");
  const { content, frontmatter } = splitFrontmatter(raw);
  const nextReadState = {
    read,
    readAt: read ? new Date().toISOString() : null,
  };
  const nextFrontmatter = updateFrontmatter(frontmatter, nextReadState);
  const nextContent = `---\n${nextFrontmatter}\n---\n${content}`;
  const tempFile = `${fullPath}.${process.pid}.tmp`;

  await writeFile(tempFile, nextContent, "utf8");
  await rename(tempFile, fullPath);
  return nextReadState;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        articlesDir: ARTICLES_DIR,
        ok: true,
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
  console.log(`Articles: ${ARTICLES_DIR}`);
});
