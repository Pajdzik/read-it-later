import { createReadStream, existsSync, readFileSync } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import crypto from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv(path.join(__dirname, ".env"));

const DEFAULT_ARTICLES_DIR =
  "/Users/kamil/Library/Mobile Documents/iCloud~md~obsidian/Documents/Kamilpedia/Articles";

const ARTICLES_DIR = path.resolve(process.env.ARTICLES_DIR || DEFAULT_ARTICLES_DIR);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3055);
const HOST = process.env.HOST || "0.0.0.0";
const STORAGE_MODE =
  process.env.STORAGE_MODE ||
  (process.env.GITHUB_OWNER || process.env.GITHUB_REPO || process.env.GITHUB_TOKEN ? "github" : "local");
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || "";
const GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || "";
const AUTH_ENABLED = Boolean(GITHUB_OAUTH_CLIENT_ID || GITHUB_OAUTH_CLIENT_SECRET);
const AUTH_BASE_URL = cleanOrigin(process.env.AUTH_BASE_URL || "");
const AUTH_ALLOWED_GITHUB_USERS = parseList(process.env.AUTH_ALLOWED_GITHUB_USERS ?? process.env.AUTH_ALLOWED_USERS).map(
  (login) => login.replace(/^@/, "").toLowerCase(),
);
const AUTH_ALLOWED_EMAILS = parseList(process.env.AUTH_ALLOWED_EMAILS).map((email) => email.toLowerCase());
const AUTH_ALLOWED_DOMAINS = parseList(process.env.AUTH_ALLOWED_DOMAINS).map((domain) =>
  domain.replace(/^@/, "").toLowerCase(),
);
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "read_later_session";
const AUTH_SESSION_DAYS = positiveNumber(process.env.AUTH_SESSION_DAYS, 7);
const AUTH_SESSION_MAX_AGE_SECONDS = Math.max(60, Math.floor(AUTH_SESSION_DAYS * 24 * 60 * 60));
const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE;
const GITHUB_OAUTH_SCOPE = process.env.GITHUB_OAUTH_SCOPE || "read:user user:email";
const GITHUB_OAUTH_AUTH_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_OAUTH_API = "https://api.github.com";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();
const oauthStates = new Map();

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t") : inner;
  }

  return trimmed.replace(/\s+#.*$/, "").trim();
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] == null) {
      process.env[key] = unquoteEnvValue(rawValue);
    }
  }
}

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

if (AUTH_ENABLED && (!GITHUB_OAUTH_CLIENT_ID || !GITHUB_OAUTH_CLIENT_SECRET)) {
  throw new Error("GitHub OAuth requires both GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET");
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

function sendRedirect(res, status, location) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    Location: location,
  });
  res.end();
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanOrigin(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestOrigin(req) {
  if (AUTH_BASE_URL) return AUTH_BASE_URL;

  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const protocol = forwardedProto?.split(",")[0]?.trim() || (req.socket.encrypted ? "https" : "http");
  const host = forwardedHost?.split(",")[0]?.trim() || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function oauthRedirectUri(req) {
  return `${requestOrigin(req)}/auth/github/callback`;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie || "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
  } else {
    res.setHeader("Set-Cookie", [current, cookie]);
  }
}

function secureCookie(req) {
  if (AUTH_COOKIE_SECURE != null) return booleanFromEnv(AUTH_COOKIE_SECURE);
  return requestOrigin(req).startsWith("https://");
}

function sessionCookie(sessionId, req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(
    sessionId,
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_SESSION_MAX_AGE_SECONDS}${secure}`;
}

function clearSessionCookie(req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function safeNextPath(value) {
  if (!value) return "/";

  try {
    const parsed = new URL(value, "http://read-later.local");
    if (parsed.origin !== "http://read-later.local") return "/";
    if (parsed.pathname.startsWith("/auth/")) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function loginPathFor(url) {
  const loginUrl = new URL("/auth/github", "http://read-later.local");
  loginUrl.searchParams.set("next", safeNextPath(`${url.pathname}${url.search}`));
  return `${loginUrl.pathname}${loginUrl.search}`;
}

function pruneExpiredAuthRecords() {
  const now = Date.now();

  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(sessionId);
  }

  for (const [state, pending] of oauthStates) {
    if (pending.expiresAt <= now) oauthStates.delete(state);
  }
}

function getSession(req) {
  if (!AUTH_ENABLED) return null;

  const sessionId = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return { id: sessionId, ...session };
}

function createSession(user) {
  const sessionId = randomToken();
  sessions.set(sessionId, {
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + AUTH_SESSION_MAX_AGE_SECONDS * 1000,
    user,
  });
  return sessionId;
}

function consumeOAuthState(state) {
  if (!state) return null;

  const pending = oauthStates.get(state);
  oauthStates.delete(state);
  if (!pending || pending.expiresAt <= Date.now()) return null;
  return pending;
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function githubAuthHeaders(accessToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "read-it-later",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function githubOAuthRequest(apiPath, accessToken) {
  const response = await fetch(`${GITHUB_OAUTH_API}${apiPath}`, {
    headers: githubAuthHeaders(accessToken),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }

  return data;
}

function verifiedPrimaryEmail(emails) {
  if (!Array.isArray(emails)) return "";

  const primary = emails.find((email) => email.primary && email.verified);
  const verified = emails.find((email) => email.verified);
  return String(primary?.email || verified?.email || "").toLowerCase();
}

function githubProfileFromOAuth(profile, emails) {
  const publicEmail = String(profile.email || "").toLowerCase();
  const email = publicEmail || verifiedPrimaryEmail(emails);
  const emailDomain = email.includes("@") ? email.split("@").pop() : "";
  const login = String(profile.login || "");

  return {
    email,
    emailDomain,
    id: String(profile.id || ""),
    login,
    loginLower: login.toLowerCase(),
    name: String(profile.name || login || email),
    picture: String(profile.avatar_url || ""),
    url: String(profile.html_url || ""),
  };
}

function canDecideAccessWithoutPrivateEmails(profile) {
  const loginLower = String(profile.login || "").toLowerCase();
  const publicEmail = String(profile.email || "").toLowerCase();
  const publicEmailDomain = publicEmail.includes("@") ? publicEmail.split("@").pop() : "";
  const hasEmailAllowlist = AUTH_ALLOWED_EMAILS.length || AUTH_ALLOWED_DOMAINS.length;

  return (
    !hasEmailAllowlist ||
    AUTH_ALLOWED_GITHUB_USERS.includes(loginLower) ||
    AUTH_ALLOWED_EMAILS.includes(publicEmail) ||
    (publicEmailDomain && AUTH_ALLOWED_DOMAINS.includes(publicEmailDomain))
  );
}

function userIsAllowed(user) {
  if (!AUTH_ALLOWED_GITHUB_USERS.length && !AUTH_ALLOWED_EMAILS.length && !AUTH_ALLOWED_DOMAINS.length) return true;
  if (AUTH_ALLOWED_GITHUB_USERS.includes(user.loginLower)) return true;
  if (user.email && AUTH_ALLOWED_EMAILS.includes(user.email)) return true;
  return user.emailDomain && AUTH_ALLOWED_DOMAINS.includes(user.emailDomain);
}

function authorizeRequest(req, res, url) {
  if (!AUTH_ENABLED) return true;

  const session = getSession(req);
  if (session) {
    req.authSession = session;
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 401, {
      error: "Sign in required",
      loginUrl: loginPathFor(url),
    });
    return false;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    sendRedirect(res, 302, loginPathFor(url));
    return false;
  }

  sendText(res, 401, "Sign in required");
  return false;
}

async function startGitHubOAuth(req, res, url) {
  if (!AUTH_ENABLED) {
    sendRedirect(res, 303, "/");
    return;
  }

  pruneExpiredAuthRecords();

  const state = randomToken();
  const codeVerifier = randomToken(48);
  oauthStates.set(state, {
    codeVerifier,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    next: safeNextPath(url.searchParams.get("next")),
  });

  const authUrl = new URL(GITHUB_OAUTH_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", GITHUB_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", oauthRedirectUri(req));
  authUrl.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "select_account");

  sendRedirect(res, 302, authUrl.href);
}

async function exchangeGitHubCode(req, code, codeVerifier) {
  const body = new URLSearchParams({
    client_id: GITHUB_OAUTH_CLIENT_ID,
    client_secret: GITHUB_OAUTH_CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    redirect_uri: oauthRedirectUri(req),
  });

  const response = await fetch(GITHUB_OAUTH_TOKEN_ENDPOINT, {
    body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const message = data.error_description || data.error || response.statusText;
    throw new Error(`GitHub token exchange failed: ${message}`);
  }

  if (!data.access_token) {
    throw new Error("GitHub token exchange did not return an access token");
  }

  return data;
}

async function finishGitHubOAuth(req, res, url) {
  if (!AUTH_ENABLED) {
    sendRedirect(res, 303, "/");
    return;
  }

  const pending = consumeOAuthState(url.searchParams.get("state"));
  if (!pending) {
    sendText(res, 401, "Invalid or expired GitHub sign-in state.");
    return;
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    sendText(res, 401, `GitHub sign-in failed: ${oauthError}`);
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    sendText(res, 400, "Missing GitHub authorization code.");
    return;
  }

  try {
    const tokens = await exchangeGitHubCode(req, code, pending.codeVerifier);
    const profile = await githubOAuthRequest("/user", tokens.access_token);
    let emails = [];

    try {
      emails = await githubOAuthRequest("/user/emails?per_page=100", tokens.access_token);
    } catch (error) {
      if (!canDecideAccessWithoutPrivateEmails(profile)) throw error;
      console.warn(`GitHub email lookup skipped: ${error.message || error}`);
    }

    const user = githubProfileFromOAuth(profile, emails);
    if (!user.id || !user.login) {
      sendText(res, 401, "GitHub did not return a usable user profile.");
      return;
    }
    if (!userIsAllowed(user)) {
      sendText(res, 403, "This GitHub account is not allowed to access Read Later.");
      return;
    }

    const sessionId = createSession(user);
    appendSetCookie(res, sessionCookie(sessionId, req));
    sendRedirect(res, 303, pending.next);
  } catch (error) {
    console.error(error);
    sendText(res, 401, error.message || "GitHub sign-in failed.");
  }
}

function signOut(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);

  appendSetCookie(res, clearSessionCookie(req));
  sendJson(res, 200, { ok: true });
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

    if (req.method === "GET" && url.pathname === "/auth/github") {
      await startGitHubOAuth(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/github/callback") {
      await finishGitHubOAuth(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      signOut(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const session = getSession(req);
      sendJson(res, 200, {
        auth: {
          enabled: AUTH_ENABLED,
          provider: AUTH_ENABLED ? "github" : null,
          user: session?.user || null,
        },
      });
      return;
    }

    if (!authorizeRequest(req, res, url)) return;

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
  if (AUTH_ENABLED) {
    const callbackOrigin = AUTH_BASE_URL || `http://localhost:${PORT}`;
    console.log(`Auth:    GitHub OAuth`);
    console.log(`OAuth:   ${callbackOrigin}/auth/github/callback`);
    if (!AUTH_ALLOWED_GITHUB_USERS.length && !AUTH_ALLOWED_EMAILS.length && !AUTH_ALLOWED_DOMAINS.length) {
      console.warn(
        "Auth:    no AUTH_ALLOWED_GITHUB_USERS, AUTH_ALLOWED_EMAILS, or AUTH_ALLOWED_DOMAINS set; any GitHub account can sign in",
      );
    }
  } else {
    console.log("Auth:    disabled");
  }
  if (STORAGE_MODE === "github") {
    console.log(`Storage: GitHub ${GITHUB_OWNER}/${GITHUB_REPO}:${GITHUB_BRANCH}/${GITHUB_ARTICLES_PATH}`);
  } else {
    console.log(`Articles: ${ARTICLES_DIR}`);
  }
});
