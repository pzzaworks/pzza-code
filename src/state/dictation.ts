import { notify } from "./notifications";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HAS_TAURI } from "../tauriEnv";
import { isDictationLanguage, type DictationLanguage } from "../dictationLanguages";

export const DICTATION_SUPPORTED = HAS_TAURI && /mac/i.test(navigator.platform || navigator.userAgent);
const ENABLED_KEY = "pzza.dictation.enabled";
const LANGUAGE_KEY = "pzza.dictation.language";
export type { DictationLanguage } from "../dictationLanguages";
type Phase = "loading" | "listening" | "finalizing" | "error";
interface Recording { id: string; tileId: string; phase: Phase; text: string; committed: string; level: number; error: string | null }
interface ModelStatus { installed: boolean; downloading: boolean; downloadedBytes: number; totalBytes: number; error?: string | null }
interface DownloadEvent { status: "downloading" | "ready" | "error"; downloadedBytes: number; totalBytes: number; error?: string }
interface SpeechEvent { id: string; kind: "loading" | "listening" | "finalizing" | "partial" | "committed" | "final" | "error" | "level"; text?: string; level?: number; error?: string }
interface DictationState {
  enabled: boolean;
  language: DictationLanguage;
  model: "checking" | "missing" | "downloading" | "ready" | "error";
  downloadedBytes: number;
  totalBytes: number;
  warming: boolean;
  error: string | null;
  recording: Recording | null;
  setEnabled: (enabled: boolean) => void;
  setLanguage: (language: DictationLanguage) => void;
  download: (replace?: boolean) => Promise<void>;
  start: (tileId: string) => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
}
function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* preferences are optional */ } }
const savedLanguage = read(LANGUAGE_KEY);
type TranscriptTarget = (text: string) => boolean | Promise<boolean>;
const targets = new Map<string, TranscriptTarget>();
let finalizingId: string | undefined;
let delivery = { id: "", text: "", transcript: "", pending: Promise.resolve(), failed: false };
let initialization: Promise<void> | undefined;
let preparation: Promise<void> | undefined;
let downloadPending = false;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// A transcript is data, never terminal control input or an implicit Enter key.
export function dictationText(text: string): string {
  return text.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}

function deliverTranscript(id: string, text: string, final: boolean) {
  const pipeline = delivery;
  pipeline.transcript = text;
  pipeline.pending = pipeline.pending.then(async () => {
    const current = useDictation.getState().recording;
    if (!current || current.id !== id || pipeline.id !== id || pipeline.failed) return;
    if (!text.startsWith(pipeline.text)) throw new Error("Recognition revised text already inserted. Stop and check the terminal before continuing.");
    const suffix = text.slice(pipeline.text.length);
    if (suffix && !await targets.get(current.tileId)?.(suffix)) throw new Error("The terminal did not confirm insertion. Check its text before recording again.");
    pipeline.text = text;
    const latest = useDictation.getState().recording;
    if (!latest || latest.id !== id) return;
    useDictation.setState({ recording: final ? null : { ...latest, committed: text } });
  }).catch((error: unknown) => {
    pipeline.failed = true;
    const current = useDictation.getState().recording;
    if (!current || current.id !== id) return;
    useDictation.setState({ recording: { ...current, phase: "error", text: current.text.startsWith(pipeline.transcript) ? current.text : pipeline.transcript, level: 0, error: message(error) } });
    void invoke<void>("speech_stop", { id, cancel: true }).catch(() => {});
  });
}

export function registerDictationTarget(tileId: string, insert: TranscriptTarget): () => void {
  targets.set(tileId, insert);
  return () => {
    if (targets.get(tileId) !== insert) return;
    targets.delete(tileId);
    if (useDictation.getState().recording?.tileId === tileId) void useDictation.getState().cancel();
  };
}

async function prepare(): Promise<void> {
  if (preparation) return preparation;
  useDictation.setState({ warming: true });
  preparation = invoke<void>("speech_prepare").catch((error: unknown) => {
    useDictation.setState({ error: message(error) });
  }).finally(() => { preparation = undefined; useDictation.setState({ warming: false }); });
  return preparation;
}

export function initializeDictation(): Promise<void> {
  if (!DICTATION_SUPPORTED) return Promise.resolve();
  if (initialization) return initialization;
  const cleanups: Array<() => void> = [];
  initialization = (async () => {
    cleanups.push(await listen<SpeechEvent>("dictation", ({ payload }) => {
      const state = useDictation.getState();
      const current = state.recording;
      if (!current || current.id !== payload.id) return;
      if (payload.kind === "final" || payload.kind === "committed") {
        if (finalizingId === current.id) return;
        const final = payload.kind === "final";
        if (final) finalizingId = current.id;
        deliverTranscript(current.id, dictationText(payload.text ?? ""), final);
      } else if (payload.kind === "error") {
        useDictation.setState({ recording: { ...current, phase: "error", level: 0, error: payload.error ?? "Dictation failed. Check microphone access in System Settings." } });
      } else if (payload.kind === "level") {
        if (current.phase === "listening") useDictation.setState({ recording: { ...current, level: Math.max(0, Math.min(1, payload.level ?? 0)) } });
      } else if (payload.kind === "partial") {
        useDictation.setState({ recording: { ...current, text: dictationText(payload.text ?? current.text) } });
      } else if (current.phase !== "finalizing") {
        useDictation.setState({ recording: { ...current, phase: payload.kind } });
      }
    }));
    cleanups.push(await listen<DownloadEvent>("dictation-download", ({ payload }) => {
      if (payload.status === "ready" || payload.status === "error") notify({ category: "app", event: payload.status === "ready" ? "model-ready" : "model-error", title: payload.status === "ready" ? "Voice model downloaded" : "Voice model download failed", body: "Open Settings to review voice input setup.", target: { section: "general" }, dedupeKey: `voice-model:${payload.status}` });
      useDictation.setState({ model: payload.status === "ready" ? "ready" : payload.status,
        downloadedBytes: payload.downloadedBytes, totalBytes: payload.totalBytes, error: payload.error ?? null });
      if (payload.status === "ready" && useDictation.getState().enabled) void prepare();
    }));
    const status = await invoke<ModelStatus>("speech_model_status");
    useDictation.setState({ model: status.installed ? "ready" : status.downloading ? "downloading" : status.error ? "error" : "missing",
      downloadedBytes: status.downloadedBytes, totalBytes: status.totalBytes, error: status.error ?? null });
    if (status.installed && useDictation.getState().enabled) void prepare();
  })().catch((error: unknown) => {
    cleanups.forEach((cleanup) => cleanup());
    initialization = undefined;
    useDictation.setState({ model: "error", error: message(error) });
    throw error;
  });
  return initialization;
}

export const useDictation = create<DictationState>((set, get) => ({
  enabled: read(ENABLED_KEY) === "true",
  language: isDictationLanguage(savedLanguage) ? savedLanguage : "auto",
  model: "checking", downloadedBytes: 0, totalBytes: 574041195, warming: false, error: null, recording: null,
  setEnabled: (enabled) => {
    save(ENABLED_KEY, String(enabled)); set({ enabled, error: null });
    if (!enabled) void get().cancel();
    else if (get().model === "ready") void prepare();
  },
  setLanguage: (language) => { save(LANGUAGE_KEY, language); set({ language }); },
  download: async (replace = false) => {
    if (!DICTATION_SUPPORTED || downloadPending || get().model === "downloading") return;
    downloadPending = true;
    try {
      await initializeDictation();
      if (get().model === "ready" && !replace) { get().setEnabled(true); return; }
      set({ model: "downloading", error: null, downloadedBytes: 0 });
      save(ENABLED_KEY, "true");
      set({ enabled: true });
      await invoke<void>("speech_model_download", { force: replace });
    } catch (error) { set({ model: "error", error: message(error) }); }
    finally { downloadPending = false; }
  },
  start: async (tileId) => {
    if (!DICTATION_SUPPORTED || !get().enabled || get().model !== "ready" || get().recording) return;
    const id = crypto.randomUUID();
    delivery = { id, text: "", transcript: "", pending: Promise.resolve(), failed: false };
    set({ recording: { id, tileId, phase: "loading", text: "", committed: "", level: 0, error: null } });
    try {
      await initializeDictation();
      if (get().recording?.id !== id) return;
      if (!targets.has(tileId)) throw new Error("Wait for this terminal to connect before recording.");
      await invoke<void>("speech_start", { id, language: get().language });
    } catch (error) {
      const current = get().recording;
      if (current?.id === id) set({ recording: { ...current, phase: "error", error: message(error) } });
    }
  },
  stop: async () => {
    const current = get().recording;
    if (!current || current.phase !== "listening") return;
    set({ recording: { ...current, phase: "finalizing", level: 0 } });
    try { await invoke<void>("speech_stop", { id: current.id, cancel: false }); }
    catch (error) {
      if (get().recording?.id === current.id) set({ recording: { ...current, phase: "error", level: 0, error: message(error) } });
    }
  },
  cancel: async () => {
    const current = get().recording;
    if (!current) return;
    set({ recording: null });
    try { await invoke<void>("speech_stop", { id: current.id, cancel: true }); }
    catch (error) { set({ error: message(error) }); }
  },
}));
