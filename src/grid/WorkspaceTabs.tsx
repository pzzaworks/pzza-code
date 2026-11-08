import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, LayoutGrid, Plus } from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { useExclusiveMenu } from "../ui/menuBus";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, WORKSPACE_COLORS, wsKeyOf } from "../workspaces";
import { altBadge, digitFromCode, NEW_WORKSPACE_SHORTCUT } from "../shortcuts";
import { workspaceIcon, DEFAULT_WORKSPACE_ICON } from "../workspaceIcons";
import { IconPicker } from "../ui/IconPicker";
import { useSmoothHeight } from "../ui/useSmoothHeight";
import { SESSION_DND, SESSION_TILE_DND, sessionDisplayName } from "../sessionMeta";
import { WorkspaceSettings } from "../panels/WorkspaceSettings";
import { useNotifications } from "../state/notifications";
import { countLabel } from "../panels/Notifications";

const WORKSPACE_DND = "application/x-pzza-workspace";

interface PendingMove {
  session: string;
  tileId: string;
  wsId: string;
}

export function WorkspaceTabs({ openRequest = 0 }: { openRequest?: number }) {
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const assignSession = useStore((s) => s.assignSession);
  const sessionWs = useStore((s) => s.sessionWs);
  const tiles = useStore((s) => s.tiles);
  const tileTitles = useStore((s) => s.tileTitles);
  const notificationItems = useNotifications((s) => s.items);
  const unreadItems = useMemo(() => notificationItems.filter((item) => !item.read), [notificationItems]);

  // Sessions waiting on the user, per workspace: a tile waits while it owns an
  // unread terminal notification (the same rule that turns its status dot
  // green, "notify" in TileStatus). Several notices from one tile count once.
  // "All" counts every waiting tile since it shows every workspace at once.
  // Notices left behind by a closed tile no longer belong to a session.
  const waitingWorkspaces = useMemo(() => {
    const byTileId = new Map(tiles.map((tile) => [tile.id, sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID]));
    const tilesByWs = new Map<string, Set<string>>();
    const all = new Set<string>();
    for (const item of unreadItems) {
      const tileId = item.target?.tileId;
      const wsId = tileId ? byTileId.get(tileId) : undefined;
      if (!tileId || !wsId) continue;
      all.add(tileId);
      const waiting = tilesByWs.get(wsId) ?? new Set<string>();
      waiting.add(tileId);
      tilesByWs.set(wsId, waiting);
    }
    const counts = new Map<string, number>([[ALL_WORKSPACE_ID, all.size]]);
    for (const [wsId, waiting] of tilesByWs) counts.set(wsId, waiting.size);
    return counts;
  }, [tiles, sessionWs, unreadItems]);
  const waitingBadge = (wsId: string, name: string) => {
    const count = waitingWorkspaces.get(wsId) ?? 0;
    if (!count) return null;
    return (
      <span className="corner-badge ws-tab-count" role="status" aria-label={`${count} session${count === 1 ? "" : "s"} waiting in ${name}`}>
        {countLabel(count)}
      </span>
    );
  };

  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsRect, setSettingsRect] = useState<DOMRect | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addRect, setAddRect] = useState<DOMRect | null>(null);
  // Both panels resize smoothly when their content expands or collapses.
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const addBodyRef = useRef<HTMLDivElement>(null);
  useSmoothHeight(settingsPanelRef, settingsBodyRef, settingsFor !== null);
  useSmoothHeight(addPanelRef, addBodyRef, addOpen);
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
  }, [workspaceId, workspaces]);

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
      markEdges();
    };
    // A clipped strip fades out on each side that has tabs scrolled out of view.
    const markEdges = () => {
      scroll.toggleAttribute("data-more-start", scroll.scrollLeft > 1);
      scroll.toggleAttribute("data-more-end", scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1);
    };
    measure();
    scroll.addEventListener("scroll", markEdges, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(brand);
    ro.observe(right);
    ro.observe(scroll);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      scroll.removeEventListener("scroll", markEdges);
      window.removeEventListener("resize", measure);
    };
  }, [workspaces]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [workspaceDrop, setWorkspaceDrop] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const draggedWorkspace = useRef<string | null>(null);
  const dragEndedAt = useRef(-Infinity);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!openRequest || !addButtonRef.current) return;
    setSettingsFor(null);
    setAddRect(addButtonRef.current.getBoundingClientRect());
    setAddOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!addOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".modal-backdrop:not([hidden])")) return;
      event.preventDefault();
      setAddOpen(false);
      setPickerOpen(false);
      addButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen]);

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
    setWorkspaceDrop(null);
    const workspace = e.dataTransfer.getData(WORKSPACE_DND);
    if (workspace) {
      if (workspace === draggedWorkspace.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        reorderWorkspace(workspace, wsId, e.clientX < rect.left + rect.width / 2 ? "before" : "after");
      }
      return;
    }
    const session = e.dataTransfer.getData(SESSION_DND);
    if (!session) return;
    const current = sessionWs[session] ?? DEFAULT_WORKSPACE_ID;
    if (current === wsId) return;
    setPending({ session, tileId: e.dataTransfer.getData(SESSION_TILE_DND) || session, wsId });
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
          width: Math.min(width, window.innerWidth - 16),
          maxHeight: Math.max(80, window.innerHeight - rect.bottom - 16),
          zIndex: 300,
        }
      : { display: "none" as const };

  return (
    <div className="ws-tabs" ref={ref} data-tour="workspaces">
      {/* Only the tabs scroll; the + stays pinned after them so it is always
          reachable no matter how many workspaces there are. */}
      <div
        className="ws-tabs-scroll"
        ref={scrollRef}
        // A mouse wheel scrolls the clipped strip sideways; trackpads already do.
        onWheel={(event) => {
          const scroll = event.currentTarget;
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft += event.deltaY;
        }}
      >
      <div
        className={`ws-tab ${workspaceId === ALL_WORKSPACE_ID ? "ws-tab-active" : ""}`}
        draggable={false}
        onClick={() => {
          setWorkspace(ALL_WORKSPACE_ID);
          setSettingsFor(null);
        }}
        title="All workspaces"
      >
        <span className="ws-tab-icon-anchor">
          <LayoutGrid size={13} className="ws-tab-icon" />
          {waitingBadge(ALL_WORKSPACE_ID, "all workspaces")}
        </span>
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
              } ${workspaceDrop?.id === w.id ? `ws-tab-reorder-${workspaceDrop.placement}` : ""}`}
              draggable
              onDragStart={(e) => {
                draggedWorkspace.current = w.id;
                e.dataTransfer.setData(WORKSPACE_DND, w.id);
                e.dataTransfer.effectAllowed = "move";
                closeMenus();
              }}
              onDragEnd={() => {
                draggedWorkspace.current = null;
                dragEndedAt.current = performance.now();
                setWorkspaceDrop(null);
                setDragOver(null);
              }}
              onClick={(e) => {
                if (performance.now() - dragEndedAt.current < 200) return;
                if (active) {
                  const wasOpen = settingsFor === w.id;
                  setSettingsFor(wasOpen ? null : w.id);
                  if (!wasOpen) setSettingsRect(e.currentTarget.getBoundingClientRect());
                } else {
                  setWorkspace(w.id);
                  setSettingsFor(null);
                }
              }}
              onContextMenu={(e) => {
                // Right-click opens this workspace's settings directly instead
                // of the generic text menu.
                e.preventDefault();
                e.stopPropagation();
                setAddOpen(false);
                setSettingsFor(w.id);
                setSettingsRect(e.currentTarget.getBoundingClientRect());
              }}
              title={w.name}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(WORKSPACE_DND) && draggedWorkspace.current) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = e.currentTarget.getBoundingClientRect();
                  setWorkspaceDrop({ id: w.id, placement: e.clientX < rect.left + rect.width / 2 ? "before" : "after" });
                } else if (e.dataTransfer.types.includes(SESSION_DND)) {
                  e.preventDefault();
                  // Must match the source's effectAllowed ("move") or WebKit
                  // refuses the drop.
                  e.dataTransfer.dropEffect = "move";
                  setDragOver(w.id);
                }
              }}
              onDragLeave={(e) => {
                if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
                setDragOver((d) => (d === w.id ? null : d));
                setWorkspaceDrop((target) => target?.id === w.id ? null : target);
              }}
              onDrop={(e) => onDropTab(w.id, e)}
            >
              <span className="ws-tab-icon-anchor">
                <Icon
                  size={13}
                  className="ws-tab-icon"
                  style={w.color ? { color: w.color } : undefined}
                />
                {waitingBadge(w.id, w.name)}
              </span>
              <span className="ws-tab-name">{w.name}</span>
              {i < 9 ? <kbd className="kbd ws-kbd">{altBadge(i + 1)}</kbd> : null}
            </div>
          </div>
        );
      })}
      </div>

      <div className="ws-tab-wrap ws-tabs-add-wrap">
        <button
          ref={addButtonRef}
          className="ws-tab-add"
          onClick={(e) => {
            const wasOpen = addOpen;
            setAddOpen(!wasOpen);
            if (!wasOpen) setAddRect(e.currentTarget.getBoundingClientRect());
          }}
          title={`New workspace (${NEW_WORKSPACE_SHORTCUT.label})`}
          aria-label="New workspace"
          aria-keyshortcuts={NEW_WORKSPACE_SHORTCUT.keys}
        >
          <Plus size={15} strokeWidth={2.2} />
        </button>
      </div>

      {settingsFor
        ? createPortal(
            <div ref={settingsPanelRef} className="menu menu-panel pzza-portal" style={dropStyle(settingsRect)}>
              <div ref={settingsBodyRef}><WorkspaceSettings id={settingsFor} close={() => setSettingsFor(null)} /></div>
            </div>,
            document.body,
          )
        : null}

      {addOpen
        ? createPortal(
            <div ref={addPanelRef} className="menu menu-panel pzza-portal creation-panel new-workspace-panel" style={dropStyle(addRect, 420)}>
              <div ref={addBodyRef} className="menu-body">
                <div className="menu-title">New workspace <kbd className="kbd" aria-hidden="true">{NEW_WORKSPACE_SHORTCUT.label}</kbd></div>
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
              Move <b>{sessionDisplayName(tiles.find((t) => t.id === pending.tileId) ?? { id: pending.session, name: pending.session }, tileTitles)}</b> to{" "}
              <b>{targetWs?.name ?? "workspace"}</b>?
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
