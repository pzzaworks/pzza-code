import type { Terminal as XTerm } from "@xterm/xterm";

// When the app runs in a plain browser (no Tauri IPC), there is no PTY backend.
// Rather than error, each tile runs this themed preview: a banner, a palette
// swatch that showcases the active theme's ANSI colors, and a tiny line editor
// so the cursor and typing feel alive. Real terminals run under `tauri dev`.
export function runBrowserPreview(term: XTerm): () => void {
  const prompt = "\x1b[36mpzza\x1b[0m:\x1b[34m~\x1b[0m$ ";

  term.writeln("\x1b[1;35m  pzza console \x1b[0m\x1b[2m- browser preview\x1b[0m");
  term.writeln(
    "\x1b[2m  Live terminals run under \x1b[0m\x1b[32mtauri dev\x1b[0m\x1b[2m. This is a themed preview.\x1b[0m",
  );
  term.writeln("");
  term.writeln("\x1b[2m  active theme palette:\x1b[0m");
  let swatch = "  ";
  for (let i = 0; i < 8; i++) swatch += `\x1b[4${i}m   \x1b[0m`;
  term.writeln(swatch);
  let bright = "  ";
  for (let i = 0; i < 8; i++) bright += `\x1b[10${i}m   \x1b[0m`;
  term.writeln(bright);
  term.write("\r\n" + prompt);

  let buf = "";
  const sub = term.onData((data) => {
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code === 13) {
        const cmd = buf.trim();
        if (cmd === "clear") {
          term.clear();
        } else if (cmd.length) {
          term.write(`\r\n\x1b[2m  preview - not wired: \x1b[0m${cmd}`);
        }
        buf = "";
        term.write("\r\n" + prompt);
      } else if (code === 127) {
        if (buf.length) {
          buf = buf.slice(0, -1);
          term.write("\b \b");
        }
      } else if (code >= 32) {
        buf += ch;
        term.write(ch);
      }
    }
  });

  return () => sub.dispose();
}
