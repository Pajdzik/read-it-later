import { Container } from "@cloudflare/containers";
import { validateSourceTarget } from "../src/articles/source-policy.js";
import { FETCH_FAILURE_HEADER } from "./protocol.js";
import { fetchViaContainer } from "./adapter.js";

type Env = ArticleFetcherBindings;

export class ArticleFetchContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = true;
  interceptHttps = false;
  envVars = { APP_ORIGIN: this.env.APP_ORIGIN ?? "" };
}

function requestError(code: string): Response {
  return new Response(null, { status: 502, headers: { [FETCH_FAILURE_HEADER]: code } });
}

async function fetchOneHop(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const target = request.url;
  if (new TextEncoder().encode(target).byteLength > 8 * 1024) return requestError("invalid_url");
  try { validateSourceTarget(target, { APP_ORIGIN: env.APP_ORIGIN }); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unsafe_destination";
    return requestError(code);
  }
  if (!env.APP_ORIGIN) return requestError("unsafe_destination");
  const stub = env.FETCH_CONTAINER.get(env.FETCH_CONTAINER.idFromName("article-fetcher-v1"));
  return fetchViaContainer(target, request.signal, (internalRequest) => stub.fetch(internalRequest));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return fetchOneHop(request, env);
  },
};
