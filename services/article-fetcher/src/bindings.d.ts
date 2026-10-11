/// <reference path="./worker-configuration.d.ts" />

interface Env {
  // Wrangler cannot infer Worker secret names from configuration.
  ARTICLE_FETCHER_TOKEN: string;
}
