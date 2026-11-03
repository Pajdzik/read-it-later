# Retired Worker fetch experiments

This page records why source fetching moved out of the Worker runtime. It is historical evidence; the current implementation is documented in [Cloudflare capture](cloudflare-capture.md), and the current release path is in [deployment](deployment.md).

## Fixed-address socket probe

A short-lived Worker probe attempted three pinned-IP requests to a public GitHub endpoint using `cloudflare:sockets`, `startTls()`, and the requested hostname. The pinned TLS cases did not return complete HTTP responses, while hostname TLS controls did. The trial could not establish either acceptance or rejection of the expected certificate hostname. Its sanitized outputs remain in the historical [probe record](benchmarks/edge-pinned-fetch-results.json); no probe executable or deployment path is supported.

Cloudflare's Workers socket types exposed `TlsOptions.expectedServerHostname`, but the tested workerd implementation did not provide reliable hostname verification for the pinned socket path. Workers `node:https` wraps global `fetch()` and does not expose the underlying socket. A DNS preflight followed by hostname `fetch()` would not prove which address is used for the connection.

## Current boundary

The application uses the private `ARTICLE_EXTRACTOR` service and a native Node executor. It validates resolved addresses, connects to a selected numeric public address, and preserves the original hostname for `Host`, SNI, and certificate verification. Redirects are manually checked and each destination is resolved and pinned again. See [the current capture design](cloudflare-capture.md) for the active security and runtime details.
