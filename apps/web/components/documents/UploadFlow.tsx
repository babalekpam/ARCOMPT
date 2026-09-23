// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { NetworkError, errorMessage } from "@/lib/api-client";
import { parseApiResponse } from "@/lib/api-shared";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { DocumentWorkbench } from "./DocumentWorkbench";
import { formatBytes, isAcceptedFile } from "./helpers";
import type { UploadResult } from "./types";

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

  const send = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await uploadDocument(file));
    } catch (e) {
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
      {!result ? (
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

      {result ? (
        <>
          {result.duplicate ? (
            <Alert tone="warning">
              <span className="font-medium">{t("documents.upload.duplicate")}</span> {t("documents.upload.duplicateHint")}
            </Alert>
          ) : (
            <Alert tone="success">{t("documents.upload.done")}</Alert>
          )}
          <DocumentWorkbench document={result.document} currency={currency} showLink />
          <Button variant="secondary" onClick={reset}>{t("documents.upload.reset")}</Button>
        </>
      ) : null}
    </div>
  );
}
