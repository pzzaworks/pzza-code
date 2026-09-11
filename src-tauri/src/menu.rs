use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
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
        if title == "Help" {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
            let groups: &[(&str, &[(&str, &str)])] = &[
                (
                    "Getting started",
                    &[
                        ("start", "Overview"),
                        ("topbar", "The top bar"),
                        ("agent-tools", "Agent tools"),
                    ],
                ),
                (
                    "Workspace",
                    &[
                        ("tiles", "Sessions & tiles"),
                        ("controls", "Tile controls"),
                        ("focus", "Focus & attention"),
                        ("workspaces", "Workspaces"),
                        ("layout", "Layout & grid"),
                        ("shortcuts", "Keyboard shortcuts"),
                    ],
                ),
                (
                    "Agents",
                    &[
                        ("usage", "Agent usage"),
                        ("multiaccount", "Multi-account"),
                        ("paste", "Image paste"),
                    ],
                ),
                (
                    "Connections",
                    &[
                        ("devices", "Devices & the agent"),
                        ("ports", "Ports"),
                        ("rdp", "Remote desktop"),
                        ("mcp", "MCP"),
                    ],
                ),
                ("Tips", &[("tips", "Tips")]),
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
                    items.len()
                },
            )?;
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
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
