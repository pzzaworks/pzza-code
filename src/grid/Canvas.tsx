import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  EyeOff,
  Focus,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Moon,
  X,
} from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { Terminal } from "../terminal/Terminal";
import { killSession } from "../serverApi";
import { HAS_TAURI } from "../tauriEnv";
import { attachCommand } from "../connection";
import {
  sessionIcon,
  iconColor,
  tileTitle,
  shortPath,
  SESSION_DND,
  type TileStatus,
} from "../sessionMeta";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "../workspaces";
import { ctrlBadge, digitFromCode } from "../shortcuts";

// Uniform N-column grid, filtered to the active workspace. One tile can be
// maximized (animated). Tiles reorder by dragging their header onto another
// tile, or move to a workspace by dragging onto a top-bar tab.
export function Canvas() {
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

  // Columns are per-workspace; the active workspace decides the grid.
  const columns = workspaceColumns[activeWorkspaceId] ?? defaultColumns;

  const deviceName =
    devices.find((d) => d.host === (connection.host ?? "devbox"))?.name ??
    (connection.host ?? "local");

  const [closing, setClosing] = useState<string | null>(null);
  const [layoutFor, setLayoutFor] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  const [statuses, setStatuses] = useState<Record<string, TileStatus>>({});
  const setStatus = useCallback(
    (id: string, s: TileStatus) =>
      setStatuses((prev) => (prev[id] === s ? prev : { ...prev, [id]: s })),
    [],
  );

  const [fullId, setFullId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; val: string } | null>(null);
  const [manualDim, setManualDim] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const wsTiles = tiles.filter(
    (t) =>
      (activeWorkspaceId === ALL_WORKSPACE_ID ||
        (sessionWs[t.session ?? t.name] ?? DEFAULT_WORKSPACE_ID) === activeWorkspaceId) &&
      !hiddenTiles.includes(t.id),
  );

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
      setActive(t.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setActive]);

  // On selecting a tile, bring it to the center of the screen - but only if it
  // is not already fully visible, so clicking a tile already on screen does not
  // yank the view around.
  useEffect(() => {
    if (!activeId || fullId) return;
    const el = document.querySelector(`[data-tile-id="${CSS.escape(activeId)}"]`);
    if (!(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const topInset = 84; // under the top bar + workspace tabs
    const fullyVisible = r.top >= topInset && r.bottom <= window.innerHeight - 8;
    if (!fullyVisible) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, [activeId, fullId]);

  // Every tile stays mounted for the life of the session - switching workspaces,
  // hiding, or maximizing only toggles CSS visibility. Re-mounting would
  // re-attach the terminal to tmux, renegotiate its size, and paint garbage
  // until a reload; keeping it alive avoids that entirely.
  const noneVisible = wsTiles.length === 0;

  const tile = (t: (typeof tiles)[number]) => {
    const base = t.session ?? t.name;
    const { cmd, args } = attachCommand(connection, base, t.cwd, t.window);
    const rs = allSessions.find((s) => s.name === base);
    const command = t.command ?? rs?.command;
    const path = shortPath(t.path ?? rs?.path);
    const Icon = sessionIcon(base, command);
    const color = iconColor(base, command);
    const wsColor = workspaces.find(
      (w) => w.id === (sessionWs[base] ?? DEFAULT_WORKSPACE_ID),
    )?.color;
    const status = statuses[t.id] ?? "idle";
    const displayName = tileTitles[t.id] ?? tileTitle(t.name);
    const isRenaming = renaming?.id === t.id;
    const shortcutIdx = wsTiles.findIndex((x) => x.id === t.id);
    const isFull = fullId === t.id;
    const isFocus = focusId === t.id;
    // Dimmed either because another tile is focused, or this tile was manually
    // darkened. The focused/maximized tile is never dimmed.
    const isDim = manualDim[t.id] ?? false;
    const dimmed = !isFull && !isFocus && (!!focusId || isDim);
    // Colored gradient border, darkened while another tile is focused.
    const borderBg = wsColor
      ? `linear-gradient(var(--bg), var(--bg)) padding-box, linear-gradient(140deg, ${
          dimmed ? `color-mix(in srgb, ${wsColor} 40%, #000)` : wsColor
        } 0%, ${
          dimmed ? "color-mix(in srgb, var(--border) 40%, #000)" : "var(--border)"
        } 22%) border-box`
      : undefined;
    const span = tileSpan[t.id] ?? { c: 1, r: 1 };
    const spanStyle = fullId
      ? undefined
      : {
          gridColumn: `span ${Math.min(span.c, columns)}`,
          gridRow: `span ${span.r}`,
        };
    const isActive = activeId === t.id;
    // Visible only when in the active workspace, not hidden, and (if a tile is
    // maximized) the maximized one. Everything else is display:none but stays
    // mounted.
    const tileWs = sessionWs[base] ?? DEFAULT_WORKSPACE_ID;
    const inWorkspace =
      activeWorkspaceId === ALL_WORKSPACE_ID || tileWs === activeWorkspaceId;
    const visible = inWorkspace && !hiddenTiles.includes(t.id) && (!fullId || isFull);
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
            ? { border: "1px solid transparent", background: borderBg }
            : {}),
        }}
        layout={visible && !fullId ? "position" : false}
        initial={isFull ? { opacity: 0, scale: 0.97 } : false}
        animate={isFull ? { opacity: 1, scale: 1 } : {}}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        onMouseDown={() => setActive(t.id)}
        onDragOver={(e) => {
          if (!fullId && dragId && dragId !== t.id) {
            e.preventDefault();
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
          draggable={!fullId && !isRenaming}
          onDragStart={(e) => {
            setDragId(t.id);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(SESSION_DND, t.name);
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
          <span className="tile-icon" style={color ? { color } : undefined}>
            <Icon size={14} />
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
            {deviceName}
          </span>
          {path ? (
            <span className="tile-path" title={rs?.path}>
              {path}
            </span>
          ) : null}
          <div className="tile-head-spacer" />
          <div className="tile-actions">
            <button
              className={`tile-btn ${isDim ? "tile-btn-on" : ""}`}
              title={isDim ? "Undim" : "Dim this window"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setManualDim((m) => ({ ...m, [t.id]: !isDim }));
              }}
            >
              <Moon size={13} />
            </button>
            <button
              className={`tile-btn ${isFocus ? "tile-btn-on" : ""}`}
              title={isFocus ? "Unfocus" : "Focus (dim others)"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setFocusId(isFocus ? null : t.id);
              }}
            >
              <Focus size={13} />
            </button>
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
            <button
              className="tile-btn"
              title={isFull ? "Restore" : "Maximize"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
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
                setManualDim((m) => ({ ...m, [t.id]: false }));
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
                setClosing(t.id);
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="tile-body">
          <Terminal
            name={base}
            cmd={cmd}
            args={args}
            cwd={t.cwd}
            window={t.window}
            active={activeId === t.id}
            onStatus={(s) => setStatus(t.id, s)}
          />
        </div>
        {dimmed ? (
          <div
            className="tile-dim-overlay"
            title={focusId ? "Click to exit focus" : "Click to undim"}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (focusId) setFocusId(null);
              else setManualDim((m) => ({ ...m, [t.id]: false }));
            }}
          />
        ) : null}
      </motion.div>
    );
  };

  return (
    <>
      <div
        className={`grid ${fullId ? "grid-full" : ""}`}
        style={{
          gridTemplateColumns: fullId
            ? "minmax(0, 1fr)"
            : `repeat(${columns}, minmax(0, 1fr))`,
        }}
        onDragOver={(e) => {
          if (dragId) e.preventDefault();
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
          <p>No tiles in this workspace.</p>
          <p className="muted">Hit + in the top bar to open a session.</p>
        </div>
      ) : null}

      <Modal open={!!closing} onClose={() => setClosing(null)} title="Close session" size="sm">
        <p className="move-q">
          <b>Close</b> just detaches your view - the session keeps running on the
          devbox. <b>Terminate</b> ends it and everything running in it.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setClosing(null)}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (closing) {
                const ct = tiles.find((t) => t.id === closing);
                if (ct && !HAS_TAURI) killSession(ct.session ?? ct.name, ct.window);
                if (fullId === closing) setFullId(null);
                if (focusId === closing) setFocusId(null);
                closeTile(closing);
              }
              setClosing(null);
            }}
          >
            Terminate
          </button>
          <button
            className="btn btn-accent"
            onClick={() => {
              if (closing) {
                if (fullId === closing) setFullId(null);
                if (focusId === closing) setFocusId(null);
                closeTile(closing);
              }
              setClosing(null);
            }}
          >
            Close
          </button>
        </div>
      </Modal>

      {layoutFor
        ? createPortal(
            <div className="layout-pop-backdrop pzza-portal" onMouseDown={() => setLayoutFor(null)}>
              <div
                className="menu layout-pop"
                style={{ left: layoutFor.x, top: layoutFor.y + 6 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {[
                  { label: "Normal", c: 1, r: 1 },
                  { label: "Wide (2 cols)", c: 2, r: 1 },
                  { label: "Full width", c: columns, r: 1 },
                  { label: "Tall (2 rows)", c: 1, r: 2 },
                  { label: "Big (2×2)", c: 2, r: 2 },
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
