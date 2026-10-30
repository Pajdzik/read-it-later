# Retired Node prototype

The Node.js Markdown-reader prototype has been removed. Potem is maintained and deployed as a Cloudflare Worker with D1 and Workers Static Assets; local development uses Wrangler through `pnpm dev` (or `pnpm start`).

The old prototype source and deployment files remain available in Git history. To inspect a file from a revision before its removal, use `git show <revision>:server.ts` or `git show <revision>:Dockerfile`.

The offline [Obsidian converter](obsidian-import.md), [GitHub backup converter](github-recovery.md), and portable archive tools remain supported for reviewing and importing existing Markdown backups. They do not start a server or modify source folders. No user vault or backup was read or migrated as part of retiring the prototype.
