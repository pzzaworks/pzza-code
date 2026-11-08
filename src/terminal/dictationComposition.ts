import type { IBuffer, IDisposable, IMarker, Terminal } from "@xterm/xterm";

// Box-drawing glyphs agent TUIs use around their input. A plain "|" is left out
// because shell prompts and typed text use it as ordinary content.
const VERTICAL_BORDER = /[│┃║▏▕╎╏┆┇┊┋]/;
const HORIZONTAL_RULE = /[─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘╔╗╚╝┏┓┗┛▔▁]/;
// Prompt glyphs that start an input line (Claude Code, Codex, shells).
const PROMPT_GLYPH = /^[>›❯➜»$%#λ]$/;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
const MIN_REGION_COLUMNS = 8;
const charCells = (char: string) => (WIDE.test(char) ? 2 : 1);

interface Region {
  // Columns [left, right) hold continuation lines; the first line starts at the caret.
  left: number;
  right: number;
  // Rows available from the caret row down, before a rule or other content.
  rows: number;
}

function cellChars(buffer: IBuffer, row: number) {
  const line = buffer.getLine?.(buffer.viewportY + row);
  return (x: number) => line?.getCell(x)?.getChars() ?? "";
}

// The input area around the caret: inside a bordered box, after a prompt glyph,
// and above the box's bottom edge or the footer that follows it. Without any of
// those markers the whole row width below the caret is used, like a shell.
export function inputRegion(buffer: IBuffer, cols: number, rows: number, row: number, column: number): Region {
  const at = cellChars(buffer, row);
  let right = cols;
  for (let x = column; x < cols; x++) if (VERTICAL_BORDER.test(at(x))) { right = x; break; }
  let border = -1;
  for (let x = Math.min(column, cols) - 1; x >= 0; x--) if (VERTICAL_BORDER.test(at(x))) { border = x; break; }
  // Inside a box, continuation lines align with where its content starts.
  // A bare shell line wraps at column 0 unless it begins with a prompt glyph.
  let left = border + 1;
  while (left < column && at(left) === " ") left++;
  if (left + 1 < column && PROMPT_GLYPH.test(at(left)) && at(left + 1) === " ") left += 2;
  else if (border < 0) left = 0;
  if (right - left < MIN_REGION_COLUMNS) { left = 0; right = cols; }
  let available = rows - row;
  for (let r = row + 1; r < rows; r++) {
    const cell = cellChars(buffer, r);
    let occupied = false;
    for (let x = left; x < right && !occupied; x++) {
      const char = cell(x);
      occupied = char !== "" && char !== " " && !VERTICAL_BORDER.test(char);
      if (HORIZONTAL_RULE.test(char)) occupied = true;
    }
    if (occupied) { available = r - row; break; }
  }
  return { left, right, rows: Math.max(1, available) };
}

// Lays text into lines of the given cell widths. When it does not fit, the
// newest words win: the start is dropped behind an ellipsis.
export function layoutComposition(text: string, first: number, rest: number, lines: number): string[] {
  const chars = Array.from(text);
  const capacity = Math.max(1, first) + Math.max(0, lines - 1) * Math.max(1, rest);
  let total = 0;
  for (const char of chars) total += charCells(char);
  let visible = chars;
  if (total > capacity) {
    let used = 1;
    let start = chars.length;
    while (start > 0 && used + charCells(chars[start - 1]) <= capacity) used += charCells(chars[--start]);
    visible = ["…", ...chars.slice(start)];
  }
  const out: string[] = [];
  let line = "";
  let width = 0;
  let limit = Math.max(1, first);
  for (const char of visible) {
    const cells = charCells(char);
    if (width + cells > limit && line) {
      out.push(line);
      line = "";
      width = 0;
      limit = Math.max(1, rest);
    }
    line += char;
    width += cells;
  }
  if (line) out.push(line);
  return out.slice(0, Math.max(1, lines));
}

/** Activity shown after the pending words: speech is being heard, or the final pass runs. */
export type DictationIndicator = "listening" | "finishing";
// Three one-cell dots, so they lay out like any other text at the caret.
export const INDICATOR_DOTS = "···";

// Splits laid-out lines into their text and the indicator dots that end the
// last line(s); the dots are always the final characters of the layout.
export function splitIndicator(lines: string[], dots: number): { text: string; first: number; count: number }[] {
  let remaining = dots;
  return lines.map((line) => Array.from(line)).reverse().map((chars) => {
    const count = Math.min(remaining, chars.length);
    remaining -= count;
    // `first` is the index of the first dot this line holds.
    return { text: chars.slice(0, chars.length - count).join(""), first: remaining, count };
  }).reverse();
}

// Composition belongs to the terminal view. It never enters the PTY or buffer.
// The screen bounds are the rendered cell grid in both normal and TUI buffers.
export function createDictationComposition(term: Terminal) {
  // Pending words to show at the caret.
  let text = "";
  let indicator: DictationIndicator | null = null;
  // Words being pasted stay on screen at the old caret until the PTY echo is
  // parsed, so confirmed text never blinks out between preview and echo.
  let held = "";
  let suspended = false;
  let awaitingEcho = false;
  let disposed = false;
  let frame = 0;
  let layer: HTMLDivElement | undefined;
  const lineElements: HTMLDivElement[] = [];
  let marker: IMarker | undefined;
  let markerListener: IDisposable | undefined;
  const releaseMarker = () => { markerListener?.dispose(); markerListener = undefined; marker?.dispose(); marker = undefined; };
  const hide = () => { if (layer) layer.hidden = true; };
  const clear = () => { text = ""; indicator = null; held = ""; awaitingEcho = false; hide(); releaseMarker(); };
  const lineElement = (index: number) => {
    let element = lineElements[index];
    if (!element) {
      element = document.createElement("div");
      Object.assign(element.style, { position: "absolute", overflow: "hidden", whiteSpace: "pre" });
      const content = document.createElement("span");
      Object.assign(content.style, { textDecoration: "underline dotted", textUnderlineOffset: "2px" });
      element.appendChild(content);
      const dots = document.createElement("span");
      dots.className = "terminal-dictation-indicator";
      for (let dot = 0; dot < INDICATOR_DOTS.length; dot++) {
        const span = document.createElement("span");
        span.className = "terminal-dictation-dot";
        span.textContent = INDICATOR_DOTS[dot];
        Object.assign(span.style, { animationDelay: `${dot * 160}ms` });
        dots.appendChild(span);
      }
      element.appendChild(dots);
      layer?.appendChild(element);
      lineElements[index] = element;
    }
    return element;
  };
  const render = () => {
    frame = 0;
    const words = awaitingEcho ? held : text;
    const dots = indicator ? INDICATOR_DOTS : "";
    const shown = words && dots ? `${words} ${dots}` : words || dots;
    if (disposed || !shown || suspended) { hide(); return; }
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
      layer.setAttribute("data-indicator", "");
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, { position: "absolute", left: "0", pointerEvents: "none", zIndex: "9", overflow: "hidden", userSelect: "none" });
      screen.appendChild(layer);
    }
    const region: Region = aboveCaret
      ? { left: 0, right: term.cols, rows: Math.max(1, Math.min(3, term.rows - 1)) }
      : inputRegion(buffer, term.cols, term.rows, row, column);
    const firstStart = aboveCaret ? 0 : Math.min(Math.max(column, region.left), region.right - 1);
    const lines = layoutComposition(shown, region.right - firstStart, region.right - region.left, region.rows);
    const cellWidth = bounds.width / term.cols;
    const cellHeight = bounds.height / term.rows;
    const top = aboveCaret ? Math.max(0, term.rows - 1 - lines.length) : row;
    Object.assign(layer.style, {
      top: `${top * cellHeight}px`, width: `${bounds.width}px`, height: `${lines.length * cellHeight}px`,
      lineHeight: `${cellHeight}px`, fontFamily: term.options.fontFamily,
      fontSize: `${term.options.fontSize}px`, fontWeight: String(term.options.fontWeight), letterSpacing: `${term.options.letterSpacing}px`,
      color: term.options.theme?.foreground ?? "#ffffff",
    });
    const background = term.options.theme?.background ?? "transparent";
    layer.setAttribute("data-indicator", indicator ?? "");
    const parts = splitIndicator(lines, Array.from(dots).length);
    lines.forEach((_, index) => {
      const start = index === 0 ? firstStart : region.left;
      const element = lineElement(index);
      Object.assign(element.style, {
        left: `${start * cellWidth}px`, top: `${index * cellHeight}px`,
        width: `${(region.right - start) * cellWidth}px`, height: `${cellHeight}px`,
      });
      const content = element.children[0] as HTMLSpanElement;
      content.textContent = parts[index].text;
      content.style.backgroundColor = background;
      // Each line shows only as many dots as it holds; the rest stay hidden.
      const indicatorDots = element.children[1] as HTMLSpanElement;
      const { first, count } = parts[index];
      indicatorDots.hidden = count === 0;
      indicatorDots.style.backgroundColor = background;
      Array.from(indicatorDots.children).forEach((dot, position) => {
        (dot as HTMLSpanElement).hidden = position < first || position >= first + count;
      });
      element.hidden = false;
    });
    for (let index = lines.length; index < lineElements.length; index++) lineElements[index].hidden = true;
    layer.hidden = false;
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
  const listeners = [
    term.onCursorMove(schedule), term.onResize(schedule), term.onScroll(schedule), term.onRender(schedule),
    term.buffer.onBufferChange(schedule), term.onWriteParsed(() => {
      if (awaitingEcho) {
        awaitingEcho = false;
        held = "";
        if (!text && !indicator) { hide(); releaseMarker(); }
      }
      schedule();
    }),
  ];
  return {
    // `activity` adds animated dots after the words, or alone at the caret
    // before the first words arrive.
    preview(value: string, activity: DictationIndicator | null = null) {
      text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 8192);
      indicator = activity;
      // While a paste is in flight the held words stay up; the new remainder
      // takes over at the moved caret once the echo is parsed.
      if (awaitingEcho || text || indicator) schedule();
      else { hide(); releaseMarker(); }
    },
    clear,
    beginConfirmedWrite() { held = text; awaitingEcho = true; schedule(); },
    suspend(value: boolean) { suspended = value; if (value) hide(); else schedule(); },
    dispose() { disposed = true; cancelAnimationFrame(frame); clear(); for (const listener of listeners) listener.dispose(); layer?.remove(); },
  };
}
