import { describe, expect, it } from "vitest";
import worker from "../benchmarks/worker";
import { extractionFixture, fixtureNames } from "../benchmarks/fixtures";

const enabled = () => ({ BENCHMARK_EXPIRES_AT: String(Date.now() + 60_000) });

describe("Defuddle Worker benchmark", () => {
  it("expires by default and only accepts fixed fixture requests", async () => {
    expect((await worker.fetch(new Request("https://benchmark.example/run/small/0"), { BENCHMARK_EXPIRES_AT: "0" })).status).toBe(410);
    expect((await worker.fetch(new Request("https://benchmark.example/run/small/0"), { BENCHMARK_EXPIRES_AT: "invalid" })).status).toBe(410);
    expect((await worker.fetch(new Request("https://benchmark.example/run/arbitrary-url/0"), enabled())).status).toBe(404);
    expect((await worker.fetch(new Request("https://benchmark.example/run/small/0", { method: "POST", body: "<html/>" }), enabled())).status).toBe(404);
  });

  it("extracts all bounded fixture shapes in the Workers runtime and rejects oversized output", async () => {
    for (const fixture of fixtureNames) {
      expect(new TextEncoder().encode(extractionFixture(fixture)).byteLength).toBeLessThanOrEqual(512 * 1024);
      const response = await worker.fetch(new Request(`https://benchmark.example/run/${fixture}/0`), enabled());
      expect(response.status, fixture).toBe(200);
      const result = await response.json() as Record<string, unknown>;
      expect(result.fixture).toBe(fixture);
      expect(result.outcome).toBe(fixture === "output-limit" ? "rejected" : "extracted");
      if (fixture !== "output-limit") expect(result.outputBytes).toBeLessThanOrEqual(256 * 1024);
      if (fixture === "small" || fixture === "typical") expect(result).toMatchObject({ formatted: true, relativeLink: true, metadata: true });
    }
  });
});
