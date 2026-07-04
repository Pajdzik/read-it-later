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

Read state is written directly to article frontmatter:

```yaml
read: true
readAt: "2026-05-24T22:33:00.000Z"
```

Articles without frontmatter get a small frontmatter block the first time they are marked read or unread.

No package install is required; the app uses only Node built-ins.

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
