declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    OWNER_GITHUB_ID?: string;
    APP_ORIGIN?: string;
    DEV_AUTH_BYPASS?: string;
    GITHUB_BACKUP_REPOSITORY?: string;
    GITHUB_BACKUP_BRANCH?: string;
    GITHUB_BACKUP_PATH?: string;
    GITHUB_BACKUP_TOKEN?: string;
  }
}
