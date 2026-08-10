use super::cli::{self, GitError};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    /// False when the directory was removed but Git still has a worktree registration.
    pub path_exists: bool,
    pub head_sha: String,
    pub branch_name: Option<String>,
    pub parent_sha: Option<String>,
    pub is_current: bool,
    pub is_prunable: bool,
    /// Omitted in snapshots written before multi-worktree canvas support; defaults to false.
    #[serde(default)]
    pub has_uncommitted_changes: bool,
}

fn worktree_paths_are_same(repo: &Path, wt_path: &Path) -> bool {
    match (std::fs::canonicalize(repo), std::fs::canonicalize(wt_path)) {
        (Ok(r), Ok(w)) => r == w,
        _ => {
            let trim = |p: &Path| {
                p.to_string_lossy()
                    .trim_end_matches(|c| c == '/' || c == '\\')
                    .to_string()
            };
            trim(repo) == trim(wt_path)
        }
    }
}

/// List all worktrees for the repository that contains `repo`.
/// `repo` may be the main checkout or any linked worktree path.
pub fn list_worktrees(repo: &Path) -> Result<Vec<WorktreeInfo>, GitError> {
    list_worktrees_impl(repo, true)
}

/// List worktree roots without running status and parent probes in every checkout.
/// This is used by file watcher setup, where only the paths are needed.
pub fn list_worktree_paths(repo: &Path) -> Result<Vec<String>, GitError> {
    Ok(list_worktrees_impl(repo, false)?
        .into_iter()
        .filter(|worktree| worktree.path_exists)
        .map(|worktree| worktree.path)
        .collect())
}

fn list_worktrees_impl(
    repo: &Path,
    inspect_checkout_state: bool,
) -> Result<Vec<WorktreeInfo>, GitError> {
    let output = cli::run(repo, &["worktree", "list", "--porcelain"])?;
    let mut parsed: Vec<PartialWt> = Vec::new();
    let mut current: Option<PartialWt> = None;

    let flush = |slot: &mut Option<PartialWt>, out: &mut Vec<PartialWt>| {
        if let Some(wt) = slot.take() {
            out.push(wt);
        }
    };

    for line in output.lines() {
        if line.trim().is_empty() {
            flush(&mut current, &mut parsed);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current, &mut parsed);
            current = Some(PartialWt {
                path: path.trim().to_string(),
                ..PartialWt::default()
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(sha) = line.strip_prefix("HEAD ") {
            entry.head_sha = Some(sha.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            let rest = rest.trim();
            if rest == "detached" {
                entry.branch_name = None;
            } else if let Some(name) = rest.strip_prefix("refs/heads/") {
                entry.branch_name = Some(name.to_string());
            }
        } else if line.starts_with("prunable") {
            entry.is_prunable = true;
        }
    }
    flush(&mut current, &mut parsed);

    let mut result: Vec<WorktreeInfo> = Vec::new();
    for partial in parsed {
        if partial.path.is_empty() {
            continue;
        }
        if is_managed_preview_worktree(&partial.path) {
            continue;
        }
        let Some(head_sha) = partial.head_sha.filter(|h| !h.is_empty()) else {
            continue;
        };

        let wt_path = Path::new(&partial.path);
        let path_exists = wt_path.exists();
        let parent_sha = if path_exists && inspect_checkout_state {
            git_parent_sha(wt_path).ok().flatten()
        } else {
            None
        };

        let is_current = worktree_paths_are_same(repo, wt_path);
        let has_uncommitted_changes = if path_exists && inspect_checkout_state {
            worktree_has_uncommitted_changes(wt_path)
        } else {
            false
        };

        result.push(WorktreeInfo {
            path: partial.path,
            path_exists,
            head_sha,
            branch_name: partial.branch_name,
            parent_sha,
            is_current,
            is_prunable: partial.is_prunable,
            has_uncommitted_changes,
        });
    }

    Ok(result)
}

fn is_managed_preview_worktree(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let marker = "/preview-worktrees/";
    normalized.contains(marker)
        && (normalized.ends_with("/preview") || normalized.ends_with("/worktree"))
}

#[derive(Default)]
struct PartialWt {
    path: String,
    head_sha: Option<String>,
    branch_name: Option<String>,
    is_prunable: bool,
}

fn worktree_has_uncommitted_changes(wt_root: &Path) -> bool {
    cli::run(
        wt_root,
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .map(|output| !output.trim().is_empty())
    .unwrap_or(false)
}

fn git_parent_sha(wt_root: &Path) -> Result<Option<String>, GitError> {
    let out = cli::run(wt_root, &["rev-list", "--parents", "-n", "1", "HEAD"])?;
    let line = out.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let _head = parts.next();
    Ok(parts.next().map(|s| s.to_string()))
}

pub fn remove_worktree(repo: &Path, worktree_path: &str, force: bool) -> Result<(), GitError> {
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(worktree_path.to_string());
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cli::run(repo, &args_ref)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_managed_preview_worktree, worktree_has_uncommitted_changes};
    use std::process::Command;

    #[test]
    fn porcelain_dirty_detection_matches_git_status() {
        let repo = std::env::temp_dir().join(format!("gv-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        Command::new("git")
            .args(["init", repo.to_str().unwrap()])
            .output()
            .expect("git init");
        std::fs::write(repo.join("dirty.txt"), "x").expect("write file");
        let dirty = worktree_has_uncommitted_changes(&repo);
        assert!(dirty, "untracked file should mark worktree dirty");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn detects_managed_preview_worktree_paths() {
        assert!(is_managed_preview_worktree(
            "/Users/luca/Library/Application Support/cobble/preview-worktrees/abc123/preview"
        ));
        assert!(is_managed_preview_worktree(
            "/Users/luca/Library/Application Support/cobble/preview-worktrees/abc123/preview"
        ));
        assert!(is_managed_preview_worktree(
            "/Users/luca/Library/Application Support/cobble/preview-worktrees/abc123/worktree"
        ));
        assert!(!is_managed_preview_worktree("/Users/luca/cursor/cobble"));
    }
}
