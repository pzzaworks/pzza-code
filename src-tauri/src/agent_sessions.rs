// Which conversation a resume-by-id agent last ran in a folder, read from the
// agent's own store, so a restored pane continues exactly that conversation.
// The agent catalog (session-agents.js) names the store as the resume's
// `lookup`; its resume command holds PLACEHOLDER where the id goes.
//
// Every store is read, never written: SQLite through the system sqlite3 in
// read-only mode, or the agent's own machine-readable listing. An id is used
// only when it has the agent's documented shape, so nothing but plain id
// characters is ever typed into the shell. A store that cannot be read (not
// installed, another layout) resumes nothing: the pane stays at its shell.
//
// Sources, by lookup:
// - cline: ~/.cline/data/sessions/sessions.db, table `sessions` with
//   `session_id`, `cwd`, `updated_at`, `is_subagent`; ids `<ms time>_<5 of
//   [0-9a-z]>` (cline/cline sdk: shared/src/db/sqlite-db.ts, session/index.ts).
// - goose: ~/.local/share/goose/sessions/sessions.db, table `sessions` with
//   `id`, `working_dir`, `updated_at`, `session_type`, `archived_at`; ids
//   `YYYYMMDD_<n>` (goose: crates/goose/src/session/session_manager.rs).
// - forge: `forge conversation list --porcelain` run in the folder lists that
//   folder's conversations newest first, the id (a UUID) first on each row
//   (forge: crates/forge_main/src/ui.rs on_show_conversations).
use std::path::{Path, PathBuf};
use std::process::Command;

/// Stands for the id in a resume command; RESUME_SESSION in session-agents.js.
pub const PLACEHOLDER: &str = "@SESSION@";

/// The resume command with the id of the conversation `folder` last ran in
/// place of PLACEHOLDER, or None when no such conversation can be read.
pub fn resolve(command: &str, lookup: &str, folder: &Path) -> Option<String> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let folder = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let id = match lookup {
        "cline" => newest_row(
            &home.join(".cline/data/sessions/sessions.db"),
            "select session_id as id, cwd as folder, updated_at as at from sessions where is_subagent = 0",
            &folder,
        ),
        "goose" => newest_row(
            &home.join(".local/share/goose/sessions/sessions.db"),
            "select id, working_dir as folder, updated_at as at from sessions where session_type = 'user' and archived_at is null",
            &folder,
        ),
        "forge" => forge_newest(&folder),
        _ => None,
    }?;
    (valid_id(lookup, &id) && command.contains(PLACEHOLDER)).then(|| command.replacen(PLACEHOLDER, &id, 1))
}

/// Whether an id has the shape the agent gives its conversations.
pub fn valid_id(lookup: &str, id: &str) -> bool {
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    match lookup {
        "cline" => id.split_once('_').is_some_and(|(time, tail)| {
            time.len() == 13 && digits(time) && tail.len() == 5 && tail.bytes().all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        }),
        "goose" => id.len() <= 24 && id.split_once('_').is_some_and(|(date, count)| date.len() == 8 && digits(date) && digits(count)),
        "forge" => uuid(id),
        // Claude Code session ids, as the app records them per pane: lowercase UUIDs.
        "claude" => uuid(id) && !id.bytes().any(|byte| byte.is_ascii_uppercase()),
        _ => false,
    }
}

fn uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, length)| part.len() == length && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// The id of the newest row whose folder is `folder`, from a query that
/// selects `id`, `folder` and `at` (a sortable time text).
fn newest_row(database: &Path, query: &str, folder: &Path) -> Option<String> {
    if !database.is_file() {
        return None;
    }
    let output = crate::local_tmux::bounded_output(Command::new("/usr/bin/sqlite3").args(["-readonly", "-json"]).arg(database).arg(query)).ok()?;
    if !output.status.success() {
        return None;
    }
    newest_in(&String::from_utf8_lossy(&output.stdout), folder)
}

/// The newest row of sqlite3's JSON output whose folder is `folder`.
fn newest_in(rows: &str, folder: &Path) -> Option<String> {
    // sqlite3 prints nothing at all for no rows.
    if rows.trim().is_empty() {
        return None;
    }
    let rows: Vec<serde_json::Value> = serde_json::from_str(rows).ok()?;
    rows.iter()
        .filter(|row| row["folder"].as_str().is_some_and(|path| same_folder(Path::new(path), folder)))
        .filter_map(|row| Some((row["at"].as_str().unwrap_or_default().to_string(), row["id"].as_str()?.to_string())))
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, id)| id)
}

fn same_folder(path: &Path, folder: &Path) -> bool {
    path == folder || std::fs::canonicalize(path).is_ok_and(|path| path == folder)
}

fn forge_newest(folder: &Path) -> Option<String> {
    // Never a bare "forge": with Foundry first on PATH that ran the wrong tool in the folder.
    let forge = crate::setup::catalog_binary("forgecode")?;
    let output = crate::local_tmux::bounded_output(
        Command::new(forge).args(["conversation", "list", "--porcelain"]).current_dir(folder).env("PATH", crate::agent::login_path()),
    ).ok()?;
    if !output.status.success() {
        return None;
    }
    first_uuid(&String::from_utf8_lossy(&output.stdout))
}

/// The first row's id in a porcelain listing (the header row has none).
fn first_uuid(listing: &str) -> Option<String> {
    listing.lines().filter_map(|line| line.split_whitespace().next()).find(|word| uuid(word)).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_have_the_agents_own_shape() {
        assert!(valid_id("cline", "1794686844123_a9z0k"));
        assert!(valid_id("goose", "20261115_3"));
        assert!(valid_id("goose", "20261115_042233"));
        assert!(valid_id("forge", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b"));
        assert!(valid_id("claude", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b"));
        for (lookup, id) in [
            ("claude", "0F8E2C1A-6B3D-4E5F-9A7B-1C2D3E4F5A6B"), ("claude", "0f8e2c1a6b3d4e5f9a7b1c2d3e4f5a6b"),
            ("claude", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b "), ("claude", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6g"),
            ("claude", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b;id"), ("claude", "-0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6"), ("claude", ""),
            ("cline", "1794686844123_A9Z0K"), ("cline", "1794686844123_a9z0"), ("cline", "x; rm -rf ~"),
            ("goose", "20261115_"), ("goose", "2026111_3"), ("goose", "20261115_3 && id"),
            ("forge", "0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6"), ("forge", "$(id)"), ("unknown", "20261115_3"),
        ] {
            assert!(!valid_id(lookup, id), "{lookup} {id}");
        }
    }

    #[test]
    fn the_newest_conversation_of_the_folder_wins() {
        let folder = Path::new("/Users/dev/project");
        let rows = r#"[
            {"id":"20261114_1","folder":"/Users/dev/project","at":"2026-11-14 09:00:00"},
            {"id":"20261115_2","folder":"/Users/dev/project","at":"2026-11-15 10:30:00"},
            {"id":"20261115_9","folder":"/Users/dev/other","at":"2026-11-15 11:00:00"}
        ]"#;
        assert_eq!(newest_in(rows, folder).as_deref(), Some("20261115_2"));
        assert_eq!(newest_in(rows, Path::new("/Users/dev/none")), None);
        assert_eq!(newest_in("", folder), None, "sqlite3 prints nothing for no rows");
        assert_eq!(newest_in("not json", folder), None);
    }

    #[test]
    fn forge_lists_the_newest_conversation_first() {
        let listing = "ID                                     TITLE        UPDATED\n0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b   Fix login    3m ago\n11111111-2222-3333-4444-555555555555   Older        2h ago\n";
        assert_eq!(first_uuid(listing).as_deref(), Some("0f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b"));
        assert_eq!(first_uuid("ID TITLE UPDATED\n"), None);
    }

    #[test]
    fn the_id_goes_in_place_of_the_placeholder_once() {
        let command = "env GOOSE_MODE=approve goose session --resume --session-id @SESSION@";
        assert_eq!(command.replacen(PLACEHOLDER, "20261115_2", 1), "env GOOSE_MODE=approve goose session --resume --session-id 20261115_2");
        // An unknown store resumes nothing.
        assert_eq!(resolve(command, "unknown", Path::new("/tmp")), None);
    }

    // Reads a real store the way a restore does: an isolated goose database
    // with sessions in two folders.
    #[test]
    fn a_real_sqlite_store_is_read_without_writing_it() {
        let directory = std::env::temp_dir().join(format!("pzza-agent-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("sessions.db");
        let project = std::fs::canonicalize(&directory).unwrap();
        let created = Command::new("/usr/bin/sqlite3").arg(&database).arg(format!(
            "create table sessions (id text primary key, working_dir text, updated_at timestamp, session_type text, archived_at timestamp);\
             insert into sessions values ('20261115_1', '{0}', '2026-11-15 09:00:00', 'user', null);\
             insert into sessions values ('20261115_2', '{0}', '2026-11-15 10:00:00', 'user', null);\
             insert into sessions values ('20261115_3', '{0}', '2026-11-15 11:00:00', 'subagent', null);\
             insert into sessions values ('20261115_4', '/elsewhere', '2026-11-15 12:00:00', 'user', null);",
            project.display()
        )).status().unwrap();
        assert!(created.success());
        let before = std::fs::read(&database).unwrap();
        let newest = newest_row(&database, "select id, working_dir as folder, updated_at as at from sessions where session_type = 'user' and archived_at is null", &project);
        assert_eq!(newest.as_deref(), Some("20261115_2"));
        assert_eq!(std::fs::read(&database).unwrap(), before, "read only");
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
