/// <reference path="./bindings.d.ts" />
import { managedConversion } from "./managed";
import { Container, ContainerProxy } from "@cloudflare/containers";

export { ContainerProxy };
type CaptureEnv = CaptureBindings;

export class ArticleCaptureContainer extends Container<CaptureEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  envVars = { APP_ORIGIN: this.env.APP_ORIGIN };

  override onError(): void { throw new Error("capture_container_unavailable"); }
}

// Intercept ONLY this virtual host. Do not add catch-all handlers or HTTPS interception:
// source connections must keep using the native validated destination sockets.
ArticleCaptureContainer.outboundByHost = { "potem.convert": (request, env: CaptureEnv) => managedConversion(request, env) };

export default {
  async fetch(request: Request, env: CaptureEnv): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/capture") return new Response(null, { status: 404 });
    if (env.MANAGED_CONVERSION_ENABLED !== "true") return Response.json({ version: 1, ok: false, error: { code: "capture_paused", retryable: false } });
    try { return await env.CAPTURE_CONTAINER.getByName("capture").fetch(request); }
    catch { return new Response(null, { status: 503 }); }
  },
} satisfies ExportedHandler<CaptureEnv>;
