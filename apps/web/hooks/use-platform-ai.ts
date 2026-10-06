"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  aiErrorState, emptyKeys, getPlatformAi, removePlatformAiKey, resetPlatformAi,
  savePlatformAi, settingsDraft, testPlatformAi,
  type AiDraft, type AiProvider, type PlatformAiSettings, type ProviderValues,
} from "@/lib/platform-ai";

export function usePlatformAi() {
  const [settings, setSettings] = useState<PlatformAiSettings | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [keys, setKeys] = useState<ProviderValues>(emptyKeys);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof aiErrorState> | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const lock = useRef(false);

  const apply = useCallback((data: PlatformAiSettings) => {
    setSettings(data);
    setDraft(settingsDraft(data));
    setKeys(emptyKeys());
  }, []);
  const reload = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setLoading(true);
    setKeys(emptyKeys());
    setError(null);
    setNotice(null);
    try { apply(await getPlatformAi()); }
    catch (cause) { setError(aiErrorState(cause)); }
    finally { setLoading(false); lock.current = false; }
  }, [apply]);
  useEffect(() => { void reload(); }, [reload]);

  async function action(operation: () => Promise<void>) {
    if (lock.current || !settings || !settings.encryptionAvailable || error?.kind === "auth" || error?.kind === "conflict" || error?.kind === "unavailable") return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await operation(); }
    catch (cause) { setError(aiErrorState(cause)); }
    finally { setKeys(emptyKeys()); setBusy(false); lock.current = false; }
  }
  const save = () => action(async () => {
    if (!settings || !draft) return;
    apply(await savePlatformAi(settings.revision, draft, keys));
    setNotice({ ok: true, message: "Configuration enregistrée pour toute la plateforme." });
  });
  const test = (id: AiProvider) => action(async () => {
    if (!draft) return;
    const result = await testPlatformAi(id, draft.models[id], keys[id]);
    setNotice({ ...result, message: `Test ${id} : ${result.message}` });
  });
  const remove = (id: AiProvider) => action(async () => {
    if (!settings) return;
    await removePlatformAiKey(id, settings.revision);
    apply(await getPlatformAi());
    setNotice({ ok: true, message: "Clé stockée supprimée. Une clé d’environnement, si elle existe, reste disponible. Les champs ont été rechargés." });
  });
  const reset = () => action(async () => {
    if (!settings) return;
    await resetPlatformAi(settings.revision);
    apply(await getPlatformAi());
    setNotice({ ok: true, message: "Les paramètres stockés ont été réinitialisés. La configuration d’environnement s’applique désormais." });
  });
  const blocked = loading || busy || !settings || !settings.encryptionAvailable || ["auth", "conflict", "unavailable"].includes(error?.kind ?? "");
  const dirty = !!settings && !!draft && (
    JSON.stringify(draft) !== JSON.stringify(settingsDraft(settings)) || Object.values(keys).some(Boolean)
  );
  return { settings, draft, setDraft, keys, setKeys, loading, busy, error, notice, blocked, dirty, reload, save, test, remove, reset };
}
