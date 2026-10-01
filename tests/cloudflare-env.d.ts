declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    OWNER_GITHUB_ID?: string;
    APP_ORIGIN?: string;
    DEV_AUTH_BYPASS?: string;
  }
}
