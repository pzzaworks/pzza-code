// The coding agent catalog as the native side needs it, generated from
// server/lib/session-agents.js by scripts/agent-catalog.mjs: the binaries setup
// looks for, how to tell them from same-named tools, and the only commands a
// restored terminal may type.
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResume {
    pub command: String,
    /// Names tmux shows as the pane command while that agent runs.
    pub programs: Vec<String>,
    /// The agent's binary is named after its version (Claude Code).
    pub version_program: bool,
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

/// The catalog entry for an exact resume command, if it is one.
pub fn resume_entry(command: &str) -> Option<&'static CatalogResume> {
    catalog().resume.iter().find(|entry| entry.command == command)
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
