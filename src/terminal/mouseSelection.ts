import type { Terminal } from "@xterm/xterm";
import { terminalLinkAt, type TerminalLink } from "./links";

// Mouse-aware remote programs consume normal drags. Keep local text selection
// available while forwarding simple clicks and modified drags to the program.
// Double-clicking a URL selects all of it, even across hard-wrapped rows, in
// every mouse mode; `onLinkSelected` receives it so copies use the joined URL.
export function installMouseSelection(container: HTMLElement, term: Terminal, onLinkSelected: (link: TerminalLink) => void): () => void {
  let gesture: { index: number; lastIndex: number; down: MouseEvent; moved: boolean } | undefined;
  let forwarding = false;
  // Rounded column for drag boundaries; `cell` floors it to hit-test a cell.
  const position = (event: MouseEvent, cell = false): number | undefined => {
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const bounds = screen.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const exact = (event.clientX - bounds.left) * term.cols / bounds.width;
    const column = Math.max(0, Math.min(cell ? term.cols - 1 : term.cols, cell ? Math.floor(exact) : Math.round(exact)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((event.clientY - bounds.top) * term.rows / bounds.height)));
    return (term.buffer.active.viewportY + row) * term.cols + column;
  };
  const down = (event: MouseEvent) => {
    if (forwarding || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !(event.target instanceof Node) || !screen.contains(event.target)) return;
    const hit = event.detail === 2 ? position(event, true) : undefined;
    const link = hit === undefined ? undefined : terminalLinkAt(term, hit % term.cols, Math.floor(hit / term.cols));
    if (!link && term.modes.mouseTrackingMode === "none") return;
    const index = position(event);
    if (index === undefined) return;
    gesture = { index, lastIndex: index, down: event, moved: false };
    term.clearSelection();
    if (link) {
      term.select(link.start.x, link.start.y, (link.end.y - link.start.y) * term.cols + link.end.x - link.start.x + 1);
      onLinkSelected(link);
      gesture.moved = true;
    } else if (event.detail >= 3) {
      term.selectLines(Math.floor(index / term.cols), Math.floor(index / term.cols));
      gesture.moved = true;
    } else if (event.detail === 2) {
      const row = Math.floor(index / term.cols);
      const line = term.buffer.active.getLine(row);
      const column = Math.min(index % term.cols, term.cols - 1);
      const separators = term.options.wordSeparator ?? " ()[]{}'\"";
      const isSeparator = (at: number) => {
        const chars = line?.getCell(at)?.getChars() || " ";
        return separators.includes(chars);
      };
      let first = column;
      let last = column + 1;
      const separator = isSeparator(column);
      while (first > 0 && isSeparator(first - 1) === separator) first--;
      while (last < term.cols && isSeparator(last) === separator) last++;
      term.select(first, row, last - first);
      gesture.moved = true;
    }
    term.focus();
    event.preventDefault();
    event.stopPropagation();
  };
  const move = (event: MouseEvent) => {
    if (!gesture) return;
    const index = position(event);
    if (index === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (index === gesture.lastIndex) return;
    gesture.lastIndex = index;
    if (index !== gesture.index) gesture.moved = true;
    if (gesture.moved) {
      const start = Math.min(index, gesture.index);
      term.select(start % term.cols, Math.floor(start / term.cols), Math.abs(index - gesture.index));
    }
  };
  const up = (event: MouseEvent) => {
    if (!gesture || event.button !== 0) return;
    const current = gesture;
    gesture = undefined;
    if (!current.moved && current.down.target instanceof Element) {
      // Defer only the press/release pair until a click is distinguished from a
      // drag. No remote mouse-down is left stuck after selecting local text.
      forwarding = true;
      try {
        current.down.target.dispatchEvent(new MouseEvent("mousedown", current.down));
        current.down.target.dispatchEvent(new MouseEvent("mouseup", event));
      } finally { forwarding = false; }
    }
  };
  const cancel = () => { gesture = undefined; };
  container.addEventListener("mousedown", down, true);
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", up, true);
  window.addEventListener("blur", cancel);
  return () => {
    container.removeEventListener("mousedown", down, true);
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
    window.removeEventListener("blur", cancel);
  };
}
