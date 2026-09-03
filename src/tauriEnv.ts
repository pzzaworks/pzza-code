// True only inside the Tauri webview, where the Rust commands exist. In a plain
// browser this is false and the app runs in themed preview mode.
export const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
