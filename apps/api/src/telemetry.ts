// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
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

/** Retire tous les puits enregistrés. Réservé aux tests. */
export function clearSecurityAlertSinks(): void {
  sinks.length = 0;
}

/**
 * Un puits défaillant (astreinte injoignable) ne doit jamais faire échouer la
 * requête qui a levé l'alerte : l'échec est journalisé, l'alerte reste tracée.
 */
export async function raiseSecurityAlert(alert: Omit<SecurityAlert, "at">): Promise<void> {
  const full: SecurityAlert = { ...alert, at: new Date().toISOString() };
  log("warn", "security.alert", full as unknown as Record<string, unknown>);
  for (const s of sinks) {
    try {
      await s(full);
    } catch (e) {
      log("error", "security.alert.sink_failed", { signal: full.signal, reason: (e as Error).message });
    }
  }
}

/**
 * Puits HTTP : poste l'alerte en JSON vers SECURITY_ALERT_WEBHOOK_URL
 * (collecteur d'astreinte, canal de discussion, gestionnaire d'incidents).
 * Le corps ne porte que le signal, les identifiants techniques et le détail
 * déjà expurgé — jamais de donnée comptable ni de paie.
 */
export function webhookAlertSink(url: string, timeoutMs = 5_000): AlertSink {
  return async (alert) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: redactSecrets(JSON.stringify(alert)),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
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

/**
 * Démarre OpenTelemetry et Sentry si OTEL_EXPORTER_OTLP_ENDPOINT / SENTRY_DSN
 * sont définis, puis branche les puits d'alerte de sécurité : sans cet appel
 * les signaux (rafale d'échecs d'authentification, rejet RLS, signature de
 * webhook invalide, divergence de règlement) ne quittent pas les journaux.
 */
export async function initTelemetry(): Promise<void> {
  const alertUrl = process.env.SECURITY_ALERT_WEBHOOK_URL;
  if (alertUrl) {
    onSecurityAlert(webhookAlertSink(alertUrl));
    log("info", "telemetry.alert_sink.webhook");
  }
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
      const Sentry = (await import(name)) as {
        init: (o: unknown) => void;
        captureMessage?: (message: string, context?: unknown) => void;
      };
      Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? "development", beforeSend: (ev: unknown) => JSON.parse(redactSecrets(JSON.stringify(ev))) });
      const capture = Sentry.captureMessage;
      if (capture) {
        onSecurityAlert((alert) =>
          capture(`security.${alert.signal}`, {
            level: "warning",
            tags: { signal: alert.signal, ...(alert.tenantId ? { tenant: alert.tenantId } : {}) },
            extra: { detail: alert.detail, at: alert.at },
          }),
        );
      }
      log("info", "telemetry.sentry.started");
    } catch (e) {
      log("warn", "telemetry.sentry.unavailable", { reason: (e as Error).message });
    }
  }
}
