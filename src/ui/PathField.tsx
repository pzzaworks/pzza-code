import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { FilePicker, type PickerHost } from "../panels/FilePicker";

// A path shown as a read-only chip that opens the device file browser on click.
// Replaces free-text path inputs everywhere: the user picks a real folder or
// file on a real device instead of typing a path they have to remember.
// Directory to open the browser in: the current value (its folder, for a
// file), else the caller's start, else the placeholder's folder when it looks
// like a path. The agent expands a leading "~" against the device's home.
function startDir(value: string, mode: "folder" | "file", start?: string, placeholder?: string): string | undefined {
  const dirOf = (p: string) => (mode === "folder" ? p : p.replace(/\/[^/]*$/, "") || "/");
  if (value) return dirOf(value);
  if (start) return start;
  if (placeholder && (placeholder.startsWith("~") || placeholder.startsWith("/"))) return dirOf(placeholder);
  return undefined;
}

export function PathField({
  value,
  onChange,
  mode = "folder",
  host = "",
  hosts,
  start,
  placeholder = "Choose…",
  title,
  pickerTitle,
  className = "",
}: {
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
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`path-field ${value ? "" : "path-field-empty"} ${className}`}
        onClick={() => setOpen(true)}
        title={title ?? (mode === "folder" ? "Choose a folder" : "Choose a file")}
      >
        <FolderOpen size={13} className="path-field-icon" />
        <span className="path-field-value">{value || placeholder}</span>
      </button>
      <FilePicker
        open={open}
        onClose={() => setOpen(false)}
        onPick={onChange}
        mode={mode}
        host={host}
        hosts={hosts}
        start={startDir(value, mode, start, placeholder)}
        title={pickerTitle}
      />
    </>
  );
}
