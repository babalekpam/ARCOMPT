import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * Limitation de débit (SECURITY.md §10.1) : seau de jetons en mémoire par clé
 * (IP, compte, point d'accès). En production derrière plusieurs instances,
 * le WAF/CDN porte la première ligne ; cette couche protège surtout les
 * points coûteux (OCR/vision, assistant) et les tentatives d'authentification.
 */
export interface RateLimitRule {
  /** Jetons par fenêtre. */
  limit: number;
  /** Fenêtre en millisecondes. */
  windowMs: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Consomme un jeton ; renvoie le nombre restant ou -1 si refusé. */
  take(key: string): number {
    const t = this.now();
    const refillPerMs = this.rule.limit / this.rule.windowMs;
    const b = this.buckets.get(key) ?? { tokens: this.rule.limit, updatedAt: t };
    b.tokens = Math.min(this.rule.limit, b.tokens + (t - b.updatedAt) * refillPerMs);
    b.updatedAt = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return -1;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear(); // borne mémoire ; jamais un vecteur de DoS
    return Math.floor(b.tokens);
  }
}

export interface RateLimitOptions extends RateLimitRule {
  /** Clé : par défaut utilisateur authentifié sinon IP, préfixée par le nom. */
  name: string;
  keyOf?: (c: Parameters<MiddlewareHandler>[0]) => string;
  onLimited?: (key: string) => void;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const limiter = new TokenBucketLimiter(opts);
  return async (c, next) => {
    const auth = c.get("auth" as never) as { userId?: string } | undefined;
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `${opts.name}:${opts.keyOf ? opts.keyOf(c) : (auth?.userId ?? ip)}`;
    const remaining = limiter.take(key);
    c.header("X-RateLimit-Limit", String(opts.limit));
    if (remaining < 0) {
      opts.onLimited?.(key);
      c.header("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
      return c.json({ error: { code: "RATE_LIMITED", message: "Trop de requêtes, réessayez plus tard" } }, 429);
    }
    c.header("X-RateLimit-Remaining", String(remaining));
    return next();
  };
}

/** En-têtes de sécurité : HSTS préchargé, pas de framing, CSP stricte pour une API JSON. */
export function securityHeaders(): MiddlewareHandler {
  return secureHeaders({
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    xFrameOptions: "DENY",
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    referrerPolicy: "no-referrer",
    crossOriginResourcePolicy: "same-site",
  });
}

/** Détection de motifs de secrets dans les journaux (SECURITY.md §10.2). */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{20,}/g, /(?<=password=)[^&\s]+/gi, /\b\d{16,19}\b/g];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[REDACTED]"), text);
}
