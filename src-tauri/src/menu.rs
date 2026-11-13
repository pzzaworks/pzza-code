use crate::open_panel::{self, PickKind};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

// Off macOS Ctrl+K is the shell's kill-line; a native accelerator would take it
// from every terminal, so there the web view handles the shortcut instead.
const COMMAND_PALETTE_ACCELERATOR: Option<&str> = if cfg!(target_os = "macos") {
    Some("CmdOrCtrl+K")
} else {
    None
};

// Cmd+Shift+O stays with the editor (Go to symbol), so Open Folder… takes
// Option+Cmd+O. Off macOS there is no native picker, so the items are left out.
const OPEN_ITEMS: &[(&str, &str, Option<&str>)] = if cfg!(target_os = "macos") {
    &[
        ("open-file", "Open File…", Some("CmdOrCtrl+O")),
        ("open-folder", "Open Folder…", Some("Alt+CmdOrCtrl+O")),
    ]
} else {
    &[]
};

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Preserve the platform's standard editing, window, and application actions.
    let menu = Menu::default(app)?;
    for entry in menu.items()? {
        let Some(submenu) = entry.as_submenu() else {
            continue;
        };
        let title = submenu.text()?;
        if title == app.package_info().name || title == "PzzaCode" {
            submenu.remove_at(0)?;
            submenu.insert(
                &MenuItem::with_id(app, "pzza:about", "About PzzaCode", true, None::<&str>)?,
                0,
            )?;
        }
        let items: &[(&str, &str, Option<&str>)] = match title.as_str() {
            "File" => &[
                ("new-session", "New Session…", Some("CmdOrCtrl+N")),
                ("new-workspace", "New Workspace…", Some("CmdOrCtrl+Shift+N")),
            ],
            "View" => &[
                (
                    "command-palette",
                    "Command Palette…",
                    COMMAND_PALETTE_ACCELERATOR,
                ),
                (
                    "search-terminals",
                    "Search All Terminals…",
                    Some("CmdOrCtrl+Shift+F"),
                ),
                (
                    "font-increase",
                    "Increase Terminal Font Size",
                    Some("CmdOrCtrl+Shift+Equal"),
                ),
                (
                    "font-decrease",
                    "Decrease Terminal Font Size",
                    Some("CmdOrCtrl+Minus"),
                ),
                ("quick-chat", "Quick Chat…", None),
                ("notifications", "Notifications…", None),
                ("devices", "Devices…", None),
                ("sync", "Sync & Repositories…", None),
                ("remote", "Remote Desktop Settings…", None),
                ("mcp", "MCP & Connections…", None),
            ],
            "Help" => &[("help", "PzzaCode Help", Some("CmdOrCtrl+Shift+Slash"))],
            _ if title == app.package_info().name || title == "PzzaCode" => {
                &[("general", "Settings…", Some("CmdOrCtrl+Comma"))]
            }
            _ => &[],
        };
        for (offset, (id, label, shortcut)) in items.iter().enumerate() {
            let item = MenuItem::with_id(app, format!("pzza:{id}"), *label, true, *shortcut)?;
            let position = if *id == "general" { 2 } else { offset };
            submenu.insert(&item, position)?;
        }
        // Open File… and Open Folder… follow in their own group (macOS only,
        // where open_panel shows the native panel).
        let pickers = if title == "File" { OPEN_ITEMS } else { &[] };
        if !pickers.is_empty() {
            submenu.insert(&PredefinedMenuItem::separator(app)?, items.len())?;
            for (offset, (id, label, shortcut)) in pickers.iter().enumerate() {
                let item = MenuItem::with_id(app, format!("pzza:{id}"), *label, true, *shortcut)?;
                submenu.insert(&item, items.len() + 1 + offset)?;
            }
        }
        if title == "Help" {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
            // The same sections and topics as the in-app Help (HELP_SECTIONS in
            // src/panels/HelpModal.tsx), so every topic is one click away.
            let groups: &[(&str, &[(&str, &str)])] = &[
                (
                    "Getting started",
                    &[
                        ("start", "Overview"),
                        ("setup", "Setup & tour"),
                        ("permissions", "Permissions & tools"),
                        ("topbar", "The menu bar"),
                        ("new-session", "New session"),
                        ("agents", "Agents & modes"),
                        ("palette", "Command palette"),
                        ("settings", "Settings map"),
                    ],
                ),
                (
                    "Workspace",
                    &[
                        ("tiles", "Sessions & tiles"),
                        ("controls", "Tile controls"),
                        ("focus", "Focus & attention"),
                        ("layout", "Layout & grid"),
                        ("spacing", "Spacing"),
                        ("workspaces", "Workspaces"),
                        ("snapshots", "Snapshots"),
                        ("restore", "Restore snapshots"),
                        ("broadcast", "Broadcast"),
                    ],
                ),
                (
                    "Git & review",
                    &[
                        ("git", "Branch & PR"),
                        ("ci", "Fix failing CI"),
                        ("shared-branch", "Shared branch"),
                        ("worktrees", "Worktrees"),
                        ("land", "Open PR & merge"),
                        ("changes", "Changes view"),
                        ("review", "Review with agent"),
                    ],
                ),
                (
                    "Terminal & editor",
                    &[
                        ("links", "Open links"),
                        ("paths", "Open file paths"),
                        ("paste", "Paste images"),
                        ("drop", "Drop files"),
                        ("find", "Find & copy"),
                        ("search", "Search terminals"),
                        ("prompts", "Saved prompts"),
                        ("code", "Code editor"),
                    ],
                ),
                (
                    "Agents & activity",
                    &[
                        ("tasks", "Tasks"),
                        ("best-of-n", "Task modes"),
                        ("quick-chat", "Quick Chat"),
                        ("agent-tools", "Agent automation"),
                        ("notifications", "Notifications"),
                        ("usage", "Usage limits"),
                        ("multiaccount", "Multi-account"),
                    ],
                ),
                (
                    "Voice dictation",
                    &[
                        ("dictation", "Dictation"),
                        ("languages", "Languages & mic"),
                    ],
                ),
                (
                    "Connections",
                    &[
                        ("devices", "Devices"),
                        ("sync", "Sync"),
                        ("ports", "Ports"),
                        ("rdp", "Remote desktop"),
                        ("mcp", "MCP"),
                    ],
                ),
                (
                    "Shortcuts & tips",
                    &[
                        ("shortcuts", "Shortcuts"),
                        ("terminal-keys", "Terminal shortcuts"),
                        ("tips", "Tips"),
                    ],
                ),
            ];
            for (label, topics) in groups {
                let group = Submenu::new(app, *label, true)?;
                for (id, topic) in *topics {
                    group.append(&MenuItem::with_id(
                        app,
                        format!("pzza:help:{id}"),
                        *topic,
                        true,
                        None::<&str>,
                    )?)?;
                }
                submenu.append(&group)?;
            }
        }
        if !items.is_empty() && title != "Help" {
            submenu.insert(
                &PredefinedMenuItem::separator(app)?,
                if items[0].0 == "general" {
                    3
                } else {
                    items.len() + if pickers.is_empty() { 0 } else { pickers.len() + 1 }
                },
            )?;
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        // The pickers are native: shown here, their choice delivered through
        // open_files like files opened from Finder.
        let picker = match event.id().as_ref() {
            "pzza:open-file" => Some(PickKind::File),
            "pzza:open-folder" => Some(PickKind::Folder),
            _ => None,
        };
        if let Some(kind) = picker {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Err(error) = open_panel::pick(app, kind) {
                eprintln!("PzzaCode could not show the open panel: {error}");
            }
            return;
        }
        if let Some(action) = event.id().as_ref().strip_prefix("pzza:") {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("app-menu-action", action);
            }
        }
    });
    Ok(())
}
