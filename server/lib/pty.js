// WebSocket PTY bridge: attaches a browser terminal to a tmux session. On a
// receiver the tmux server is on the devbox, so the child is ssh; on the source
// it runs tmux directly. ws and node-pty are optional - if they are not
// installed the agent runs without the WebSocket terminal (the desktop app uses
// the Rust PTY instead), so the import failure is logged and swallowed.
import { DEVBOX, IS_CLIENT } from "./config.js";
import { sh, shOn, shQuote, SSH_TOKEN } from "./shell.js";
import { hostOk, tokenOk } from "./http.js";

const OUTPUT_HIGH = 256 * 1024;
const OUTPUT_LOW = 128 * 1024;
const MESSAGE_LIMIT = 1024 * 1024;

// Credits cover both the socket and the browser parser, not just socket delivery.
export function createPtyOutputFlow(ws, term) {
  let outstanding = 0;
  let paused = false;
  let ended = false;
  let disposed = false;
  let drainTimer;
  const finish = () => {
    if (ended && outstanding === 0 && ws.readyState === ws.OPEN) ws.close();
  };
  return {
    data(data) {
      if (disposed || ws.readyState !== ws.OPEN) return;
      const bytes = Buffer.from(data, "utf8");
      // A paused PTY may have one already-delivered read in flight.
      if (outstanding + bytes.length > OUTPUT_HIGH + MESSAGE_LIMIT) {
        ws.close(1011, "terminal output exceeded flow limit");
        term.pause();
        return;
      }
      outstanding += bytes.length;
      if (!paused && outstanding >= OUTPUT_HIGH) {
        paused = true;
        term.pause();
      }
      try {
        ws.send(bytes, (error) => { if (error) ws.close(1011, "terminal output failed"); });
      } catch {
        ws.close(1011, "terminal output failed");
      }
    },
    acknowledge(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > outstanding) {
        ws.close(1008, "invalid terminal acknowledgement");
        return;
      }
      outstanding -= bytes;
      if (paused && !ended && outstanding <= OUTPUT_LOW) {
        paused = false;
        term.resume();
      }
      finish();
    },
    exit() {
      if (ended || disposed) return;
      ended = true;
      finish();
      if (outstanding > 0) {
        drainTimer = setTimeout(() => ws.close(1011, "terminal drain timed out"), 30000);
        drainTimer.unref();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(drainTimer);
    },
  };
}

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
  const wss = new WebSocketServer({ server, path: "/pty", maxPayload: MESSAGE_LIMIT });

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
    let flow = null;
    let attachedHost = "";
    let viewSession = null; // grouped view session to clean up on close

    ws.on("message", (raw, isBinary) => {
      if (isBinary) { ws.close(1008, "binary input is unsupported"); return; }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ack" && flow) { flow.acknowledge(msg.bytes); return; }
      if ((msg.type === "attach" || msg.type === "resize") &&
          (![msg.cols, msg.rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000))) {
        ws.close(1008, "invalid terminal dimensions");
        return;
      }
      try {
        if (msg.type === "attach" && !term) {
          if (msg.host !== undefined && (typeof msg.host !== "string" || (msg.host && !SSH_TOKEN.test(msg.host)))) {
            ws.close(1008, "invalid host");
            return;
          }
          attachedHost = msg.host || "";
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
              `exec tmux -u attach -t ${shQuote(view)}`;
          } else {
            // Never shrink a session another client (cmux) is viewing.
            // Also heal a server started without a locale so new panes get a UTF-8 LANG.
            const prep =
              `tmux show-environment -g LANG >/dev/null 2>&1 || tmux set-environment -g LANG "\${LANG:-en_US.UTF-8}" 2>/dev/null; ` +
              `tmux set-option -t ${shQuote(name)} window-size latest 2>/dev/null; tmux set-option -t ${shQuote(name)} aggressive-resize on 2>/dev/null`;
            attach = `${prep}; exec tmux -u new-session -A -s ${shQuote(name)}${
              msg.cwd ? ` -c ${shQuote(msg.cwd)}` : ""
            }`;
          }

          // Advertise truecolor so apps inside tmux (yazi, ratatui TUIs) emit 24-bit
          // colors instead of quantizing to 256 and washing out. tmux and zsh read
          // the locale from LC_ALL / LC_CTYPE / LANG; an agent launched without one
          // would get `_` for every non-ASCII glyph, so supply a UTF-8 locale then.
          const hasLocale = ["LC_ALL", "LC_CTYPE", "LANG"].some((k) => process.env[k]);
          const ptyEnv = { ...process.env, ...(hasLocale ? {} : { LANG: "en_US.UTF-8" }), COLORTERM: "truecolor" };
          if (attachedHost || IS_CLIENT) {
            term = pty.spawn("ssh", ["-tt", attachedHost || DEVBOX, `sh -lc ${shQuote(attach)}`], {
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

          flow = createPtyOutputFlow(ws, term);
          term.onData((data) => flow.data(data));
          term.onExit(() => flow.exit());
        } else if (msg.type === "input" && term) {
          if (typeof msg.data !== "string") { ws.close(1008, "invalid terminal input"); return; }
          term.write(msg.data);
        } else if (msg.type === "resize" && term) {
          term.resize(msg.cols || 80, msg.rows || 24);
        }
      } catch {
        ws.close(1011, "terminal operation failed");
      }
    });

    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      flow?.dispose();
      if (term) {
        try {
          term.kill();
        } catch {
          /* gone */
        }
        term = null;
      }
      if (viewSession) {
        shOn(attachedHost, `tmux kill-session -t ${shQuote(viewSession)} 2>/dev/null`, () => {});
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
