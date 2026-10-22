import type { D1Database, KVNamespace, RateLimit, DurableObjectId } from "@cloudflare/workers-types";

export interface SignalingNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

declare global {
  interface CloudflareEnv {
    DB: D1Database;
    SIGNALING_DO: SignalingNamespace;
    OTA_KV: KVNamespace;
    LOGIN_RATE_LIMITER?: RateLimit;
    APPLE_BUNDLE_ID?: string;
    APPLE_ISSUER_ID?: string;
    APPLE_KEY_ID?: string;
    APPLE_PRIVATE_KEY?: string;
    APP_SECRET?: string;
    ADMIN_JWT_SECRET?: string;
    BUILD_TIME?: string;
    BUILD_VERSION?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_KEY?: string;
    CLOUDFLARE_EMAIL?: string;
    CRON_SECRET?: string;
    GOOGLE_PACKAGE_NAME?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
    MIN_APP_VERSION_ANDROID?: string;
    MIN_APP_VERSION_IOS?: string;
    OTA_ADMIN_ENABLED?: string;
    OTA_DEFAULT_CHANNEL?: string;
    OTA_PUBLISH_TOKEN?: string;
    OTA_SIGNING_KEY_ID?: string;
    OTA_SIGNING_PRIVATE_KEY?: string;
    R2_PUBLIC_BASE?: string;
    TOKEN_SECRET?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    TURN_KEY_ID?: string;
    TURN_KEY_SECRET?: string;
  }
}
