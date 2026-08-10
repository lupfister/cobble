mod branches;
pub mod cli;
mod commits;
mod preview;
mod stash;
mod worktrees;

pub use branches::{
    branch_from_ref_sig_entry, branch_head_digest_from_ref_sig, build_remote_only_branch,
    compute_remote_heads_digest, fetch_remotes, format_branch_head_digest,
    get_branch_info_for_name, get_checked_out_ref, get_default_branch, get_repo_info,
    list_branches, list_local_branch_heads, list_origin_branch_heads, resolve_branch_upstream_ref,
    try_fast_forward_pull, Branch, CheckedOutRef,
};
pub use commits::{
    commit_working_tree, get_all_repo_commits, get_branch_commits_since, get_direct_commits,
    get_merge_commits, get_working_tree_summary, merge_remote_only_branch_commits,
    merge_upstream_ahead_commits, stage_working_tree, DirectCommit, MergeNode,
};
pub use preview::{
    clear_active_preview_target, detect_localhost_url, mark_install_success,
    prepare_preview_target, preview_path_needs_install, should_run_install, ActivePreviewTarget,
    PreparePreviewTargetResult, PreviewTarget,
};
pub use stash::{
    apply_stash_restore, create_branch_from_uncommitted, create_root_branch, list_stashes,
    move_stash_to_new_branch, stash_drop, stash_push, GitStashEntry,
};
pub use worktrees::{
    list_worktree_paths, list_worktrees, remove_worktree as remove_git_worktree, WorktreeInfo,
};
