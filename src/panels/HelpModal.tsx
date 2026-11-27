import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Info, Lightbulb, Sparkles, TriangleAlert } from "lucide-react";
import { openUrl } from "../forward";
import { HAS_TAURI } from "../tauriEnv";
import { DOCS_CONTENT } from "../help/generated/content";
import { DOCS_SITE } from "../help/generated/docs";
import type { MdxComponents } from "../help/generated/mdx";
import { AgentMarkSprite, DOCS_SCENES } from "../help/generated/scenes";
import { HELP_ORDER, HELP_SECTIONS, helpLabel, helpPage, helpSlug, sectionOf, topicOfSlug, type HelpRequest, type HelpTopic } from "./helpTopics";

// Help is the website's docs, page for page: each topic renders its docs page
// (src/help/generated, written from the website by `npm run sync:help`) with
// the docs' own product scenes. This file only supplies what the docs' MDX
// leaves to its host: the app's markup for keys, callouts and the shortcut
// table, links that stay inside Help, and the page around the content.

/* ---------------------------------------------------------------- links -- */

/** Opens a page of the website in the browser, as the rest of the app opens links. */
function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!HAS_TAURI) return; // a browser opens target="_blank" itself
  event.preventDefault();
  void openUrl(url).catch(() => { /* Rejected or unsupported addresses are simply not opened. */ });
}

/** A docs link: another docs page opens here in Help, anything else in the browser. */
function DocLink({ href = "", children, onNavigate }: { href?: string; children?: ReactNode; onNavigate: (topic: HelpTopic) => void }) {
  const docs = /^\/docs(?:\/([\w-]+))?\/?(?:#.*)?$/.exec(href);
  const topic = docs ? topicOfSlug(docs[1] ?? "index") : undefined;
  const url = href.startsWith("/") ? `${DOCS_SITE}${href}` : href;
  if (topic) {
    return <a href={url} onClick={(event) => { event.preventDefault(); onNavigate(topic); }}>{children}</a>;
  }
  return <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => openExternal(event, url)}>{children}</a>;
}

/* ---------------------------------------------------- docs components -- */

const Kbd = ({ children }: { children?: ReactNode }) => <kbd className="kbd">{children}</kbd>;

const CALLOUT_ICONS = { warn: TriangleAlert, error: TriangleAlert, info: Info, tip: Lightbulb, success: Lightbulb } as const;
/** The docs' `<Callout>` as the app's note. */
function Callout({ type = "info", children }: { type?: string; children?: ReactNode }) {
  const Icon = type in CALLOUT_ICONS ? CALLOUT_ICONS[type as keyof typeof CALLOUT_ICONS] : Info;
  return <div className={`doc-note help-callout ${type === "tip" || type === "success" ? "doc-note-tip" : ""}`} role="note">
    <Icon size={14} aria-hidden="true" />
    <div className="help-callout-body">{children}</div>
  </div>;
}

/** The docs' two-column key table; its rows are written in the page. */
const ShortcutTable = ({ children }: { children?: ReactNode }) => <table className="doc-keys"><tbody>{children}</tbody></table>;

/**
 * A product scene in the page. The figure is the boundary the app's
 * stylesheet keeps the Settings dialog's own rules out of (see
 * `.help-figure` there), and it gives the scene the theme's muted text
 * colour, which the dialog tints for its own pages.
 */
function figure(Scene: ComponentType): ComponentType {
  const Figure = () => <div className="help-figure"><Scene /></div>;
  Figure.displayName = `HelpFigure(${Scene.displayName ?? Scene.name})`;
  return Figure;
}
const FIGURES: Record<string, ComponentType> = Object.fromEntries(Object.entries(DOCS_SCENES).map(([tag, Scene]) => [tag, figure(Scene)]));

function docsComponents(onNavigate: (topic: HelpTopic) => void): MdxComponents {
  return {
    ...FIGURES,
    Kbd,
    Callout,
    ShortcutTable,
    a: ({ href, children }: { href?: string; children?: ReactNode }) => <DocLink href={href} onNavigate={onNavigate}>{children}</DocLink>,
    // The article's title is its h3, so the page's own headings sit under it.
    h2: ({ children }: { children?: ReactNode }) => <h4 className="help-h">{children}</h4>,
    h3: ({ children }: { children?: ReactNode }) => <h5 className="help-h">{children}</h5>,
    p: ({ children }: { children?: ReactNode }) => <p className="doc-p">{children}</p>,
    code: ({ children }: { children?: ReactNode }) => <code className="doc-code">{children}</code>,
    table: ({ children }: { children?: ReactNode }) => <table className="doc-keys help-table">{children}</table>,
  };
}

const rootProperty = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** A custom property of the document root, kept current as the theme changes it there. */
function useRootProperty(name: string): string {
  const [value, setValue] = useState(() => rootProperty(name));
  useEffect(() => {
    const update = () => setValue(rootProperty(name));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    update();
    return () => observer.disconnect();
  }, [name]);
  return value;
}

/* ----------------------------------------------------------------- page -- */

// The Help part of the Settings sidebar: sections that unfold into their pages.
// The section of the open page is unfolded; a click on another section opens
// its first page, and a click on the open section folds it.
export function HelpNav({ value, onChange }: { value: HelpTopic; onChange: (topic: HelpTopic) => void }) {
  const current = sectionOf(value);
  // A fold lasts until another page opens; it is reset while rendering so the
  // newly opened section never shows folded for a frame.
  const [folded, setFolded] = useState(false);
  const [foldedOn, setFoldedOn] = useState(value);
  if (foldedOn !== value) {
    setFoldedOn(value);
    setFolded(false);
  }
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [value]);
  return <div className="settings-nav-children help-nav" role="group" aria-label="Help topics">
    {HELP_SECTIONS.map((section) => {
      const here = section.id === current.id;
      const open = here && !folded;
      return <div className="help-nav-section" key={section.id}>
        <button type="button" className={`settings-hub-sublink help-nav-head ${here ? "is-current" : ""}`} aria-expanded={open}
          onClick={() => { if (here) setFolded(open); else onChange(section.topics[0]); }}>
          <ChevronRight size={12} className="help-nav-chevron" aria-hidden="true" />
          <span className="settings-hub-sublabel">{section.label}</span>
        </button>
        {open ? <div className="help-nav-pages" role="group" aria-label={`${section.label} pages`}>
          {section.topics.map((topic) => {
            const label = helpLabel(topic);
            const active = topic === value;
            return <button type="button" key={topic} ref={active ? activeRef : undefined} title={label}
              aria-current={active ? "page" : undefined} className={`settings-hub-sublink help-nav-page ${active ? "active" : ""}`} onClick={() => onChange(topic)}>
              <span className="settings-hub-sublabel">{label}</span>
            </button>;
          })}
        </div> : null}
      </div>;
    })}
  </div>;
}

// One Help page with previous / next links that run through every section.
export function HelpContent({ topic, request, onNavigate }: { topic: HelpTopic; request?: HelpRequest; onNavigate: (topic: HelpTopic) => void }) {
  const head = useRef<HTMLDivElement>(null);
  // Focus follows a page opened from elsewhere (menu, palette, an agent) or
  // through previous / next and the page's links, so keyboard and screen
  // reader users land on it.
  const handled = useRef<number | undefined>(undefined);
  const paged = useRef(false);
  useEffect(() => {
    if (request && request.topic === topic && handled.current !== request.serial) {
      handled.current = request.serial;
      head.current?.focus({ preventScroll: true });
    } else if (paged.current) head.current?.focus({ preventScroll: true });
    paged.current = false;
  }, [request, topic]);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const components = useMemo(() => docsComponents((target) => { paged.current = true; navigate.current(target); }), []);
  const muted = useRootProperty("--muted");
  const page = helpPage(topic);
  const Content = DOCS_CONTENT[helpSlug(topic)];
  const section = sectionOf(topic);
  const index = HELP_ORDER.indexOf(topic);
  const prev = HELP_ORDER[index - 1];
  const next = HELP_ORDER[index + 1];
  const position = section.topics.findIndex((id) => id === topic);
  const go = (target: HelpTopic) => { paged.current = true; onNavigate(target); };
  return <article className="help-article" key={topic} data-help-topic={topic}>
    <span className="help-crumb">{section.label} · {position + 1} of {section.topics.length}</span>
    <div className="help-article-head" tabIndex={-1} ref={head}>
      <div>
        <h3>{page.title}</h3>
        {page.description ? <p className="help-benefit">{page.description}</p> : null}
      </div>
    </div>
    {topic === "start" ? <div className="help-tour-banner">
      <Sparkles size={15} />
      <div><strong>New here?</strong><span>Take the tour of every control, or run setup again.</span></div>
      <span className="help-tour-actions">
        <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-setup"))}>Run setup</button>
        <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-tour"))}>Start tour</button>
      </span>
    </div> : null}
    <div className="help-prose" style={{ "--help-root-muted": muted } as CSSProperties}>
      <Content components={components} />
    </div>
    {/* The agents' marks the scenes point at, as the docs render it once per page. */}
    <AgentMarkSprite />
    <nav className="help-pager" aria-label="Previous and next help pages">
      {prev ? <button type="button" className="help-pager-link" aria-label={`Previous: ${helpLabel(prev)}`} onClick={() => go(prev)}>
        <span className="help-pager-dir"><ChevronLeft size={13} aria-hidden="true" />Previous</span>
        <span className="help-pager-title">{helpLabel(prev)}</span>
      </button> : <span />}
      {next ? <button type="button" className="help-pager-link is-next" aria-label={`Next: ${helpLabel(next)}`} onClick={() => go(next)}>
        <span className="help-pager-dir">Next<ChevronRight size={13} aria-hidden="true" /></span>
        <span className="help-pager-title">{helpLabel(next)}</span>
      </button> : null}
    </nav>
  </article>;
}
