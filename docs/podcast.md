# Private article podcast

Potem can prepare an English narration of a saved copy and expose completed episodes through a private RSS feed. On iPhone, add that URL in Podcasts under **Library → … → Follow a Show by URL**. Downloads, playback speed, queue, listening position, and screen-off controls belong to the podcast app. Listening never changes an article's read status in Potem.

**Prepare audio** is the only generation trigger. Viewing articles, reading the feed, polling status, and downloading audio never call the speech provider. Completed episodes stay in private R2 storage until their article or audio is explicitly deleted. There is no automatic removal after listening. A podcast download is not evidence that an episode was heard.

## Enable the feature

The main Worker and capture service ship with `ARTICLE_AUDIO_ENABLED=false`. The production deployment workflow provisions the audio bucket and queue, applies migrations, and deploys both services, while leaving generation disabled. For staging, provision the corresponding resources and deploy both configurations to `--env staging`.

1. Enable Google Cloud Text-to-Speech and billing on the intended project. Create a dedicated service account authorized to use the billed project's API. Use the [Google authentication guidance](https://docs.cloud.google.com/text-to-speech/docs/authentication); do not grant broad Owner/Editor access simply for narration.
2. Store the service account JSON as the **main Worker's** `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` secret. Keep the private key out of source, command arguments, logs, and chat. Wrangler's interactive secret input or a protected stdin file can accept the JSON. The capture service needs no Google credentials.
3. Set `GOOGLE_TTS_PROJECT_ID`, `AUDIO_MONTHLY_BUDGET_USD` (default `10`), and `AUDIO_FREE_CHARACTERS` in the selected main Worker environment. The free allocation defaults to `0`; set it to `1000000` only after verifying that the allowance is available to this app. A separate project does not by itself isolate a shared billing account's allowance.
4. Create `read-it-later-audio-<environment>` as a private R2 bucket, bound as `AUDIO_BUCKET` in **both** Workers. Ensure the queue with `pnpm audio:queue:ensure --env <environment> --execute`. Apply D1 migrations to the selected environment. Main and capture must share the same D1 database and audio bucket.
5. Deploy the capture image/service with FFmpeg installed, then the main Worker. Set `ARTICLE_AUDIO_ENABLED=true` in both environment configurations only after the validation below passes. Keep the existing extraction flags independent.
6. In Potem, open a saved copy and select **Prepare audio**. Once ready, create a feed in Settings, copy its URL, and subscribe on the iPhone.

The local example configuration documents the same variables. Local execution also needs the private capture service binding; setting a flag alone does not supply an assembler. Default builds and tests do not use real Google credentials.

## Generation and costs

The initial voice is `en-US-Chirp3-HD-Charon`. Markdown is converted deterministically: prose, headings, lists, link labels, and table rows are narrated; fenced code is announced and remains available in the saved copy. No summarization/rewrite model is involved. An episode snapshots its title, author, and saved-copy revision. Subsequent edits do not silently replace its audio or RSS identity.

Google requests are split at natural boundaries below 4,500 UTF-8 bytes, within the [5,000-byte API limit](https://docs.cloud.google.com/text-to-speech/quotas). Each successful 24 kHz mono PCM WAV chunk is checkpointed in R2. The private container joins the WAVs with FFmpeg and encodes one seekable 64 kbps MP3. Assembly retries reuse the WAVs. Ready media is published only after byte count and duration are available.

At 150 words/minute and roughly 9,000 characters per ten minutes, ten hours needs about 540,000 characters. [Chirp pricing](https://cloud.google.com/text-to-speech/pricing) currently includes one million monthly characters, followed by $30 per million. That example is $0 if its free allowance is unused, or $16.20 without it, before retries and infrastructure. Replaying completed audio has no new synthesis cost. At 64 kbps, ten hours occupies approximately 288 MB.

The monthly ledger follows the Pacific billing calendar and uses conservative request units. It reserves budget before requests and includes uncertain outcomes, so failures cannot silently release potentially charged usage. A provider request with an uncertain outcome requires an explicit retry; completed chunks are reused. If the estimated spending limit is reached, generation stops and the owner can retry after adjusting the limit or after the billing period changes. This is an **estimated feature spending limit**, not a guarantee about Google's total invoice, taxes, or consumption outside Potem. Provider billing alerts are a useful additional check.

## Privacy and lifecycle

- Owner APIs use the existing session and CSRF checks. Capture tokens cannot generate audio, read episodes, or manage the feed.
- Podcast clients use a separate, random, read-only URL token, independent of login cookies. D1 stores only its SHA-256 hash. The URL is shown once, held only in UI memory, and cleared on Settings close/session end.
- Anyone possessing that URL can read the feed and download its episodes. **Rotate feed URL** invalidates the old feed and media URLs; update the podcast subscription afterward. **Revoke feed** stops new access. Already downloaded files cannot be recalled.
- Tokens stay in query parameters, which configured Worker observability redacts. Application logs must not contain URLs, feed bodies, provider responses, credentials, or capability tokens. Audio buckets have no public access.
- Each episode has an immutable GUID and enclosure URL. The RSS response contains the latest 1,000 completed episodes; older media URLs remain valid until explicit removal. Article deletion immediately denies feed/media access, with durable R2 cleanup afterward. Ready files are never removed merely because they are old or have been downloaded.
- Audio is derived data and is excluded from the existing portable library JSON/ZIP exports. Restoring the library does not restore podcast tokens or synthesized files; prepare audio again as needed.

## Interfaces

| Route | Authorization and behavior |
| --- | --- |
| `GET /api/articles/:id/audio` | Owner; status and estimate, no generation |
| `POST /api/articles/:id/audio` | Owner + CSRF; `{expectedRevision}` prepares or explicitly retries |
| `DELETE /api/articles/:id/audio` | Owner + CSRF; removes episode and cancels pending work |
| `GET /api/podcast/settings` | Owner; feature status, token creation date, ready count, monthly usage |
| `POST /api/podcast/token` | Owner + CSRF; creates/rotates token, returns URL once |
| `DELETE /api/podcast/token` | Owner + CSRF; revokes feed/media access |
| `GET/HEAD /api/podcast/feed.xml?token=…` | Podcast token; RSS, never generation |
| `GET/HEAD /api/podcast/episodes/:id.mp3?token=…` | Podcast token; completed MP3, byte ranges and seeking |

The assembly endpoint is a private service-binding route, not a public app API. Its temporary capability grants access only to the validated chunk list for one leased job and is revoked afterward. Requests never supply arbitrary download URLs or filesystem paths.

## Release validation

Run `pnpm typecheck`, the Worker tests, `pnpm test:capture`, `pnpm test:queues-deployment`, `pnpm test:podcast-ui`, and both deployment dry runs. Exercise the mobile/browser regressions after building. Before enabling production, validate a representative long article and a maximum-size saved copy on the actual Cloudflare basic container; reject resource-limit failures explicitly without truncating text.

Audition prose, names, numbers, technical terms, tables, and joins at 1× and 1.5×. Then subscribe with a physical iPhone and verify refreshed episodes, full downloads, airplane mode, seeking, interruptions, Bluetooth/lock-screen controls, and resume. Browser emulation cannot prove native podcast behavior. Provider quality claims and mocked tests do not establish actual voice quality.
