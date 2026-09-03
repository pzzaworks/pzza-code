import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Columns2, Columns3, Columns4, LayoutGrid } from "lucide-react";
import { useStore } from "../state/store";
import { useExclusiveMenu } from "../ui/menuBus";
import { ALL_WORKSPACE_ID } from "../workspaces";

const OPTIONS = [
  { n: 2, Icon: Columns2, label: "2 columns" },
  { n: 3, Icon: Columns3, label: "3 columns" },
  { n: 4, Icon: Columns4, label: "4 columns" },
] as const;

// Grid-columns dropdown for the top bar.
export function LayoutMenu() {
  const workspaceColumns = useStore((s) => s.workspaceColumns);
  const defaultColumns = useStore((s) => s.defaultColumns);
  const setColumns = useStore((s) => s.setColumns);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const [open, setOpen] = useState(false);

  const columns = workspaceColumns[activeWorkspaceId] ?? defaultColumns;
  const wsName =
    activeWorkspaceId === ALL_WORKSPACE_ID
      ? "All"
      : workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "";
  const ref = useRef<HTMLDivElement>(null);

  useExclusiveMenu("layout", open, useCallback(() => setOpen(false), []));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className={`icon-btn ${open ? "icon-btn-on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Grid layout"
      >
        <LayoutGrid size={16} strokeWidth={1.9} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.12 }}
          >
            <div className="menu-head-title">
              Layout
              {wsName ? <span className="menu-head-ws">{wsName}</span> : null}
            </div>
            {OPTIONS.map(({ n, Icon, label }) => (
              <button
                key={n}
                className={`menu-item ${columns === n ? "menu-item-on" : ""}`}
                onClick={() => {
                  setColumns(n);
                  setOpen(false);
                }}
              >
                <Icon size={16} strokeWidth={1.9} />
                {label}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
