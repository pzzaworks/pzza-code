import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  Columns2,
  Copy,
  EyeOff,
  FileCode,
  FolderInput,
  Focus,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Rows2,
  Square,
  StretchHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";
import { useStore } from "../state/store";
import { deviceNameFor } from "../devices";
import { Modal } from "../ui/Modal";
import { Terminal } from "../terminal/Terminal";
import { TileCodePanel } from "./TileCodePanel";
import { duplicateSession, fetchSessionPath, killSession } from "../serverApi";
import { confirmEditorDiscard } from "../editorChanges";
import { attachCommand, sessionConnection } from "../connection";
import {
  sessionDisplayName,
  shortPath,
  SESSION_DND,
  SESSION_TILE_DND,
  type TileStatus,
} from "../sessionMeta";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { ctrlBadge, digitFromCode } from "../shortcuts";
import { useDictation } from "../state/dictation";
import { DictationButton } from "../ui/Dictation";

// Uniform N-column grid, filtered to the active workspace. One tile can be
// maximized (animated). Tiles reorder by dragging their header onto another
// tile, or move to a workspace by dragging onto a top-bar tab.
export function Canvas({ onNewSession }: { onNewSession: () => void }) {
  const tiles = useStore((s) => s.tiles);
  const allSessions = useStore((s) => s.allSessions);
  const workspaceColumns = useStore((s) => s.workspaceColumns);
  const defaultColumns = useStore((s) => s.defaultColumns);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const closeTile = useStore((s) => s.closeTile);
  const reorderTile = useStore((s) => s.reorderTile);
  const moveTileToEnd = useStore((s) => s.moveTileToEnd);
  const connection = useStore((s) => s.connection);
  const sessionWs = useStore((s) => s.sessionWs);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const hiddenTiles = useStore((s) => s.hiddenTiles);
  const hideTile = useStore((s) => s.hideTile);
  const tileSpan = useStore((s) => s.tileSpan);
  const setTileSpan = useStore((s) => s.setTileSpan);
  const tileTitles = useStore((s) => s.tileTitles);
  const renameTile = useStore((s) => s.renameTile);
  const devices = useStore((s) => s.devices);
  const tileCode = useStore((s) => s.tileCode);
  const toggleTileCode = useStore((s) => s.toggleTileCode);
  const recordingTileId = useDictation((state) => state.recording?.tileId);
  useEffect(() => {
    if (!recordingTileId) return;
    const source = tiles.find((entry) => entry.id === recordingTileId);
    if (!source || activeId !== recordingTileId || hiddenTiles.includes(recordingTileId) ||
        (activeWorkspaceId !== ALL_WORKSPACE_ID && (sessionWs[wsKeyOf(source)] ?? DEFAULT_WORKSPACE_ID) !== activeWorkspaceId)) {
      void useDictation.getState().cancel();
    }
  }, [recordingTileId, activeId, hiddenTiles, activeWorkspaceId, sessionWs, tiles]);

  // Columns are per-workspace; the active workspace decides the grid.
  const columns = workspaceColumns[activeWorkspaceId] ?? defaultColumns;

  // A tile's badge names the device it actually runs on.
  const tileDevice = (host?: string): string => deviceNameFor(devices, host);

  const [closing, setClosing] = useState<string | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const showDuplicateSpinner = useDelayedLoading(duplicating !== null);
  const duplicationPending = useRef(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [layoutFor, setLayoutFor] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  // "Move to workspace" popup, opened from a tile's toolbar button.
  const assignSession = useStore((s) => s.assignSession);
  const [moveFor, setMoveFor] = useState<{ id: string; x: number; y: number } | null>(null);

  const [statuses, setStatuses] = useState<Record<string, TileStatus>>({});
  const setStatus = useCallback(
    (id: string, s: TileStatus) =>
      setStatuses((prev) => (prev[id] === s ? prev : { ...prev, [id]: s })),
    [],
  );

  const [fullId, setFullId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    // Programmatic tile focus must reveal the target even if another tile was
    // maximized or isolated locally in the canvas.
    if (activeId && fullId && activeId !== fullId) setFullId(null);
    if (activeId && focusId && activeId !== focusId) setFocusId(null);
  }, [activeId, fullId, focusId]);
  const [renaming, setRenaming] = useState<{ id: string; val: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const wsTiles = tiles.filter(
    (t) =>
      (activeWorkspaceId === ALL_WORKSPACE_ID ||
        (sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID) === activeWorkspaceId) &&
      !hiddenTiles.includes(t.id),
  );

  const pointerIntent = useRef<{ id: string; pointer: number; x: number; y: number; started: number; cancelled: boolean } | null>(null);
  const scrollToTile = useCallback((id: string) => {
    if (fullId) return;
    const element = document.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) return;
    const rect = element.getBoundingClientRect();
    if (rect.top < 84 || rect.bottom > window.innerHeight - 8) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, [fullId]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const intent = pointerIntent.current;
      if (intent && event.pointerId === intent.pointer && Math.hypot(event.clientX - intent.x, event.clientY - intent.y) > 6) intent.cancelled = true;
    };
    const cancel = () => { if (pointerIntent.current) pointerIntent.current.cancelled = true; };
    const release = (event: PointerEvent) => {
      const intent = pointerIntent.current;
      if (!intent || event.pointerId !== intent.pointer) return;
      pointerIntent.current = null;
      const target = event.target instanceof Element ? event.target.closest("[data-tile-id]") : null;
      if (!intent.cancelled && performance.now() - intent.started < 250 &&
          target?.getAttribute("data-tile-id") === intent.id && useStore.getState().activeId === intent.id) {
        scrollToTile(intent.id);
      }
    };
    const abandon = () => { pointerIntent.current = null; };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", abandon, true);
    window.addEventListener("dragstart", cancel, true);
    window.addEventListener("wheel", cancel, true);
    window.addEventListener("blur", abandon);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", abandon, true);
      window.removeEventListener("dragstart", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("blur", abandon);
    };
  }, [scrollToTile]);

  // Ctrl + number activates the Nth visible tile. Read the current order from a
  // ref so the handler stays valid as tiles come and go.
  const wsTilesRef = useRef(wsTiles);
  useEffect(() => {
    wsTilesRef.current = wsTiles;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || e.shiftKey || !e.ctrlKey) return;
      const n = digitFromCode(e.code);
      if (n === null || n < 1) return;
      const t = wsTilesRef.current[n - 1];
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      pointerIntent.current = null;
      setActive(t.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setActive]);

  // Keyboard/programmatic selection still scrolls immediately. Pointer
  // selection waits for release so holding or dragging never moves the canvas.
  useEffect(() => {
    if (activeId && !pointerIntent.current) scrollToTile(activeId);
  }, [activeId, scrollToTile]);

  // Every tile stays mounted for the life of the session - switching workspaces,
  // hiding, or maximizing only toggles CSS visibility. Re-mounting would
  // re-attach the terminal to tmux, renegotiate its size, and paint garbage
  // until a reload; keeping it alive avoids that entirely.
  const noneVisible = wsTiles.length === 0;

  // A maximized tile only maximizes within its own workspace. Switching to a
  // different workspace must show that workspace normally, not a blank grid
  // (the maximized tile lives elsewhere and the maximize gate would otherwise
  // hide every tile here); returning to its workspace restores the maximize.
  const fullTile = fullId ? tiles.find((t) => t.id === fullId) : undefined;
  const fullInActiveWs =
    !!fullTile &&
    (activeWorkspaceId === ALL_WORKSPACE_ID ||
      (sessionWs[wsKeyOf(fullTile)] ?? DEFAULT_WORKSPACE_ID) === activeWorkspaceId);
  const effFull = fullInActiveWs ? fullId : null;

  const duplicate = async (source: (typeof tiles)[number]) => {
    if (duplicationPending.current) return;
    duplicationPending.current = true;
    setDuplicating(source.id);
    setDuplicateError(null);
    const host = source.host ?? connection.host ?? undefined;
    const workspace = sessionWs[wsKeyOf(source)] ?? DEFAULT_WORKSPACE_ID;
    const label = `${sessionDisplayName(source, tileTitles)} copy`;
    try {
      const copy = await duplicateSession(source.session ?? source.name, source.window, host);
      const store = useStore.getState();
      const id = host ? `${host}::${copy.name}` : copy.name;
      store.assignSession(id, store.workspaces.some((entry) => entry.id === workspace) ? workspace : DEFAULT_WORKSPACE_ID);
      store.renameTile(id, label);
      store.openSession(copy.name, copy.cwd, host);
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "Could not duplicate the session");
    } finally {
      duplicationPending.current = false;
      setDuplicating(null);
    }
  };

  const tile = (t: (typeof tiles)[number]) => {
    const base = t.session ?? t.name;
    const { cmd, args } = attachCommand(sessionConnection(t.host, connection), base, t.cwd, t.window);
    const rs = allSessions.find((s) => s.name === base);
    const fullPath = t.path ?? rs?.path;
    const path = shortPath(fullPath);
    const codeOpen = tileCode[t.id]?.open ?? false;
    const wsColor = workspaces.find(
      (w) => w.id === (sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID),
    )?.color;
    const status = statuses[t.id] ?? "idle";
    const displayName = sessionDisplayName(t, tileTitles);
    const isRenaming = renaming?.id === t.id;
    const shortcutIdx = wsTiles.findIndex((x) => x.id === t.id);
    const isFull = fullId === t.id;
    const isFocus = focusId === t.id;
    // The focused/maximized tile stays visible while focus dims the others.
    const dimmed = !isFull && !isFocus && !!focusId;
    // Keep workspace hues intact; focus softens their opacity through CSS.
    const borderBg = wsColor
      ? `linear-gradient(140deg, ${wsColor} 0%, var(--border) 22%)`
      : undefined;
    const span = tileSpan[t.id] ?? { c: 1, r: 1 };
    const spanStyle = effFull
      ? undefined
      : {
          gridColumn: `span ${Math.min(span.c, columns)}`,
          gridRow: `span ${span.r}`,
        };
    const isActive = activeId === t.id;
    // Visible only when in the active workspace, not hidden, and (if a tile is
    // maximized) the maximized one. Everything else is display:none but stays
    // mounted.
    const tileWs = sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID;
    const inWorkspace =
      activeWorkspaceId === ALL_WORKSPACE_ID || tileWs === activeWorkspaceId;
    const visible = inWorkspace && !hiddenTiles.includes(t.id) && (!effFull || isFull);
    const cls = [
      "tile",
      visible ? "" : "tile-off",
      isActive ? "tile-active" : "",
      overId === t.id && dragId !== t.id ? "tile-over" : "",
      dragId === t.id ? "tile-dragging" : "",
      dimmed ? "tile-dimmed" : "",
      isFocus ? "tile-focused" : "",
      // The tile you haven't clicked gets a very light grey wash so the active
      // one stands out. Skipped while dimmed/focused/maximized (those own the
      // overlay) so the effects don't stack.
      !isActive && !isFocus && !dimmed && !isFull ? "tile-inactive" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <motion.div
        key={t.id}
        data-tile-id={t.id}
        className={cls}
        style={{
          ...(spanStyle ?? {}),
          ...(borderBg
            ? { border: "1px solid transparent" }
            : {}),
        }}
        layout={visible && !effFull ? "position" : false}
        initial={isFull ? { opacity: 0, scale: 0.97 } : false}
        animate={isFull ? { opacity: 1, scale: 1 } : {}}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        onPointerDownCapture={(event) => {
          pointerIntent.current = {
            id: t.id, pointer: event.pointerId, x: event.clientX, y: event.clientY,
            started: performance.now(),
            cancelled: event.button !== 0 || !!(event.target instanceof Element && event.target.closest("button, input, select, a")),
          };
        }}
        onMouseDown={() => setActive(t.id)}
        onDragOver={(e) => {
          if (!effFull && dragId && dragId !== t.id) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOverId(t.id);
          }
        }}
        onDrop={(e) => {
          if (dragId && dragId !== t.id) {
            e.preventDefault();
            e.stopPropagation();
            reorderTile(dragId, t.id);
          }
          setDragId(null);
          setOverId(null);
        }}
      >
        <div
          className="tile-head"
          draggable={!effFull && !isRenaming}
          onDragStart={(e) => {
            setDragId(t.id);
            e.dataTransfer.effectAllowed = "move";
            // Carry the workspace key (host-namespaced), so dropping on a tab
            // assigns exactly the key the grid filters by.
            e.dataTransfer.setData(SESSION_DND, wsKeyOf(t));
            e.dataTransfer.setData(SESSION_TILE_DND, t.id);
            // Drag a snapshot of the whole tile, not just the header.
            const tileEl = (e.currentTarget as HTMLElement).closest(".tile");
            if (tileEl) {
              const r = tileEl.getBoundingClientRect();
              e.dataTransfer.setDragImage(tileEl, e.clientX - r.left, e.clientY - r.top);
            }
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
        >
          <span className={`stat stat-${status}`} title={status} />
          <span className="tile-icon">
            <LiveSessionIcon session={base} window={t.window} host={t.host} />
          </span>
          {isRenaming ? (
            <input
              className="tile-title-input"
              autoFocus
              value={renaming.val}
              spellCheck={false}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming({ id: t.id, val: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameTile(t.id, renaming.val);
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                renameTile(t.id, renaming.val);
                setRenaming(null);
              }}
            />
          ) : (
            <span
              className="tile-title"
              title="Click to rename"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setRenaming({ id: t.id, val: displayName });
              }}
            >
              {displayName}
            </span>
          )}
          {shortcutIdx >= 0 && shortcutIdx < 9 ? (
            <kbd className="kbd tile-kbd" title="Activate">
              {ctrlBadge(shortcutIdx + 1)}
            </kbd>
          ) : null}
          <span className="tile-device" title="Running on">
            <DeviceIcon host={t.host} size={11} />{tileDevice(t.host)}
          </span>
          {path ? (
            <span className="tile-path" title={rs?.path}>
              {path}
            </span>
          ) : null}
          <div className="tile-head-spacer" />
          <div className="tile-actions">
            <button
              className="tile-btn"
              title="Tile layout"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setLayoutFor(
                  layoutFor?.id === t.id ? null : { id: t.id, x: r.right, y: r.bottom },
                );
              }}
            >
              <LayoutGrid size={13} />
            </button>
            <DictationButton tileId={t.id} activate={() => setActive(t.id)} />
            <button
              className={`tile-btn ${isFocus ? "tile-btn-on" : ""}`}
              title={isFocus ? "Unfocus" : "Focus (dim others)"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setActive(t.id);
                setFocusId(isFocus ? null : t.id);
              }}
            >
              <Focus size={13} />
            </button>
            <button
              className={`tile-btn ${codeOpen ? "tile-btn-on" : ""}`}
              title={codeOpen ? "Back to terminal" : "Code editor"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (codeOpen) {
                  void confirmEditorDiscard([t.id]).then((confirmed) => { if (confirmed) toggleTileCode(t.id); });
                  return;
                }
                // Root the editor at the terminal's live cwd (a fresh session
                // has no scanned path yet); fall back to any known path.
                fetchSessionPath(base, t.host, t.window)
                  .then((live) => toggleTileCode(t.id, live || fullPath))
                  .catch(() => toggleTileCode(t.id, fullPath));
              }}
            >
              <FileCode size={13} />
            </button>
            <button
              className="tile-btn"
              title="Move to workspace"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMoveFor(moveFor?.id === t.id ? null : { id: t.id, x: r.right, y: r.bottom });
              }}
            >
              <FolderInput size={13} />
            </button>
            <button
              className="tile-btn"
              title="Duplicate session"
              aria-label="Duplicate session"
              disabled={duplicating !== null}
              aria-busy={duplicating === t.id}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); void duplicate(t); }}
            >
              {showDuplicateSpinner && duplicating === t.id ? <Loader2 size={13} className="async-spinner" /> : <Copy size={13} />}
            </button>
            <button
              className="tile-btn"
              title={isFull ? "Restore" : "Maximize"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setActive(t.id);
                setFullId(isFull ? null : t.id);
              }}
            >
              {isFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              className="tile-btn"
              title="Hide (keeps running)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (fullId === t.id) setFullId(null);
                if (focusId === t.id) setFocusId(null);
                hideTile(t.id);
              }}
            >
              <EyeOff size={13} />
            </button>
            <button
              className="tile-btn tile-btn-danger"
              title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setCloseError(null);
                setClosing(t.id);
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {borderBg ? <div className="tile-color-border" aria-hidden="true" style={{ background: borderBg }} /> : null}
        <div className={`tile-body ${codeOpen ? `tile-body-code-${tileCode[t.id]?.layout ?? "full"}` : ""}`}>
          <Terminal
            tileId={t.id}
            name={base}
            host={t.host ?? connection.host ?? undefined}
            cmd={cmd}
            args={args}
            cwd={t.cwd}
            window={t.window}
            active={activeId === t.id}
            onStatus={(s) => setStatus(t.id, s)}
          />
          {codeOpen ? <TileCodePanel tileId={t.id} /> : null}
        </div>
        {dimmed ? (
          <div
            className="tile-dim-overlay"
            title="Click to exit focus"
            onMouseDown={(e) => {
              e.stopPropagation();
              setFocusId(null);
            }}
          />
        ) : null}
      </motion.div>
    );
  };

  return (
    <>
      <Modal open={duplicateError !== null} onClose={() => setDuplicateError(null)} title="Duplicate session" size="sm">
        <p role="alert">{duplicateError}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setDuplicateError(null)}>Dismiss</button></div>
      </Modal>
      <div
        className={`grid ${effFull ? "grid-full" : ""}`}
        style={{
          gridTemplateColumns: effFull
            ? "minmax(0, 1fr)"
            : `repeat(${columns}, minmax(0, 1fr))`,
        }}
        onDragOver={(e) => {
          if (dragId) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          if (dragId) {
            e.preventDefault();
            moveTileToEnd(dragId);
          }
          setDragId(null);
          setOverId(null);
        }}
      >
        {tiles.map(tile)}
      </div>
      {noneVisible ? (
        <div className="grid-empty grid-empty-overlay">
          <section className="empty-session-window" aria-label="Empty workspace">
            <div className="empty-session-chrome" aria-hidden="true">
              <TerminalSquare size={14} />
              <span>Session</span>
              <div className="tile-head-spacer" />
              <Minus size={12} />
              <Square size={10} />
              <X size={12} />
            </div>
            <div className="empty-session-body">
              <div className="empty-session-prompt" aria-hidden="true"><span>›</span><span className="empty-session-cursor" /></div>
              <p>Start a session in this workspace.</p>
              <button type="button" className="btn btn-accent empty-session-create" onClick={onNewSession}>
                <Plus size={16} />
                New Session
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <Modal open={!!closing} onClose={() => { if (!terminating) setClosing(null); }} title="Close session" size="sm">
        <p className="move-q">
          <b>Close</b> detaches this view and keeps the session running on its device.
          <b> Terminate</b> ends {tiles.find((tile) => tile.id === closing)?.window !== undefined ? "this window" : "the session"} and everything running in it.
        </p>
        {closeError ? <p className="pj-error" role="alert">{closeError}</p> : null}
        <div className="modal-actions">
          <button className="btn" disabled={terminating} onClick={() => setClosing(null)}>Cancel</button>
          <button
            className="btn btn-danger"
            disabled={terminating}
            onClick={async () => {
              const current = tiles.find((tile) => tile.id === closing);
              if (!current || terminating) return;
              setTerminating(true);
              setCloseError(null);
              try {
                const affected = tiles.filter((tile) => (tile.host ?? connection.host ?? "") === (current.host ?? connection.host ?? "") &&
                  (tile.session ?? tile.name) === (current.session ?? current.name) &&
                  (current.window === undefined || tile.window === current.window));
                if (!await confirmEditorDiscard(affected.map((tile) => tile.id))) return;
                await killSession(current.session ?? current.name, current.window, sessionConnection(current.host, connection).host ?? "");
                for (const tile of affected) {
                  if (fullId === tile.id) setFullId(null);
                  if (focusId === tile.id) setFocusId(null);
                  closeTile(tile.id);
                }
                setClosing(null);
              } catch (error) {
                setCloseError(error instanceof Error ? error.message : String(error));
              } finally {
                setTerminating(false);
              }
            }}
          >
            {terminating ? "Terminating…" : "Terminate"}
          </button>
          <button
            className="btn btn-accent"
            disabled={terminating}
            onClick={async () => {
              if (!closing || !await confirmEditorDiscard([closing])) return;
              if (fullId === closing) setFullId(null);
              if (focusId === closing) setFocusId(null);
              closeTile(closing);
              setClosing(null);
            }}
          >Close</button>
        </div>
      </Modal>

      {moveFor
        ? createPortal(
            <div className="layout-pop-backdrop pzza-portal" onMouseDown={() => setMoveFor(null)}>
              <div
                className="menu layout-pop"
                style={{ right: window.innerWidth - moveFor.x, top: moveFor.y + 6 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(() => {
                  const target = tiles.find((x) => x.id === moveFor.id);
                  const key = target ? wsKeyOf(target) : "";
                  const current = sessionWs[key] ?? DEFAULT_WORKSPACE_ID;
                  return workspaces.map((w) => (
                    <button
                      key={w.id}
                      className={`menu-item ${current === w.id ? "menu-item-on" : ""}`}
                      onClick={() => {
                        if (key) assignSession(key, w.id);
                        setMoveFor(null);
                      }}
                    >
                      {w.name}
                    </button>
                  ));
                })()}
              </div>
            </div>,
            document.body,
          )
        : null}

      {layoutFor
        ? createPortal(
            <div className="layout-pop-backdrop pzza-portal" onMouseDown={() => setLayoutFor(null)}>
              <div
                className="menu layout-pop"
                style={{ right: window.innerWidth - layoutFor.x, top: layoutFor.y + 6 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {[
                  { label: "Normal", Icon: Square, c: 1, r: 1 },
                  { label: "Wide (2 cols)", Icon: Columns2, c: 2, r: 1 },
                  { label: "Full width", Icon: StretchHorizontal, c: columns, r: 1 },
                  { label: "Tall (2 rows)", Icon: Rows2, c: 1, r: 2 },
                  { label: "Big (2×2)", Icon: LayoutGrid, c: 2, r: 2 },
                ]
                  .filter((o, i, arr) => {
                    // Drop duplicates (e.g. at 2 columns "Wide" == "Full width").
                    const key = (x: { c: number; r: number }) =>
                      `${Math.min(x.c, columns)}-${x.r}`;
                    return arr.findIndex((y) => key(y) === key(o)) === i;
                  })
                  .map((o) => {
                    const cur = tileSpan[layoutFor.id] ?? { c: 1, r: 1 };
                    const on =
                      Math.min(cur.c, columns) === Math.min(o.c, columns) && cur.r === o.r;
                    return (
                    <button
                      key={o.label}
                      className={`menu-item ${on ? "menu-item-on" : ""}`}
                      onClick={() => {
                        setTileSpan(layoutFor.id, o.c, o.r);
                        setLayoutFor(null);
                      }}
                    >
                      <o.Icon size={16} strokeWidth={1.9} />
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
