# Read Later

A web reader for the `Articles` folder in Kamilpedia. It can read Markdown files from a local Obsidian vault or from a GitHub repository, serve article images, and store read/unread state in each article's YAML frontmatter.

## Start

```sh
npm start
```

Open the local URL printed by the server:

```text
http://localhost:3055
```

For phone access, keep the Mac and phone on the same Wi-Fi network and open the `Phone:` URL printed by the server.

## Configuration

The default article folder is:

```text
/Users/kamil/Library/Mobile Documents/iCloud~md~obsidian/Documents/Kamilpedia/Articles
```

You can override it when starting the app:

```sh
ARTICLES_DIR="/path/to/Articles" npm start
```

The server automatically loads a local `.env` file before reading configuration. Values already set in your shell take precedence.

Read state is written directly to article frontmatter:

```yaml
read: true
readAt: "2026-05-24T22:33:00.000Z"
```

Articles without frontmatter get a small frontmatter block the first time they are marked read or unread.

No package install is required; the app uses only Node built-ins.

## Docker deployment

Build the image:

```sh
docker build -t read-it-later .
```

Run with GitHub-backed storage:

```sh
docker run --rm -p 3055:3055 \
  -e STORAGE_MODE=github \
  -e GITHUB_OWNER="your-github-user-or-org" \
  -e GITHUB_REPO="your-repo" \
  -e GITHUB_BRANCH="main" \
  -e GITHUB_ARTICLES_PATH="Articles" \
  -e GITHUB_TOKEN="github_pat_..." \
  -e AUTH_BASE_URL="https://reader.example.com" \
  -e AUTH_ALLOWED_GITHUB_USERS="your-github-login" \
  -e GITHUB_OAUTH_CLIENT_ID="your-oauth-client-id" \
  -e GITHUB_OAUTH_CLIENT_SECRET="your-oauth-client-secret" \
  read-it-later
```

For production, especially when `GITHUB_TOKEN` is set, enable GitHub OAuth and at least one allowlist setting such as `AUTH_ALLOWED_GITHUB_USERS`, `AUTH_ALLOWED_EMAILS`, or `AUTH_ALLOWED_DOMAINS`. Without OAuth credentials, authentication is disabled.

Deployment health checks can use:

```text
GET /healthz
```

This endpoint is intentionally unauthenticated and only returns `{"ok":true}`.

For local file-backed storage, mount the article folder and point `ARTICLES_DIR` at the container path:

```sh
docker run --rm -p 3055:3055 \
  -v "/path/to/Articles:/articles" \
  -e ARTICLES_DIR="/articles" \
  read-it-later
```

## GitHub OAuth

Authentication is disabled by default. Set GitHub OAuth app credentials in `.env` to require GitHub sign-in before serving the app or article APIs:

```dotenv
AUTH_BASE_URL=http://localhost:3055
AUTH_ALLOWED_GITHUB_USERS=your-github-login
GITHUB_OAUTH_CLIENT_ID=your-oauth-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-oauth-client-secret
```

Create a GitHub OAuth app, then set its authorization callback URL to:

```text
http://localhost:3055/auth/github/callback
```

If the app is served through another origin, set `AUTH_BASE_URL` to that origin and use the matching callback URI, for example `https://reader.example.com/auth/github/callback`.

The OAuth credentials above are separate from the `GITHUB_TOKEN` used by GitHub-backed article storage.

Optional auth settings:

- `AUTH_ALLOWED_GITHUB_USERS`: comma-separated GitHub usernames allowed to sign in.
- `AUTH_ALLOWED_EMAILS`: comma-separated verified GitHub account emails allowed to sign in.
- `AUTH_ALLOWED_DOMAINS`: comma-separated verified GitHub account email domains allowed to sign in.
- `GITHUB_OAUTH_SCOPE`: OAuth scopes to request, default `read:user user:email`.
- `AUTH_SESSION_DAYS`: session lifetime, default `7`.
- `AUTH_COOKIE_SECURE`: set to `true` when serving behind HTTPS and `AUTH_BASE_URL` cannot be inferred.
- `PATCH_READ_BODY_LIMIT_BYTES`: maximum JSON body size for read-state updates, default `4096`.

If no allowlist is set, any GitHub account that can authorize the OAuth app can sign in.

In `NODE_ENV=production`, GitHub-backed storage with `GITHUB_TOKEN` requires OAuth, and OAuth requires at least one allowlist setting. The explicit escape hatches are `ALLOW_UNAUTHENTICATED_GITHUB_WRITES=true` and `ALLOW_OPEN_PRODUCTION_AUTH=true`; they are meant for deliberate private deployments, not public exposure.

## GitHub-backed deployment

Set `STORAGE_MODE=github` to read and write articles through the GitHub API instead of the local filesystem:

```sh
STORAGE_MODE=github \
GITHUB_OWNER="your-github-user-or-org" \
GITHUB_REPO="your-repo" \
GITHUB_BRANCH="main" \
GITHUB_ARTICLES_PATH="Articles" \
GITHUB_TOKEN="github_pat_..." \
npm start
```

The token must stay on the server as an environment variable. Use a fine-grained GitHub personal access token scoped to the target repository with `Contents: Read and write`.

For any production deployment that uses `GITHUB_TOKEN`, set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_BASE_URL`, and at least one auth allowlist. This prevents a server with repository write access from being exposed with authentication disabled or open to any GitHub account.

In GitHub mode:

- `GET /api/articles` lists Markdown files under `GITHUB_ARTICLES_PATH`.
- `GET /api/articles/:id` reads article Markdown from the repo.
- `GET /api/articles/:id/asset?path=...` serves relative article assets from the repo.
- `PATCH /api/articles/:id/read` commits the updated frontmatter back to `GITHUB_BRANCH`.

If a file changes between fetch and commit, the app retries the read-state commit once with the latest file SHA.
