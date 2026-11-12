import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { rankOptions } from "./selectSearch";

export interface Option {
  value: string;
  label: string;
  sub?: string;
  icon?: ReactNode;
  // Extra search terms that are not shown (aliases, command names).
  keywords?: string[];
  // Options sharing a group are listed together under a sticky header, the
  // groups in the order they first appear.
  group?: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onOpen?: () => void;
  // "end" anchors the list to the trigger's right edge, for controls near the panel edge.
  align?: "start" | "end";
  className?: string;
  title?: string;
  // A search field at the top of the list; on by default past SEARCH_THRESHOLD options.
  searchable?: boolean;
}

// Room kept between an open list and the window edge.
const EDGE = 8;
const SEARCH_THRESHOLD = 8;
// A searchable list is never narrower than this, so the field stays usable.
const SEARCH_MIN_WIDTH = 220;

interface Row {
  option: Option;
  // Position in the visible (filtered, grouped) list.
  index: number;
  // Position in `options`, which keeps element ids stable while filtering.
  key: number;
}

interface Section {
  group?: string;
  rows: Row[];
}

function buildView(options: Option[], query: string): { sections: Section[]; rows: Row[] } {
  const keys = new Map(options.map((option, key) => [option, key]));
  const ranked = rankOptions(options, query);
  const groups = [...new Set(options.map((option) => option.group))];
  const rows: Row[] = [];
  const sections = groups
    .map((group) => ({ group, rows: ranked.filter((option) => option.group === group).map((option) => {
      const row = { option, index: 0, key: keys.get(option) ?? 0 };
      rows.push(row);
      return row;
    }) }))
    .filter((section) => section.rows.length > 0);
  rows.forEach((row, index) => { row.index = index; });
  return { sections, rows };
}

// Scrolls a row into its list, clear of the sticky header of its group.
function reveal(list: HTMLElement, item: HTMLElement, center: boolean) {
  const header = item.closest('[role="group"]')?.querySelector<HTMLElement>(".cselect-group-label")?.offsetHeight ?? 0;
  const top = item.offsetTop - header;
  const bottom = item.offsetTop + item.offsetHeight;
  if (center) list.scrollTop = top - (list.clientHeight - header - item.offsetHeight) / 2;
  else if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

// Custom select (never a native <select>). The list renders in a portal at the
// document root, so it is never clipped by a scrolling panel and always stacks
// above everything.
export function Select({ value, options, onChange, placeholder, disabled = false, ariaLabel, onOpen, align = "start", className = "", title, searchable }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // True while the keyboard drives the highlight, so a resting pointer does
  // not show a second highlighted row.
  const [keys, setKeys] = useState(false);
  // A searchable list keeps the size it opened with while filtering.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const opening = useRef(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (key: number) => `${baseId}-option-${key}`;

  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const current = options.find((o) => o.value === value);
  const view = useMemo(() => buildView(options, withSearch ? query : ""), [options, query, withSearch]);
  const activeRow = view.rows[Math.min(active, view.rows.length - 1)];
  // Remeasured only when the options themselves change, not on every new array.
  const optionsKey = options.map((o) => `${o.value}\u0000${o.label}\u0000${o.sub ?? ""}\u0000${o.group ?? ""}`).join("\u0001");
  const selectedIndex = (rows: Row[]) => Math.max(0, rows.findIndex((row) => row.option.value === value));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  };
  const pick = (next: string) => {
    onChange(next);
    close(true);
  };
  const openMenu = () => {
    onOpen?.();
    setQuery("");
    setKeys(false);
    setSize(null);
    setActive(selectedIndex(buildView(options, "").rows));
    opening.current = true;
    setOpen(true);
  };

  // Keeps the open list inside the window: a list wider than the room right
  // of its trigger moves left (or right, when anchored at the end).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !rect || !menu) return;
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - EDGE) { menu.style.left = `${Math.max(EDGE, window.innerWidth - EDGE - box.width)}px`; menu.style.right = "auto"; }
    else if (box.left < EDGE) { menu.style.left = `${EDGE}px`; menu.style.right = "auto"; }
  }, [open, rect]);
  useLayoutEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => btnRef.current && setRect(btnRef.current.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // Locks the size of the unfiltered list (measured before paint), so typing
  // never makes the menu jump. A changed option set is measured again.
  useLayoutEffect(() => { if (open && !query) setSize(null); }, [optionsKey]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!withSearch || !open || !rect || !menu || size || query) return;
    const box = menu.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });
  }, [withSearch, open, rect, size, query]);

  // Focus moves into the list on open (the search field when there is one).
  const mounted = open && !!rect;
  useLayoutEffect(() => {
    if (!mounted) return;
    (searchRef.current ?? listRef.current)?.focus({ preventScroll: true });
  }, [mounted]);

  // The highlighted row stays in view; on open the selected one is centred.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!mounted || !list || !activeRow) return;
    const item = document.getElementById(optionId(activeRow.key));
    if (item) reveal(list, item, opening.current);
    opening.current = false;
  }, [mounted, activeRow?.key, size]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = view.rows.length - 1;
    const move = (index: number) => { event.preventDefault(); setKeys(true); setActive(Math.max(0, Math.min(last, index))); };
    switch (event.key) {
      case "ArrowDown": return move(active + 1);
      case "ArrowUp": return move(active - 1);
      case "Home": return move(0);
      case "End": return move(last);
      case "Enter":
        event.preventDefault();
        if (activeRow) pick(activeRow.option.value);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (query) { setQuery(""); setActive(selectedIndex(buildView(options, "").rows)); opening.current = true; }
        else close(true);
        return;
      case "Tab":
        // Focus returns to the trigger before the browser moves it on.
        close(true);
        return;
    }
  };

  const empty = view.rows.length === 0;
  const menuStyle = {
    ...(align === "end" ? { right: window.innerWidth - (rect?.right ?? 0) } : { left: rect?.left ?? 0 }),
    top: (rect?.bottom ?? 0) + 5,
    minWidth: withSearch ? Math.max(rect?.width ?? 0, SEARCH_MIN_WIDTH) : rect?.width,
    width: size ? size.width : "max-content",
    ...(size ? { height: size.height } : {}),
    maxWidth: `calc(100vw - ${2 * EDGE}px)`,
  };

  const renderRow = ({ option, index, key }: Row) => (
    <div
      key={option.value}
      id={optionId(key)}
      role="option"
      aria-selected={option.value === value}
      className={`cselect-item ${option.value === value ? "cselect-item-on" : ""} ${index === activeRow?.index ? "cselect-item-active" : ""}`}
      // Keeps focus in the search field (or list) while picking with the pointer.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => { if (keys) setKeys(false); if (index !== active) setActive(index); }}
      onClick={() => pick(option.value)}
    >
      {option.icon}
      <span className="cselect-item-main">
        <span className="cselect-item-label">{option.label}</span>
        {option.sub ? <span className="cselect-item-sub">{option.sub}</span> : null}
      </span>
      <span className="cselect-item-check">{option.value === value ? <Check size={14} /> : null}</span>
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cselect ${open ? "cselect-open" : ""} ${className}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={title}
        onClick={() => { if (open) close(false); else openMenu(); }}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openMenu(); } }}
      >
        {current?.icon}
        <span className="cselect-value">{current?.label ?? placeholder ?? "Select"}</span>
        <ChevronDown size={14} className={`muted-icon ${open ? "flip" : ""}`} />
      </button>

      {open && rect
        ? createPortal(
            <div className="cselect-backdrop pzza-portal" onMouseDown={() => close(true)}>
              {/* As wide as its longest option (never wrapped), at least the
                  trigger's width, and moved left when it would leave the window.
                  It opens with the shared menu animation (CSS). */}
              <div
                ref={menuRef}
                className={`cselect-menu cselect-menu-list ${withSearch ? "cselect-menu-search" : ""}`}
                style={menuStyle}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {withSearch ? (
                  <label className="cselect-search">
                    <Search size={13} aria-hidden="true" />
                    <input
                      ref={searchRef}
                      type="text"
                      role="combobox"
                      size={1}
                      value={query}
                      placeholder="Search"
                      aria-label={`Search ${ariaLabel ?? "options"}`}
                      aria-autocomplete="list"
                      aria-expanded="true"
                      aria-controls={listId}
                      aria-activedescendant={activeRow ? optionId(activeRow.key) : undefined}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      onChange={(e) => {
                        const next = e.target.value;
                        setQuery(next);
                        setActive(next.trim() ? 0 : selectedIndex(buildView(options, "").rows));
                      }}
                      onKeyDown={onKeyDown}
                    />
                  </label>
                ) : null}
                <div
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  aria-label={ariaLabel}
                  className={`cselect-list ${keys ? "cselect-keys" : ""} ${empty ? "cselect-list-empty" : ""}`}
                  tabIndex={withSearch ? undefined : -1}
                  aria-activedescendant={!withSearch && activeRow ? optionId(activeRow.key) : undefined}
                  onKeyDown={withSearch ? undefined : onKeyDown}
                >
                  {view.sections.map((section, at) => section.group ? (
                    <div key={`g${at}-${section.group}`} role="group" aria-labelledby={`${baseId}-group-${at}`} className="cselect-group">
                      <div id={`${baseId}-group-${at}`} className="cselect-group-label" aria-hidden="true">{section.group}</div>
                      {section.rows.map(renderRow)}
                    </div>
                  ) : section.rows.map(renderRow))}
                </div>
                {empty ? <div className="cselect-empty" role="status">No matches</div> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
