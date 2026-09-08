import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Globe } from "lucide-react";
import { DICTATION_LANGUAGES, type DictationLanguage } from "../dictationLanguages";
import AF from "country-flag-icons/react/3x2/AF";
import AL from "country-flag-icons/react/3x2/AL";
import AM from "country-flag-icons/react/3x2/AM";
import AZ from "country-flag-icons/react/3x2/AZ";
import BA from "country-flag-icons/react/3x2/BA";
import BD from "country-flag-icons/react/3x2/BD";
import BG from "country-flag-icons/react/3x2/BG";
import BY from "country-flag-icons/react/3x2/BY";
import CD from "country-flag-icons/react/3x2/CD";
import CN from "country-flag-icons/react/3x2/CN";
import CZ from "country-flag-icons/react/3x2/CZ";
import DE from "country-flag-icons/react/3x2/DE";
import DK from "country-flag-icons/react/3x2/DK";
import EE from "country-flag-icons/react/3x2/EE";
import ES from "country-flag-icons/react/3x2/ES";
import ET from "country-flag-icons/react/3x2/ET";
import FI from "country-flag-icons/react/3x2/FI";
import FO from "country-flag-icons/react/3x2/FO";
import FR from "country-flag-icons/react/3x2/FR";
import GB_WLS from "country-flag-icons/react/3x2/GB-WLS";
import GE from "country-flag-icons/react/3x2/GE";
import GR from "country-flag-icons/react/3x2/GR";
import HK from "country-flag-icons/react/3x2/HK";
import HR from "country-flag-icons/react/3x2/HR";
import HT from "country-flag-icons/react/3x2/HT";
import HU from "country-flag-icons/react/3x2/HU";
import ID from "country-flag-icons/react/3x2/ID";
import IL from "country-flag-icons/react/3x2/IL";
import IN from "country-flag-icons/react/3x2/IN";
import IR from "country-flag-icons/react/3x2/IR";
import IS from "country-flag-icons/react/3x2/IS";
import IT from "country-flag-icons/react/3x2/IT";
import JP from "country-flag-icons/react/3x2/JP";
import KH from "country-flag-icons/react/3x2/KH";
import KR from "country-flag-icons/react/3x2/KR";
import KZ from "country-flag-icons/react/3x2/KZ";
import LA from "country-flag-icons/react/3x2/LA";
import LK from "country-flag-icons/react/3x2/LK";
import LT from "country-flag-icons/react/3x2/LT";
import LU from "country-flag-icons/react/3x2/LU";
import LV from "country-flag-icons/react/3x2/LV";
import MG from "country-flag-icons/react/3x2/MG";
import MK from "country-flag-icons/react/3x2/MK";
import MM from "country-flag-icons/react/3x2/MM";
import MN from "country-flag-icons/react/3x2/MN";
import MT from "country-flag-icons/react/3x2/MT";
import MY from "country-flag-icons/react/3x2/MY";
import NG from "country-flag-icons/react/3x2/NG";
import NL from "country-flag-icons/react/3x2/NL";
import NO from "country-flag-icons/react/3x2/NO";
import NP from "country-flag-icons/react/3x2/NP";
import NZ from "country-flag-icons/react/3x2/NZ";
import PH from "country-flag-icons/react/3x2/PH";
import PK from "country-flag-icons/react/3x2/PK";
import PL from "country-flag-icons/react/3x2/PL";
import PT from "country-flag-icons/react/3x2/PT";
import RO from "country-flag-icons/react/3x2/RO";
import RS from "country-flag-icons/react/3x2/RS";
import RU from "country-flag-icons/react/3x2/RU";
import SA from "country-flag-icons/react/3x2/SA";
import SE from "country-flag-icons/react/3x2/SE";
import SI from "country-flag-icons/react/3x2/SI";
import SK from "country-flag-icons/react/3x2/SK";
import SO from "country-flag-icons/react/3x2/SO";
import TH from "country-flag-icons/react/3x2/TH";
import TJ from "country-flag-icons/react/3x2/TJ";
import TM from "country-flag-icons/react/3x2/TM";
import TR from "country-flag-icons/react/3x2/TR";
import TZ from "country-flag-icons/react/3x2/TZ";
import UA from "country-flag-icons/react/3x2/UA";
import US from "country-flag-icons/react/3x2/US";
import UZ from "country-flag-icons/react/3x2/UZ";
import VA from "country-flag-icons/react/3x2/VA";
import VN from "country-flag-icons/react/3x2/VN";
import ZA from "country-flag-icons/react/3x2/ZA";
import ZW from "country-flag-icons/react/3x2/ZW";

const FLAGS = {
  "AF": AF,
  "AL": AL,
  "AM": AM,
  "AZ": AZ,
  "BA": BA,
  "BD": BD,
  "BG": BG,
  "BY": BY,
  "CD": CD,
  "CN": CN,
  "CZ": CZ,
  "DE": DE,
  "DK": DK,
  "EE": EE,
  "ES": ES,
  "ET": ET,
  "FI": FI,
  "FO": FO,
  "FR": FR,
  "GB-WLS": GB_WLS,
  "GE": GE,
  "GR": GR,
  "HK": HK,
  "HR": HR,
  "HT": HT,
  "HU": HU,
  "ID": ID,
  "IL": IL,
  "IN": IN,
  "IR": IR,
  "IS": IS,
  "IT": IT,
  "JP": JP,
  "KH": KH,
  "KR": KR,
  "KZ": KZ,
  "LA": LA,
  "LK": LK,
  "LT": LT,
  "LU": LU,
  "LV": LV,
  "MG": MG,
  "MK": MK,
  "MM": MM,
  "MN": MN,
  "MT": MT,
  "MY": MY,
  "NG": NG,
  "NL": NL,
  "NO": NO,
  "NP": NP,
  "NZ": NZ,
  "PH": PH,
  "PK": PK,
  "PL": PL,
  "PT": PT,
  "RO": RO,
  "RS": RS,
  "RU": RU,
  "SA": SA,
  "SE": SE,
  "SI": SI,
  "SK": SK,
  "SO": SO,
  "TH": TH,
  "TJ": TJ,
  "TM": TM,
  "TR": TR,
  "TZ": TZ,
  "UA": UA,
  "US": US,
  "UZ": UZ,
  "VA": VA,
  "VN": VN,
  "ZA": ZA,
  "ZW": ZW,
};

interface Props {
  value: DictationLanguage;
  onChange: (value: DictationLanguage) => void;
  disabled?: boolean;
}

const OPTIONS = [
  { code: "auto", label: "Auto-detect language", country: null },
  ...DICTATION_LANGUAGES,
] as const;

function LanguageIcon({ country }: { country: (typeof OPTIONS)[number]["country"] }) {
  if (country === null) return <Globe size={18} aria-hidden="true" />;
  const Flag = FLAGS[country];
  return <Flag aria-hidden="true" style={{ width: 21, height: 14, borderRadius: 2, flexShrink: 0 }} />;
}

export function DictationLanguageSelect({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, height: 320 });
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = OPTIONS.find((option) => option.code === value) ?? OPTIONS[0];
  const filtered = OPTIONS.filter((option) => `${option.label} ${option.code}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (code: DictationLanguage) => { onChange(code); close(); };

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
      aria-label={`Dictation language: ${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(""); setActive(0); setOpen(!open); }}>
      <LanguageIcon country={selected.country} />
      <span className="cselect-value">{selected.label}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div className="cselect-backdrop pzza-portal" onMouseDown={close}>
      <div className="cselect-menu dictation-language-menu" style={{ left: position.left, top: position.top, width: position.width, height: position.height, maxHeight: position.height, overflow: "hidden", display: "flex", flexDirection: "column", boxSizing: "border-box" }}
        onMouseDown={(event) => event.stopPropagation()}>
        <input ref={search} type="search" role="combobox" aria-label="Search dictation languages" aria-autocomplete="list" aria-expanded="true" aria-controls={id}
          aria-activedescendant={filtered[active] ? `${id}-${filtered[active].code}` : undefined}
          placeholder="Search languages..." value={query}
          style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", marginBottom: 5, background: "var(--surface-alt)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7 }}
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
        <div ref={list} id={id} role="listbox" aria-label="Dictation languages" style={{ overflowY: "auto", minHeight: 0 }}>
          {filtered.map((option, index) => <button key={option.code} id={`${id}-${option.code}`} data-index={index} role="option" aria-selected={option.code === value}
            type="button" tabIndex={-1} className={`cselect-item ${index === active ? "cselect-item-on" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(option.code)}>
            <LanguageIcon country={option.country} /><span className="cselect-item-main">{option.label}</span>
            <span className="cselect-item-check">{option.code === value && <Check size={14} aria-hidden="true" />}</span>
          </button>)}
          {filtered.length === 0 && <div role="status" style={{ padding: 10, color: "var(--muted)" }}>No languages found</div>}
        </div>
      </div>
    </div>, document.body)}
  </>;
}
