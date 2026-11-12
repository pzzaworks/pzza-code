import { useEffect, useMemo, useState } from "react";
import type { Extension } from "@codemirror/state";

// The highlighting languages (every CodeMirror language pack, about 1.5 MB of
// code) are their own chunk, loaded the first time a file or diff opens rather
// than with the editor. Views wait for it like they wait for the file, so text
// never shows unhighlighted first.
type Languages = typeof import("./editorLanguage");
let languages: Languages | null = null;
let loading: Promise<void> | null = null;
let failed = false;

export function loadEditorLanguages(): Promise<void> {
  return (loading ??= import("./editorLanguage").then(
    (module) => { languages = module; },
    () => { failed = true; },
  ));
}

/**
 * The highlighting for a file path. `ready` is false while the languages load;
 * a failed load leaves the file plain (null) rather than blocking it.
 */
export function useEditorLanguage(path: string | null | undefined): { ready: boolean; language: Extension | null } {
  const [, setSettled] = useState(false);
  const ready = !path || languages !== null || failed;
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void loadEditorLanguages().then(() => { if (alive) setSettled(true); });
    return () => { alive = false; };
  }, [ready]);
  const loaded = languages !== null;
  const language = useMemo(() => (path && languages ? languages.editorLanguage(path) : null), [path, loaded]);
  return { ready, language };
}
