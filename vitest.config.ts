import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      queueConsumers: [],
      bindings: {
        MANAGED_CONVERSION_ENABLED: "true",
        TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
      },
    },
  }))],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
