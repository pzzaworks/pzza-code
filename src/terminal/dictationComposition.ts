import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

// Composition belongs to the terminal view. It never enters the PTY or buffer.
// The screen bounds are the rendered cell grid in both normal and TUI buffers.
export function createDictationComposition(term: Terminal) {
  let text = "";
  let suspended = false;
  let awaitingEcho = false;
  let disposed = false;
  let frame = 0;
  let layer: HTMLDivElement | undefined;
  let content: HTMLSpanElement | undefined;
  let marker: IMarker | undefined;
  let markerListener: IDisposable | undefined;
  const releaseMarker = () => { markerListener?.dispose(); markerListener = undefined; marker?.dispose(); marker = undefined; };
  const hide = () => { if (layer) layer.hidden = true; };
  const clear = () => { text = ""; awaitingEcho = false; hide(); releaseMarker(); };
  const render = () => {
    frame = 0;
    if (disposed || !text || suspended || awaitingEcho) { hide(); return; }
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) { hide(); return; }
    const bounds = screen.getBoundingClientRect();
    if (!bounds.width || !bounds.height) { hide(); return; }
    const buffer = term.buffer.active;
    const wrapped = buffer.cursorX >= term.cols;
    const column = wrapped ? 0 : buffer.cursorX;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY + (wrapped ? 1 : 0);
    // A pending wrap at the last cell has no destination row until real input
    // scrolls the terminal. Keep that composition just above the caret instead.
    const aboveCaret = wrapped && row === term.rows;
    if (row < 0 || (row >= term.rows && !aboveCaret)) { hide(); return; }
    if (buffer.type === "normal") {
      const line = buffer.baseY + buffer.cursorY;
      if (!marker || marker.line !== line) {
        releaseMarker();
        marker = term.registerMarker();
        markerListener = marker?.onDispose(clear);
      }
    } else releaseMarker();
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "terminal-dictation-composition";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, { position: "absolute", left: "0", pointerEvents: "none", zIndex: "9", overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-all", userSelect: "none" });
      content = document.createElement("span");
      Object.assign(content.style, { textDecoration: "underline dotted", textUnderlineOffset: "2px" });
      layer.appendChild(content);
      screen.appendChild(layer);
    }
    const cellWidth = bounds.width / term.cols;
    const cellHeight = bounds.height / term.rows;
    Object.assign(layer.style, {
      top: `${(aboveCaret && term.rows > 1 ? row - 1 : row) * cellHeight}px`, width: `${bounds.width}px`, maxHeight: `${(aboveCaret ? Math.max(1, Math.min(3, term.rows - 1)) : term.rows - row) * cellHeight}px`,
      transform: aboveCaret ? "translateY(-100%)" : "none",
      textIndent: `${column * cellWidth}px`, lineHeight: `${cellHeight}px`, fontFamily: term.options.fontFamily,
      fontSize: `${term.options.fontSize}px`, fontWeight: String(term.options.fontWeight), letterSpacing: `${term.options.letterSpacing}px`,
      color: term.options.theme?.foreground ?? "#ffffff",
    });
    if (content) { content.textContent = text; content.style.backgroundColor = term.options.theme?.background ?? "transparent"; }
    layer.hidden = false;
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
  const listeners = [
    term.onCursorMove(schedule), term.onResize(schedule), term.onScroll(schedule), term.onRender(schedule),
    term.buffer.onBufferChange(schedule), term.onWriteParsed(() => { awaitingEcho = false; schedule(); }),
  ];
  return {
    preview(value: string) { text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 8192); if (!text) { hide(); releaseMarker(); } else schedule(); },
    clear,
    beginConfirmedWrite() { clear(); awaitingEcho = true; },
    suspend(value: boolean) { suspended = value; if (value) hide(); else schedule(); },
    dispose() { disposed = true; cancelAnimationFrame(frame); clear(); for (const listener of listeners) listener.dispose(); layer?.remove(); },
  };
}
