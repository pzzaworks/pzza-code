import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Globe } from "lucide-react";
import { DICTATION_LANGUAGES, type DictationLanguage } from "../dictationLanguages";
import type { SupportedLanguage } from "../supportedLanguages";
import { LanguageFlag } from "./LanguageFlag";

const OPTIONS = [
  { code: "auto", label: "Auto-detect language", country: null },
  ...DICTATION_LANGUAGES,
] as const;
type Option = (typeof OPTIONS)[number];

function LanguageIcon({ country }: { country: Option["country"] }) {
  if (country === null) return <Globe size={18} aria-hidden="true" />;
  return <LanguageFlag country={country} />;
}

interface MenuProps {
  options: readonly Option[];
  label: string;
  buttonLabel: string;
  icon: Option["country"];
  selected: (code: DictationLanguage) => boolean;
  // Returns whether the menu stays open, so several languages can be picked.
  onPick: (code: DictationLanguage) => boolean;
  disabled: boolean;
}

// A searchable language list in a portal, anchored to its trigger button.
function LanguageMenu({ options, label, buttonLabel, icon, selected, onPick, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, height: 320 });
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  // Every language, the picked ones first (after Auto); the search narrows it.
  // The order is fixed when the menu opens, so picking one does not move rows.
  const [order, setOrder] = useState<string[]>([]);
  const rank = (code: string) => { const index = order.indexOf(code); return index < 0 ? order.length : index; };
  const listed = [...options].sort((a, b) => rank(a.code) - rank(b.code));
  const filtered = listed.filter((option) => `${option.label} ${option.code}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (code: DictationLanguage) => { if (!onPick(code)) close(); };

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 13;
      const above = rect.top - 13;
      const height = Math.max(80, Math.min(320, Math.max(below, above)));
      setPosition({ width, height, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: below >= height ? rect.bottom + 5 : Math.max(8, rect.top - height - 5) });
    };
    update();
    search.current?.focus();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return <>
    <button ref={button} type="button" className={`cselect ${open ? "cselect-open" : ""}`} disabled={disabled}
      aria-label={`${label}: ${buttonLabel}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => {
        setQuery(""); setActive(0);
        setOrder([...options.filter((option) => option.code === "auto"), ...options.filter((option) => option.code !== "auto" && selected(option.code)), ...options.filter((option) => option.code !== "auto" && !selected(option.code))].map((option) => option.code));
        setOpen(!open);
      }}>
      <LanguageIcon country={icon} />
      <span className="cselect-value">{buttonLabel}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div className="cselect-backdrop pzza-portal" onMouseDown={close}>
      <div className="cselect-menu dictation-language-menu" style={{ left: position.left, top: position.top, width: position.width, height: position.height, maxHeight: position.height, overflow: "hidden", display: "flex", flexDirection: "column", boxSizing: "border-box" }}
        onMouseDown={(event) => event.stopPropagation()}>
        <input ref={search} type="search" role="combobox" aria-label={`Search ${label.toLowerCase()}`} aria-autocomplete="list" aria-expanded="true" aria-controls={id}
          aria-activedescendant={filtered[active] ? `${id}-${filtered[active].code}` : undefined}
          placeholder="Search languages..." value={query}
          style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", marginBottom: 5, background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--hairline-strong)", borderRadius: "var(--r-sm)" }}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key === "Tab") { setOpen(false); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
            }
            if (event.key === "Enter" && filtered[active]) { event.preventDefault(); choose(filtered[active].code); }
          }} />
        <div ref={list} id={id} role="listbox" aria-label={label} aria-multiselectable={options[0]?.code !== "auto" || undefined} style={{ overflowY: "auto", minHeight: 0 }}>
          {filtered.map((option, index) => <button key={option.code} id={`${id}-${option.code}`} data-index={index} role="option" aria-selected={selected(option.code)}
            type="button" tabIndex={-1} className={`cselect-item ${index === active ? "cselect-item-on" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(option.code)}>
            <LanguageIcon country={option.country} /><span className="cselect-item-main">{option.label}</span>
            <span className="cselect-item-check">{selected(option.code) && <Check size={14} aria-hidden="true" />}</span>
          </button>)}
          {filtered.length === 0 && <div role="status" style={{ padding: 10, color: "var(--muted)" }}>No languages found</div>}
        </div>
      </div>
    </div>, document.body)}
  </>;
}

interface Props {
  value: DictationLanguage;
  onChange: (value: DictationLanguage) => void;
  disabled?: boolean;
}

export function DictationLanguageSelect({ value, onChange, disabled = false }: Props) {
  const selected = OPTIONS.find((option) => option.code === value) ?? OPTIONS[0];
  return <LanguageMenu options={OPTIONS} label="Dictation language" buttonLabel={selected.label} icon={selected.country} disabled={disabled}
    selected={(code) => code === value} onPick={(code) => { onChange(code); return false; }} />;
}

interface MultiProps {
  values: readonly SupportedLanguage[];
  onChange: (values: SupportedLanguage[]) => void;
  max: number;
  disabled?: boolean;
}

/** Picks several languages; the first picked is the main one. At least one stays selected. */
export function SpeechLanguagesSelect({ values, onChange, max, disabled = false }: MultiProps) {
  const main = DICTATION_LANGUAGES.find((option) => option.code === values[0]);
  const names = values.map((code) => DICTATION_LANGUAGES.find((option) => option.code === code)?.label ?? code);
  return <LanguageMenu options={DICTATION_LANGUAGES} label="My languages" buttonLabel={names.join(", ") || "Choose languages"} icon={main?.country ?? null} disabled={disabled}
    selected={(code) => values.some((value) => value === code)}
    onPick={(code) => {
      if (code === "auto") return true;
      if (values.includes(code)) { if (values.length > 1) onChange(values.filter((value) => value !== code)); }
      else if (values.length < max) onChange([...values, code]);
      return true;
    }} />;
}
