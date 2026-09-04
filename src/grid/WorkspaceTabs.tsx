import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, LayoutGrid, Plus } from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { useExclusiveMenu } from "../ui/menuBus";
import { ALL_WORKSPACE_ID, WORKSPACE_COLORS } from "../workspaces";
import { altBadge, digitFromCode } from "../shortcuts";
import { workspaceIcon, DEFAULT_WORKSPACE_ICON } from "../workspaceIcons";
import { IconPicker } from "../ui/IconPicker";
import { SESSION_DND, tileTitle } from "../sessionMeta";
import { WorkspaceSettings } from "../panels/WorkspaceSettings";

interface PendingMove {
  session: string;
  wsId: string;
}

export function WorkspaceTabs() {
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const assignSession = useStore((s) => s.assignSession);
  const sessionWs = useStore((s) => s.sessionWs);

  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsRect, setSettingsRect] = useState<DOMRect | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addRect, setAddRect] = useState<DOMRect | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [color, setColor] = useState(WORKSPACE_COLORS[0]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // With many workspaces the strip scrolls; keep the active tab in view when
  // it changes so switching never lands on a tab that is scrolled out of sight.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(".ws-tab-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspaceId]);

  // Position the strip from the real edges of the brand and the tool cluster.
  // It is centered on the bar whenever the tabs fit that way; when they only
  // fit off-center it slides toward the roomier side instead of clipping; and
  // only once the whole middle region is used up does it clip (the tabs then
  // scroll while the + stays pinned). No fixed guess at the side controls.
  useEffect(() => {
    const strip = ref.current;
    const scroll = scrollRef.current;
    const bar = strip?.parentElement;
    const brand = bar?.querySelector<HTMLElement>(".brand");
    const right = bar?.querySelector<HTMLElement>(".topbar-right");
    if (!strip || !scroll || !bar || !brand || !right) return;
    const GAP = 10;
    const measure = () => {
      const b = bar.getBoundingClientRect();
      const regionL = brand.getBoundingClientRect().right - b.left + GAP;
      const regionR = right.getBoundingClientRect().left - b.left - GAP;
      const region = Math.max(120, regionR - regionL);
      // Natural width of the whole tab group, even while it is being clipped.
      const addWrap = scroll.nextElementSibling as HTMLElement | null;
      const natural = scroll.scrollWidth + (addWrap?.offsetWidth ?? 0) + 2;
      const width = Math.min(natural, region);
      const centered = b.width / 2 - width / 2;
      const left = Math.min(Math.max(centered, regionL), regionR - width);
      strip.style.left = `${Math.round(left)}px`;
      strip.style.maxWidth = `${Math.floor(width)}px`;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(brand);
    ro.observe(right);
    ro.observe(scroll);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [workspaces]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const closeMenus = useCallback(() => {
    setSettingsFor(null);
    setAddOpen(false);
  }, []);
  useExclusiveMenu("ws-tabs", settingsFor !== null || addOpen, closeMenus);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest?.(".pzza-portal")) return;
      if (ref.current && !ref.current.contains(target as Node)) closeMenus();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [closeMenus]);

  // Alt/Option + number switches workspaces: 0 = All, 1..9 = the Nth workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !e.altKey) return;
      const n = digitFromCode(e.code);
      if (n === null) return;
      const target = n === 0 ? ALL_WORKSPACE_ID : workspaces[n - 1]?.id;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      setWorkspace(target);
      setSettingsFor(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [workspaces, setWorkspace]);

  const submitAdd = () => {
    if (!name.trim()) return;
    addWorkspace(name, icon, color);
    setName("");
    setIcon(DEFAULT_WORKSPACE_ICON);
    setColor(WORKSPACE_COLORS[0]);
    setAddOpen(false);
  };

  const onDropTab = (wsId: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const session = e.dataTransfer.getData(SESSION_DND);
    if (!session) return;
    const current = sessionWs[session] ?? workspaces[0]?.id;
    if (current === wsId) return;
    setPending({ session, wsId });
  };

  const confirmMove = () => {
    if (!pending) return;
    assignSession(pending.session, pending.wsId);
    setWorkspace(pending.wsId);
    setPending(null);
  };

  const targetWs = pending ? workspaces.find((w) => w.id === pending.wsId) : null;

  // Anchor a portaled dropdown just under the tab / button it belongs to,
  // clamped to the viewport (the tabs bar itself can scroll).
  const dropStyle = (rect: DOMRect | null, width = 288) =>
    rect
      ? {
          position: "fixed" as const,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          top: rect.bottom + 5,
          width,
          zIndex: 300,
        }
      : { display: "none" as const };

  return (
    <div className="ws-tabs" ref={ref}>
      {/* Only the tabs scroll; the + stays pinned after them so it is always
          reachable no matter how many workspaces there are. */}
      <div className="ws-tabs-scroll" ref={scrollRef}>
      <div
        className={`ws-tab ${workspaceId === ALL_WORKSPACE_ID ? "ws-tab-active" : ""}`}
        onClick={() => {
          setWorkspace(ALL_WORKSPACE_ID);
          setSettingsFor(null);
        }}
        title="All workspaces"
      >
        <LayoutGrid size={13} className="ws-tab-icon" />
        <span className="ws-tab-name">All</span>
        <kbd className="kbd ws-kbd">{altBadge(0)}</kbd>
      </div>

      {workspaces.map((w, i) => {
        const Icon = workspaceIcon(w.icon);
        const active = w.id === workspaceId;
        return (
          <div key={w.id} className="ws-tab-wrap">
            <div
              className={`ws-tab ${active ? "ws-tab-active" : ""} ${
                dragOver === w.id ? "ws-tab-drop" : ""
              }`}
              onClick={(e) => {
                if (active) {
                  const wasOpen = settingsFor === w.id;
                  setSettingsFor(wasOpen ? null : w.id);
                  if (!wasOpen) setSettingsRect(e.currentTarget.getBoundingClientRect());
                } else {
                  setWorkspace(w.id);
                  setSettingsFor(null);
                }
              }}
              title={w.name}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(SESSION_DND)) {
                  e.preventDefault();
                  setDragOver(w.id);
                }
              }}
              onDragLeave={() => setDragOver((d) => (d === w.id ? null : d))}
              onDrop={(e) => onDropTab(w.id, e)}
            >
              <Icon
                size={13}
                className="ws-tab-icon"
                style={w.color ? { color: w.color } : undefined}
              />
              <span className="ws-tab-name">{w.name}</span>
              {i < 9 ? <kbd className="kbd ws-kbd">{altBadge(i + 1)}</kbd> : null}
            </div>
          </div>
        );
      })}
      </div>

      <div className="ws-tab-wrap ws-tabs-add-wrap">
        <button
          className="ws-tab-add"
          onClick={(e) => {
            const wasOpen = addOpen;
            setAddOpen(!wasOpen);
            if (!wasOpen) setAddRect(e.currentTarget.getBoundingClientRect());
          }}
          title="New workspace"
        >
          <Plus size={15} strokeWidth={2.2} />
        </button>
      </div>

      {settingsFor
        ? createPortal(
            <div className="menu menu-panel pzza-portal" style={dropStyle(settingsRect)}>
              <WorkspaceSettings id={settingsFor} close={() => setSettingsFor(null)} />
            </div>,
            document.body,
          )
        : null}

      {addOpen
        ? createPortal(
            <div className="menu menu-panel pzza-portal" style={dropStyle(addRect)}>
              <div className="menu-body">
                <div className="menu-title">New workspace</div>
                <div className="ws-chip">
                  <button
                    className={`ws-chip-avatar ${pickerOpen ? "on" : ""}`}
                    style={{ color }}
                    onClick={() => setPickerOpen((v) => !v)}
                    title="Icon & color"
                  >
                    {(() => {
                      const IconComp = workspaceIcon(icon);
                      return <IconComp size={16} />;
                    })()}
                  </button>
                  <input
                    className="ws-chip-name"
                    autoFocus
                    placeholder="New workspace"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitAdd()}
                  />
                </div>

                {pickerOpen ? (
                  <div className="ws-picker">
                    <IconPicker value={icon} onSelect={setIcon} />
                    <div className="color-grid">
                      {WORKSPACE_COLORS.map((c) => (
                        <button
                          key={c}
                          className="color-choice"
                          style={{ background: c }}
                          onClick={() => setColor(c)}
                        >
                          {color === c ? <Check size={13} color="#fff" /> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <button className="btn btn-accent ws-add-btn" onClick={submitAdd} disabled={!name.trim()}>
                  <Plus size={14} strokeWidth={2.2} />
                  Add workspace
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      <Modal open={!!pending} onClose={() => setPending(null)} title="Move session" size="sm">
        {pending ? (
          <>
            <p className="move-q">
              Move <b>{tileTitle(pending.session)}</b> to <b>{targetWs?.name ?? "workspace"}</b>?
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="btn btn-accent" onClick={confirmMove}>
                Move
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
