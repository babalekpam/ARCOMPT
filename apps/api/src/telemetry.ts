import { redactSecrets } from "./security.js";

/**
 * Observabilité (SECURITY.md §10.3) : journaux structurés sans secrets ni
 * données de paie, OpenTelemetry et Sentry activés seulement si configurés
 * (chargés dynamiquement pour ne pas imposer les dépendances en dev), et
 * alertes de sécurité temps réel sur les signaux définis par le document.
 */
export type SecuritySignal =
  | "auth.failure_burst"
  | "admin.access"
  | "rls.rejection"
  | "webhook.invalid_signature"
  | "ai.call_spike"
  | "payment.entry_divergence"
  | "rate.limited";

export interface SecurityAlert {
  signal: SecuritySignal;
  tenantId?: string;
  userId?: string;
  detail: string;
  at: string;
}

export type AlertSink = (alert: SecurityAlert) => void | Promise<void>;

const sinks: AlertSink[] = [];

export function onSecurityAlert(sink: AlertSink): void {
  sinks.push(sink);
}

export async function raiseSecurityAlert(alert: Omit<SecurityAlert, "at">): Promise<void> {
  const full: SecurityAlert = { ...alert, at: new Date().toISOString() };
  log("warn", "security.alert", full as unknown as Record<string, unknown>);
  for (const s of sinks) await s(full);
}

/** Compteur glissant pour transformer des échecs répétés en alerte (ex. 20 échecs d'auth en 5 min). */
export class BurstDetector {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
  ) {}
  hit(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length >= this.threshold;
  }
}

export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  const safe = redactSecrets(line);
  if (level === "error") console.error(safe);
  else if (level === "warn") console.warn(safe);
  else console.log(safe);
}

/** Démarre OpenTelemetry et Sentry si OTEL_EXPORTER_OTLP_ENDPOINT / SENTRY_DSN sont définis. */
export async function initTelemetry(): Promise<void> {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const sdkName = "@opentelemetry/sdk-node";
      const autoName = "@opentelemetry/auto-instrumentations-node";
      const { NodeSDK } = (await import(sdkName)) as { NodeSDK: new (o: unknown) => { start(): void } };
      const { getNodeAutoInstrumentations } = (await import(autoName)) as { getNodeAutoInstrumentations: () => unknown };
      new NodeSDK({ serviceName: "arcompt-api", instrumentations: [getNodeAutoInstrumentations()] }).start();
      log("info", "telemetry.otel.started");
    } catch (e) {
      log("warn", "telemetry.otel.unavailable", { reason: (e as Error).message });
    }
  }
  if (process.env.SENTRY_DSN) {
    try {
      const name = "@sentry/node";
      const Sentry = (await import(name)) as { init: (o: unknown) => void };
      Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? "development", beforeSend: (ev: unknown) => JSON.parse(redactSecrets(JSON.stringify(ev))) });
      log("info", "telemetry.sentry.started");
    } catch (e) {
      log("warn", "telemetry.sentry.unavailable", { reason: (e as Error).message });
    }
  }
}
