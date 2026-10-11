# Protected article fetch gateway

This follow-up service supplies the connection-time destination check required by automatic Markdown extraction. The application saves each bookmark and its durable extraction intent before processing; gateway failure can fail the copy job, but cannot undo or reject the saved bookmark. The production feature remains paused until this gateway and its private route pass staging checks.

## Components and trust boundary

```mermaid
flowchart LR
    App[Main Worker] -->|ARTICLE_FETCHER service binding| Adapter[Private adapter Worker]
    Adapter -->|fixed VPC Service + shared secret| Tunnel[Cloudflare Tunnel]
    Tunnel --> Gateway[Node gateway on your host]
    Gateway -->|one pinned public HTTP(S) connection| Origin[Public article origin]
```

The adapter has no `workers.dev` route or preview URL. It accepts only a GET carrying the original URL, validates it, and sends a small JSON request to one fixed gateway endpoint. It forwards no caller cookies, bearer token, authorization, referer, or arbitrary headers. The gateway requires a separate 32-byte-or-longer secret, resolves A/AAAA answers once, rejects the request if any answer is not public, and connects to a chosen validated address through a custom socket lookup. HTTPS uses the original hostname for SNI and certificate verification. Automatic redirects are returned to the main Worker, which revalidates and follows at most three hops. There is no ordinary-fetch fallback.

The gateway only returns the upstream status and `Content-Type`, `Location`, and `Retry-After`; cookies and internal headers are discarded. It requests identity encoding, rejects compressed responses, enforces a 5-second hop timeout and 512 KiB body cap, and bounds concurrent work. Logs contain startup/error category data only; never add source URLs, query strings, response bodies, or tokens to logs.

Workers VPC is the private path to the host, not the host compute itself. [Workers VPC is currently documented as free during beta](https://developers.cloudflare.com/workers-vpc/reference/pricing/) and requires an active Tunnel/Mesh/WAN connection; [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) expose only the registered service. The Node host, its availability, and its network egress are your responsibility. Ordinary Gateway block policies are not the security guarantee here: Cloudflare's [policy enforcement order](https://developers.cloudflare.com/cloudflare-one/traffic-policies/order-of-enforcement/#connection-establishment) documents that a connection may begin before policy enforcement, and Enterprise Network Firewall is required to prevent that initial connection. The gateway pins the validated destination at its socket boundary instead.

## Resources to configure

Create distinct staging and production resources and secrets:

1. A small Node 22 host/container for each environment (or a deliberately isolated shared host), with outbound DNS and public HTTP(S) egress. Restrict inbound access to `cloudflared`/the Tunnel; do not publish port 8080 to the Internet. Keep the Docker container unprivileged and restartable.
2. A Cloudflare Tunnel from that host to the account, with the connector able to reach the gateway's HTTP listener on port 8080. Give each environment a separate private service target where practical.
3. A Workers VPC Service of type **HTTP** associated with the intended Tunnel and configured for HTTP port 8080. The adapter sends requests to the fixed hostname `article-fetch-gateway.internal`; the VPC Service ID determines the actual private route regardless of that request hostname. Scope the service target to only this gateway; do not bind the adapter to a broad VPC network.
4. Deploy `services/article-fetch-gateway` on the host. Build from the repository root with `docker build -f services/article-fetch-gateway/Dockerfile -t article-fetch-gateway .`. Supply `ARTICLE_FETCHER_TOKEN`, `APP_ORIGIN`, and comma-separated exact `BLOCKED_HOSTS` via the host's secret manager/runtime configuration. Use a random, unique token for each environment. The example environment file is a template only.
5. Put the staging and production VPC Service IDs in their matching `env.staging` and `env.production` blocks in `services/article-fetcher/wrangler.jsonc`. Add a unique `ARTICLE_FETCHER_TOKEN` Wrangler secret for each Worker, then deploy with `pnpm exec wrangler deploy --config services/article-fetcher/wrangler.jsonc --env staging` or `--env production`. Always name the environment explicitly; the top-level service ID is a template only. Keep `workers_dev` and preview URLs disabled. Verify each VPC binding points at the matching environment's gateway.
6. Add the optional main-app service binding only to the environment being staged. Start from [`services/article-fetcher/app-binding.template.jsonc`](../services/article-fetcher/app-binding.template.jsonc), set its actual adapter Worker name, and add the binding under that app environment's `services` array. Do not add a placeholder or unconditional production binding to the default app config: CI deploys production from the main config after a merge.

No app binding, token, hostname, VPC Service ID, Tunnel, container, or Gateway policy is provisioned by merging this code. Keep `BACKGROUND_CAPTURE_ENABLED=false` until all staging criteria pass.

Creating the VPC Service requires the Cloudflare **Connectivity Directory Admin** role; binding it to a Worker requires **Connectivity Directory Bind** or Admin. See [Workers VPC roles and bindings](https://developers.cloudflare.com/workers-vpc/api/#required-roles).

## Staging validation and release gates

Use staging-only app D1, adapter, VPC Service, tunnel hostname, gateway host configuration, and tokens. Save a bookmark from the mobile flow and close it after the successful save acknowledgment. Confirm that the article is present even when you deliberately stop the gateway; the extraction state may retry or fail, while the saved link remains.

Before enabling extraction in staging, record evidence for each item:

- The adapter has no public route/preview URL and rejects non-GET input, malformed URLs, credentials, restricted ports, private literals, and restricted host suffixes.
- The gateway rejects missing/wrong authentication, missing/malformed DNS results, mixed public/private A/AAAA results, mapped IPv4, link-local, loopback, private, reserved, and multicast targets. Use injected resolver/dial test fixtures; do not probe internal addresses.
- Gateway socket diagnostics in a controlled staging fixture prove the custom lookup selects only the validated address while HTTPS SNI/certificate checking stays on the original hostname. No redirect is followed in the gateway; the app validates each later hop.
- Redirect response, timeout, client disconnect, compressed response, missing or false `Content-Length`, and streamed 512 KiB overflow behave as expected. No partial page is returned as a successful extraction.
- The request/response path does not carry app cookies, capture tokens, OAuth secrets, upstream `Set-Cookie`, or unapproved headers. Logs contain no URL, page text, or credentials.
- Save acknowledgment succeeds and D1 contains the link even while extraction is unavailable. Then restore the gateway and validate one real public article through the entire adapter/gateway path, followed by manual-copy priority and retry behavior.
- Measure Defuddle CPU and memory in deployed staging with representative and worst-case accepted HTML. Workers Free scheduled CPU remains 10 ms; this gateway does not increase the app Worker CPU allowance. Do not enable if measurements exceed limits; select and document another runtime/plan deliberately.

Only after those checks, set `BACKGROUND_CAPTURE_ENABLED=true` in staging and exercise the scheduled processor, then apply the same isolated-resource checklist and evidence gate before production. Feature pause is `BACKGROUND_CAPTURE_ENABLED=false`; this stops extraction while leaving saved links, intents, jobs, and existing copies intact. If the route or security behavior is uncertain, pause first. Gateway host failure is expected to affect copy availability, never bookmark creation.

## Limits and cost

The adapter and VPC Service do not provision Node compute. Workers VPC is currently beta/free; Cloudflare can change beta behavior or pricing. The server/container has its own hosting, bandwidth, DNS, and availability costs. The main Worker retains its existing plan's Cron CPU and D1 limits, including the 10 ms scheduled CPU budget on Workers Free. Obtain current provider/account costs before enabling; this repository does not upgrade a plan or create infrastructure.
