// The coding agent catalog as the native side needs it, generated from
// server/lib/session-agents.js by scripts/agent-catalog.mjs: the binaries setup
// looks for, how to tell them from same-named tools, and the only commands a
// restored terminal may type.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

/// A plain path fragment from an agent's detect rules; `end` anchors it at the
/// end of the path (same as agentBinaryPathRules in session-agents.js).
#[derive(Debug, Deserialize)]
pub struct PathFragment {
    pub text: String,
    pub end: bool,
}

impl PathFragment {
    fn matches(&self, path: &str) -> bool {
        if self.end { path.ends_with(&self.text) } else { path.contains(&self.text) }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAgent {
    pub id: String,
    pub binaries: Vec<String>,
    /// Per-user install folders, relative to the home folder.
    pub install_dirs: Vec<String>,
    /// A binary whose path contains one of these is another tool (Foundry's forge).
    pub exclude_paths: Vec<PathFragment>,
    /// When not empty, the binary's path must contain one of these.
    pub require_paths: Vec<PathFragment>,
}

impl CatalogAgent {
    /// Whether a binary found by name can be this agent, given the path it was
    /// found at and the path it resolves to (same rule as agentBinaryAllowed).
    pub fn allows_paths(&self, paths: &[&str]) -> bool {
        let any = |fragments: &[PathFragment]| paths.iter().any(|path| fragments.iter().any(|fragment| fragment.matches(path)));
        !any(&self.exclude_paths) && (self.require_paths.is_empty() || any(&self.require_paths))
    }

    /// Whether the binary at `path` can be this agent, checking its resolved path too.
    pub fn allows_binary(&self, path: &std::path::Path) -> bool {
        let found = path.to_string_lossy();
        let real = std::fs::canonicalize(path).map(|real| real.to_string_lossy().into_owned()).unwrap_or_else(|_| found.to_string());
        self.allows_paths(&[&found, &real])
    }
}

/// The environment variable that starts an agent with another config folder
/// (a second account), and the name that folder must have.
#[derive(Debug, Deserialize)]
pub struct CatalogAccount {
    pub env: String,
    pub folder: String,
}

impl CatalogAccount {
    /// Whether `value` is a config folder the agent can be started with: an
    /// absolute path of plain path characters (as validAgentAccount in
    /// session-agents.js checks), whose last part is the folder name alone or
    /// with a "-suffix", and which sits directly in `home`.
    pub fn allows_folder(&self, value: &str, home: &Path) -> bool {
        let Some(rest) = value.strip_prefix('/') else {
            return false;
        };
        let plain = |segment: &str| {
            !segment.is_empty() && segment != "." && segment != ".." && segment.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+:,.-".contains(c))
        };
        let segments: Vec<&str> = rest.split('/').collect();
        if value.len() > 160 || segments.len() < 2 || !segments.iter().all(|segment| plain(segment)) {
            return false;
        }
        let name = segments[segments.len() - 1];
        let named = name == self.folder || name.strip_prefix(self.folder.as_str()).is_some_and(|suffix| suffix.len() > 1 && suffix.starts_with('-'));
        // The activity probe reports the folder with the home folder resolved.
        let parent = Path::new(value).parent();
        named && (parent == Some(home) || std::fs::canonicalize(home).ok().as_deref() == parent)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResume {
    pub command: String,
    /// Names tmux shows as the pane command while that agent runs.
    pub programs: Vec<String>,
    /// The agent's binary is named after its version (Claude Code).
    pub version_program: bool,
    /// The agent can run with another config folder (see CatalogAccount).
    pub account: Option<CatalogAccount>,
}

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub agents: Vec<CatalogAgent>,
    pub resume: Vec<CatalogResume>,
}

pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(include_str!("agent_catalog.json")).expect("the bundled agent catalog is valid"))
}

/// The catalog entry for an exact resume command, if it is one: a catalog
/// command as it is, or with `env <account env>=<folder> ` in front for an
/// agent with accounts (one `env` with the catalog command's own variables
/// after the folder), the folder being one CatalogAccount allows in the home
/// folder.
pub fn resume_entry(command: &str) -> Option<&'static CatalogResume> {
    resume_entry_in(command, home_folder().as_deref())
}

/// The account folder a valid resume command starts its agent with, if it is
/// not the default one (`~/.claude` named explicitly is the same account as
/// none, and so the same conversations).
pub fn resume_account(command: &str) -> Option<&str> {
    let (_, name, folder) = account_prefix(command)?;
    let account = resume_entry(command)?.account.as_ref()?;
    let default = folder.rsplit('/').next() == Some(account.folder.as_str());
    (account.env == name && !default).then_some(folder)
}

fn home_folder() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from)
}

// `env NAME=VALUE rest`, split into its parts.
fn account_prefix(command: &str) -> Option<(&str, &str, &str)> {
    let rest = command.strip_prefix("env ")?;
    let (assignment, rest) = rest.split_once(' ')?;
    let (name, value) = assignment.split_once('=')?;
    Some((rest, name, value))
}

fn resume_entry_in(command: &str, home: Option<&Path>) -> Option<&'static CatalogResume> {
    if let Some(entry) = catalog().resume.iter().find(|entry| entry.command == command) {
        return Some(entry);
    }
    let (rest, name, folder) = account_prefix(command)?;
    let home = home?;
    catalog().resume.iter().find(|entry| {
        // The catalog command without its own `env`, which the prefix carries.
        let base = entry.command.strip_prefix("env ").unwrap_or(&entry.command);
        base == rest && entry.account.as_ref().is_some_and(|account| account.env == name && account.allows_folder(folder, home))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> &'static CatalogAgent {
        catalog().agents.iter().find(|agent| agent.id == id).unwrap()
    }

    #[test]
    fn the_bundled_catalog_lists_agents_and_resume_commands() {
        let catalog = catalog();
        assert!(catalog.agents.iter().any(|agent| agent.id == "claude" && agent.binaries == ["claude"]));
        assert!(catalog.agents.len() >= 29);
        assert!(resume_entry("claude -c --permission-mode manual").is_some_and(|entry| entry.version_program));
        assert!(resume_entry("claude -c").is_none(), "plain claude starts in auto mode, so it is never resumed that way");
        assert!(catalog.resume.iter().all(|entry| !entry.programs.is_empty()));
    }

    #[test]
    fn resume_commands_may_name_an_account_folder_in_the_home_folder() {
        let home = Some(Path::new("/Users/me"));
        let entry = |command: &str| resume_entry_in(command, home);
        assert!(entry("env CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude -c --dangerously-skip-permissions").is_some_and(|entry| entry.version_program));
        assert!(entry("env CLAUDE_CONFIG_DIR=/Users/me/.claude claude -c --permission-mode manual").is_some());
        for refused in [
            "env CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude -c",
            "env CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude -c --permission-mode manual; rm -rf ~",
            "env CLAUDE_CONFIG_DIR=/tmp/.claude-work claude -c --permission-mode manual",
            "env CLAUDE_CONFIG_DIR=/Users/me/other claude -c --permission-mode manual",
            "env CLAUDE_CONFIG_DIR=/Users/me/.claude- claude -c --permission-mode manual",
            "env CLAUDE_CONFIG_DIR=/Users/me/../me/.claude-x claude -c --permission-mode manual",
            "env CLAUDE_CONFIG_DIR='/Users/me/.claude-x' claude -c --permission-mode manual",
            "env CLAUDE_CONFIG_DIR=/Users/me/.claude-$(id) claude -c --permission-mode manual",
            "env PATH=/Users/me/.claude-work claude -c --permission-mode manual",
            "env CODEX_HOME=/Users/me/.claude-work codex resume --last --sandbox read-only --ask-for-approval on-request",
        ] {
            assert!(entry(refused).is_none(), "{refused}");
        }
        assert!(resume_entry_in("env CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude -c --permission-mode manual", None).is_none(), "no home folder");
    }

    #[test]
    fn the_account_of_a_resume_command_is_its_chosen_folder_only() {
        let home = std::env::var("HOME").expect("tests run with a home folder");
        let command = |folder: &str| format!("env CLAUDE_CONFIG_DIR={home}/{folder} claude -c --permission-mode plan");
        assert_eq!(resume_account(&command(".claude-work")), Some(format!("{home}/.claude-work").as_str()));
        assert_eq!(resume_account(&command(".claude")), None, "the default folder is the default account");
        assert_eq!(resume_account("claude -c --permission-mode plan"), None);
        assert_eq!(resume_account(&format!("env PATH={home}/.claude-work claude -c --permission-mode plan")), None);
    }

    #[test]
    fn same_named_tools_are_not_taken_for_agents() {
        let forge = agent("forgecode");
        assert!(!forge.allows_paths(&["/Users/me/.foundry/bin/forge"]), "Foundry's forge");
        assert!(forge.allows_paths(&["/opt/homebrew/bin/forge", "/opt/homebrew/lib/node_modules/forgecode/bin/forge"]));
        let goose = agent("goose");
        assert!(!goose.allows_paths(&["/opt/homebrew/bin/goose", "/opt/homebrew/Cellar/goose/3.26.0/bin/goose"]), "the migration tool");
        assert!(goose.allows_paths(&["/Users/me/.local/bin/goose"]));
        let amp = agent("amp");
        assert!(!amp.allows_paths(&["/opt/homebrew/bin/amp", "/opt/homebrew/Cellar/amp/0.7.0/bin/amp"]), "the text editor");
        assert!(amp.allows_paths(&["/Users/me/.amp/bin/amp"]));
        assert!(amp.allows_paths(&["/opt/homebrew/bin/amp", "/opt/homebrew/Cellar/ampcode/1/bin/amp"]));
        assert!(!amp.allows_paths(&["/Users/me/.amp/bin/amp-old"]), "an end-anchored fragment matches only at the end");
        assert!(agent("claude").allows_paths(&["/anywhere/claude"]));
    }
}
