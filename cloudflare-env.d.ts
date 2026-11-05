declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  }
}
