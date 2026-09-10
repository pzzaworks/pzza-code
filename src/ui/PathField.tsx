import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { FilePicker, type PickerHost } from "../panels/FilePicker";

// A selected path belongs to its device. File-mode starts in the parent folder;
// the receiving device expands a leading tilde against its own home.
function startDir(value: string, mode: "folder" | "file", start?: string, placeholder?: string): string | undefined {
  const dirOf = (path: string) => (mode === "folder" ? path : path.replace(/\/[^/]*$/, "") || "/");
  if (value) return dirOf(value);
  if (start) return start;
  if (placeholder && (placeholder.startsWith("~") || placeholder.startsWith("/"))) return dirOf(placeholder);
  return undefined;
}

export function PathField({ value, onChange, mode = "folder", host = "", hosts, start, placeholder = "Choose…", title, pickerTitle, className = "", disabled = false, fixedHost = false }: {
  value: string;
  onChange: (path: string, host: string) => void;
  mode?: "folder" | "file";
  host?: string;
  hosts?: PickerHost[];
  start?: string;
  placeholder?: string;
  title?: string;
  pickerTitle?: string;
  className?: string;
  disabled?: boolean;
  fixedHost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [host, disabled]);
  return <>
    <button type="button" className={`path-field ${value ? "" : "path-field-empty"} ${className}`} disabled={disabled} onClick={() => setOpen(true)} title={title ?? (mode === "folder" ? "Choose a folder" : "Choose a file")}>
      <FolderOpen size={13} className="path-field-icon" /><span className="path-field-value">{value || placeholder}</span>
    </button>
    <FilePicker key={host} open={open && !disabled} onClose={() => setOpen(false)} onPick={(path, selectedHost) => {
      if (!disabled && (!fixedHost || selectedHost === host)) onChange(path, selectedHost);
    }} mode={mode} host={host} hosts={fixedHost ? undefined : hosts} start={startDir(value, mode, start, placeholder)} title={pickerTitle} />
  </>;
}
