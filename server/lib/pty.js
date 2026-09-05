// WebSocket PTY bridge: attaches a browser terminal to a tmux session. On a
// receiver the tmux server is on the devbox, so the child is ssh; on the source
// it runs tmux directly. ws and node-pty are optional - if they are not
// installed the agent runs without the WebSocket terminal (the desktop app uses
// the Rust PTY instead), so the import failure is logged and swallowed.
import { DEVBOX, IS_CLIENT } from "./config.js";
import { sh, shQuote } from "./shell.js";
import { hostOk, tokenOk } from "./http.js";

export async function startPtyBridge(server) {
  let WebSocketServer;
  let pty;
  try {
    ({ WebSocketServer } = await import("ws"));
    pty = (await import("node-pty")).default;
  } catch (e) {
    console.warn(`PzzaCode agent: WebSocket PTY disabled (${e?.message || e}).`);
    return;
  }
  const wss = new WebSocketServer({ server, path: "/pty" });

  wss.on("connection", (ws, req) => {
    // The upgrade carries the token as ?token=; refuse anything else.
    let upgradeToken = "";
    try {
      upgradeToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get("token") || "";
    } catch {
      /* malformed */
    }
    if (!hostOk(req) || !tokenOk(upgradeToken)) {
      ws.close(1008, "unauthorized");
      return;
    }
    let term = null;
    let viewSession = null; // grouped view session to clean up on close

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "attach" && !term) {
        const name = String(msg.name || "").trim();
        if (!name || name === "undefined") {
          ws.close();
          return;
        }
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        const hasWin = msg.window !== undefined && msg.window !== null;
        let attach;
        if (hasWin) {
          // A specific window: view it through a grouped session so it can show a
          // different window than other clients. Cleaned up explicitly on close
          // (destroy-unattached would kill it before we manage to attach).
          const view = `pzza-v-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`;
          viewSession = view;
          attach =
            `tmux new-session -d -t ${shQuote(name)} -s ${shQuote(view)} 2>/dev/null; ` +
            `tmux set-option -t ${shQuote(view)} window-size latest 2>/dev/null; ` +
            `tmux select-window -t ${shQuote(view + ":" + msg.window)} 2>/dev/null; ` +
            `exec tmux attach -t ${shQuote(view)}`;
        } else {
          // Never shrink a session another client (cmux) is viewing.
          const prep = `tmux set-option -t ${shQuote(name)} window-size latest 2>/dev/null; tmux set-option -t ${shQuote(name)} aggressive-resize on 2>/dev/null`;
          attach = `${prep}; exec tmux new-session -A -s ${shQuote(name)}${
            msg.cwd ? ` -c ${shQuote(msg.cwd)}` : ""
          }`;
        }

        // Advertise truecolor so apps inside tmux (yazi, ratatui TUIs) emit 24-bit
        // colors instead of quantizing to 256 and washing out.
        const ptyEnv = { ...process.env, COLORTERM: "truecolor" };
        if (IS_CLIENT) {
          term = pty.spawn("ssh", ["-tt", DEVBOX, `sh -lc ${shQuote(attach)}`], {
            name: "xterm-256color",
            cols,
            rows,
            env: ptyEnv,
          });
        } else {
          term = pty.spawn("sh", ["-lc", attach], {
            name: "xterm-256color",
            cols,
            rows,
            cwd: process.env.HOME,
            env: ptyEnv,
          });
        }

        term.onData((d) => {
          if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, "utf8"));
        });
        term.onExit(() => {
          if (ws.readyState === ws.OPEN) ws.close();
        });
      } else if (msg.type === "input" && term) {
        term.write(msg.data);
      } else if (msg.type === "resize" && term) {
        term.resize(msg.cols || 80, msg.rows || 24);
      }
    });

    ws.on("close", () => {
      if (term) {
        try {
          term.kill();
        } catch {
          /* gone */
        }
        term = null;
      }
      if (viewSession) {
        sh(`tmux kill-session -t ${shQuote(viewSession)} 2>/dev/null`, () => {});
        viewSession = null;
      }
    });
  });
}

// Clean up leftover internal window-view sessions that are no longer attached.
export function sweepOrphanViews() {
  sh("tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null", (err, out) => {
    if (err) return;
    for (const line of String(out || "").split("\n")) {
      const [name, attached] = line.split(" ");
      if (name && name.startsWith("pzza-v-") && attached === "0") {
        sh(`tmux kill-session -t ${shQuote(name)} 2>/dev/null`, () => {});
      }
    }
  });
}
