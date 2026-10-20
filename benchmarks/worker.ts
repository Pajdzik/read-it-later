import { extractArticleMarkdown } from "../src/articles/extraction";
import { parseArticleMetadata } from "../src/articles/metadata";
import { extractionFixture, fixtureNames, type FixtureName } from "./fixtures";

interface BenchmarkEnv { BENCHMARK_EXPIRES_AT: string }

/** Temporary fixture-only benchmark: no URL fetching, bindings, or library data. */
export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const expiresAt = Number(env.BENCHMARK_EXPIRES_AT || 0);
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return new Response(null, { status: 410 });
    const match = /^\/run\/([a-z-]+)\/(\d{1,2})$/.exec(new URL(request.url).pathname);
    if (request.method !== "GET" || !match || (match[1] !== "baseline" && !fixtureNames.includes(match[1] as FixtureName))) return new Response(null, { status: 404 });
    const name = match[1];
    if (name === "baseline") return Response.json({ fixture: name, inputBytes: 0, outputBytes: 0 });
    const html = extractionFixture(name as FixtureName);
    const inputBytes = new TextEncoder().encode(html).byteLength;
    if (inputBytes > 512 * 1024) throw new Error("benchmark_fixture_too_large");
    try {
      const metadata = parseArticleMetadata(html);
      const markdown = await extractArticleMarkdown(html, "https://fixture.example/article");
      const result = { fixture: name, inputBytes, outputBytes: new TextEncoder().encode(markdown).byteLength,
        formatted: markdown.includes("**important formatting**"), relativeLink: markdown.includes("https://fixture.example/related"), metadata: metadata.title === "Worker extraction fixture", outcome: "extracted" };
      console.info(JSON.stringify({ event: "extraction_benchmark", ...result }));
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      const result = { fixture: name, inputBytes, outcome: "rejected" };
      console.info(JSON.stringify({ event: "extraction_benchmark", ...result }));
      return Response.json(result, { status: name === "output-limit" ? 200 : 422, headers: { "Cache-Control": "no-store" } });
    }
  },
} satisfies ExportedHandler<BenchmarkEnv>;
