<p align="center">
  <img src=".github/logo.png" alt="PzzaCode" width="88" />
</p>

<p align="center">
  A grid terminal manager for agentic coding - run and watch many terminals and AI coding agents across your machines, from one fast cockpit.
</p>

<p align="center">
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-CE412B?logo=rust&logoColor=white" alt="Rust" /></a>
  <a href="https://github.com/tmux/tmux"><img src="https://img.shields.io/badge/tmux-1BB91F?logo=tmux&logoColor=white" alt="tmux" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Every tile is a live terminal - a shell or a coding agent (Claude Code, Codex) - backed by a **tmux** session on the device. Closing the app just detaches: everything keeps running and comes back exactly where you left it. Runs in the browser (talking to a small agent on the device) or as a native desktop app.

## Features

- **Grid of terminals** - see and drive every session at once; drag to reorder, maximize, or resize a tile.
- **Workspaces** - browser-style tabs group sessions, each with its own grid layout, icon and color.
- **Focus & dim** - spotlight one tile, dim the rest, or grey out everything but the one you clicked.
- **Keyboard-first** - `⌥1-9` switch workspaces, `⌃1-9` jump to a tile, `⌘V` pastes an image straight to your agent (even over SSH).
- **Per-device agents** - a small agent serves each machine's terminals, ports and saved state; a setup wizard installs it on a new device over SSH.
- **Auto port forwarding** - the device's listening ports mirrored to your machine automatically.
- **Remote desktop** - open a device's Linux desktop over an SSH-tunneled RDP session.
- **MCP** - expose your sessions and ports to Claude / Codex / Zed / Cursor / Windsurf.
- **Live agent usage** - Claude / Codex 5-hour and weekly windows, reset countdowns and plan, read from the accounts on the device.
- **Multi-account** - launch a session bound to a specific Claude or Codex account.

## Getting Started

Install the agent on a device (Node 18+ and tmux required):

```bash
./install.sh
```

Run the app:

```bash
npm install
npm run dev
```

Open the printed URL. From **Add a device** in the setup wizard you can install the agent on any other machine you can SSH into.

## Tech Stack

- **Framework**: React 18 + Vite 6
- **Desktop**: Tauri 2 (Rust, portable-pty)
- **Terminals**: xterm.js (WebGL) + tmux
- **Agent**: Node + node-pty + ws
- **State**: zustand
- **Animation**: Framer Motion

## License

[MIT](LICENSE) © Berke (pzzaworks)
