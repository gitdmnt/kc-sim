export interface Env {
  DB: D1Database;
  KCNAV_BASE: string;
  KCNAV_MIN_INTERVAL_MS: string;
  /** "development" enables the local admin bypass (localhost only); anything else is production. */
  ENVIRONMENT?: string;
  /** Cloudflare Access team domain, e.g. "kc-sim.cloudflareaccess.com" (issuer of the admin JWTs). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience tag (AUD) of the Access application that covers /admin/*. */
  ACCESS_AUD?: string;
  /** Secret: HMAC key for hashing client IPs (never stored raw). */
  IP_HASH_SALT?: string;
  /** Workers Rate Limiting binding: per-IP limit on write requests (wrangler.toml [[ratelimits]]). */
  WRITE_LIMITER: RateLimit;
  /** "1"/"true": kill switch, every write (registration, upload) answers 503. */
  WRITES_DISABLED?: string;
  /** "1"/"true": jobs runs leave staged uploads staged (POST /admin/jobs/run, /admin/ingest/run). */
  INGEST_PAUSED?: string;
}
