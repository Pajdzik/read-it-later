# Read Later

A local web reader for the `Articles` folder in Kamilpedia. It reads Markdown files from the Obsidian vault, serves local article images, and stores read/unread state in each article's YAML frontmatter.

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
