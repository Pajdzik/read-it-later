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

If no allowlist is set, any GitHub account that can authorize the OAuth app can sign in.

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

In GitHub mode:

- `GET /api/articles` lists Markdown files under `GITHUB_ARTICLES_PATH`.
- `GET /api/articles/:id` reads article Markdown from the repo.
- `GET /api/articles/:id/asset?path=...` serves relative article assets from the repo.
- `PATCH /api/articles/:id/read` commits the updated frontmatter back to `GITHUB_BRANCH`.

If a file changes between fetch and commit, the app retries the read-state commit once with the latest file SHA.
