// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, NetworkError, errorMessage } from "@/lib/api-client";
import { parseApiResponse } from "@/lib/api-shared";
import { useT } from "@/lib/i18n-client";
import { getOfflineServices } from "@/lib/offline-browser";
import { notifySyncChanged } from "@/lib/offline-sync";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { DocumentWorkbench } from "./DocumentWorkbench";
import { formatBytes, isAcceptedFile } from "./helpers";
import type { UploadResult } from "./types";

/** Au-delà, une pièce ne tient pas raisonnablement dans la file chiffrée de l'appareil. */
const OFFLINE_QUEUE_MAX_BYTES = 10 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Envoi multipart via le proxy (qui relaie le corps en flux) ; jamais de JSON pour un fichier. */
async function uploadDocument(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("source", "UPLOAD");
  let res: Response;
  try {
    res = await fetch("/api/proxy/documents", { method: "POST", body: form, headers: { accept: "application/json" } });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : "réseau indisponible");
  }
  return parseApiResponse<UploadResult>(res);
}

/**
 * Dépôt d'une pièce : glisser-déposer, sélection ou capture caméra (mobile),
 * envoi, avis de doublon, puis atelier extraction / proposition.
 */
export function UploadFlow({ currency }: { currency: string }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [queuedName, setQueuedName] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (f: File | undefined) => {
    setError(null);
    setResult(null);
    setQueuedName(null);
    if (!f) return;
    if (!isAcceptedFile(f)) {
      setFile(null);
      setError(t("documents.upload.rejectedType"));
      return;
    }
    setFile(f);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files?.[0]);
  };

  /**
   * File hors ligne des pièces (docs/OFFLINE.md) : le corps part en base64,
   * que l'API accepte sur le même endpoint ; le serveur déduplique par
   * empreinte du contenu, donc un rejeu après une coupure en plein envoi ne
   * crée pas de second exemplaire. Renvoie vrai si la pièce est prise en
   * charge (en file ou message d'erreur propre déjà affiché).
   */
  const queueOffline = async (f: File): Promise<boolean> => {
    if (f.size > OFFLINE_QUEUE_MAX_BYTES) {
      setError(t("documents.upload.tooLargeOffline"));
      return true;
    }
    const svc = await getOfflineServices();
    if (!svc) return false;
    const base64 = await fileToBase64(f);
    await svc.operations.enqueue("document.upload", { base64, filename: f.name, ...(f.type ? { mimeType: f.type } : {}), source: "UPLOAD" }, {});
    notifySyncChanged();
    setQueuedName(f.name);
    setFile(null);
    if (pickRef.current) pickRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
    return true;
  };

  const send = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (await queueOffline(file)) return;
        throw new NetworkError("réseau indisponible");
      }
      setResult(await uploadDocument(file));
    } catch (e) {
      // Coupure franche ou en plein envoi : la pièce attend sur l'appareil.
      if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
        try {
          if (await queueOffline(file)) return;
        } catch {
          /* la file elle-même a échoué : on montre l'erreur d'envoi */
        }
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    if (pickRef.current) pickRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  };

  return (
    <div className="space-y-4">
      {!result && !queuedName ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-xl border-2 border-dashed p-6 text-center transition ${dragging ? "border-slate-900 bg-slate-100 dark:border-slate-100 dark:bg-slate-800" : "border-slate-300 dark:border-slate-700"}`}
        >
          <p className="text-2xl" aria-hidden>✦</p>
          <p className="mt-1 font-medium">{t("documents.upload.drop")}</p>
          <p className="text-xs text-slate-500">{t("documents.upload.dropHint")}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={() => pickRef.current?.click()}>{t("documents.upload.choose")}</Button>
            <Button variant="secondary" onClick={() => cameraRef.current?.click()}>{t("documents.upload.camera")}</Button>
          </div>
          <input ref={pickRef} type="file" accept="image/*,application/pdf" className="sr-only" aria-label={t("documents.upload.choose")} onChange={(e) => choose(e.target.files?.[0])} />
          <input ref={cameraRef} type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" aria-label={t("documents.upload.camera")} onChange={(e) => choose(e.target.files?.[0])} />
        </div>
      ) : null}

      {file && !result ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          {preview ? <img src={preview} alt="" className="h-16 w-16 rounded-lg object-cover" /> : <span className="grid h-16 w-16 place-items-center rounded-lg bg-slate-100 text-xl dark:bg-slate-800" aria-hidden>▤</span>}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-slate-500">{file.type || "—"} · {formatBytes(file.size)}</p>
          </div>
          <Button onClick={() => void send()} disabled={busy}>{busy ? t("documents.upload.sending") : t("documents.upload.send")}</Button>
          <Button variant="ghost" onClick={reset} disabled={busy}>{t("common.cancel")}</Button>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {queuedName ? (
        <>
          <Alert tone="success">
            {t("documents.upload.queued")} <span className="font-medium">{queuedName}</span>
          </Alert>
          <Button variant="secondary" onClick={() => { setQueuedName(null); reset(); }}>{t("documents.upload.reset")}</Button>
        </>
      ) : null}

      {result ? (
        <>
          {result.duplicate ? (
            <Alert tone="warning">
              <span className="font-medium">{t("documents.upload.duplicate")}</span> {t("documents.upload.duplicateHint")}
            </Alert>
          ) : (
            <Alert tone="success">{t("documents.upload.done")}</Alert>
          )}
          <DocumentWorkbench document={result.document} currency={currency} jobId={result.jobId} showLink />
          <Button variant="secondary" onClick={reset}>{t("documents.upload.reset")}</Button>
        </>
      ) : null}
    </div>
  );
}
