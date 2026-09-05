#!/usr/bin/env bash
#
# PzzaCode - device agent installer.
#
# Sets up the agent (the process that serves terminals, ports and saved state to
# the app) on this machine and, on Linux/macOS, registers it as a background
# service so it starts on boot. Safe to re-run: every step is idempotent.
#
# Usage:
#   ./install.sh                      # install as a "source" device (this is the box with tmux)
#   PZZA_DEVBOX_HOST=devbox ./install.sh   # install as a "client" (forwards to a source over ssh)
#   PORT=5190 ./install.sh            # override the agent port (default 5190)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-5190}"
DEVBOX_HOST="${PZZA_DEVBOX_HOST:-}"
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pzza-console"

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  B="\033[1m"; DIM="\033[2m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; C="\033[36m"; X="\033[0m"
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; X=""
fi
ok()   { printf "  ${G}✓${X} %s\n" "$1"; }
warn() { printf "  ${Y}!${X} %s\n" "$1"; }
err()  { printf "  ${R}✗${X} %s\n" "$1"; }
step() { printf "\n${B}%s${X}\n" "$1"; }

printf "${B}${C}PzzaCode${X}${B} - device agent installer${X}\n"
printf "${DIM}%s${X}\n" "$SCRIPT_DIR"

# --- prerequisites -----------------------------------------------------------
step "Checking prerequisites"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $(node -v)"
  else
    err "node $(node -v) is too old - need v18+"; exit 1
  fi
else
  err "node not found - install Node.js v18+ first (https://nodejs.org)"; exit 1
fi

if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}')"
else
  warn "tmux not found - the agent needs it for persistent sessions."
  warn "  Debian/Ubuntu: sudo apt install tmux   |   macOS: brew install tmux"
fi

command -v ssh >/dev/null 2>&1 && ok "ssh present" || warn "ssh not found (only needed for client role)"

if [ -n "$DEVBOX_HOST" ]; then
  ok "role: client -> forwards to '${DEVBOX_HOST}'"
else
  ok "role: source (tmux/ports are local to this machine)"
fi

# --- dependencies ------------------------------------------------------------
step "Installing agent dependencies"
install_deps() {
  local dir="$1" label="$2"
  if [ -f "$dir/package.json" ]; then
    ( cd "$dir" && { npm ci --silent 2>/dev/null || npm install --silent; } )
    ok "$label deps installed"
  fi
}
install_deps "$SCRIPT_DIR/server" "agent"
install_deps "$SCRIPT_DIR/mcp" "mcp"

# --- state directory ---------------------------------------------------------
step "Preparing state directory"
mkdir -p "$STATE_DIR/backups"
ok "$STATE_DIR"

# --- tmux config (idempotent) ------------------------------------------------
step "Configuring tmux"
TMUX_CONF="$HOME/.tmux.conf"
MARK="# >>> pzza-console >>>"
END_MARK="# <<< pzza-console <<<"
if [ -f "$TMUX_CONF" ] && grep -qF "$MARK" "$TMUX_CONF"; then
  ok "tmux.conf already has the pzza-console block"
else
  {
    printf "\n%s\n" "$MARK"
    echo "set -g mouse on"
    echo "set -g set-clipboard off"
    echo 'set -as terminal-features ",xterm-256color:RGB"'
    echo "set-environment -g COLORTERM truecolor"
    printf "%s\n" "$END_MARK"
  } >> "$TMUX_CONF"
  ok "appended truecolor + mouse + no-copy-on-select to $TMUX_CONF"
  command -v tmux >/dev/null 2>&1 && tmux source-file "$TMUX_CONF" 2>/dev/null || true
fi

# --- service registration ----------------------------------------------------
step "Registering background service"
NODE_BIN="$(command -v node)"
ENTRY="$SCRIPT_DIR/server/index.js"

register_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/pzza-agent.service" <<UNIT
[Unit]
Description=PzzaCode device agent
After=network.target

[Service]
Type=simple
Environment=PORT=${PORT}
Environment=PZZA_DEVBOX_HOST=${DEVBOX_HOST}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_BIN} ${ENTRY}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now pzza-agent.service
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable linger (agent won't start until you log in)"
  ok "systemd user service 'pzza-agent' enabled and started"
}

register_launchd() {
  local plist="$HOME/Library/LaunchAgents/com.pzzaworks.console.agent.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pzzaworks.console.agent</string>
  <key>ProgramArguments</key><array><string>${NODE_BIN}</string><string>${ENTRY}</string></array>
  <key>WorkingDirectory</key><string>${SCRIPT_DIR}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>${PORT}</string>
    <key>PZZA_DEVBOX_HOST</key><string>${DEVBOX_HOST}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"
  ok "launchd agent 'com.pzzaworks.console.agent' loaded"
}

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  register_systemd
elif [ "$(uname)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  register_launchd
else
  warn "no systemd/launchd - start the agent manually:"
  warn "  PORT=${PORT} PZZA_DEVBOX_HOST='${DEVBOX_HOST}' ${NODE_BIN} ${ENTRY}"
fi

# --- verify ------------------------------------------------------------------
step "Verifying"
sleep 1
if command -v curl >/dev/null 2>&1; then
  for i in 1 2 3 4 5; do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      ok "agent responding on http://127.0.0.1:${PORT}"
      break
    fi
    [ "$i" = 5 ] && warn "agent not responding yet - check: systemctl --user status pzza-agent" || sleep 1
  done
else
  warn "curl not found - skipping health check"
fi

printf "\n${B}${G}Done.${X} Open the app and it will connect to this agent on port ${B}${PORT}${X}.\n"
