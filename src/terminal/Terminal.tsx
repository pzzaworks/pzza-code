import { useEffect, useRef } from "react";
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
function copyToClipboard(text: string): void {
  if (!text) return;
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      /* clipboard genuinely unavailable */
    }
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
      return;
    }
  } catch {
    /* fall through */
  }
  fallback();
}

interface Props {
  name: string;
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
export function Terminal({ name, cmd, args, cwd, window: win, active, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const safeFitRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const themeId = useStore((s) => s.themeId);
  const fontSize = useStore((s) => s.fontSize);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const refreshNonce = useStore((s) => s.refreshNonce);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: useStore.getState().cursorBlink,
      // Nerd Fonts first so yazi/btop/lazydocker glyphs render (fall back to a
      // plain monospace for the text if none are installed).
      fontFamily:
        '"MesloLGS NF", "JetBrainsMono Nerd Font", "JetBrainsMonoNL Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: useStore.getState().fontSize,
      lineHeight: snappedLineHeight(useStore.getState().fontSize),
      scrollback: 10000,
      theme: themeById(useStore.getState().themeId).terminal,
    });
    termRef.current = term;

    // Copy the selection on Cmd+C (macOS) or Ctrl+Shift+C, working in insecure
    // contexts too. Plain Ctrl+C is left alone so it still sends SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      const isCopy =
        (e.metaKey && !e.ctrlKey && !e.altKey && k === "c") ||
        (e.ctrlKey && e.shiftKey && k === "c");
      if (isCopy && term.hasSelection()) {
        copyToClipboard(term.getSelection());
        term.focus();
        return false;
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

    if (HAS_TAURI) {
      spawnPty(
        { cmd, args, cwd, cols: term.cols, rows: term.rows },
        (bytes) => {
          markActive();
          term.write(bytes);
        },
      )
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
          markActive();
          term.write(bytes);
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
      );
      term.onData((d) => ws?.write(d));
      term.onResize(({ cols, rows }) => ws?.resize(cols, rows));
    }

    // Cmd/Ctrl+V of an image: upload it to the devbox and type the resulting
    // path into the pty so the agent (Claude/Codex) can read it. Text pastes
    // fall through to xterm untouched.
    const sendInput = (text: string) => {
      if (tauriId !== null) writePty(tauriId, text);
      else ws?.write(text);
    };
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgItem = Array.from(items).find((it) => it.type.startsWith("image/"));
      if (!imgItem) return; // let xterm handle plain-text pastes
      const blob = imgItem.getAsFile();
      if (!blob) return;
      e.preventDefault();
      e.stopPropagation();
      uploadPasteImage(blob)
        .then((p) => sendInput(p + " "))
        .catch((err) => term.writeln(`\r\n[image paste failed] ${err}\r\n`));
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
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("wheel", onWheel, { capture: true });
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(idleTimer);
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
    if (term) term.options.theme = themeById(themeId).terminal;
  }, [themeId]);

  // Track active state for the wheel guard, and focus the terminal when it
  // becomes active (so keyboard tile shortcuts land input in the right pane).
  useEffect(() => {
    activeRef.current = active;
    if (active) termRef.current?.focus();
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

  return <div ref={containerRef} className="term-surface" />;
}
