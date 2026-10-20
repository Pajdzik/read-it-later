import { Container } from "@cloudflare/containers";

interface CaptureEnv {
  CAPTURE_CONTAINER: DurableObjectNamespace<ArticleCaptureContainer>;
  APP_ORIGIN: string;
}

export class ArticleCaptureContainer extends Container<CaptureEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  envVars = { APP_ORIGIN: this.env.APP_ORIGIN };

  override onError(): void { throw new Error("capture_container_unavailable"); }
}

export default {
  async fetch(request: Request, env: CaptureEnv): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/capture") return new Response(null, { status: 404 });
    try { return await env.CAPTURE_CONTAINER.getByName("capture").fetch(request); }
    catch { return new Response(null, { status: 503 }); }
  },
} satisfies ExportedHandler<CaptureEnv>;
