import {
  siClaudecode,
  siCline,
  siCodebuddy,
  siCursor,
  siGithubcopilot,
  siGooglegemini,
  siGooglejules,
  siKimi,
  siOpencode,
  siPi,
  siQodo,
  siQwen,
  siTrae,
  siWarp,
  type SimpleIcon,
} from "simple-icons";
import { AGENT_MARKS, type AgentMark, type AgentMarkPath } from "./agentMarks";
import { CODEX_PATH } from "./BrandIcons";

// Agent marks. Every agent with an official vector logo shows it, in one color
// (currentColor): simple-icons (CC0 path data, unmodified) where it carries
// the mark, otherwise the vendor's own vector from ./agentMarks. The marks
// remain trademarks of their owners and only identify the tool. An agent
// without an official vector mark gets a neutral monogram, never an imitation
// of a logo.

export type AgentLogo =
  | {
      kind: "brand";
      id: string;
      title: string;
      // Where the vector was taken from.
      source: string;
      viewBox: string;
      fillRule?: "evenodd";
      paths: readonly AgentMarkPath[];
      // The maker's mark stands in for a product with none of its own.
      parentMark: boolean;
    }
  | {
      kind: "monogram";
      id: string;
      // One or two letters; one is drawn at small sizes.
      monogram: string;
    };

function simpleIconMark(icon: SimpleIcon, parentMark?: true): AgentMark {
  return { title: icon.title, source: `simple-icons:${icon.slug}`, viewBox: "0 0 24 24", paths: [{ d: icon.path }], ...(parentMark ? { parentMark } : {}) };
}

const BRAND_MARKS: Readonly<Record<string, AgentMark>> = {
  claude: simpleIconMark(siClaudecode),
  // simple-icons no longer carries the OpenAI mark, so the path the app has
  // always shown lives with the other app marks.
  codex: { title: "OpenAI Codex", source: "simple-icons:openai (since removed upstream)", viewBox: "0 0 24 24", paths: [{ d: CODEX_PATH }] },
  opencode: simpleIconMark(siOpencode),
  gemini: simpleIconMark(siGooglegemini),
  copilot: simpleIconMark(siGithubcopilot),
  cursor: simpleIconMark(siCursor),
  qwen: simpleIconMark(siQwen),
  cline: simpleIconMark(siCline),
  pi: simpleIconMark(siPi),
  warp: simpleIconMark(siWarp),
  kimi: simpleIconMark(siKimi),
  codebuddy: simpleIconMark(siCodebuddy),
  jules: simpleIconMark(siGooglejules),
  qodo: simpleIconMark(siQodo, true),
  "trae-agent": simpleIconMark(siTrae, true),
  ...AGENT_MARKS,
};

// Agents with no official vector mark. Hand-picked letters where the id alone
// reads poorly.
const MONOGRAMS: Record<string, string> = {
  // aider.chat ships only a raster favicon and a text wordmark set in an
  // embedded font.
  aider: "Ai",
  "grok-community": "Gc",
  continue: "Co",
  plandex: "Pl",
  openhands: "OH",
  iflow: "iF",
  codebuff: "Cf",
  mux: "Mx",
  "hermes-agent": "He",
};

/** Agent ids that have a logo decision here (brand mark or chosen monogram). */
export const AGENT_LOGO_IDS: readonly string[] = [...Object.keys(BRAND_MARKS), ...Object.keys(MONOGRAMS)];

// "foo-bar" -> "FB", "foo" -> "Fo"; anything unusable falls back to "?".
function deriveMonogram(id: string): string {
  const parts = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase() + (parts[0][1] ?? "").toLowerCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function agentLogo(id: string): AgentLogo {
  const brand = Object.hasOwn(BRAND_MARKS, id) ? BRAND_MARKS[id] : undefined;
  if (brand) return { ...brand, kind: "brand", id, parentMark: brand.parentMark ?? false };
  return { kind: "monogram", id, monogram: Object.hasOwn(MONOGRAMS, id) ? MONOGRAMS[id] : deriveMonogram(id) };
}

interface Props {
  id: string;
  size?: number | string;
  className?: string;
  // An accessible name; without one the icon is decorative (next to a label).
  title?: string;
}

export function AgentIcon({ id, size = 14, className, title }: Props) {
  const logo = agentLogo(id);
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  if (logo.kind === "brand") {
    return (
      <svg width={size} height={size} viewBox={logo.viewBox} fill="currentColor" fillRule={logo.fillRule} className={className} data-agent-logo="brand" {...a11y}>
        {logo.paths.map(path => (path.strokeWidth ? <path key={path.d} d={path.d} stroke="currentColor" strokeWidth={path.strokeWidth} /> : <path key={path.d} d={path.d} />))}
      </svg>
    );
  }
  // Two letters only where they stay legible.
  const small = typeof size === "number" ? size < 20 : !/^(2\d|[3-9]\d|\d{3,})(px)?$/.test(size);
  const letters = small ? logo.monogram.slice(0, 1).toUpperCase() : logo.monogram;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} data-agent-logo="monogram" {...a11y}>
      <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <text
        x="12"
        y="12.5"
        fill="currentColor"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={letters.length > 1 ? 10.5 : 13}
        fontWeight={650}
        letterSpacing={letters.length > 1 ? -0.4 : 0}
        style={{ fontFamily: "inherit" }}
      >
        {letters}
      </text>
    </svg>
  );
}
