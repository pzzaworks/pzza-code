import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../state/store";
import { themeById } from "../theme/themes";
import { killPty, resizePty, spawnPty, writePty } from "./ptyBridge";
import { openWsPty, type WsPtyHandle } from "./wsPty";
import { runBrowserPreview } from "./browserPreview";
import { HAS_TAURI } from "../tauriEnv";
import { uploadPasteImage } from "../serverApi";
import type { TileStatus } from "../sessionMeta";

// Copy text to the OS clipboard. navigator.clipboard only exists in a secure
// context (https or localhost), so on a client that opened the app over plain
// http via a LAN address it is undefined - fall back to a hidden textarea +
// execCommand("copy"), which works from a user gesture in any context.
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* The browser may refuse clipboard access; try the user-gesture fallback. */ }
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-1000px";
  document.body.appendChild(input);
  try {
    input.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

interface Props {
  name: string;
  host?: string;
  cmd: string;
  args: string[];
  cwd?: string;
  window?: number;
  active?: boolean;
  onStatus?: (s: TileStatus) => void;
}

// Desired line spacing. We snap the actual line height so that
// fontSize * lineHeight lands on a whole CSS pixel: with a fractional cell
// height the FitAddon's row count and the renderer's real cell height drift
// apart over many rows, pushing the last line past the tile's clipped edge.
const LINE_RATIO = 1.15;
const snappedLineHeight = (fontSize: number) => Math.round(fontSize * LINE_RATIO) / fontSize;

// One live terminal tile. xterm owns its own WebGL canvas, so it lives outside
// React's reconcile loop. Transport depends on where the app runs: Rust PTY
// under Tauri, the devbox WebSocket server in a plain browser.
export function Terminal({ name, host, cmd, args, cwd, window: win, active, onStatus }: Props) {
  const [hasSelection, setHasSelection] = useState(false);
  const [pasteStatus, setPasteStatus] = useState<{ error: boolean; message: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const safeFitRef = useRef<(() => void) | null>(null);
  const flushOutputRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const themeId = useStore((s) => s.themeId);
  const semiTransparent = useStore((s) => s.semiTransparent);
  const fontSize = useStore((s) => s.fontSize);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const refreshNonce = useStore((s) => s.refreshNonce);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      allowProposedApi: true,
      // Keep the renderer mounted when appearance toggles at runtime.
      allowTransparency: true,
      macOptionClickForcesSelection: true,
      cursorBlink: useStore.getState().cursorBlink,
      // Nerd Fonts first so yazi/btop/lazydocker glyphs render (fall back to a
      // plain monospace for the text if none are installed).
      fontFamily:
        '"MesloLGS NF", "JetBrainsMono Nerd Font", "JetBrainsMonoNL Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: useStore.getState().fontSize,
      lineHeight: snappedLineHeight(useStore.getState().fontSize),
      // tmux keeps the real history on the remote side; a deep local buffer
      // only multiplies memory per tile (each line is a typed-array row).
      scrollback: 3000,
      theme: { ...themeById(useStore.getState().themeId).terminal, ...(useStore.getState().semiTransparent ? { background: "#00000000" } : {}) },
    });
    termRef.current = term;

    const copySelection = () => {
      const selected = term.getSelection();
      if (!selected) return;
      void copyToClipboard(selected).then((ok) => {
        if (!ok && !disposed) setPasteStatus({ error: true, message: "Clipboard access failed. Try the Copy selection button again." });
      });
    };
    const selectionListener = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    // Native copy events write to the local clipboard even for SSH terminals.
    const onCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", term.getSelection());
      event.preventDefault();
      event.stopPropagation();
    };
    container.addEventListener("copy", onCopy, true);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const copy = event.key.toLowerCase() === "c" && !event.altKey &&
        ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey));
      if (!copy) return true;
      event.preventDefault();
      if (term.hasSelection()) copySelection();
      else {
        const modifier = /mac/i.test(navigator.platform) ? "Option" : "Shift";
        setPasteStatus({ error: false, message: `Hold ${modifier} and drag to select terminal text, then copy.` });
      }
      return false;
    });

    // OSC 52 clipboard passthrough: when tmux (set-clipboard on) or a TUI app
    // like nvim yanks, it emits OSC 52 with the copied text - mirror it to the
    // OS clipboard so copying from inside a mouse-grabbing app works over SSH.
    // Off by default: terminal output is untrusted, and a silent clipboard
    // overwrite is a paste-jacking vector (a crafted file `cat`ed in a tile
    // could plant a command that runs on the next paste). Opt in via Settings.
    term.parser.registerOscHandler(52, (data) => {
      if (!useStore.getState().osc52Clipboard) return true;
      const semi = data.indexOf(";");
      if (semi < 0) return true;
      // Only the clipboard selection ("c", or unspecified); ignore primary/cut buffers.
      const sel = data.slice(0, semi);
      if (sel && !sel.includes("c")) return true;
      const payload = data.slice(semi + 1);
      if (!payload || payload === "?") return true; // read/query - ignore
      if (payload.length > 16 * 1024) return true; // yanks are small; refuse bulk payloads
      try {
        const bin = atob(payload);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        // Strip control characters (keep tab/newline) so a planted escape
        // sequence cannot ride along into whatever the clipboard is pasted into.
        const text = new TextDecoder().decode(bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
        void copyToClipboard(text).then((ok) => {
          if (!ok && !disposed) setPasteStatus({ error: true, message: "Clipboard access failed." });
        });
      } catch {
        /* malformed base64 - ignore */
      }
      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    term.open(container);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      // Browsers cap concurrent WebGL contexts (~16). With several tiles - and
      // churn from hide/show creating new contexts - the browser evicts an older
      // context, blanking that terminal (selection still draws, but glyphs are
      // gone with the texture atlas). Handle the loss: drop the WebGL addon so
      // xterm falls back to its DOM renderer, then repaint from the buffer.
      webgl.onContextLoss(() => {
        try {
          webgl?.dispose();
        } catch {
          /* already gone */
        }
        webgl = null;
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* term disposed */
        }
      });
      term.loadAddon(webgl);
    } catch {
      /* canvas fallback */
    }
    // Fit once now, then again on the next frame once the grid item has its
    // final size, so the PTY is spawned with correct cols/rows and TUIs render
    // at the right dimensions rather than a stale default.
    const safeFit = () => {
      // Compute the target size WITHOUT resizing first (fit.fit() would resize to
      // its own row count, then our correction would resize again - that R -> R-1
      // -> R churn spams SIGWINCH and desyncs cols/rows with tmux, corrupting the
      // prompt). Instead propose, correct against the real cell height, and do a
      // single resize only when the size actually changed - so repeat calls with
      // an already-correct size are no-ops and nothing thrashes.
      let dims: { cols: number; rows: number } | undefined;
      try {
        dims = fit.proposeDimensions();
      } catch {
        /* not measurable yet */
        return;
      }
      if (
        !dims ||
        !Number.isFinite(dims.cols) ||
        !Number.isFinite(dims.rows) ||
        dims.cols < 1 ||
        dims.rows < 1
      ) {
        return;
      }
      let rows = dims.rows;
      // FitAddon can over-count by a row, leaving the last line clipped by the
      // tile's rounded overflow. Trim to what the real rendered cell height fits.
      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      if (screen && term.rows > 0) {
        const cellH = screen.offsetHeight / term.rows;
        if (cellH > 0) {
          const cs = getComputedStyle(container);
          const avail =
            container.clientHeight -
            parseFloat(cs.paddingTop || "0") -
            parseFloat(cs.paddingBottom || "0");
          rows = Math.max(1, Math.min(rows, Math.floor((avail + 0.5) / cellH)));
        }
      }
      if (dims.cols !== term.cols || rows !== term.rows) {
        term.resize(dims.cols, rows);
      } else {
        // Same size but we just became measurable again (e.g. shown after a
        // workspace switch): repaint so a kept-alive tile is never left blank.
        term.refresh(0, term.rows - 1);
      }
    };
    safeFitRef.current = safeFit;
    safeFit();

    let disposed = false;
    let tauriId: number | null = null;
    let ws: WsPtyHandle | null = null;
    let previewDispose: (() => void) | null = null;
    let gotData = false;

    // The bundled Nerd Font symbols load asynchronously. Because the @font-face
    // has a restricted unicode-range, we must ask for it with actual icon glyphs
    // or the browser decides it isn't needed and never fetches it. Once it's
    // loaded, rebuild the WebGL glyph atlas and repaint so file/type icons
    // render instead of tofu boxes.
    if (typeof document !== "undefined" && document.fonts) {
      // Sample glyphs from the Nerd Font blocks (file, folder, seti/devicons):
      // loading one BMP icon pulls the whole face, which then covers every icon.
      const iconSample = String.fromCodePoint(0xf15b, 0xf07b, 0xe5fb, 0xe702);
      document.fonts
        .load('16px "Symbols Nerd Font Mono"', iconSample)
        .catch(() => undefined)
        .then(() => {
          if (disposed) return;
          try {
            webgl?.clearTextureAtlas();
          } catch {
            /* canvas fallback */
          }
          term.refresh(0, term.rows - 1);
        });
    }

    // Status: producing output -> active (green blink), quiet -> idle (grey),
    // pty gone -> failed (red).
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const markActive = () => {
      onStatus?.("active");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => onStatus?.("idle"), 2000);
    };

    const raf = requestAnimationFrame(safeFit);
    const t1 = setTimeout(safeFit, 80);
    const t2 = setTimeout(safeFit, 250);

    // Output scheduling. The focused tile writes straight through so typing
    // stays instant. Every other tile batches its output: a TUI that redraws
    // continuously (a spinner, btop) would otherwise force a full WebGL repaint
    // per burst in a pane nobody is looking at closely. Batches flush at a fixed
    // cadence (slower still while the window is hidden or another app has
    // focus) and immediately once they grow large, so a flood of output never
    // piles up in memory.
    const BACKGROUND_FLUSH_MS = 50; // ~20 fps for visible, unfocused tiles
    const HIDDEN_FLUSH_MS = 250; // window hidden or in the background
    const MAX_PENDING_BYTES = 256 * 1024;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushOutput = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      const chunks = pending;
      pending = [];
      pendingBytes = 0;
      for (const chunk of chunks) term.write(chunk);
    };
    flushOutputRef.current = flushOutput;
    const windowFocused = () => document.visibilityState === "visible" && document.hasFocus();
    const writeOutput = (bytes: Uint8Array) => {
      markActive();
      if (activeRef.current && windowFocused()) {
        if (pending.length) flushOutput();
        term.write(bytes);
        return;
      }
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes >= MAX_PENDING_BYTES) {
        flushOutput();
        return;
      }
      if (flushTimer === undefined) {
        const delay = document.visibilityState === "visible" ? BACKGROUND_FLUSH_MS : HIDDEN_FLUSH_MS;
        flushTimer = setTimeout(flushOutput, delay);
      }
    };

    if (HAS_TAURI) {
      spawnPty({ cmd, args, cwd, cols: term.cols, rows: term.rows }, writeOutput)
        .then((id) => {
          if (disposed) return killPty(id);
          tauriId = id;
          term.onData((d) => writePty(id, d));
          term.onResize(({ cols, rows }) => resizePty(id, cols, rows));
        })
        .catch((err) => term.writeln(`\r\n[pty spawn failed] ${err}\r\n`));
    } else {
      ws = openWsPty(
        name,
        term.cols,
        term.rows,
        cwd,
        (bytes) => {
          gotData = true;
          writeOutput(bytes);
        },
        () => {
          // Server unreachable and nothing streamed yet: show the preview so the
          // tile is not a dead black box.
          if (!gotData && !previewDispose) previewDispose = runBrowserPreview(term);
        },
        () => {
          // pty exited on the server side.
          if (!disposed) onStatus?.("failed");
        },
        win,
        host,
      );
      term.onData((d) => ws?.write(d));
      term.onResize(({ cols, rows }) => ws?.resize(cols, rows));
    }

    const pasteController = new AbortController();
    let pasteQueue = Promise.resolve();
    let pasteNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    const onPaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const images = Array.from(clipboard.items)
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const text = clipboard.getData("text");
      if (!images.length && !text) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep consecutive image/text pastes ordered while an upload is pending.
      pasteQueue = pasteQueue.then(async () => {
        if (disposed) return;
        if (!images.length) { term.paste(text); return; }
        clearTimeout(pasteNoticeTimer);
        try {
          for (let index = 0; index < images.length; index++) {
            const image = images[index];
            if (disposed) return;
            if (image.size > 20 * 1024 * 1024) throw new Error("Images must be 20 MB or smaller.");
            setPasteStatus({ error: false, message: `Uploading image ${index + 1}/${images.length} to the terminal device…` });
            const target = HAS_TAURI ? host ?? "" : host;
            const imagePath = await uploadPasteImage(image, target, pasteController.signal);
            if (disposed) return;
            if (!imagePath.startsWith("/") || imagePath.length > 4096 || /[\x00-\x1f\x7f]/.test(imagePath)) {
              throw new Error("The device returned an invalid image path.");
            }
            if (HAS_TAURI && tauriId === null) throw new Error("Terminal is not connected yet. Paste the image again once it connects.");
            // Quote paths containing spaces/apostrophes and preserve bracketed paste.
            const quoted = "'" + imagePath.replace(/'/g, "'\\''") + "' ";
            term.paste(quoted);
          }
          setPasteStatus({ error: false, message: images.length === 1 ? "Image path pasted." : `${images.length} image paths pasted.` });
          pasteNoticeTimer = setTimeout(() => { if (!disposed) setPasteStatus(null); }, 3000);
        } catch (error) {
          if (!disposed) setPasteStatus({ error: true, message: error instanceof Error ? error.message : "Image paste failed." });
        }
      });
    };
    container.addEventListener("paste", onPaste, true);

    // Focus the terminal on click so a following Cmd/Ctrl+V lands here even when
    // the tile was already active (the active effect only refocuses on change).
    const onMouseDown = () => term.focus();
    container.addEventListener("mousedown", onMouseDown);

    // Only scroll the terminal you actually clicked into. When the tile is not
    // active, swallow the wheel before xterm sees it (capture phase) but don't
    // preventDefault, so the grid can still scroll normally underneath.
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) e.stopPropagation();
    };
    container.addEventListener("wheel", onWheel, { capture: true });

    const resizeObserver = new ResizeObserver(safeFit);
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("copy", onCopy, true);
      selectionListener.dispose();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("wheel", onWheel, { capture: true });
      disposed = true;
      pasteController.abort();
      clearTimeout(pasteNoticeTimer);
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(idleTimer);
      clearTimeout(flushTimer);
      flushOutputRef.current = null;
      resizeObserver.disconnect();
      previewDispose?.();
      // Detach only - the remote tmux session keeps running.
      if (tauriId !== null) killPty(tauriId);
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = { ...themeById(themeId).terminal, ...(semiTransparent ? { background: "#00000000" } : {}) };
  }, [themeId, semiTransparent]);

  // Track active state for the wheel guard, and focus the terminal when it
  // becomes active (so keyboard tile shortcuts land input in the right pane).
  useEffect(() => {
    activeRef.current = active;
    if (active) {
      // Catch up on any output batched while this tile was in the background.
      flushOutputRef.current?.();
      termRef.current?.focus();
    }
  }, [active]);

  // Live font size / cursor changes from Settings, then refit so the PTY
  // dimensions follow the new cell size.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.lineHeight = snappedLineHeight(fontSize);
    term.options.cursorBlink = cursorBlink;
    try {
      fitRef.current?.fit();
    } catch {
      /* not measurable yet */
    }
  }, [fontSize, cursorBlink]);

  // When the grid is reshaped elsewhere (new session, workspace switch, layout
  // change), a resize can leave this kept-alive terminal with stale paint cells.
  // Re-fit, then nudge the row count so tmux does a full redraw that overwrites
  // every cell, and finally repaint xterm. Runs twice to catch any transition.
  useEffect(() => {
    if (refreshNonce === 0) return;
    const hardRefresh = () => {
      const term = termRef.current;
      if (!term) return;
      safeFitRef.current?.();
      const { cols, rows } = term;
      if (rows > 1) {
        try {
          // A real size change makes the tmux server repaint the whole pane.
          term.resize(cols, rows - 1);
          term.resize(cols, rows);
        } catch {
          /* not attached */
        }
      }
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* renderer not ready */
      }
    };
    const t1 = setTimeout(hardRefresh, 130);
    const t2 = setTimeout(hardRefresh, 340);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [refreshNonce]);

  return <>
    <div ref={containerRef} className="term-surface" />
    {hasSelection ? <button className="btn btn-sm term-copy-selection" type="button"
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={() => {
        const text = termRef.current?.getSelection();
        if (text) void copyToClipboard(text).then((ok) => {
          setPasteStatus({ error: !ok, message: ok ? "Text copied to your clipboard." : "Clipboard access failed. Try copying again." });
        });
      }}>Copy selection</button> : null}
    {pasteStatus ? <div className={`term-paste-status ${pasteStatus.error ? "term-paste-error" : ""}`} role={pasteStatus.error ? "alert" : "status"}>
      <span>{pasteStatus.message}</span>
      <button type="button" className="tile-btn" aria-label="Dismiss clipboard message" onClick={() => setPasteStatus(null)}>×</button>
    </div> : null}
  </>;
}
