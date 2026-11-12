import { notify } from "./notifications";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HAS_TAURI } from "../tauriEnv";
import { isDictationLanguage, type DictationLanguage } from "../dictationLanguages";
import { isSupportedLanguage, type SupportedLanguage } from "../supportedLanguages";

export const DICTATION_SUPPORTED = HAS_TAURI && /mac/i.test(navigator.platform || navigator.userAgent);
const ENABLED_KEY = "pzza.dictation.enabled";
const LANGUAGE_KEY = "pzza.dictation.language";
const INPUT_DEVICE_KEY = "pzza.dictation.inputDevice";
const SILENCE_STOP_KEY = "pzza.dictation.silenceStop";
// Seconds of quiet after speech that end a recording on its own; 0 is off.
export const SILENCE_STOP_CHOICES = [0, 3, 5, 10] as const;
export type SilenceStopSeconds = typeof SILENCE_STOP_CHOICES[number];
export const DEFAULT_SILENCE_STOP: SilenceStopSeconds = 5;
export function isSilenceStop(value: unknown): value is SilenceStopSeconds {
  return SILENCE_STOP_CHOICES.some((choice) => choice === value);
}
// "My languages": the languages detection picks among, main language first.
const MY_LANGUAGES_KEY = "pzza.speech.myLanguages";
export const MAX_MY_LANGUAGES = 6;
export type { DictationLanguage } from "../dictationLanguages";
type Phase = "loading" | "listening" | "finalizing" | "error";
// `voice`: the microphone hears speech right now (before any words are recognized).
interface Recording { id: string; tileId: string; phase: Phase; text: string; committed: string; level: number; voice: boolean; processing: boolean; error: string | null }
interface ModelStatus { installed: boolean; downloading: boolean; downloadedBytes: number; totalBytes: number; error?: string | null }
interface DownloadEvent { status: "downloading" | "ready" | "error"; downloadedBytes: number; totalBytes: number; error?: string }
interface SpeechEvent { id: string; kind: "loading" | "listening" | "finalizing" | "partial" | "committed" | "final" | "error" | "level" | "processing" | "voice"; text?: string; language?: string; level?: number; active?: boolean; error?: string }
interface InputDevice { id: string; name: string; isDefault: boolean; builtIn?: boolean; bluetooth?: boolean }
interface InputDeviceSelection { id: string; name: string }
interface DictationState {
  enabled: boolean;
  language: DictationLanguage;
  /** Languages this user speaks, main language first; null follows the Mac (systemSpeechLanguages). */
  myLanguages: SupportedLanguage[] | null;
  inputDevice: InputDeviceSelection | null;
  /** Seconds of quiet after speech that stop a recording; 0 never stops on silence. */
  silenceStop: SilenceStopSeconds;
  inputDevices: InputDevice[];
  inputDevicesLoading: boolean;
  inputDevicesError: string | null;
  model: "checking" | "missing" | "downloading" | "ready" | "error";
  downloadedBytes: number;
  totalBytes: number;
  warming: boolean;
  error: string | null;
  recording: Recording | null;
  setEnabled: (enabled: boolean) => void;
  setLanguage: (language: DictationLanguage) => void;
  setMyLanguages: (languages: SupportedLanguage[] | null) => void;
  setInputDevice: (id: string | null) => void;
  setSilenceStop: (seconds: SilenceStopSeconds) => void;
  refreshInputDevices: () => Promise<void>;
  download: (replace?: boolean) => Promise<void>;
  /** `silenceStop: false` keeps the microphone open through any silence (push to talk). */
  start: (tileId: string, options?: { silenceStop?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
}
function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* preferences are optional */ } }
const savedLanguage = read(LANGUAGE_KEY);
function languageList(value: unknown): SupportedLanguage[] {
  return Array.isArray(value) ? [...new Set(value.filter(isSupportedLanguage))].slice(0, MAX_MY_LANGUAGES) : [];
}
function savedMyLanguages(): SupportedLanguage[] | null {
  try {
    const languages = languageList(JSON.parse(read(MY_LANGUAGES_KEY) ?? "null"));
    return languages.length ? languages : null;
  } catch { return null; }
}
/** The Mac's own language when it is a supported one; null when unknown. */
export function systemSpeechLanguage(): SupportedLanguage | null {
  // Some hosts (tests, older WebViews) expose no navigator or no language.
  const tag: unknown = typeof navigator === "undefined" ? undefined : navigator.language;
  const code = typeof tag === "string" ? tag.split("-")[0].toLowerCase() : "";
  return isSupportedLanguage(code) ? code : null;
}
/** My languages in effect, main language first: the user's choice, else the Mac's (see systemSpeechLanguages). */
export function speechLanguages(): SupportedLanguage[] {
  return useDictation.getState().myLanguages ?? systemSpeechLanguages();
}

// The languages set in System Settings ("en-TR"), read natively: the web view
// reports only its own UI language ("en"), which dropped the region and with
// it Turkish. The web view's languages stand in until they arrive.
let systemLanguageTags: readonly string[] | null = null;
if (HAS_TAURI) {
  void invoke<string[]>("system_languages")
    .then(tags => { if (Array.isArray(tags)) systemLanguageTags = tags.filter((tag): tag is string => typeof tag === "string"); })
    .catch(() => { /* the web view's languages stay in use */ });
}

/**
 * The languages the Mac says its user speaks, for when they chose none: the
 * preferred languages, then the main language of each one's region ("en-TR"
 * is English set up in Turkey, so Turkish too). Detecting among all supported
 * languages instead turned short or quiet speech into Polish or Ukrainian.
 */
export function systemSpeechLanguages(): SupportedLanguage[] {
  const tags: unknown = systemLanguageTags?.length ? systemLanguageTags : typeof navigator === "undefined" ? undefined : navigator.languages ?? [navigator.language];
  const found: SupportedLanguage[] = [];
  const add = (code: string | undefined) => { const value = code?.toLowerCase(); if (value && isSupportedLanguage(value) && !found.includes(value)) found.push(value); };
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag !== "string") continue;
    try {
      const locale = new Intl.Locale(tag);
      add(locale.language);
      if (locale.region) add(new Intl.Locale(`und-${locale.region}`).maximize().language);
    } catch { /* not a valid language tag */ }
  }
  return found;
}
function savedSilenceStop(): SilenceStopSeconds {
  const saved = read(SILENCE_STOP_KEY);
  const seconds = saved === null ? NaN : Number(saved);
  return isSilenceStop(seconds) ? seconds : DEFAULT_SILENCE_STOP;
}
function savedInputDevice(): InputDeviceSelection | null {
  try {
    const value: unknown = JSON.parse(read(INPUT_DEVICE_KEY) ?? "null");
    if (typeof value === "object" && value !== null && "id" in value && "name" in value &&
        typeof value.id === "string" && value.id.length > 0 && value.id.length <= 4096 &&
        typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256) {
      return { id: value.id, name: value.name };
    }
  } catch { /* Ignore invalid saved device preferences. */ }
  return null;
}
interface TranscriptTarget {
  insert: (text: string) => boolean | Promise<boolean>;
  focus: () => void;
  // `activity` animates dots after the words: speech is heard, or the final pass runs.
  preview: (text: string, activity?: PreviewActivity | null) => void;
  clearPreview: () => void;
}
const targets = new Map<string, TranscriptTarget>();
let finalizingId: string | undefined;
// How long the final pass may take before the recording is closed with the
// words already typed: a pass that never answers must not leave the control
// spinning on "Finishing" for good.
const FINAL_PASS_LIMIT_MS = 25_000;
function watchFinalPass(id: string): void {
  setTimeout(() => {
    const current = useDictation.getState().recording;
    if (!current || current.id !== id || current.phase !== "finalizing") return;
    targets.get(current.tileId)?.clearPreview();
    useDictation.setState({ recording: { ...current, phase: "error", level: 0, processing: false, error: "Dictation took too long to finish. The words already typed were kept." } });
    void invoke<void>("speech_stop", { id, cancel: true }).catch(() => {});
  }, FINAL_PASS_LIMIT_MS);
}
// `writing` is the transcript an in-flight paste will complete, or null when idle.
let delivery: { id: string; text: string; transcript: string; pending: Promise<void>; failed: boolean; writing: string | null } =
  { id: "", text: "", transcript: "", pending: Promise.resolve(), failed: false, writing: null };
let initialization: Promise<void> | undefined;
let preparation: Promise<void> | undefined;
let downloadPending = false;
let inputDevicesPending: Promise<void> | undefined;
let cancellation: Promise<void> | undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// A transcript is data, never terminal control input or an implicit Enter key.
export function dictationText(text: string): string {
  return text.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}

export function dictationPendingText(preview: string, committed: string): string {
  return preview.startsWith(committed) ? preview.slice(committed.length) : "";
}

export type PreviewActivity = "listening" | "finishing";
/**
 * What the caret shows for a recording: the pending words and an activity
 * indicator. Speech gets the indicator at once, before its words are
 * recognized; after Stop only the indicator remains (the final pass may
 * revise the pending words) until the final text is typed.
 */
export function dictationPreview(recording: Pick<Recording, "phase" | "text" | "voice">, delivered: string): { text: string; activity: PreviewActivity | null } | null {
  if (recording.phase === "finalizing") return { text: "", activity: "finishing" };
  if (recording.phase !== "listening") return null;
  return { text: dictationPendingText(recording.text, delivered), activity: recording.voice ? "listening" : null };
}

function renderPreview(id: string) {
  const current = useDictation.getState().recording;
  if (!current || current.id !== id || delivery.id !== id) return;
  const target = targets.get(current.tileId);
  if (!target) return;
  // During a paste, preview only what follows the words being written. The
  // composition keeps those words visible until the terminal echoes them.
  const preview = delivery.failed ? null : dictationPreview(current, delivery.writing ?? delivery.text);
  if (!preview) {
    target.clearPreview();
    return;
  }
  target.preview(preview.text, preview.activity);
}

function deliverTranscript(id: string, text: string, final: boolean) {
  const pipeline = delivery;
  pipeline.transcript = text;
  pipeline.pending = pipeline.pending.then(async () => {
    const current = useDictation.getState().recording;
    if (!current || current.id !== id || pipeline.id !== id || pipeline.failed) return;
    if (!text.startsWith(pipeline.text)) throw new Error("Recognition revised text already inserted. Stop and check the terminal before continuing.");
    const suffix = text.slice(pipeline.text.length);
    if (final && !text && !pipeline.text) {
      throw new Error(current.text ? "Recognition ended before it could confirm the remaining words. Please repeat them." : "No speech was recognized. Check your microphone input and try again.");
    }
    const target = targets.get(current.tileId);
    if (suffix) {
      pipeline.writing = text;
      try {
        const inserted = target?.insert(suffix);
        renderPreview(id);
        if (!await inserted) throw new Error("The terminal did not confirm insertion. Check its text before recording again.");
      } finally { pipeline.writing = null; }
    }
    pipeline.text = text;
    const latest = useDictation.getState().recording;
    if (!latest || latest.id !== id) return;
    if (final) target?.clearPreview();
    useDictation.setState({ recording: final ? null : { ...latest, committed: text } });
    if (!final) renderPreview(id);
  }).catch((error: unknown) => {
    pipeline.failed = true;
    const current = useDictation.getState().recording;
    if (!current || current.id !== id) return;
    targets.get(current.tileId)?.clearPreview();
    useDictation.setState({ recording: { ...current, phase: "error", text: current.text.startsWith(pipeline.transcript) ? current.text : pipeline.transcript, level: 0, processing: false, error: message(error) } });
    void invoke<void>("speech_stop", { id, cancel: true }).catch(() => {});
  });
}

export function registerDictationTarget(tileId: string, target: TranscriptTarget): () => void {
  targets.set(tileId, target);
  return () => {
    if (targets.get(tileId) !== target) return;
    target.clearPreview();
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

// The native side releases the speech model after a long idle period. A
// pointer resting on (or focus reaching) a microphone button reloads it ahead
// of the click, at most this often.
const PREWARM_MS = 30_000;
let prewarmedAt = 0;

/** Loads the speech model ahead of a likely recording, such as the microphone button being hovered. */
export function prewarmDictation(): void {
  const state = useDictation.getState();
  if (!DICTATION_SUPPORTED || !state.enabled || state.model !== "ready" || state.recording || preparation) return;
  const now = Date.now();
  if (now - prewarmedAt < PREWARM_MS) return;
  prewarmedAt = now;
  void prepare();
}

export function initializeDictation(): Promise<void> {
  if (!DICTATION_SUPPORTED) return Promise.resolve();
  if (initialization) return initialization;
  const cleanups: Array<() => void> = [];
  initialization = (async () => {
    cleanups.push(await listen<SpeechEvent>("dictation", ({ payload }) => {
      const state = useDictation.getState();
      const current = state.recording;
      if (!current || current.id !== payload.id || current.phase === "error") return;
      if (payload.kind === "final" || payload.kind === "committed") {
        if (finalizingId === current.id) return;
        const final = payload.kind === "final";
        if (final) finalizingId = current.id;
        deliverTranscript(current.id, dictationText(payload.text ?? ""), final);
      } else if (payload.kind === "error") {
        targets.get(current.tileId)?.clearPreview();
        useDictation.setState({ recording: { ...current, phase: "error", level: 0, processing: false, error: payload.error ?? "Dictation failed. Check microphone access in System Settings." } });
      } else if (payload.kind === "processing") {
        useDictation.setState({ recording: { ...current, processing: payload.active === true } });
      } else if (payload.kind === "level") {
        if (current.phase === "listening") useDictation.setState({ recording: { ...current, level: Math.max(0, Math.min(1, payload.level ?? 0)) } });
      } else if (payload.kind === "voice") {
        if (current.phase !== "listening") return;
        useDictation.setState({ recording: { ...current, voice: payload.active === true } });
        renderPreview(current.id);
      } else if (payload.kind === "partial") {
        useDictation.setState({ recording: { ...current, text: dictationText(payload.text ?? current.text) } });
        renderPreview(current.id);
      } else if (current.phase !== "finalizing") {
        // The microphone permission prompt can blur the terminal after start.
        if (payload.kind === "listening" && current.phase === "loading") targets.get(current.tileId)?.focus();
        useDictation.setState({ recording: { ...current, phase: payload.kind, ...(payload.kind === "finalizing" ? { voice: false, level: 0 } : {}) } });
        // Silence can end the recording natively; the caret then shows the final pass.
        if (payload.kind === "finalizing") { renderPreview(current.id); watchFinalPass(current.id); }
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
  myLanguages: savedMyLanguages(),
  inputDevice: savedInputDevice(), silenceStop: savedSilenceStop(), inputDevices: [], inputDevicesLoading: false, inputDevicesError: null,
  model: "checking", downloadedBytes: 0, totalBytes: 1081140203, warming: false, error: null, recording: null,
  setEnabled: (enabled) => {
    save(ENABLED_KEY, String(enabled)); set({ enabled, error: null });
    if (!enabled) void get().cancel();
    else if (get().model === "ready") void prepare();
  },
  setLanguage: (language) => { save(LANGUAGE_KEY, language); set({ language }); },
  setMyLanguages: (languages) => {
    const myLanguages = languages === null ? null : languageList(languages);
    if (myLanguages?.length === 0) return;
    if (myLanguages) save(MY_LANGUAGES_KEY, JSON.stringify(myLanguages));
    else { try { localStorage.removeItem(MY_LANGUAGES_KEY); } catch { /* preferences are optional */ } }
    set({ myLanguages });
  },
  setSilenceStop: (seconds) => {
    if (!isSilenceStop(seconds)) return;
    save(SILENCE_STOP_KEY, String(seconds));
    set({ silenceStop: seconds });
  },
  setInputDevice: (id) => {
    if (get().recording) return;
    const device = id === null ? null : get().inputDevices.find((candidate) => candidate.id === id);
    if (device === undefined) return;
    const inputDevice = device ? { id: device.id, name: device.name } : null;
    save(INPUT_DEVICE_KEY, JSON.stringify(inputDevice));
    set({ inputDevice });
  },
  refreshInputDevices: () => {
    if (!DICTATION_SUPPORTED) return Promise.resolve();
    if (inputDevicesPending) return inputDevicesPending;
    set({ inputDevicesLoading: true, inputDevicesError: null });
    inputDevicesPending = invoke<InputDevice[]>("speech_input_devices")
      .then((inputDevices) => { set({ inputDevices }); })
      .catch((error: unknown) => { set({ inputDevicesError: message(error) }); })
      .finally(() => { inputDevicesPending = undefined; set({ inputDevicesLoading: false }); });
    return inputDevicesPending;
  },
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
  start: async (tileId, options) => {
    if (!DICTATION_SUPPORTED || !get().enabled || get().model !== "ready" || get().recording) return;
    const id = crypto.randomUUID();
    delivery = { id, text: "", transcript: "", pending: Promise.resolve(), failed: false, writing: null };
    set({ recording: { id, tileId, phase: "loading", text: "", committed: "", level: 0, voice: false, processing: false, error: null } });
    try {
      await cancellation;
      await initializeDictation();
      if (get().recording?.id !== id) return;
      const target = targets.get(tileId);
      if (!target) throw new Error("Wait for this terminal to connect before recording.");
      target.clearPreview();
      target.focus();
      const silenceStop = options?.silenceStop === false ? 0 : get().silenceStop;
      await invoke<void>("speech_start", { id, language: get().language, languages: speechLanguages(), inputDeviceId: get().inputDevice?.id ?? null, silenceStopMs: silenceStop ? silenceStop * 1000 : null });
    } catch (error) {
      const current = get().recording;
      if (current?.id === id) set({ recording: { ...current, phase: "error", processing: false, error: message(error) } });
    }
  },
  stop: async () => {
    const current = get().recording;
    if (!current) return;
    if (current.phase !== "listening") { await get().cancel(); return; }
    targets.get(current.tileId)?.focus();
    set({ recording: { ...current, phase: "finalizing", level: 0, voice: false } });
    renderPreview(current.id);
    watchFinalPass(current.id);
    try { await invoke<void>("speech_stop", { id: current.id, cancel: false }); }
    catch (error) {
      if (get().recording?.id === current.id) set({ recording: { ...current, phase: "error", level: 0, processing: false, error: message(error) } });
    }
  },
  cancel: async () => {
    const current = get().recording;
    if (!current) return;
    targets.get(current.tileId)?.clearPreview();
    set({ recording: null });
    // The control can reset immediately; new capture waits for native cleanup.
    const pending = (cancellation ?? Promise.resolve()).then(() => invoke<void>("speech_stop", { id: current.id, cancel: true }));
    cancellation = pending;
    try { await pending; }
    catch (error) { set({ error: message(error) }); }
    finally { if (cancellation === pending) cancellation = undefined; }
  },
}));
