use super::cli::{self, GitError};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

const LOG_FIELD_SEPARATOR: &str = "\u{1f}";
const MAX_REPO_GRAPH_COMMITS: usize = 20_000;
const MAX_GRAPH_COMMIT_BRANCH_PAIRS: usize = 500_000;
const MIN_REPO_GRAPH_COMMITS: usize = 500;
const MAX_REMOTE_RANGE_COMMITS: usize = 2_000;

fn repo_graph_commit_limit(branch_count: usize) -> usize {
    (MAX_GRAPH_COMMIT_BRANCH_PAIRS / branch_count.max(1))
        .clamp(MIN_REPO_GRAPH_COMMITS, MAX_REPO_GRAPH_COMMITS)
}

#[cfg(test)]
mod graph_limit_tests {
    use super::repo_graph_commit_limit;

    #[test]
    fn scales_commit_history_down_as_branch_count_grows() {
        assert_eq!(repo_graph_commit_limit(1), 20_000);
        assert_eq!(repo_graph_commit_limit(50), 10_000);
        assert_eq!(repo_graph_commit_limit(100), 5_000);
        assert_eq!(repo_graph_commit_limit(2_000), 500);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCommit {
    pub full_sha: String,
    pub sha: String,
    pub parent_sha: Option<String>,
    pub parent_shas: Vec<String>,
    pub child_shas: Vec<String>,
    pub cluster_key: Option<String>,
    pub branch: String,
    pub message: String,
    pub author: String,
    pub date: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_remote: bool,
}

#[derive(Debug, Clone)]
struct ParsedCommitLine {
    full_sha: String,
    sha: String,
    parent_sha: Option<String>,
    parent_shas: Vec<String>,
    message: String,
    author: String,
    date: String,
}

/// Get commits from a branch in log order.
pub fn get_direct_commits(
    repo: &Path,
    branch: &str,
    limit: Option<u32>,
) -> Result<Vec<DirectCommit>, GitError> {
    let output = if let Some(limit) = limit {
        cli::run(
            repo,
            &[
                "log",
                &format!("--max-count={}", limit),
                "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P",
                branch,
            ],
        )?
    } else {
        cli::run(
            repo,
            &["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P", branch],
        )?
    };

    let parsed_all: Vec<ParsedCommitLine> = output
        .lines()
        .filter(|s| !s.is_empty())
        .filter_map(parse_direct_commit_line)
        .collect();
    let mut seen_shas = HashSet::<String>::new();
    let parsed: Vec<ParsedCommitLine> = parsed_all
        .into_iter()
        .filter(|commit| seen_shas.insert(commit.full_sha.clone()))
        .collect();

    let commits = build_direct_commits(parsed, branch.to_string(), false);

    Ok(commits)
}

/// Commits reachable from `branch` that are not reachable from `since_sha` (when provided).
pub fn get_branch_commits_since(
    repo: &Path,
    branch: &str,
    since_sha: Option<&str>,
    limit: u32,
) -> Result<Vec<DirectCommit>, GitError> {
    let max_count = limit.max(1);
    let output = match since_sha.filter(|value| !value.is_empty()) {
        Some(old_sha) => cli::run(
            repo,
            &[
                "log",
                &format!("--max-count={max_count}"),
                "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P",
                &format!("{old_sha}..{branch}"),
            ],
        )?,
        None => {
            return get_direct_commits(repo, branch, Some(max_count));
        }
    };

    let parsed_all: Vec<ParsedCommitLine> = output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(parse_direct_commit_line)
        .collect();
    let mut seen_shas = HashSet::<String>::new();
    let parsed: Vec<ParsedCommitLine> = parsed_all
        .into_iter()
        .filter(|commit| seen_shas.insert(commit.full_sha.clone()))
        .collect();

    Ok(build_direct_commits(parsed, branch.to_string(), false))
}

/// Commits on `upstream_ref` that are not reachable from the local `branch` tip.
pub fn merge_upstream_ahead_commits(
    repo: &Path,
    branch: &str,
    upstream_ref: &str,
    commits: &mut Vec<DirectCommit>,
) -> Result<(), GitError> {
    let local_head = cli::run(repo, &["rev-parse", branch])?.trim().to_string();
    if local_head.is_empty() {
        return Ok(());
    }
    let remote_head = cli::run(repo, &["rev-parse", upstream_ref])
        .map(|output| output.trim().to_string())
        .unwrap_or_default();
    if remote_head.is_empty() || local_head == remote_head {
        return Ok(());
    }

    let range = format!("{local_head}..{upstream_ref}");
    append_commits_from_log_range(repo, &range, branch, true, commits)
}

/// Commits on a remote-only branch tip that are not already in the graph.
pub fn merge_remote_only_branch_commits(
    repo: &Path,
    default_branch: &str,
    branch_name: &str,
    upstream_ref: &str,
    commits: &mut Vec<DirectCommit>,
) -> Result<(), GitError> {
    let merge_base = cli::run(repo, &["merge-base", default_branch, upstream_ref])?
        .trim()
        .to_string();
    if merge_base.is_empty() {
        return Ok(());
    }
    let remote_head = cli::run(repo, &["rev-parse", upstream_ref])?
        .trim()
        .to_string();
    if remote_head.is_empty() || merge_base == remote_head {
        return Ok(());
    }
    let range = format!("{merge_base}..{upstream_ref}");
    append_commits_from_log_range(repo, &range, branch_name, true, commits)
}

fn append_commits_from_log_range(
    repo: &Path,
    range: &str,
    branch: &str,
    is_remote: bool,
    commits: &mut Vec<DirectCommit>,
) -> Result<(), GitError> {
    let remaining = MAX_REPO_GRAPH_COMMITS.saturating_sub(commits.len());
    if remaining == 0 {
        return Ok(());
    }
    let limit = remaining.min(MAX_REMOTE_RANGE_COMMITS);
    let existing_shas: HashSet<String> = commits
        .iter()
        .map(|commit| commit.full_sha.clone())
        .collect();
    let output = cli::run(
        repo,
        &[
            "log",
            range,
            &format!("--max-count={limit}"),
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P",
        ],
    )?;
    let parsed: Vec<ParsedCommitLine> = output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(parse_direct_commit_line)
        .filter(|commit| !existing_shas.contains(&commit.full_sha))
        .collect();
    if parsed.is_empty() {
        return Ok(());
    }

    let mut remote_commits = build_direct_commits(parsed, branch.to_string(), is_remote);
    commits.append(&mut remote_commits);
    let merged = std::mem::take(commits);
    *commits = with_child_links(merged);
    Ok(())
}

/// Get every commit reachable from local branch refs, and associate each commit with exactly one branch.
pub fn get_all_repo_commits(
    repo: &Path,
    default_branch: &str,
    other_branches: &[String],
    branch_created_dates: &HashMap<String, String>,
    merge_target_branch_by_commit_sha: &HashMap<String, String>,
) -> Result<Vec<DirectCommit>, GitError> {
    let mut refs: Vec<String> = std::iter::once(default_branch.to_string())
        .chain(
            other_branches
                .iter()
                .filter(|name| *name != default_branch)
                .cloned(),
        )
        .collect();
    refs.sort();
    refs.dedup();
    let graph_commit_limit = repo_graph_commit_limit(refs.len());
    let mut args: Vec<String> = vec![
        "log".to_string(),
        format!("--max-count={graph_commit_limit}"),
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P".to_string(),
    ];
    args.extend(refs);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = cli::run(repo, &arg_refs)?;
    let parsed: Vec<ParsedCommitLine> = output
        .lines()
        .filter(|s| !s.is_empty())
        .filter_map(parse_direct_commit_line)
        .collect();

    let mut non_default_branches: Vec<String> = other_branches
        .iter()
        .filter(|name| *name != default_branch)
        .cloned()
        .collect();
    non_default_branches.reverse();

    let mut default_first_parent_set = HashSet::<String>::new();
    let default_fp_output = cli::run(
        repo,
        &[
            "rev-list",
            "--first-parent",
            &format!("--max-count={graph_commit_limit}"),
            default_branch,
        ],
    )?;
    for sha in default_fp_output
        .lines()
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
    {
        default_first_parent_set.insert(sha.to_string());
    }

    let mut commit_parent_shas_by_sha = HashMap::<String, Vec<String>>::new();
    for commit in &parsed {
        commit_parent_shas_by_sha.insert(commit.full_sha.clone(), commit.parent_shas.clone());
    }

    let branch_order: Vec<String> = std::iter::once(default_branch.to_string())
        .chain(non_default_branches.iter().cloned())
        .collect();
    let mut head_sha_by_branch = HashMap::<String, String>::new();
    for branch_name in &branch_order {
        let head_output = cli::run(repo, &["rev-parse", branch_name])?;
        let head_sha = head_output.trim();
        if !head_sha.is_empty() {
            head_sha_by_branch.insert(branch_name.clone(), head_sha.to_string());
        }
    }

    let mut distance_by_commit_sha_and_branch = HashMap::<(String, String), usize>::new();
    let mut first_parent_distance_by_commit_sha_and_branch =
        HashMap::<(String, String), usize>::new();
    for branch_name in &branch_order {
        let Some(head_sha) = head_sha_by_branch.get(branch_name) else {
            continue;
        };
        let mut queue = VecDeque::<(String, usize)>::new();
        queue.push_back((head_sha.clone(), 0));
        let mut first_parent_queue = VecDeque::<(String, usize)>::new();
        first_parent_queue.push_back((head_sha.clone(), 0));

        while let Some((sha, distance)) = queue.pop_front() {
            let key = (sha.clone(), branch_name.clone());
            if let Some(existing) = distance_by_commit_sha_and_branch.get(&key) {
                if *existing <= distance {
                    continue;
                }
            }
            distance_by_commit_sha_and_branch.insert(key, distance);

            let Some(parent_shas) = commit_parent_shas_by_sha.get(&sha) else {
                continue;
            };
            for parent_sha in parent_shas {
                if parent_sha.is_empty() {
                    continue;
                }
                queue.push_back((parent_sha.clone(), distance + 1));
            }
        }

        while let Some((sha, distance)) = first_parent_queue.pop_front() {
            let key = (sha.clone(), branch_name.clone());
            if let Some(existing) = first_parent_distance_by_commit_sha_and_branch.get(&key) {
                if *existing <= distance {
                    continue;
                }
            }
            first_parent_distance_by_commit_sha_and_branch.insert(key, distance);

            let Some(parent_shas) = commit_parent_shas_by_sha.get(&sha) else {
                continue;
            };
            let Some(first_parent_sha) = parent_shas.first() else {
                continue;
            };
            if first_parent_sha.is_empty() {
                continue;
            }
            first_parent_queue.push_back((first_parent_sha.clone(), distance + 1));
        }
    }

    let mut disabled_branches = HashSet::<String>::new();
    for (b_index, b_name) in branch_order.iter().enumerate() {
        if b_name == default_branch {
            continue;
        }
        let Some(b_head) = head_sha_by_branch.get(b_name) else {
            continue;
        };
        for (a_index, a_name) in branch_order.iter().enumerate() {
            if a_name == b_name {
                continue;
            }
            if !head_sha_by_branch.contains_key(a_name) {
                continue;
            }
            let key = (b_head.clone(), a_name.clone());
            if first_parent_distance_by_commit_sha_and_branch.contains_key(&key) {
                let is_a_older = match (
                    branch_created_dates.get(a_name),
                    branch_created_dates.get(b_name),
                ) {
                    (Some(a_date), Some(b_date)) => {
                        a_date < b_date || (a_date == b_date && a_name < b_name)
                    }
                    _ => a_index < b_index,
                };
                if is_a_older {
                    disabled_branches.insert(b_name.clone());
                    break;
                }
            }
        }
    }

    let mut commits = parsed
        .into_iter()
        .map(|commit| DirectCommit {
            branch: assign_commit_branch(
                &commit.full_sha,
                default_branch,
                &branch_order,
                &disabled_branches,
                branch_created_dates,
                &default_first_parent_set,
                &first_parent_distance_by_commit_sha_and_branch,
                &distance_by_commit_sha_and_branch,
            ),
            full_sha: commit.full_sha,
            sha: commit.sha,
            parent_sha: commit.parent_sha,
            parent_shas: commit.parent_shas,
            child_shas: Vec::new(),
            cluster_key: None,
            message: commit.message,
            author: commit.author,
            date: commit.date,
            is_remote: false,
        })
        .collect::<Vec<_>>();

    let branch_by_commit_sha: HashMap<String, String> = commits
        .iter()
        .map(|commit| (commit.full_sha.clone(), commit.branch.clone()))
        .collect();
    for commit in &mut commits {
        let Some(parent_shas) = commit_parent_shas_by_sha.get(&commit.full_sha) else {
            continue;
        };
        if parent_shas.len() < 2 {
            continue;
        }
        let first_parent_branch = parent_shas
            .first()
            .and_then(|parent_sha| branch_by_commit_sha.get(parent_sha))
            .cloned()
            .or_else(|| {
                merge_target_branch_by_commit_sha
                    .get(&commit.full_sha)
                    .cloned()
            });
        if let Some(branch) = first_parent_branch {
            let reachable_from_branch = distance_by_commit_sha_and_branch
                .contains_key(&(commit.full_sha.clone(), branch.clone()));
            if !reachable_from_branch {
                continue;
            }
            commit.branch = branch;
        }
    }

    // Enforce branch ownership boundaries: a branch can only own commits that are
    // descendants of (or equal to) that branch's child/root commit on its first-parent line.
    let first_parent_by_sha: HashMap<String, String> = commit_parent_shas_by_sha
        .iter()
        .filter_map(|(sha, parents)| parents.first().map(|parent| (sha.clone(), parent.clone())))
        .collect();
    let is_branch_older = |a_name: &str, a_index: usize, b_name: &str, b_index: usize| -> bool {
        match (
            branch_created_dates.get(a_name),
            branch_created_dates.get(b_name),
        ) {
            (Some(a_date), Some(b_date)) => {
                a_date < b_date || (a_date == b_date && a_name < b_name)
            }
            _ => a_index < b_index,
        }
    };
    let mut child_sha_by_branch = HashMap::<String, String>::new();
    for (branch_index, branch_name) in branch_order.iter().enumerate() {
        if branch_name == default_branch {
            continue;
        }
        let Some(head_sha) = head_sha_by_branch.get(branch_name).cloned() else {
            continue;
        };
        let mut cursor = head_sha.clone();
        loop {
            let Some(parent_sha) = first_parent_by_sha.get(&cursor).cloned() else {
                child_sha_by_branch.insert(branch_name.clone(), cursor.clone());
                break;
            };
            let parent_reached_by_older_branch =
                branch_order
                    .iter()
                    .enumerate()
                    .any(|(other_index, other_name)| {
                        other_name != branch_name
                            && is_branch_older(other_name, other_index, branch_name, branch_index)
                            && first_parent_distance_by_commit_sha_and_branch
                                .contains_key(&(parent_sha.clone(), other_name.clone()))
                    });
            if parent_reached_by_older_branch {
                child_sha_by_branch.insert(branch_name.clone(), cursor.clone());
                break;
            }
            cursor = parent_sha;
        }
    }
    let mut descendant_cache = HashMap::<(String, String), bool>::new();
    let mut is_descendant_or_equal = |sha: &str, ancestor_sha: &str| -> bool {
        if sha == ancestor_sha {
            return true;
        }
        let key = (sha.to_string(), ancestor_sha.to_string());
        if let Some(value) = descendant_cache.get(&key).copied() {
            return value;
        }
        let mut queue = VecDeque::<String>::new();
        let mut visited = HashSet::<String>::new();
        queue.push_back(sha.to_string());
        visited.insert(sha.to_string());
        let mut found = false;
        while let Some(current_sha) = queue.pop_front() {
            let Some(parent_shas) = commit_parent_shas_by_sha.get(&current_sha) else {
                continue;
            };
            for parent_sha in parent_shas {
                if parent_sha.is_empty() {
                    continue;
                }
                if parent_sha == ancestor_sha {
                    found = true;
                    break;
                }
                if visited.insert(parent_sha.clone()) {
                    queue.push_back(parent_sha.clone());
                }
            }
            if found {
                break;
            }
        }
        descendant_cache.insert(key, found);
        found
    };
    let branch_accepts_commit = |branch_name: &str,
                                 commit_sha: &str,
                                 child_sha_by_branch: &HashMap<String, String>,
                                 is_descendant_or_equal: &mut dyn FnMut(&str, &str) -> bool|
     -> bool {
        if branch_name == default_branch {
            return true;
        }
        let Some(child_sha) = child_sha_by_branch.get(branch_name) else {
            return false;
        };
        is_descendant_or_equal(commit_sha, child_sha)
    };
    for commit in &mut commits {
        let current_branch_reachable = if commit.branch.is_empty() {
            false
        } else {
            distance_by_commit_sha_and_branch
                .contains_key(&(commit.full_sha.clone(), commit.branch.clone()))
        };
        if current_branch_reachable
            && commit.branch != default_branch
            && !disabled_branches.contains(&commit.branch)
            && branch_accepts_commit(
                &commit.branch,
                &commit.full_sha,
                &child_sha_by_branch,
                &mut is_descendant_or_equal,
            )
        {
            continue;
        }
        if branch_accepts_commit(
            &commit.branch,
            &commit.full_sha,
            &child_sha_by_branch,
            &mut is_descendant_or_equal,
        ) {
            continue;
        }
        let mut best_match: Option<(String, usize, usize, bool)> = None;
        for (branch_index, branch_name) in branch_order.iter().enumerate() {
            if disabled_branches.contains(branch_name) {
                continue;
            }
            if !branch_accepts_commit(
                branch_name,
                &commit.full_sha,
                &child_sha_by_branch,
                &mut is_descendant_or_equal,
            ) {
                continue;
            }
            let key = (commit.full_sha.clone(), branch_name.clone());
            let Some(distance) = distance_by_commit_sha_and_branch.get(&key).copied() else {
                continue;
            };
            let is_default_branch = branch_name == default_branch;
            match &best_match {
                None => {
                    best_match = Some((
                        branch_name.clone(),
                        distance,
                        branch_index,
                        is_default_branch,
                    ))
                }
                Some((best_branch_name, best_distance, best_index, best_is_default_branch)) => {
                    if is_default_branch != *best_is_default_branch {
                        if !is_default_branch {
                            best_match = Some((
                                branch_name.clone(),
                                distance,
                                branch_index,
                                is_default_branch,
                            ));
                        }
                        continue;
                    }
                    let is_candidate_older = match (
                        branch_created_dates.get(branch_name),
                        branch_created_dates.get(best_branch_name),
                    ) {
                        (Some(cand_date), Some(best_date)) => {
                            cand_date < best_date
                                || (cand_date == best_date && branch_name < best_branch_name)
                        }
                        _ => branch_index < *best_index,
                    };
                    if distance < *best_distance
                        || (distance == *best_distance && is_candidate_older)
                    {
                        best_match = Some((
                            branch_name.clone(),
                            distance,
                            branch_index,
                            is_default_branch,
                        ));
                    }
                }
            }
        }
        if let Some((branch_name, _, _, _)) = best_match {
            commit.branch = branch_name;
        } else {
            commit.branch.clear();
        }
    }

    Ok(with_cluster_keys(with_child_links(commits)))
}

fn assign_commit_branch(
    sha: &str,
    default_branch: &str,
    branch_order: &[String],
    disabled_branches: &HashSet<String>,
    branch_created_dates: &HashMap<String, String>,
    default_first_parent_set: &HashSet<String>,
    first_parent_distance_by_commit_sha_and_branch: &HashMap<(String, String), usize>,
    distance_by_commit_sha_and_branch: &HashMap<(String, String), usize>,
) -> String {
    // Keep mainline ownership stable for default branch first-parent commits.
    if default_first_parent_set.contains(sha) {
        return default_branch.to_string();
    }

    // Prefer the oldest first-parent owner. Descendant branches can reach parent
    // commits, but those commits still belong to the branch where they first
    // appeared; child branches only own commits their parents cannot reach.
    let mut first_parent_best_match: Option<(&str, usize, usize)> = None;
    for (branch_index, branch_name) in branch_order.iter().enumerate() {
        if disabled_branches.contains(branch_name) {
            continue;
        }
        let key = (sha.to_string(), branch_name.clone());
        let Some(distance) = first_parent_distance_by_commit_sha_and_branch
            .get(&key)
            .copied()
        else {
            continue;
        };
        match first_parent_best_match {
            None => first_parent_best_match = Some((branch_name.as_str(), distance, branch_index)),
            Some((best_branch_name, best_distance, best_index)) => {
                let is_candidate_older = match (
                    branch_created_dates.get(branch_name),
                    branch_created_dates.get(best_branch_name),
                ) {
                    (Some(cand_date), Some(best_date)) => {
                        cand_date < best_date
                            || (cand_date == best_date && branch_name.as_str() < best_branch_name)
                    }
                    _ => branch_index < best_index,
                };
                if is_candidate_older || (!is_candidate_older && distance < best_distance) {
                    first_parent_best_match = Some((branch_name.as_str(), distance, branch_index));
                }
            }
        }
    }
    if let Some((branch_name, _, _)) = first_parent_best_match {
        return branch_name.to_string();
    }

    // Otherwise, choose the branch head with shortest graph distance to this commit.
    let mut best_match: Option<(&str, usize, usize)> = None;
    for (branch_index, branch_name) in branch_order.iter().enumerate() {
        if disabled_branches.contains(branch_name) {
            continue;
        }
        let key = (sha.to_string(), branch_name.clone());
        let Some(distance) = distance_by_commit_sha_and_branch.get(&key).copied() else {
            continue;
        };
        match best_match {
            None => best_match = Some((branch_name.as_str(), distance, branch_index)),
            Some((best_branch_name, best_distance, best_index)) => {
                let is_candidate_older = match (
                    branch_created_dates.get(branch_name),
                    branch_created_dates.get(best_branch_name),
                ) {
                    (Some(cand_date), Some(best_date)) => {
                        cand_date < best_date
                            || (cand_date == best_date && branch_name.as_str() < best_branch_name)
                    }
                    _ => branch_index < best_index,
                };
                if distance < best_distance || (distance == best_distance && is_candidate_older) {
                    best_match = Some((branch_name.as_str(), distance, branch_index));
                }
            }
        }
    }
    if let Some((branch_name, _, _)) = best_match {
        return branch_name.to_string();
    }

    String::new()
}

#[cfg(test)]
mod branch_assignment_tests {
    use super::get_all_repo_commits;
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepo {
        path: PathBuf,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn run_git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap_or_else(|error| panic!("git {:?} failed to start: {error}", args));
        if !output.status.success() {
            panic!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn new_repo() -> TestRepo {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cobble-branch-assignment-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp repo");
        run_git(&path, &["init", "-b", "main"]);
        run_git(&path, &["config", "user.email", "test@example.com"]);
        run_git(&path, &["config", "user.name", "Test User"]);
        TestRepo { path }
    }

    fn commit_file(repo: &Path, file_name: &str, content: &str, message: &str) -> String {
        fs::write(repo.join(file_name), content).expect("write test file");
        run_git(repo, &["add", file_name]);
        run_git(repo, &["commit", "-m", message]);
        run_git(repo, &["rev-parse", "HEAD"])
    }

    #[test]
    fn assigns_deleted_fast_forward_branch_commits_to_default() {
        let repo = new_repo();
        commit_file(&repo.path, "main.txt", "base", "base");
        run_git(&repo.path, &["checkout", "-b", "feature"]);
        let feature_sha = commit_file(&repo.path, "feature.txt", "feature", "feature work");

        run_git(&repo.path, &["checkout", "main"]);
        run_git(&repo.path, &["merge", "--ff-only", "feature"]);
        run_git(&repo.path, &["branch", "-D", "feature"]);
        run_git(&repo.path, &["checkout", "-b", "other"]);
        commit_file(&repo.path, "other.txt", "other", "other work");

        let commits = get_all_repo_commits(
            &repo.path,
            "main",
            &["main".to_string(), "other".to_string()],
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("load commits");

        let feature_commit = commits
            .iter()
            .find(|commit| commit.full_sha == feature_sha)
            .expect("feature commit is reachable");
        assert_eq!(feature_commit.branch, "main");
    }

    #[test]
    fn assigns_deleted_merged_branch_commits_to_default_not_nearby_branch() {
        let repo = new_repo();
        commit_file(&repo.path, "main.txt", "base", "base");
        run_git(&repo.path, &["checkout", "-b", "feature"]);
        let feature_sha = commit_file(&repo.path, "feature.txt", "feature", "feature work");

        run_git(&repo.path, &["checkout", "main"]);
        run_git(&repo.path, &["merge", "--no-ff", "--no-edit", "feature"]);
        run_git(&repo.path, &["branch", "-D", "feature"]);
        run_git(&repo.path, &["checkout", "-b", "other"]);
        commit_file(&repo.path, "other.txt", "other", "other work");

        let commits = get_all_repo_commits(
            &repo.path,
            "main",
            &["main".to_string(), "other".to_string()],
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("load commits");

        let feature_commit = commits
            .iter()
            .find(|commit| commit.full_sha == feature_sha)
            .expect("feature commit is reachable");
        assert_eq!(feature_commit.branch, "main");
    }

    #[test]
    fn assigns_nested_deleted_branch_commits_in_fast_forwarded_history_to_default() {
        let repo = new_repo();
        commit_file(&repo.path, "main.txt", "base", "base");
        run_git(&repo.path, &["checkout", "-b", "feature"]);
        commit_file(&repo.path, "feature.txt", "feature", "feature work");
        run_git(&repo.path, &["checkout", "-b", "nested"]);
        let nested_sha = commit_file(&repo.path, "nested.txt", "nested", "nested work");

        run_git(&repo.path, &["checkout", "feature"]);
        run_git(&repo.path, &["merge", "--no-ff", "--no-edit", "nested"]);
        run_git(&repo.path, &["branch", "-D", "nested"]);
        run_git(&repo.path, &["checkout", "main"]);
        run_git(&repo.path, &["merge", "--ff-only", "feature"]);
        run_git(&repo.path, &["branch", "-D", "feature"]);
        run_git(&repo.path, &["checkout", "-b", "other"]);
        commit_file(&repo.path, "other.txt", "other", "other work");

        let commits = get_all_repo_commits(
            &repo.path,
            "main",
            &["main".to_string(), "other".to_string()],
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("load commits");

        let nested_commit = commits
            .iter()
            .find(|commit| commit.full_sha == nested_sha)
            .expect("nested commit is reachable");
        assert_eq!(nested_commit.branch, "main");
    }

    #[test]
    fn new_branch_from_existing_branch_does_not_own_parent_commits() {
        let repo = new_repo();
        commit_file(&repo.path, "main.txt", "base", "base");
        run_git(&repo.path, &["checkout", "-b", "branch-a"]);
        let a_sha = commit_file(&repo.path, "a.txt", "a", "branch A work");
        run_git(&repo.path, &["checkout", "-b", "branch-b"]);
        let mut branch_dates = HashMap::new();
        branch_dates.insert("main".to_string(), "2024-01-01T00:00:00Z".to_string());
        branch_dates.insert("branch-a".to_string(), "2024-01-02T00:00:00Z".to_string());
        branch_dates.insert("branch-b".to_string(), "2024-01-03T00:00:00Z".to_string());

        let commits = get_all_repo_commits(
            &repo.path,
            "main",
            &[
                "main".to_string(),
                "branch-a".to_string(),
                "branch-b".to_string(),
            ],
            &branch_dates,
            &HashMap::new(),
        )
        .expect("load commits");

        let a_commit = commits
            .iter()
            .find(|commit| commit.full_sha == a_sha)
            .expect("branch A commit is reachable");
        assert_eq!(a_commit.branch, "branch-a");
        assert!(
            commits.iter().all(|commit| commit.branch != "branch-b"),
            "branch-b should not own inherited branch-a commits"
        );
    }

    #[test]
    fn child_branch_only_owns_commits_after_branch_point() {
        let repo = new_repo();
        commit_file(&repo.path, "main.txt", "base", "base");
        run_git(&repo.path, &["checkout", "-b", "branch-a"]);
        let a_sha = commit_file(&repo.path, "a.txt", "a", "branch A work");
        run_git(&repo.path, &["checkout", "-b", "branch-b"]);
        let b_sha = commit_file(&repo.path, "b.txt", "b", "branch B work");
        let mut branch_dates = HashMap::new();
        branch_dates.insert("main".to_string(), "2024-01-01T00:00:00Z".to_string());
        branch_dates.insert("branch-a".to_string(), "2024-01-02T00:00:00Z".to_string());
        branch_dates.insert("branch-b".to_string(), "2024-01-03T00:00:00Z".to_string());

        let commits = get_all_repo_commits(
            &repo.path,
            "main",
            &[
                "main".to_string(),
                "branch-a".to_string(),
                "branch-b".to_string(),
            ],
            &branch_dates,
            &HashMap::new(),
        )
        .expect("load commits");

        let a_commit = commits
            .iter()
            .find(|commit| commit.full_sha == a_sha)
            .expect("branch A commit is reachable");
        let b_commit = commits
            .iter()
            .find(|commit| commit.full_sha == b_sha)
            .expect("branch B commit is reachable");
        assert_eq!(a_commit.branch, "branch-a");
        assert_eq!(b_commit.branch, "branch-b");
    }
}

fn parse_direct_commit_line(line: &str) -> Option<ParsedCommitLine> {
    let parts: Vec<&str> = line.splitn(6, LOG_FIELD_SEPARATOR).collect();
    if parts.len() < 6 {
        return None;
    }
    let parent_sha = parts[5]
        .split_whitespace()
        .next()
        .map(|value| value.to_string());
    Some(ParsedCommitLine {
        full_sha: parts[0].to_string(),
        sha: parts[1].to_string(),
        parent_sha,
        parent_shas: parts[5]
            .split_whitespace()
            .map(|value| value.to_string())
            .collect(),
        message: parts[2].to_string(),
        author: parts[3].to_string(),
        date: parts[4].to_string(),
    })
}

fn build_direct_commits(
    parsed: Vec<ParsedCommitLine>,
    branch: String,
    is_remote: bool,
) -> Vec<DirectCommit> {
    let commits = parsed
        .into_iter()
        .map(|commit| DirectCommit {
            full_sha: commit.full_sha,
            sha: commit.sha,
            parent_sha: commit.parent_sha,
            parent_shas: commit.parent_shas,
            child_shas: Vec::new(),
            cluster_key: None,
            branch: branch.clone(),
            message: commit.message,
            author: commit.author,
            date: commit.date,
            is_remote,
        })
        .collect::<Vec<_>>();
    with_child_links(commits)
}

fn with_child_links(mut commits: Vec<DirectCommit>) -> Vec<DirectCommit> {
    let mut child_shas_by_parent = HashMap::<String, Vec<String>>::new();
    for commit in &commits {
        for parent_sha in &commit.parent_shas {
            if parent_sha.is_empty() {
                continue;
            }
            child_shas_by_parent
                .entry(parent_sha.clone())
                .or_default()
                .push(commit.full_sha.clone());
        }
    }
    for commit in &mut commits {
        let mut child_shas = child_shas_by_parent
            .get(&commit.full_sha)
            .cloned()
            .unwrap_or_default();
        child_shas.sort();
        child_shas.dedup();
        commit.child_shas = child_shas;
    }
    commits
}

fn with_cluster_keys(mut commits: Vec<DirectCommit>) -> Vec<DirectCommit> {
    const CLUSTER_PARENT_TIME_WINDOW_SECS: i64 = 90 * 60;
    const CLUSTER_PARENT_MAX_INTERVENING_COMMITS: usize = 1;

    let commit_time_secs = |date: &str| -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(date)
            .ok()
            .map(|dt| dt.timestamp())
    };

    let mut branch_by_sha = HashMap::<String, String>::new();
    for commit in &commits {
        branch_by_sha.insert(commit.full_sha.clone(), commit.branch.clone());
    }

    let mut indexes_by_branch = HashMap::<String, Vec<usize>>::new();
    for (index, commit) in commits.iter().enumerate() {
        indexes_by_branch
            .entry(commit.branch.clone())
            .or_default()
            .push(index);
    }

    for (branch, indexes) in indexes_by_branch {
        let mut ordered = indexes;
        ordered.sort_by(|left, right| {
            let left_commit = &commits[*left];
            let right_commit = &commits[*right];
            left_commit
                .date
                .cmp(&right_commit.date)
                .then_with(|| left_commit.full_sha.cmp(&right_commit.full_sha))
        });

        let mut cluster_idx = 0usize;
        let mut previous_sha: Option<String> = None;
        let mut position_by_sha = HashMap::<String, usize>::new();
        for (position, index) in ordered.iter().enumerate() {
            position_by_sha.insert(commits[*index].full_sha.clone(), position);
        }
        for (position, index) in ordered.iter().copied().enumerate() {
            let commit = &commits[index];
            let starts_new_cluster = match &previous_sha {
                None => true,
                Some(prev_sha) => {
                    let previous = commits
                        .iter()
                        .find(|candidate| candidate.full_sha == *prev_sha);
                    let parent_matches_previous = commit
                        .parent_sha
                        .as_ref()
                        .map(|parent_sha| parent_sha == prev_sha)
                        .unwrap_or(false);
                    let parent_branch_matches = commit
                        .parent_sha
                        .as_ref()
                        .and_then(|parent_sha| branch_by_sha.get(parent_sha))
                        .map(|parent_branch| parent_branch == &branch)
                        .unwrap_or(false);
                    let previous_has_single_child = previous
                        .map(|prev| prev.child_shas.len() == 1)
                        .unwrap_or(false);
                    let strict_continuity = parent_matches_previous
                        && parent_branch_matches
                        && previous_has_single_child;
                    if strict_continuity {
                        false
                    } else {
                        let parent_bridge = commit.parent_sha.as_ref().and_then(|parent_sha| {
                            let parent_position = position_by_sha.get(parent_sha).copied()?;
                            if parent_position >= position {
                                return None;
                            }
                            let parent_branch_matches = branch_by_sha
                                .get(parent_sha)
                                .map(|parent_branch| parent_branch == &branch)
                                .unwrap_or(false);
                            if !parent_branch_matches {
                                return None;
                            }
                            let parent_index = ordered[parent_position];
                            let parent = &commits[parent_index];
                            if parent.child_shas.len() != 1 {
                                return None;
                            }
                            let intervening = position.saturating_sub(parent_position + 1);
                            if intervening > CLUSTER_PARENT_MAX_INTERVENING_COMMITS {
                                return None;
                            }
                            let parent_time = commit_time_secs(&parent.date)?;
                            let commit_time = commit_time_secs(&commit.date)?;
                            let time_gap = (commit_time - parent_time).abs();
                            if time_gap > CLUSTER_PARENT_TIME_WINDOW_SECS {
                                return None;
                            }
                            Some(())
                        });
                        parent_bridge.is_none()
                    }
                }
            };
            if starts_new_cluster {
                cluster_idx += 1;
            }
            commits[index].cluster_key = Some(format!("cluster:{branch}:{cluster_idx}"));
            previous_sha = Some(commits[index].full_sha.clone());
        }
    }

    commits
}

/// Compact summary for AI commit/stash titles (`--stat` + status, not full hunks).
pub fn get_working_tree_summary(repo: &Path) -> Result<String, GitError> {
    let stat = cli::run(repo, &["diff", "HEAD", "--stat", "--no-color"]).unwrap_or_default();
    let status =
        cli::run(repo, &["status", "--short", "--untracked-files=normal"]).unwrap_or_default();
    if stat.trim().is_empty() && status.trim().is_empty() {
        return Ok(String::new());
    }
    Ok(format!("{stat}\n--- status ---\n{status}"))
}

/// Stage all changes (`git add -A`) and create a commit with the given message.
pub fn commit_working_tree(repo: &Path, message: &str) -> Result<(), GitError> {
    cli::run(repo, &["add", "-A"])?;
    cli::run(repo, &["commit", "-m", message])?;
    Ok(())
}

/// Stage all changes (`git add -A`) without creating a commit.
pub fn stage_working_tree(repo: &Path) -> Result<(), GitError> {
    cli::run(repo, &["add", "-A"])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeNode {
    pub sha: String,
    pub full_sha: String,
    pub pr_number: Option<i32>,
    pub pr_title: Option<String>,
    pub date: String,
    pub parent_shas: Vec<String>,
    pub target_branch: String,
    pub target_commit_sha: String,
}

/// Get merge commits from a branch (commits with 2+ parents)
pub fn get_merge_commits(
    repo: &Path,
    branch: &str,
    exclude_ref: Option<&str>,
    page: u32,
    per_page: u32,
) -> Result<(Vec<MergeNode>, bool), GitError> {
    let skip = page * per_page;
    // Fetch one extra to determine if there are more
    let limit = per_page + 1;

    let revision = if let Some(exclude) = exclude_ref {
        if exclude.is_empty() {
            branch.to_string()
        } else {
            let merge_base = cli::run(repo, &["merge-base", branch, exclude])
                .ok()
                .map(|output| output.trim().to_string())
                .filter(|value| !value.is_empty());
            if let Some(base) = merge_base {
                format!("{}..{}", base, branch)
            } else {
                branch.to_string()
            }
        }
    } else {
        branch.to_string()
    };

    let args = vec![
        "log".to_string(),
        "--merges".to_string(),
        "--first-parent".to_string(),
        format!("--max-count={}", limit),
        format!("--skip={}", skip),
        "--format=%H%x1f%h%x1f%s%x1f%cI%x1f%P".to_string(),
        revision,
    ];
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<&str>>();
    let output = cli::run(repo, &arg_refs)?;

    let mut nodes: Vec<MergeNode> = output
        .lines()
        .filter(|s| !s.is_empty())
        .filter_map(|line| parse_merge_commit(line, branch))
        .collect();

    // Check if there are more results
    let has_more = nodes.len() > per_page as usize;
    if has_more {
        nodes.pop(); // Remove the extra one we fetched
    }

    Ok((nodes, has_more))
}

fn parse_merge_commit(line: &str, target_branch: &str) -> Option<MergeNode> {
    let parts: Vec<&str> = line.splitn(5, LOG_FIELD_SEPARATOR).collect();
    if parts.len() < 5 {
        return None;
    }

    let full_sha = parts[0].to_string();
    let sha = parts[1].to_string();
    let subject = parts[2];
    let date = parts[3].to_string();
    let parent_shas = parts[4]
        .split_whitespace()
        .map(|sha| sha.to_string())
        .collect::<Vec<String>>();

    // Parse PR number from commit message
    // Common formats:
    // "Merge pull request #123 from user/branch"
    // "Merge branch 'feature' (#123)"
    let (pr_number, pr_title) = parse_pr_info(subject);

    Some(MergeNode {
        sha,
        target_commit_sha: full_sha.clone(),
        full_sha,
        pr_number,
        pr_title,
        date,
        parent_shas,
        target_branch: target_branch.to_string(),
    })
}

fn parse_pr_info(subject: &str) -> (Option<i32>, Option<String>) {
    // Try "Merge pull request #123 from ..."
    if subject.starts_with("Merge pull request #") {
        if let Some(rest) = subject.strip_prefix("Merge pull request #") {
            let parts: Vec<&str> = rest.splitn(2, ' ').collect();
            if let Some(num_str) = parts.first() {
                if let Ok(num) = num_str.parse::<i32>() {
                    // Extract title from "from user/branch-name"
                    let title = parts
                        .get(1)
                        .map(|s| s.strip_prefix("from ").unwrap_or(s).to_string());
                    return (Some(num), title);
                }
            }
        }
    }

    // Try "(#123)" anywhere in the message
    if let Some(start) = subject.find("(#") {
        if let Some(end) = subject[start..].find(')') {
            let num_str = &subject[start + 2..start + end];
            if let Ok(num) = num_str.parse::<i32>() {
                // Use the part before (#123) as title
                let title = subject[..start].trim().to_string();
                return (Some(num), if title.is_empty() { None } else { Some(title) });
            }
        }
    }

    // Try "#123" anywhere
    for (i, _) in subject.match_indices('#') {
        let rest = &subject[i + 1..];
        let num_end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if num_end > 0 {
            if let Ok(num) = rest[..num_end].parse::<i32>() {
                return (Some(num), None);
            }
        }
    }

    (None, None)
}

#[cfg(test)]
mod remote_merge_tests {
    use super::*;
    use crate::git::branches::{build_remote_only_branch, list_origin_branch_heads};
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    #[test]
    fn merges_remote_only_cursor_branch_commit() {
        let repo = repo_root();
        if super::cli::run(
            &repo,
            &[
                "rev-parse",
                "--verify",
                "origin/cursor/commit-app-previews-7896",
            ],
        )
        .is_err()
        {
            return;
        }

        let default_branch = "main";
        let branch_name = "cursor/commit-app-previews-7896";
        let upstream_ref = format!("origin/{branch_name}");
        let mut commits =
            get_all_repo_commits(&repo, default_branch, &[], &HashMap::new(), &HashMap::new())
                .expect("local commits");

        merge_remote_only_branch_commits(
            &repo,
            default_branch,
            &branch_name,
            &upstream_ref,
            &mut commits,
        )
        .expect("remote-only merge");

        let remote_commit = commits
            .iter()
            .find(|commit| commit.branch == branch_name && commit.is_remote);
        assert!(
            remote_commit.is_some(),
            "expected remote commit on {branch_name}, got branches: {:?}",
            commits
                .iter()
                .filter(|commit| commit.full_sha.starts_with("c131b6f"))
                .map(|commit| (&commit.branch, commit.is_remote))
                .collect::<Vec<_>>()
        );

        let branch = build_remote_only_branch(
            &repo,
            &branch_name,
            remote_commit.unwrap().full_sha.as_str(),
            default_branch,
        )
        .expect("remote branch metadata");
        assert!(branch.commits_ahead >= 1);
        assert_eq!(branch.remote_sync_status, "on-github");
    }

    #[test]
    fn lists_origin_cursor_branch_head() {
        let repo = repo_root();
        let heads = list_origin_branch_heads(&repo).expect("origin heads");
        assert!(
            heads
                .iter()
                .any(|(name, _)| name == "cursor/commit-app-previews-7896"),
            "missing origin cursor branch in {:?}",
            heads.iter().take(5).collect::<Vec<_>>()
        );
    }
}
