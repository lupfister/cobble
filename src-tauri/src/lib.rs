mod git;
mod github;
#[cfg(target_os = "macos")]
mod macos_traffic_lights;
mod opencode;
mod repo_git_gate;
mod terminal_ai_titles;
mod terminal_host;

pub fn run_terminal_host() -> Result<(), String> {
    terminal_host::run_terminal_host()
}

use tauri::{Emitter, Manager};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_window_state::{StateFlags, WindowExt};

use chrono::{DateTime, Duration, Utc};
use git::{Branch, CheckedOutRef, DirectCommit, MergeNode};
use github::{GitHubAuthStatus, GitHubInfo, MergedPR, OpenPR};
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    name: String,
    path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PushResult {
    branch_name: String,
    target_sha: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSelectionResult {
    deleted_branches: Vec<String>,
    discarded_uncommitted_changes: bool,
    checked_out_ref: Option<CheckedOutRef>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWorktreeResult {
    deleted_branch: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SquashCommitRangeResult {
    branch_name: String,
    squashed_sha: String,
    commit_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommitMutationResult {
    worktree_path: String,
    checked_out_ref: CheckedOutRef,
    branch_name: String,
    full_sha: String,
    sha: String,
    message: String,
    author: String,
    date: String,
    parent_sha: Option<String>,
    parent_shas: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeneratedCommitDraftResult {
    commit_message: String,
    branch_name: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StashPushResult {
    worktree_path: String,
    stash: git::GitStashEntry,
    checked_out_ref: CheckedOutRef,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StashDropResult {
    removed_index: u32,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StashRestoreResult {
    removed_index: u32,
    checked_out_ref: CheckedOutRef,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PersistProjectSnapshotResult {
    persisted: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectPreviewConfig {
    install_command: String,
    run_command: String,
    last_confirmed_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectPreviewDefaults {
    install_command: String,
    run_command: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectPreviewResult {
    preview_path: String,
    target_id: String,
    url: Option<String>,
    status: String,
    logs: String,
    preview_mode: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectPreviewLogTail {
    logs: String,
}

struct PreviewProcess {
    child: Child,
    log_path: PathBuf,
    preview_path: String,
    target_id: String,
    preview_mode: String,
}

struct RepoWatcherActivity {
    last_git_event_epoch: AtomicU64,
    last_worktree_event_epoch: AtomicU64,
}

static WATCHER_ACTIVITY: OnceLock<Mutex<HashMap<String, std::sync::Arc<RepoWatcherActivity>>>> =
    OnceLock::new();

fn increment_watcher_activity(repo_path: &str, is_git: bool) {
    let normalized = normalize_repo_path_id(repo_path);
    let mut map = WATCHER_ACTIVITY
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let entry = map.entry(normalized.clone()).or_insert_with(|| {
        std::sync::Arc::new(RepoWatcherActivity {
            last_git_event_epoch: AtomicU64::new(0),
            last_worktree_event_epoch: AtomicU64::new(0),
        })
    });
    if is_git {
        entry.last_git_event_epoch.fetch_add(1, Ordering::Relaxed);
    } else {
        entry
            .last_worktree_event_epoch
            .fetch_add(1, Ordering::Relaxed);
    }
}

static WATCHER_STATE: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
    OnceLock::new();
static REPO_CHANGE_STATE: OnceLock<Mutex<HashMap<String, RepoChangeState>>> = OnceLock::new();
static PREVIEW_PROCESS_STATE: OnceLock<Mutex<HashMap<String, PreviewProcess>>> = OnceLock::new();
static DELETED_PROJECTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PREVIEW_SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
const MAX_LAYOUT_SNAPSHOTS_PER_REPO: i64 = 12;
const PREVIEW_LOG_TAIL_BYTES: u64 = 64 * 1024;
const PREVIEW_LOG_MAX_LINES: usize = 200;

fn project_is_deleted(id: &str) -> Result<bool, String> {
    DELETED_PROJECTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|deleted| deleted.contains(id))
        .map_err(|_| "Deleted project state lock poisoned".to_string())
}
const PREVIEW_LOG_COMPACT_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024;
const PREVIEW_LOG_COMPACT_KEEP_BYTES: u64 = 1024 * 1024;
/// Debounce bursty editor saves before emitting working-tree `local` activity.
const GIT_ACTIVITY_WORKTREE_DEBOUNCE_MS: u64 = 500;

const REPO_CHANGE_LOCAL: u8 = 1;
const REPO_CHANGE_GRAPH: u8 = 2;

#[derive(Clone, Copy, Default)]
struct RepoChangeState {
    generation: u64,
    reasons: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChangeSignal {
    repo_path: String,
    generation: u64,
    local_changed: bool,
    graph_changed: bool,
}

fn record_repo_change(repo_path: &str, reasons: u8) {
    let key = normalize_repo_path_id(repo_path);
    repo_git_gate::invalidate_probe_signature(&key);
    let mut states = REPO_CHANGE_STATE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("repo change state mutex poisoned");
    let state = states.entry(key).or_default();
    state.generation = state.generation.wrapping_add(1).max(1);
    state.reasons |= reasons;
}

#[tauri::command(rename_all = "camelCase")]
fn get_repo_change_signal(repo_path: String, after_generation: Option<u64>) -> RepoChangeSignal {
    let key = normalize_repo_path_id(&repo_path);
    let mut states = REPO_CHANGE_STATE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("repo change state mutex poisoned");
    let state = states.entry(key.clone()).or_default();
    let changed = after_generation.map_or(true, |generation| generation != state.generation);
    let reasons = if changed { state.reasons } else { 0 };
    if changed {
        state.reasons = 0;
    }
    RepoChangeSignal {
        repo_path: key,
        generation: state.generation,
        local_changed: reasons & REPO_CHANGE_LOCAL != 0,
        graph_changed: reasons & REPO_CHANGE_GRAPH != 0,
    }
}

async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Blocking task failed: {e}"))?
}
const REPO_VISUAL_CACHE_SCHEMA_VERSION: i32 = 9;
const PROJECT_SNAPSHOT_SCHEMA_VERSION: i32 = 3;
const PROJECT_SNAPSHOT_RETAIN_COUNT: i64 = 2;
#[cfg(target_os = "macos")]
const OPEN_REPO_DETECTION_CACHE_TTL: StdDuration = StdDuration::from_secs(8);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitActivityEventPayload {
    repo_path: String,
    kind: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BranchCommitPreviewEntry {
    full_sha: String,
    sha: String,
    parent_sha: Option<String>,
    parent_shas: Vec<String>,
    child_shas: Vec<String>,
    message: String,
    author: String,
    date: String,
    kind: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    is_remote: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoVisualSnapshot {
    path: String,
    name: String,
    default_branch: String,
    branches: Vec<Branch>,
    merge_nodes: Vec<MergeNode>,
    direct_commits: Vec<DirectCommit>,
    unpushed_direct_commits: Vec<DirectCommit>,
    merge_target_branch_by_commit_sha: HashMap<String, String>,
    unpushed_commit_shas_by_branch: HashMap<String, Vec<String>>,
    checked_out_ref: Option<CheckedOutRef>,
    worktrees: Vec<git::WorktreeInfo>,
    stashes: Vec<git::GitStashEntry>,
    branch_commit_previews: HashMap<String, Vec<BranchCommitPreviewEntry>>,
    branch_parent_by_name: HashMap<String, Option<String>>,
    lane_by_branch: HashMap<String, i32>,
    branch_unique_ahead_counts: HashMap<String, i32>,
    loaded: bool,
    cache_schema_version: i32,
    updated_at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoRefreshFingerprint {
    repo_path: String,
    default_branch: String,
    head_sha: String,
    upstream_sha: Option<String>,
    has_uncommitted_changes: bool,
    branch_count: usize,
    worktree_count: usize,
    stash_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoQuickState {
    repo_path: String,
    head_sha: String,
    upstream_sha: Option<String>,
    has_uncommitted_changes: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoHeadState {
    repo_path: String,
    head_sha: String,
    upstream_sha: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoSyncWorktreeDirty {
    path: String,
    has_uncommitted_changes: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoSyncTokens {
    repo_path: String,
    dirty_token: String,
    graph_token: String,
    dirty_worktrees: Vec<RepoSyncWorktreeDirty>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SimpleGraphNode {
    id: String,
    branch_name: String,
    clump_id: String,
    x_horizontal: f64,
    y_horizontal: f64,
    x_vertical: f64,
    y_vertical: f64,
    parent_sha: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SimpleGraphClump {
    id: String,
    branch_name: String,
    commit_shas: Vec<String>,
    lead_sha: String,
    count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectGraphSnapshotPayload {
    repo_visual_snapshot: RepoVisualSnapshot,
    clumps: Vec<SimpleGraphClump>,
    simple_nodes: Vec<SimpleGraphNode>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshotRecord {
    project_id: String,
    repo_path: String,
    snapshot_version: i64,
    fingerprint: String,
    schema_version: i32,
    created_at_ms: i64,
    payload: ProjectGraphSnapshotPayload,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectLoadProgressEvent {
    repo_path: String,
    status: String,
    phase: String,
    progress: u8,
    error: Option<String>,
}

fn emit_project_load_progress(
    app: &tauri::AppHandle,
    repo_path: &str,
    status: &str,
    phase: &str,
    progress: u8,
    error: Option<String>,
) {
    let _ = app.emit(
        "project-load-progress",
        ProjectLoadProgressEvent {
            repo_path: normalize_repo_path_id(repo_path),
            status: status.to_string(),
            phase: phase.to_string(),
            progress: progress.min(100),
            error,
        },
    );
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FingerprintCheckResult {
    project_id: String,
    repo_path: String,
    changed: bool,
    current_fingerprint: String,
    stored_fingerprint: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RefreshProjectResult {
    project_id: String,
    repo_path: String,
    updated: bool,
    snapshot: Option<ProjectSnapshotRecord>,
}

fn parse_time_ms(value: Option<&str>) -> i64 {
    value
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn compute_lane_by_branch(
    branches: &[Branch],
    default_branch: &str,
    branch_commit_previews: &HashMap<String, Vec<BranchCommitPreviewEntry>>,
    branch_parent_by_name: &HashMap<String, Option<String>>,
) -> HashMap<String, i32> {
    let by_name: HashMap<String, Branch> = branches
        .iter()
        .cloned()
        .map(|branch| (branch.name.clone(), branch))
        .collect();
    let mut first_commit_time_by_branch = HashMap::<String, i64>::new();
    for branch in branches {
        let first_time = branch_commit_previews
            .get(&branch.name)
            .into_iter()
            .flat_map(|previews| previews.iter())
            .filter(|preview| preview.kind != "branch-created")
            .filter_map(|preview| {
                chrono::DateTime::parse_from_rfc3339(&preview.date)
                    .ok()
                    .map(|dt| dt.timestamp_millis())
            })
            .min();
        if let Some(time) = first_time {
            first_commit_time_by_branch.insert(branch.name.clone(), time);
        }
    }
    let branch_start_time = |branch: &Branch| -> i64 {
        first_commit_time_by_branch
            .get(&branch.name)
            .copied()
            .unwrap_or_else(|| {
                parse_time_ms(
                    branch
                        .created_date
                        .as_deref()
                        .or(branch.diverged_from_date.as_deref())
                        .or(Some(branch.last_commit_date.as_str())),
                )
            })
    };
    let resolve_parent = |branch: &Branch| -> Option<String> {
        let mapped = branch_parent_by_name
            .get(&branch.name)
            .and_then(|value| value.clone());
        if let Some(parent) = mapped {
            if parent != branch.name && (parent == default_branch || by_name.contains_key(&parent))
            {
                return Some(parent);
            }
        }
        if let Some(parent) = branch.parent_branch.clone() {
            if parent != branch.name && by_name.contains_key(&parent) {
                return Some(parent);
            }
        }
        None
    };

    let mut lane_by_name = HashMap::<String, i32>::new();
    lane_by_name.insert(default_branch.to_string(), 0);

    let mut pending: Vec<Branch> = branches
        .iter()
        .filter(|branch| branch.name != default_branch)
        .cloned()
        .collect();
    pending.sort_by(|left, right| {
        branch_start_time(left)
            .cmp(&branch_start_time(right))
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut detached_cursor = 1_i32;
    for branch in pending {
        let parent = resolve_parent(&branch);
        let lane = if let Some(parent_name) = parent {
            let parent_lane = lane_by_name.get(&parent_name).copied().unwrap_or(0);
            (parent_lane + 1).max(detached_cursor)
        } else {
            detached_cursor
        };
        lane_by_name.insert(branch.name.clone(), lane);
        detached_cursor = detached_cursor.max(lane + 1);
    }
    lane_by_name
}

fn path_contains_noise_dir(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(
            name.as_ref(),
            "node_modules"
                | ".next"
                | "dist"
                | "build"
                | "target"
                | ".turbo"
                | "out"
                | "__pycache__"
                | ".venv"
                | "venv"
                | ".pytest_cache"
                | "coverage"
                | ".gradle"
                | "DerivedData"
        )
    })
}

fn worktree_watch_roots_same(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => {
            let trim = |p: &Path| {
                p.to_string_lossy()
                    .trim_end_matches(|c| c == '/' || c == '\\')
                    .to_string()
            };
            trim(a) == trim(b)
        }
    }
}

fn visual_cache_db_path() -> Result<PathBuf, String> {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::cache_dir)
        .ok_or_else(|| "Could not determine local data directory".to_string())?;
    Ok(base_dir.join("cobble").join("repo-visual-cache.sqlite3"))
}

fn preview_worktree_storage_root() -> Result<PathBuf, String> {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::cache_dir)
        .ok_or_else(|| "Could not determine local data directory".to_string())?;
    Ok(base_dir.join("cobble").join("preview-worktrees"))
}

fn open_visual_cache_connection() -> Result<Connection, String> {
    let db_path = visual_cache_db_path()?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create cache directory: {e}"))?;
    }
    let conn =
        Connection::open(db_path).map_err(|e| format!("Failed to open cache database: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let _ = conn.pragma_update(None, "journal_mode", &"WAL");
    let _ = conn.pragma_update(None, "synchronous", &"NORMAL");
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS repo_visual_cache (
            repo_path TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            schema_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS repo_layout_cache (
            repo_path TEXT NOT NULL,
            layout_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (repo_path, layout_key)
        );
        CREATE TABLE IF NOT EXISTS repo_node_position_cache (
            repo_path TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_registry (
            project_id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL UNIQUE,
            active_snapshot_version INTEGER,
            last_fingerprint TEXT,
            last_checked_at_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS project_snapshot (
            project_id TEXT NOT NULL,
            repo_path TEXT NOT NULL,
            snapshot_version INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (project_id, snapshot_version)
        );
        CREATE INDEX IF NOT EXISTS idx_project_snapshot_active
            ON project_snapshot(project_id, is_active, snapshot_version DESC);
        CREATE TABLE IF NOT EXISTS deleted_remote_branches (
            repo_path TEXT NOT NULL,
            branch_name TEXT NOT NULL,
            remote_ref TEXT NOT NULL,
            sha TEXT NOT NULL,
            deleted_at_ms INTEGER NOT NULL,
            PRIMARY KEY (repo_path, branch_name, remote_ref)
        );
        ",
    )
    .map_err(|e| format!("Failed to initialize cache schema: {e}"))?;
    Ok(conn)
}

fn load_cached_repo_visual_snapshot(repo_path: &str) -> Result<Option<RepoVisualSnapshot>, String> {
    let conn = open_visual_cache_connection()?;
    let row: Option<(String, i32)> = conn
        .query_row(
            "SELECT payload_json, schema_version FROM repo_visual_cache WHERE repo_path = ?1",
            params![repo_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read cache row: {e}"))?;
    let Some((payload_json, schema_version)) = row else {
        return Ok(None);
    };
    if schema_version != REPO_VISUAL_CACHE_SCHEMA_VERSION {
        return Ok(None);
    }
    let payload = serde_json::from_str::<RepoVisualSnapshot>(&payload_json)
        .map_err(|e| format!("Failed to decode cached snapshot: {e}"))?;
    Ok(Some(payload))
}

fn store_repo_visual_snapshot(snapshot: &RepoVisualSnapshot) -> Result<(), String> {
    let id = normalize_repo_path_id(&snapshot.path);
    if project_is_deleted(&id)? {
        return Ok(());
    }
    let conn = open_visual_cache_connection()?;
    let payload_json = serde_json::to_string(snapshot)
        .map_err(|e| format!("Failed to encode repo snapshot: {e}"))?;
    conn.execute(
        "
        INSERT INTO repo_visual_cache (repo_path, payload_json, updated_at_ms, schema_version)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(repo_path) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at_ms = excluded.updated_at_ms,
            schema_version = excluded.schema_version
        ",
        params![
            snapshot.path,
            payload_json,
            snapshot.updated_at_ms,
            REPO_VISUAL_CACHE_SCHEMA_VERSION,
        ],
    )
    .map_err(|e| format!("Failed to upsert repo snapshot: {e}"))?;
    Ok(())
}

fn load_cached_repo_layout_snapshot(
    repo_path: &str,
    layout_key: &str,
) -> Result<Option<String>, String> {
    let conn = open_visual_cache_connection()?;
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM repo_layout_cache WHERE repo_path = ?1 AND layout_key = ?2",
            params![repo_path, layout_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read layout cache row: {e}"))?;
    Ok(payload)
}

fn upsert_repo_layout_snapshot(
    repo_path: &str,
    layout_key: &str,
    payload_json: &str,
) -> Result<(), String> {
    let id = normalize_repo_path_id(repo_path);
    if project_is_deleted(&id)? {
        return Ok(());
    }
    let conn = open_visual_cache_connection()?;
    conn.execute(
        "
        INSERT INTO repo_layout_cache (repo_path, layout_key, payload_json, updated_at_ms)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(repo_path, layout_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at_ms = excluded.updated_at_ms
        ",
        params![
            repo_path,
            layout_key,
            payload_json,
            Utc::now().timestamp_millis()
        ],
    )
    .map_err(|e| format!("Failed to upsert layout snapshot: {e}"))?;
    conn.execute(
        "
        DELETE FROM repo_layout_cache
        WHERE repo_path = ?1
          AND layout_key NOT IN (
            SELECT layout_key
            FROM repo_layout_cache
            WHERE repo_path = ?1
            ORDER BY updated_at_ms DESC
            LIMIT ?2
          )
        ",
        params![repo_path, MAX_LAYOUT_SNAPSHOTS_PER_REPO],
    )
    .map_err(|e| format!("Failed to prune layout snapshots: {e}"))?;
    Ok(())
}

fn load_cached_repo_node_positions(repo_path: &str) -> Result<Option<String>, String> {
    let id = normalize_repo_path_id(repo_path);
    let conn = open_visual_cache_connection()?;
    let try_key = |key: &str| -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT payload_json FROM repo_node_position_cache WHERE repo_path = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read node position cache row: {e}"))
    };
    if let Some(payload) = try_key(&id)? {
        return Ok(Some(payload));
    }
    if repo_path != id {
        return try_key(repo_path);
    }
    Ok(None)
}

fn upsert_repo_node_positions(repo_path: &str, payload_json: &str) -> Result<(), String> {
    let id = normalize_repo_path_id(repo_path);
    if project_is_deleted(&id)? {
        return Ok(());
    }
    let conn = open_visual_cache_connection()?;
    conn.execute(
        "
        INSERT INTO repo_node_position_cache (repo_path, payload_json, updated_at_ms)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(repo_path) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at_ms = excluded.updated_at_ms
        ",
        params![id, payload_json, Utc::now().timestamp_millis()],
    )
    .map_err(|e| format!("Failed to upsert node position cache: {e}"))?;
    Ok(())
}

fn delete_repo_node_positions(repo_path: &str) -> Result<(), String> {
    let conn = open_visual_cache_connection()?;
    let id = normalize_repo_path_id(repo_path);
    conn.execute(
        "DELETE FROM repo_node_position_cache WHERE repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to clear node position cache: {e}"))?;
    Ok(())
}

fn delete_project_cache_rows(repo_path: &str) -> Result<(), String> {
    let id = normalize_repo_path_id(repo_path);
    let deleted_projects = DELETED_PROJECTS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut deleted_projects = deleted_projects
        .lock()
        .map_err(|_| "Deleted project state lock poisoned".to_string())?;
    deleted_projects.insert(id.clone());
    drop(deleted_projects);
    let mut conn = open_visual_cache_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin project delete transaction: {e}"))?;
    tx.execute(
        "DELETE FROM project_snapshot WHERE project_id = ?1 OR repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to delete project snapshots: {e}"))?;
    tx.execute(
        "DELETE FROM project_registry WHERE project_id = ?1 OR repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to delete project registry row: {e}"))?;
    tx.execute(
        "DELETE FROM repo_layout_cache WHERE repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to delete project layout cache: {e}"))?;
    tx.execute(
        "DELETE FROM repo_node_position_cache WHERE repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to delete project node position cache: {e}"))?;
    tx.execute(
        "DELETE FROM repo_visual_cache WHERE repo_path = ?1 OR repo_path = ?2",
        params![id, repo_path],
    )
    .map_err(|e| format!("Failed to delete project visual cache: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit project delete transaction: {e}"))?;
    Ok(())
}

fn normalize_repo_path_id(repo_path: &str) -> String {
    if repo_path == "/" {
        "/".to_string()
    } else {
        repo_path.trim_end_matches('/').to_lowercase()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RepoChangeProbe {
    pub(crate) signature: String,
    pub(crate) branch_head_digest: String,
    pub(crate) head_sha: String,
    pub(crate) has_uncommitted_changes: bool,
    pub(crate) worktree_sig: String,
    pub(crate) stash_sig: String,
    pub(crate) remote_heads_digest: String,
    pub(crate) head_unpushed_count: String,
}

fn format_worktree_sig(worktrees: &[git::WorktreeInfo]) -> String {
    let mut worktree_lines: Vec<String> = worktrees
        .iter()
        .map(|worktree| {
            format!(
                "{}:{}:{}:{}",
                worktree.path,
                worktree.head_sha,
                worktree.branch_name.clone().unwrap_or_default(),
                if worktree.has_uncommitted_changes {
                    "1"
                } else {
                    "0"
                }
            )
        })
        .collect();
    worktree_lines.sort();
    worktree_lines.join("|")
}

fn format_stash_sig(stashes: &[git::GitStashEntry]) -> String {
    stashes
        .iter()
        .map(|stash| format!("{}:{}:{}", stash.index, stash.base_sha, stash.message))
        .collect::<Vec<_>>()
        .join("|")
}

fn compose_probe_signature(probe: &RepoChangeProbe) -> String {
    format!(
        "{}@@{}@@{}@@{}@@{}@@{}@@{}",
        probe.head_sha,
        if probe.has_uncommitted_changes {
            "1"
        } else {
            "0"
        },
        probe.branch_head_digest,
        probe.worktree_sig,
        probe.stash_sig,
        probe.head_unpushed_count,
        probe.remote_heads_digest,
    )
}

fn compute_repo_change_probe_inner(repo_path: &str) -> Result<RepoChangeProbe, String> {
    let path = Path::new(repo_path);
    let head_sha = git::cli::run(path, &["rev-parse", "HEAD"])
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    let porcelain = git::cli::run(
        path,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .map_err(|e| e.to_string())?;
    let has_uncommitted_changes = !porcelain.trim().is_empty();
    let heads = git::list_local_branch_heads(path).map_err(|e| e.to_string())?;
    let branch_head_digest = git::format_branch_head_digest(&heads);
    let worktrees = git::list_worktrees(path).map_err(|e| e.to_string())?;
    let worktree_sig = format_worktree_sig(&worktrees);
    let stashes = git::list_stashes(path).map_err(|e| e.to_string())?;
    let stash_sig = format_stash_sig(&stashes);
    let remote_heads_digest = git::compute_remote_heads_digest(path).unwrap_or_default();
    let head_unpushed_count =
        git::cli::run(path, &["rev-list", "--count", "HEAD@{upstream}..HEAD"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "0".to_string());
    let mut probe = RepoChangeProbe {
        signature: String::new(),
        branch_head_digest,
        head_sha,
        has_uncommitted_changes,
        worktree_sig,
        stash_sig,
        remote_heads_digest,
        head_unpushed_count,
    };
    probe.signature = compose_probe_signature(&probe);
    repo_git_gate::store_probe(repo_path, &probe);
    Ok(probe)
}

fn probe_lite_matches_fingerprint(probe: &RepoChangeProbe, stored_fp: &str) -> bool {
    let parts: Vec<&str> = stored_fp.split("@@").collect();
    if parts.len() < 7 {
        return false;
    }
    if probe.head_sha != parts[1] {
        return false;
    }
    if probe.has_uncommitted_changes != (parts[3] == "1") {
        return false;
    }
    if probe.branch_head_digest != git::branch_head_digest_from_ref_sig(parts[4]) {
        return false;
    }
    if probe.worktree_sig != parts[5] {
        return false;
    }
    if probe.stash_sig != parts[6] {
        return false;
    }
    let upstream_part = parts[2];
    if !probe.remote_heads_digest.is_empty() {
        let remote_from_fp = upstream_part.split('|').nth(1).unwrap_or("");
        if !remote_from_fp.is_empty() && probe.remote_heads_digest != remote_from_fp {
            return false;
        }
    }
    true
}

fn compose_repo_fingerprint(
    default_branch: &str,
    checked_out_ref: &CheckedOutRef,
    branches: &[Branch],
    worktrees: &[git::WorktreeInfo],
    stashes: &[git::GitStashEntry],
    upstream_sha: Option<String>,
    remote_heads_digest: String,
) -> String {
    let branch_ref_sig = branches
        .iter()
        .map(|branch| {
            format!(
                "{}:{}:{}:{}:{}",
                branch.name,
                branch.head_sha,
                branch.commits_ahead,
                branch.unpushed_commits,
                branch.remote_sync_status
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    let worktree_sig = format_worktree_sig(worktrees);
    let stash_sig = format_stash_sig(stashes);
    let upstream_part = if remote_heads_digest.is_empty() {
        upstream_sha.unwrap_or_default()
    } else if let Some(upstream_sha) = upstream_sha {
        format!("{upstream_sha}|{remote_heads_digest}")
    } else {
        remote_heads_digest
    };
    format!(
        "{}@@{}@@{}@@{}@@{}@@{}@@{}",
        default_branch,
        checked_out_ref.head_sha,
        upstream_part,
        if checked_out_ref.has_uncommitted_changes {
            "1"
        } else {
            "0"
        },
        branch_ref_sig,
        worktree_sig,
        stash_sig
    )
}

fn fingerprint_unchanged_via_probe(
    _repo_path: &str,
    stored_fp: &str,
    probe: &RepoChangeProbe,
) -> Result<bool, String> {
    Ok(probe_lite_matches_fingerprint(probe, stored_fp))
}

fn fingerprint_patch_via_probe(stored_fp: &str, probe: &RepoChangeProbe) -> Option<String> {
    let parts: Vec<&str> = stored_fp.split("@@").collect();
    if parts.len() < 7 {
        return None;
    }
    if probe.head_sha != parts[1] {
        return None;
    }
    if probe.branch_head_digest != git::branch_head_digest_from_ref_sig(parts[4]) {
        return None;
    }
    let upstream_part = parts[2];
    if !probe.remote_heads_digest.is_empty() {
        let remote_from_fp = upstream_part.split('|').nth(1).unwrap_or("");
        if !remote_from_fp.is_empty() && probe.remote_heads_digest != remote_from_fp {
            return None;
        }
    }
    let default_branch = parts[0];
    let head_sha = parts[1];
    let upstream_part = parts[2];
    let branch_ref_sig = parts[4];

    let has_uncommitted_changes = if probe.has_uncommitted_changes {
        "1"
    } else {
        "0"
    };
    let worktree_sig = &probe.worktree_sig;
    let stash_sig = &probe.stash_sig;

    Some(format!(
        "{}@@{}@@{}@@{}@@{}@@{}@@{}",
        default_branch,
        head_sha,
        upstream_part,
        has_uncommitted_changes,
        branch_ref_sig,
        worktree_sig,
        stash_sig
    ))
}

fn compute_repo_fingerprint_inner(
    repo_path: &str,
) -> Result<(String, RepoRefreshFingerprint), String> {
    let path = Path::new(repo_path);
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
    let branches = git::list_branches(path, &default_branch).map_err(|e| e.to_string())?;
    let checked_out_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
    let worktrees = git::list_worktrees(path).map_err(|e| e.to_string())?;
    let stashes = git::list_stashes(path).map_err(|e| e.to_string())?;
    let upstream_sha = git::resolve_branch_upstream_ref(path, &default_branch)
        .and_then(|upstream_ref| git::cli::run(path, &["rev-parse", &upstream_ref]).ok())
        .map(|output| output.trim().to_string())
        .filter(|value| !value.is_empty());
    let remote_heads_digest = git::compute_remote_heads_digest(path).unwrap_or_default();

    let fingerprint = compose_repo_fingerprint(
        &default_branch,
        &checked_out_ref,
        &branches,
        &worktrees,
        &stashes,
        upstream_sha.clone(),
        remote_heads_digest,
    );

    Ok((
        fingerprint,
        RepoRefreshFingerprint {
            repo_path: repo_path.to_string(),
            default_branch,
            head_sha: checked_out_ref.head_sha,
            upstream_sha,
            has_uncommitted_changes: checked_out_ref.has_uncommitted_changes,
            branch_count: branches.len(),
            worktree_count: worktrees.len(),
            stash_count: stashes.len(),
        },
    ))
}

fn compute_repo_fingerprint(repo_path: &str) -> Result<(String, RepoRefreshFingerprint), String> {
    repo_git_gate::with_repo_git_lock(repo_path, || compute_repo_fingerprint_inner(repo_path))
}

fn build_simple_graph_projection(
    snapshot: &RepoVisualSnapshot,
) -> (Vec<SimpleGraphClump>, Vec<SimpleGraphNode>) {
    let mut branch_order: Vec<String> = std::iter::once(snapshot.default_branch.clone())
        .chain(snapshot.branches.iter().map(|branch| branch.name.clone()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    branch_order.sort();
    let lane_by_branch: HashMap<String, i32> = if snapshot.lane_by_branch.is_empty() {
        branch_order
            .iter()
            .enumerate()
            .map(|(idx, name)| (name.clone(), idx as i32))
            .collect()
    } else {
        snapshot.lane_by_branch.clone()
    };

    let mut commits_by_branch = HashMap::<String, Vec<&DirectCommit>>::new();
    for commit in &snapshot.direct_commits {
        commits_by_branch
            .entry(commit.branch.clone())
            .or_default()
            .push(commit);
    }
    for commits in commits_by_branch.values_mut() {
        commits.sort_by(|left, right| {
            right
                .date
                .cmp(&left.date)
                .then_with(|| right.full_sha.cmp(&left.full_sha))
        });
    }

    let mut clumps = Vec::<SimpleGraphClump>::new();
    let mut nodes = Vec::<SimpleGraphNode>::new();
    let chunk_size = 20_usize;
    for branch_name in branch_order {
        let lane = lane_by_branch.get(&branch_name).copied().unwrap_or(0) as f64;
        let Some(commits) = commits_by_branch.get(&branch_name) else {
            continue;
        };
        for (chunk_idx, chunk) in commits.chunks(chunk_size).enumerate() {
            let clump_id = format!("clump:{}:{}", branch_name, chunk_idx);
            let lead_sha = chunk
                .first()
                .map(|commit| commit.full_sha.clone())
                .unwrap_or_default();
            let commit_shas: Vec<String> =
                chunk.iter().map(|commit| commit.full_sha.clone()).collect();
            clumps.push(SimpleGraphClump {
                id: clump_id.clone(),
                branch_name: branch_name.clone(),
                commit_shas,
                lead_sha,
                count: chunk.len(),
            });
            for (offset, commit) in chunk.iter().enumerate() {
                let x_h = (chunk_idx * chunk_size + offset) as f64;
                nodes.push(SimpleGraphNode {
                    id: commit.full_sha.clone(),
                    branch_name: branch_name.clone(),
                    clump_id: clump_id.clone(),
                    x_horizontal: x_h,
                    y_horizontal: lane,
                    x_vertical: lane,
                    y_vertical: x_h,
                    parent_sha: commit.parent_sha.clone(),
                });
            }
        }
    }
    (clumps, nodes)
}

fn load_active_project_snapshot(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<ProjectSnapshotRecord>, String> {
    let row: Option<(String, String, i64, String, i32, i64, String)> = conn
        .query_row(
            "
            SELECT project_id, repo_path, snapshot_version, fingerprint, schema_version, created_at_ms, payload_json
            FROM project_snapshot
            WHERE project_id = ?1 AND is_active = 1
            ORDER BY snapshot_version DESC
            LIMIT 1
            ",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to query active project snapshot: {e}"))?;
    let Some((
        project_id,
        repo_path,
        snapshot_version,
        fingerprint,
        schema_version,
        created_at_ms,
        payload_json,
    )) = row
    else {
        return Ok(None);
    };
    let payload = serde_json::from_str::<ProjectGraphSnapshotPayload>(&payload_json)
        .map_err(|e| format!("Failed to decode project snapshot payload: {e}"))?;
    Ok(Some(ProjectSnapshotRecord {
        project_id,
        repo_path,
        snapshot_version,
        fingerprint,
        schema_version,
        created_at_ms,
        payload,
    }))
}

fn publish_project_snapshot_with_progress(
    repo_path: &str,
    fingerprint_override: Option<&str>,
    progress: Option<&dyn Fn(&str, u8)>,
) -> Result<ProjectSnapshotRecord, String> {
    let normalized_repo_path = normalize_repo_path_id(repo_path);
    if project_is_deleted(&normalized_repo_path)? {
        return Err("Project was removed".to_string());
    }
    let project_id = normalized_repo_path.clone();
    let snapshot = compute_repo_visual_snapshot_with_progress(&normalized_repo_path, progress)?;
    let fingerprint = match fingerprint_override {
        Some(value) => value.to_string(),
        None => {
            let checked_out_ref = snapshot
                .checked_out_ref
                .as_ref()
                .ok_or_else(|| "Snapshot is missing the checked out ref".to_string())?;
            let path = Path::new(&normalized_repo_path);
            let upstream_sha = git::resolve_branch_upstream_ref(path, &snapshot.default_branch)
                .and_then(|upstream_ref| git::cli::run(path, &["rev-parse", &upstream_ref]).ok())
                .map(|output| output.trim().to_string())
                .filter(|value| !value.is_empty());
            let remote_heads_digest = git::compute_remote_heads_digest(path).unwrap_or_default();
            let local_branch_names: HashSet<String> = git::list_local_branch_heads(path)
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            let fingerprint_branches: Vec<Branch> = snapshot
                .branches
                .iter()
                .filter(|branch| local_branch_names.contains(&branch.name))
                .cloned()
                .collect();
            compose_repo_fingerprint(
                &snapshot.default_branch,
                checked_out_ref,
                &fingerprint_branches,
                &snapshot.worktrees,
                &snapshot.stashes,
                upstream_sha,
                remote_heads_digest,
            )
        }
    };
    let (clumps, simple_nodes) = build_simple_graph_projection(&snapshot);
    let payload = ProjectGraphSnapshotPayload {
        repo_visual_snapshot: snapshot,
        clumps,
        simple_nodes,
    };
    if payload.repo_visual_snapshot.direct_commits.is_empty() {
        return Err("Snapshot validation failed: direct commits payload is empty".to_string());
    }
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to encode project snapshot payload: {e}"))?;
    let now_ms = Utc::now().timestamp_millis();
    let mut conn = open_visual_cache_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin project snapshot transaction: {e}"))?;
    tx.execute(
        "
        INSERT INTO project_registry(project_id, repo_path, active_snapshot_version, last_fingerprint, last_checked_at_ms)
        VALUES (?1, ?2, NULL, NULL, ?3)
        ON CONFLICT(project_id) DO UPDATE SET
            repo_path = excluded.repo_path
        ",
        params![project_id, normalized_repo_path, now_ms],
    )
    .map_err(|e| format!("Failed to upsert project registry: {e}"))?;
    let next_version: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(snapshot_version), 0) + 1 FROM project_snapshot WHERE project_id = ?1",
            params![normalize_repo_path_id(repo_path)],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to compute next project snapshot version: {e}"))?;
    tx.execute(
        "
        INSERT INTO project_snapshot(
            project_id, repo_path, snapshot_version, fingerprint, schema_version, created_at_ms, payload_json, is_active
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
        ",
        params![
            normalize_repo_path_id(repo_path),
            normalized_repo_path,
            next_version,
            fingerprint,
            PROJECT_SNAPSHOT_SCHEMA_VERSION,
            now_ms,
            payload_json,
        ],
    )
    .map_err(|e| format!("Failed to insert project snapshot: {e}"))?;
    tx.execute(
        "UPDATE project_snapshot SET is_active = 0 WHERE project_id = ?1",
        params![normalize_repo_path_id(repo_path)],
    )
    .map_err(|e| format!("Failed to clear active snapshot: {e}"))?;
    tx.execute(
        "UPDATE project_snapshot SET is_active = 1 WHERE project_id = ?1 AND snapshot_version = ?2",
        params![normalize_repo_path_id(repo_path), next_version],
    )
    .map_err(|e| format!("Failed to activate snapshot: {e}"))?;
    tx.execute(
        "
        UPDATE project_registry
        SET active_snapshot_version = ?2, last_fingerprint = ?3, last_checked_at_ms = ?4
        WHERE project_id = ?1
        ",
        params![
            normalize_repo_path_id(repo_path),
            next_version,
            fingerprint,
            now_ms
        ],
    )
    .map_err(|e| format!("Failed to update project registry active snapshot: {e}"))?;
    tx.execute(
        "
        DELETE FROM project_snapshot
        WHERE project_id = ?1
          AND snapshot_version NOT IN (
            SELECT snapshot_version FROM project_snapshot
            WHERE project_id = ?1
            ORDER BY snapshot_version DESC
            LIMIT ?2
          )
        ",
        params![
            normalize_repo_path_id(repo_path),
            PROJECT_SNAPSHOT_RETAIN_COUNT
        ],
    )
    .map_err(|e| format!("Failed to prune old project snapshots: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit project snapshot transaction: {e}"))?;
    Ok(ProjectSnapshotRecord {
        project_id: normalize_repo_path_id(repo_path),
        repo_path: normalized_repo_path,
        snapshot_version: next_version,
        fingerprint,
        schema_version: PROJECT_SNAPSHOT_SCHEMA_VERSION,
        created_at_ms: now_ms,
        payload,
    })
}

fn publish_project_snapshot(
    repo_path: &str,
    fingerprint_override: Option<&str>,
) -> Result<ProjectSnapshotRecord, String> {
    publish_project_snapshot_with_progress(repo_path, fingerprint_override, None)
}

fn fetch_all_merge_nodes_for_branches_internal(
    repo_path: &str,
    branches: &[Branch],
    default_branch: &str,
) -> Result<Vec<MergeNode>, String> {
    let path = Path::new(repo_path);
    let mut branch_names: Vec<String> = std::iter::once(default_branch.to_string())
        .chain(branches.iter().map(|branch| branch.name.clone()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    branch_names.sort();
    if let Some(default_index) = branch_names.iter().position(|name| name == default_branch) {
        branch_names.swap(0, default_index);
    }
    let mut deduped = HashMap::<String, MergeNode>::new();
    for branch_name in branch_names {
        let mut page = 0;
        loop {
            let exclude_ref = (branch_name != default_branch).then_some(default_branch);
            let (nodes, has_more) =
                git::get_merge_commits(path, &branch_name, exclude_ref, page, 100)
                    .map_err(|e| e.to_string())?;
            for node in nodes {
                let key = format!("{}:{}", node.target_commit_sha, node.target_branch);
                deduped.entry(key).or_insert(node);
            }
            if !has_more {
                break;
            }
            page += 1;
        }
    }
    Ok(deduped.into_values().collect())
}

fn compute_repo_visual_snapshot(repo_path: &str) -> Result<RepoVisualSnapshot, String> {
    compute_repo_visual_snapshot_with_progress(repo_path, None)
}

fn compute_repo_visual_snapshot_with_progress(
    repo_path: &str,
    progress: Option<&dyn Fn(&str, u8)>,
) -> Result<RepoVisualSnapshot, String> {
    let report = |phase: &str, value: u8| {
        if let Some(callback) = progress {
            callback(phase, value);
        }
    };
    report("Reading repository", 8);
    let path = Path::new(repo_path);
    let (name, resolved_path) = git::get_repo_info(path).map_err(|e| e.to_string())?;
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
    let mut branches = git::list_branches(path, &default_branch).map_err(|e| e.to_string())?;
    // Sort branches by creation date (oldest first) so that older branches retain
    // commit ownership priority in case of identical HEAD commits.
    branches.sort_by(|a, b| {
        let a_date = a.created_date.as_ref().unwrap_or(&a.last_commit_date);
        let b_date = b.created_date.as_ref().unwrap_or(&b.last_commit_date);
        match a_date.cmp(b_date) {
            std::cmp::Ordering::Equal => a.name.cmp(&b.name),
            other => other,
        }
    });
    report("Reading branches", 18);
    let merge_nodes =
        fetch_all_merge_nodes_for_branches_internal(&resolved_path, &branches, &default_branch)?;
    let merge_target_branch_by_commit_sha: HashMap<String, String> = merge_nodes
        .iter()
        .map(|node| (node.target_commit_sha.clone(), node.target_branch.clone()))
        .collect();
    let all_branch_names: Vec<String> = std::iter::once(default_branch.clone())
        .chain(branches.iter().map(|branch| branch.name.clone()))
        .collect();
    let mut branch_created_dates = HashMap::<String, String>::new();
    for branch in &branches {
        let date = branch
            .created_date
            .as_ref()
            .unwrap_or(&branch.last_commit_date)
            .clone();
        branch_created_dates.insert(branch.name.clone(), date);
    }
    if let Ok(default_date_output) =
        git::cli::run(path, &["show", "-s", "--format=%cI", &default_branch])
    {
        let default_date = default_date_output.trim().to_string();
        if !default_date.is_empty() {
            branch_created_dates.insert(default_branch.clone(), default_date);
        }
    }
    report("Building commit graph", 35);
    let direct_commits = git::get_all_repo_commits(
        path,
        &default_branch,
        &all_branch_names,
        &branch_created_dates,
        &merge_target_branch_by_commit_sha,
    )
    .map_err(|e| e.to_string())?;
    let mut direct_commits = direct_commits;
    let mut local_branch_names: HashSet<String> =
        branches.iter().map(|branch| branch.name.clone()).collect();
    local_branch_names.insert(default_branch.clone());

    // Load deleted remote branches for filtering
    let normalized_repo_path = normalize_repo_path_id(repo_path);
    let mut deleted_remote_refs = HashSet::<(String, String, String)>::new();
    if let Ok(conn) = open_visual_cache_connection() {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT branch_name, remote_ref, sha FROM deleted_remote_branches WHERE repo_path = ?1",
        ) {
            if let Ok(rows) = stmt.query_map(params![normalized_repo_path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }) {
                for r in rows.flatten() {
                    deleted_remote_refs.insert(r);
                }
            }
        }
    }

    report("Reading remote branches", 58);
    let origin_branch_heads = git::list_origin_branch_heads(path).map_err(|e| e.to_string())?;

    // Cleanup database: remove deleted_remote_branches entries that are no longer present on the remote at all
    {
        let mut active_remote_refs = HashSet::<String>::new();
        for (branch_name, _) in &origin_branch_heads {
            active_remote_refs.insert(format!("refs/remotes/origin/{branch_name}"));
        }
        let stale_refs = if let Ok(conn) = open_visual_cache_connection() {
            if let Ok(mut stmt) =
                conn.prepare("SELECT remote_ref FROM deleted_remote_branches WHERE repo_path = ?1")
            {
                if let Ok(rows) =
                    stmt.query_map(params![normalized_repo_path], |row| row.get::<_, String>(0))
                {
                    rows.flatten()
                        .filter(|r| !active_remote_refs.contains(r))
                        .collect::<Vec<String>>()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        if !stale_refs.is_empty() {
            if let Ok(mut conn) = open_visual_cache_connection() {
                if let Ok(tx) = conn.transaction() {
                    for r in stale_refs {
                        let _ = tx.execute("DELETE FROM deleted_remote_branches WHERE repo_path = ?1 AND remote_ref = ?2", params![normalized_repo_path, r]);
                    }
                    let _ = tx.commit();
                }
            }
        }
    }

    let mut remote_only_branches = Vec::new();
    for (branch_name, remote_head) in origin_branch_heads {
        let upstream_ref = format!("origin/{branch_name}");
        let upstream_full_ref = format!("refs/remotes/origin/{branch_name}");

        if local_branch_names.contains(&branch_name) {
            git::merge_upstream_ahead_commits(
                path,
                &branch_name,
                &upstream_ref,
                &mut direct_commits,
            )
            .map_err(|e| e.to_string())?;
            continue;
        }

        // Filter out if this remote-only branch was previously deleted by the user at this commit SHA
        if deleted_remote_refs.contains(&(
            branch_name.clone(),
            upstream_full_ref.clone(),
            remote_head.clone(),
        )) {
            continue;
        }

        git::merge_remote_only_branch_commits(
            path,
            &default_branch,
            &branch_name,
            &upstream_ref,
            &mut direct_commits,
        )
        .map_err(|e| e.to_string())?;
        if let Some(branch) =
            git::build_remote_only_branch(path, &branch_name, &remote_head, &default_branch)
        {
            remote_only_branches.push(branch);
        }
    }
    branches.extend(remote_only_branches);
    branches.sort_by(|left, right| right.last_commit_date.cmp(&left.last_commit_date));
    report("Checking branch state", 70);
    let unpushed_direct_commits =
        get_unpushed_direct_commits_blocking(resolved_path.clone(), default_branch.clone())?;
    let checked_out_ref = git::get_checked_out_ref(path).ok();
    report("Checking worktrees", 78);
    let worktrees = git::list_worktrees(path).unwrap_or_default();
    let stashes = git::list_stashes(path).unwrap_or_default();

    let mut unpushed_commit_shas_by_branch = HashMap::new();
    for branch_name in std::iter::once(default_branch.clone())
        .chain(branches.iter().map(|branch| branch.name.clone()))
    {
        let shas =
            get_branch_unpushed_commit_shas_blocking(resolved_path.clone(), branch_name.clone())
                .unwrap_or_default();
        unpushed_commit_shas_by_branch.insert(branch_name, shas);
    }

    let mut merge_node_by_merged_head_sha = HashMap::<String, MergeNode>::new();
    for node in &merge_nodes {
        for parent_sha in node.parent_shas.iter().skip(1) {
            if !parent_sha.is_empty() && !merge_node_by_merged_head_sha.contains_key(parent_sha) {
                merge_node_by_merged_head_sha.insert(parent_sha.clone(), node.clone());
            }
        }
    }

    let active_branches: Vec<Branch> = branches
        .iter()
        .filter(|branch| branch.name != default_branch)
        .cloned()
        .collect();
    let mut child_branch_count_by_parent = HashMap::<String, usize>::new();
    for branch in &active_branches {
        if let Some(parent) = branch.parent_branch.as_ref() {
            if parent != &branch.name {
                *child_branch_count_by_parent
                    .entry(parent.clone())
                    .or_insert(0) += 1;
            }
        }
    }
    let mut head_sha_groups = HashMap::<String, Vec<Branch>>::new();
    for branch in &active_branches {
        if !branch.head_sha.is_empty() {
            head_sha_groups
                .entry(branch.head_sha.clone())
                .or_default()
                .push(branch.clone());
        }
    }
    let mut fresh_copy_branch_names = HashSet::<String>::new();
    for group in head_sha_groups.values() {
        if group.len() < 2 {
            continue;
        }
        let mut sorted = group.clone();
        sorted.sort_by(|left, right| {
            let left_date = left
                .created_date
                .clone()
                .or(left.diverged_from_date.clone())
                .unwrap_or_else(|| left.last_commit_date.clone());
            let right_date = right
                .created_date
                .clone()
                .or(right.diverged_from_date.clone())
                .unwrap_or_else(|| right.last_commit_date.clone());
            left_date.cmp(&right_date)
        });
        for branch in sorted.into_iter().skip(1) {
            let has_children = child_branch_count_by_parent
                .get(&branch.name)
                .copied()
                .unwrap_or(0)
                > 0;
            let head_matches_origin = !branch.head_sha.is_empty()
                && (branch.head_sha == branch.created_from_sha.clone().unwrap_or_default()
                    || branch.head_sha == branch.diverged_from_sha.clone().unwrap_or_default());
            let is_true_fresh_copy = branch.commits_ahead == 0
                && head_matches_origin
                && !has_children
                && !merge_node_by_merged_head_sha.contains_key(&branch.head_sha);
            if is_true_fresh_copy {
                fresh_copy_branch_names.insert(branch.name);
            }
        }
    }
    for branch in &active_branches {
        let has_children = child_branch_count_by_parent
            .get(&branch.name)
            .copied()
            .unwrap_or(0)
            > 0;
        let head_matches_origin = !branch.head_sha.is_empty()
            && (branch.head_sha == branch.created_from_sha.clone().unwrap_or_default()
                || branch.head_sha == branch.diverged_from_sha.clone().unwrap_or_default());
        if branch.commits_ahead == 0
            && head_matches_origin
            && !merge_node_by_merged_head_sha.contains_key(&branch.head_sha)
            && !has_children
        {
            fresh_copy_branch_names.insert(branch.name.clone());
        }
    }

    report("Preparing map", 90);
    let mut branch_commit_previews = HashMap::<String, Vec<BranchCommitPreviewEntry>>::new();
    let mut branch_unique_ahead_counts = HashMap::<String, i32>::new();
    for branch in &active_branches {
        let mut history_commits: Vec<BranchCommitPreviewEntry> = direct_commits
            .iter()
            .filter(|commit| commit.branch == branch.name)
            .map(|commit| BranchCommitPreviewEntry {
                full_sha: commit.full_sha.clone(),
                sha: commit.sha.clone(),
                parent_sha: commit.parent_sha.clone(),
                parent_shas: commit.parent_shas.clone(),
                child_shas: commit.child_shas.clone(),
                message: commit.message.clone(),
                author: commit.author.clone(),
                date: commit.date.clone(),
                kind: "commit".to_string(),
                is_remote: commit.is_remote,
            })
            .collect();
        history_commits.sort_by(|left, right| {
            right
                .date
                .cmp(&left.date)
                .then_with(|| right.full_sha.cmp(&left.full_sha))
        });
        branch_unique_ahead_counts.insert(branch.name.clone(), history_commits.len() as i32);
        branch_commit_previews.insert(branch.name.clone(), history_commits);
    }

    let mut commit_branch_by_sha = HashMap::<String, String>::new();
    for commit in &direct_commits {
        commit_branch_by_sha.insert(commit.full_sha.clone(), commit.branch.clone());
    }
    let resolve_branch_for_sha = |sha: &str| -> Option<String> {
        if sha.is_empty() {
            return None;
        }
        commit_branch_by_sha.get(sha).cloned().or_else(|| {
            commit_branch_by_sha
                .iter()
                .find(|(commit_sha, _)| commit_sha.starts_with(sha) || sha.starts_with(*commit_sha))
                .map(|(_, branch_name)| branch_name.clone())
        })
    };
    let branch_parent_by_name = {
        let mut map = HashMap::<String, Option<String>>::new();
        map.insert(default_branch.clone(), None);
        for branch in &branches {
            if branch.name == default_branch {
                map.insert(branch.name.clone(), None);
                continue;
            }
            let branch_commits: Vec<&DirectCommit> = direct_commits
                .iter()
                .filter(|commit| commit.branch == branch.name)
                .collect();
            let branch_commit_shas: HashSet<&str> = branch_commits
                .iter()
                .map(|commit| commit.full_sha.as_str())
                .collect();
            let graph_parent_sha = branch_commits
                .iter()
                .filter(|commit| {
                    commit
                        .parent_sha
                        .as_deref()
                        .map(|parent| !branch_commit_shas.contains(parent))
                        .unwrap_or(true)
                })
                .min_by(|left, right| {
                    left.date
                        .cmp(&right.date)
                        .then_with(|| left.full_sha.cmp(&right.full_sha))
                })
                .and_then(|commit| commit.parent_sha.clone());
            let metadata_fork_sha = branch
                .created_from_sha
                .as_ref()
                .or(branch.diverged_from_sha.as_ref())
                .cloned();
            let parent = graph_parent_sha
                .as_deref()
                .and_then(&resolve_branch_for_sha)
                .or_else(|| {
                    metadata_fork_sha
                        .as_deref()
                        .and_then(&resolve_branch_for_sha)
                })
                .or_else(|| {
                    branch
                        .parent_branch
                        .clone()
                        .filter(|name| name != &branch.name)
                });
            map.insert(branch.name.clone(), parent);
        }
        map
    };
    let lane_by_branch = compute_lane_by_branch(
        &branches,
        &default_branch,
        &branch_commit_previews,
        &branch_parent_by_name,
    );

    Ok(RepoVisualSnapshot {
        path: resolved_path,
        name,
        default_branch,
        branches,
        merge_nodes,
        direct_commits,
        unpushed_direct_commits,
        merge_target_branch_by_commit_sha,
        unpushed_commit_shas_by_branch,
        checked_out_ref,
        worktrees,
        stashes,
        branch_commit_previews,
        branch_parent_by_name,
        lane_by_branch,
        branch_unique_ahead_counts,
        loaded: true,
        cache_schema_version: REPO_VISUAL_CACHE_SCHEMA_VERSION,
        updated_at_ms: Utc::now().timestamp_millis(),
    })
}

fn watch_repo_blocking(repo_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let repo_root = Path::new(&repo_path);
    let repo_root_canonical = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let git_dir_hint = repo_root_canonical.join(".git");
    let resolved_git_dir =
        git::cli::run(&repo_root_canonical, &["rev-parse", "--absolute-git-dir"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(|path| path.canonicalize().unwrap_or(path))
            .filter(|path| path.exists())
            .or_else(|| {
                git_dir_hint
                    .exists()
                    .then(|| git_dir_hint.canonicalize().unwrap_or(git_dir_hint.clone()))
            });
    let resolved_git_common_dir =
        git::cli::run(&repo_root_canonical, &["rev-parse", "--git-common-dir"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    path
                } else {
                    repo_root_canonical.join(path)
                }
            })
            .map(|path| path.canonicalize().unwrap_or(path))
            .filter(|path| path.exists());
    let Some(primary_git_dir) = resolved_git_dir else {
        return Ok(());
    };

    let event_repo_path = repo_root.to_string_lossy().to_string();
    let watcher_key = normalize_repo_path_id(&event_repo_path);
    {
        let lock = WATCHER_STATE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap();
        if lock.contains_key(&watcher_key) {
            return Ok(());
        }
    }

    let linked_worktree_roots: Vec<PathBuf> = git::list_worktree_paths(&repo_root_canonical)
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .map(|path| path.canonicalize().unwrap_or(path))
        .filter(|path| !worktree_watch_roots_same(&repo_root_canonical, path))
        .collect();

    let (tx, rx) = std::sync::mpsc::channel();
    let (worktree_signal_tx, worktree_signal_rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;

    let _ = watcher.watch(&repo_root_canonical, RecursiveMode::Recursive);
    let _ = watcher.watch(&primary_git_dir, RecursiveMode::Recursive);
    if let Some(common_dir) = resolved_git_common_dir.as_ref() {
        if common_dir != &primary_git_dir {
            let _ = watcher.watch(common_dir, RecursiveMode::Recursive);
        }
    }
    for linked_root in &linked_worktree_roots {
        let _ = watcher.watch(linked_root, RecursiveMode::Recursive);
    }

    let (git_signal_tx, git_signal_rx) = std::sync::mpsc::channel::<(bool, bool)>();
    let mut git_roots = vec![primary_git_dir.clone()];
    if let Some(common_dir) = resolved_git_common_dir {
        if common_dir != primary_git_dir {
            git_roots.push(common_dir);
        }
    }
    let repo_path_for_events = event_repo_path;
    let repo_root_for_events = repo_root_canonical.clone();
    let linked_worktree_roots_for_events = linked_worktree_roots.clone();
    let app_for_worktree_debounce = app.clone();
    let repo_path_for_worktree_debounce = repo_path_for_events.clone();

    std::thread::spawn(move || loop {
        match worktree_signal_rx.recv() {
            Ok(()) => {}
            Err(_) => break,
        }
        loop {
            match worktree_signal_rx.recv_timeout(std::time::Duration::from_millis(
                GIT_ACTIVITY_WORKTREE_DEBOUNCE_MS,
            )) {
                Ok(()) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        increment_watcher_activity(&repo_path_for_worktree_debounce, false);
        let _ = app_for_worktree_debounce.emit(
            "git-activity",
            GitActivityEventPayload {
                repo_path: repo_path_for_worktree_debounce.clone(),
                kind: "local".to_string(),
            },
        );
    });

    let app_for_git_debounce = app.clone();
    let repo_path_for_git_debounce = repo_path_for_events.clone();
    std::thread::spawn(move || loop {
        let mut first_signal = match git_signal_rx.recv() {
            Ok(sig) => sig,
            Err(_) => break,
        };
        loop {
            match git_signal_rx.recv_timeout(std::time::Duration::from_millis(150)) {
                Ok(sig) => {
                    first_signal.0 = first_signal.0 || sig.0; // accumulate graph change
                    first_signal.1 = first_signal.1 || sig.1; // accumulate local change
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        increment_watcher_activity(&repo_path_for_git_debounce, true);
        if first_signal.0 {
            let _ = app_for_git_debounce.emit(
                "git-activity",
                GitActivityEventPayload {
                    repo_path: repo_path_for_git_debounce.clone(),
                    kind: "graph".to_string(),
                },
            );
        }
        if first_signal.1 {
            let _ = app_for_git_debounce.emit(
                "git-activity",
                GitActivityEventPayload {
                    repo_path: repo_path_for_git_debounce.clone(),
                    kind: "local".to_string(),
                },
            );
        }
    });

    std::thread::spawn(move || {
        for res in rx {
            if let Ok(event) = res {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    continue;
                }

                let mut has_graph_change = false;
                let mut has_local_change = false;
                let mut has_worktree_file_change = false;
                for p in &event.paths {
                    if path_contains_noise_dir(p) {
                        continue;
                    }

                    let p_canonical = p.canonicalize().unwrap_or_else(|_| p.clone());
                    let is_git_internal =
                        git_roots.iter().any(|root| p_canonical.starts_with(root));

                    // Ignore metadata changes (e.g. timestamps/permissions) unless they occur within the .git directory (e.g. refs, HEAD)
                    if matches!(
                        event.kind,
                        notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
                    ) && !is_git_internal
                    {
                        continue;
                    }

                    if is_git_internal {
                        let path_str = p_canonical.to_string_lossy();
                        let is_index_path = path_str.ends_with("/index")
                            || path_str.ends_with("\\index")
                            || path_str.ends_with("index.lock");
                        if is_index_path {
                            has_local_change = true;
                            continue;
                        }

                        let is_worktree_path =
                            path_str.contains("/worktrees/") || path_str.contains("\\worktrees\\");
                        if is_worktree_path {
                            has_graph_change = true;
                            continue;
                        }

                        let is_graph_path = path_str.contains("/refs/")
                            || path_str.contains("\\refs\\")
                            || path_str.contains("/logs/")
                            || path_str.contains("\\logs\\")
                            || path_str.ends_with("HEAD")
                            || path_str.ends_with("FETCH_HEAD")
                            || path_str.ends_with("ORIG_HEAD")
                            || path_str.ends_with("packed-refs")
                            || path_str.contains("/packed-refs")
                            || path_str.contains("\\packed-refs");
                        if is_graph_path {
                            has_graph_change = true;
                        }
                        continue;
                    }

                    let in_worktree = p_canonical.starts_with(&repo_root_for_events)
                        || linked_worktree_roots_for_events
                            .iter()
                            .any(|root| p_canonical.starts_with(root));
                    if in_worktree {
                        has_worktree_file_change = true;
                    }
                }

                if has_graph_change || has_local_change {
                    let _ = git_signal_tx.send((has_graph_change, has_local_change));
                }

                if has_worktree_file_change && !has_graph_change && !has_local_change {
                    record_repo_change(&repo_path_for_events, REPO_CHANGE_LOCAL);
                    let _ = worktree_signal_tx.send(());
                }
            }
        }
    });

    let mut lock = WATCHER_STATE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    lock.insert(watcher_key, watcher);

    Ok(())
}

#[tauri::command]
async fn watch_repo(repo_path: String, app: tauri::AppHandle) -> Result<(), String> {
    run_blocking(move || watch_repo_blocking(repo_path, app)).await
}

#[tauri::command]
fn unwatch_repo(repo_path: String) -> Result<(), String> {
    let normalized_repo_path = normalize_repo_path_id(&repo_path);
    if let Some(state) = WATCHER_STATE.get() {
        state
            .lock()
            .map_err(|_| "Repo watcher state lock poisoned".to_string())?
            .remove(&normalized_repo_path);
    }
    if let Some(activity) = WATCHER_ACTIVITY.get() {
        activity
            .lock()
            .map_err(|_| "Repo watcher activity lock poisoned".to_string())?
            .remove(&normalized_repo_path);
    }
    Ok(())
}

// =============================================================================
// Directory Browsing
// =============================================================================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_repo: bool,
}

/// List visible sub-directories of a directory.
/// Returns sorted directories only (files are intentionally omitted).
/// Also indicates if each directory is a git repository.
#[tauri::command(rename_all = "camelCase")]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("Directory does not exist: {path}"));
    }

    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    const MAX_DIRECTORY_ENTRIES: usize = 2000;
    let mut dirs = Vec::new();

    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/directories
        if name.starts_with('.') {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }

        let entry_path = entry.path();
        let is_repo = entry_path.join(".git").is_dir();

        let item = DirEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: true,
            is_repo,
        };

        dirs.push(item);
        if dirs.len() >= MAX_DIRECTORY_ENTRIES {
            break;
        }
    }

    // Sort alphabetically (case-insensitive)
    dirs.sort_by_key(|entry| entry.name.to_ascii_lowercase());
    Ok(dirs)
}

/// Folders to skip during search - system folders unlikely to contain projects.
const SKIP_FOLDERS: &[&str] = &[
    // macOS system
    "Library",
    "Applications",
    "System",
    "Volumes",
    "cores",
    "private",
    // Common non-project folders
    "node_modules",
    "target",
    "build",
    "dist",
    "vendor",
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "env",
    ".cargo",
    ".rustup",
    ".npm",
    ".cache",
    "Caches",
    // Media/documents unlikely to have repos
    "Movies",
    "Music",
    "Pictures",
    "Photos Library.photoslibrary",
];

/// Common development folder names - search these when at home directory.
const DEV_FOLDERS: &[&str] = &[
    "dev",
    "projects",
    "code",
    "repos",
    "src",
    "workspace",
    "work",
    "github",
    "gitlab",
    "Development",
    "Documents",
    "Desktop",
];

/// Search for git repositories matching a query.
/// Only returns directories containing a .git folder.
/// When at home directory, only searches inside common dev folders.
/// Returns up to `limit` matches sorted by relevance.
#[tauri::command(rename_all = "camelCase")]
fn search_directories(
    path: String,
    query: String,
    max_depth: Option<u32>,
    limit: Option<usize>,
) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    let max_depth = max_depth.unwrap_or(6);
    let limit = limit.unwrap_or(20);
    let query_lower = query.to_lowercase();
    let mut visited_dirs = 0usize;
    let max_visited_dirs = 6000usize;
    let deadline = Instant::now() + StdDuration::from_millis(180);

    if !dir.exists() || !dir.is_dir() {
        return Err(format!("Invalid directory: {path}"));
    }

    let mut results = Vec::new();
    let collect_limit = limit * 3;

    // Check if we're at the home directory
    let home_dir = dirs::home_dir();
    let is_home = home_dir.as_ref().is_some_and(|h| h == dir);

    if is_home {
        // When at home, only search inside common dev folders
        for dev_folder in DEV_FOLDERS {
            let dev_path = dir.join(dev_folder);
            if dev_path.exists() && dev_path.is_dir() {
                let should_stop = search_repos_iterative(
                    &dev_path,
                    &query_lower,
                    max_depth,
                    &mut results,
                    collect_limit,
                    &mut visited_dirs,
                    max_visited_dirs,
                    deadline,
                );
                if should_stop {
                    break;
                }
            }
        }
    } else {
        // Normal iterative search for non-home directories
        search_repos_iterative(
            dir,
            &query_lower,
            max_depth,
            &mut results,
            collect_limit,
            &mut visited_dirs,
            max_visited_dirs,
            deadline,
        );
    }

    // Sort results by relevance:
    // 1. Exact matches first
    // 2. Then by path depth (shallower = better)
    results.sort_by(|a, b| {
        let a_exact = a.name.to_lowercase() == query_lower;
        let b_exact = b.name.to_lowercase() == query_lower;
        if a_exact != b_exact {
            return b_exact.cmp(&a_exact); // exact matches first
        }

        let a_depth = a.path.matches('/').count();
        let b_depth = b.path.matches('/').count();
        a_depth.cmp(&b_depth) // shallower first
    });
    results.truncate(limit);

    Ok(results)
}

/// Iterative directory walk for searching git repositories (avoids native stack overflow).
fn search_repos_iterative(
    root: &Path,
    query: &str,
    max_depth: u32,
    results: &mut Vec<DirEntry>,
    limit: usize,
    visited_dirs: &mut usize,
    max_visited_dirs: usize,
    deadline: Instant,
) -> bool {
    let mut stack = vec![(root.to_path_buf(), 0u32)];

    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth || results.len() >= limit {
            return results.len() >= limit;
        }
        if *visited_dirs >= max_visited_dirs || Instant::now() >= deadline {
            return true;
        }
        *visited_dirs += 1;

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with('.') {
                continue;
            }
            if SKIP_FOLDERS.contains(&name.as_str()) {
                continue;
            }
            if *visited_dirs >= max_visited_dirs || Instant::now() >= deadline {
                return true;
            }

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let entry_path = entry.path();
            let is_repo = entry_path.join(".git").is_dir();

            if is_repo {
                let name_lower = name.to_lowercase();
                if query.is_empty() || name_lower.starts_with(query) || name_lower.contains(query) {
                    results.push(DirEntry {
                        name: name.clone(),
                        path: entry_path.to_string_lossy().to_string(),
                        is_dir: true,
                        is_repo: true,
                    });
                    if results.len() >= limit {
                        return true;
                    }
                }
            } else if depth < max_depth {
                stack.push((entry_path, depth + 1));
            }
        }
    }

    false
}

/// Get the user's home directory.
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeNodesResponse {
    nodes: Vec<MergeNode>,
    has_more: bool,
}

#[tauri::command]
async fn get_branches(repo_path: String) -> Result<Vec<Branch>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let default = git::get_default_branch(path).unwrap_or_else(|_| "main".to_string());
        git::list_branches(path, &default).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_visual_snapshot(
    repo_path: String,
    force_refresh: Option<bool>,
) -> Result<RepoVisualSnapshot, String> {
    run_blocking(move || {
        if !force_refresh.unwrap_or(false) {
            if let Some(cached) = load_cached_repo_visual_snapshot(&repo_path)? {
                return Ok(cached);
            }
        }
        let snapshot = compute_repo_visual_snapshot(&repo_path)?;
        store_repo_visual_snapshot(&snapshot)?;
        Ok(snapshot)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn add_project_and_ingest(
    repo_path: String,
    force_refresh: Option<bool>,
    app: tauri::AppHandle,
) -> Result<ProjectSnapshotRecord, String> {
    run_blocking(move || {
        let normalized_repo_path = normalize_repo_path_id(&repo_path);
        emit_project_load_progress(
            &app,
            &normalized_repo_path,
            "loading",
            "Checking repository",
            3,
            None,
        );
        let result = repo_git_gate::with_repo_git_lock(&normalized_repo_path, || {
            DELETED_PROJECTS
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .map_err(|_| "Deleted project state lock poisoned".to_string())?
                .remove(&normalized_repo_path);
            let project_id = normalized_repo_path.clone();
            let force_refresh = force_refresh.unwrap_or(false);
            let conn = open_visual_cache_connection()?;
            let existing = load_active_project_snapshot(&conn, &project_id)?;
            if !force_refresh {
                if let Some(active) = existing {
                    let probe = match repo_git_gate::cached_probe(&normalized_repo_path) {
                        Some(probe) => probe,
                        None => compute_repo_change_probe_inner(&normalized_repo_path)?,
                    };
                    if active.schema_version == PROJECT_SNAPSHOT_SCHEMA_VERSION
                        && probe_lite_matches_fingerprint(&probe, &active.fingerprint)
                    {
                        return Ok(active);
                    }
                }
            }
            let progress_app = app.clone();
            let progress_repo_path = normalized_repo_path.clone();
            let progress = move |phase: &str, value: u8| {
                emit_project_load_progress(
                    &progress_app,
                    &progress_repo_path,
                    "loading",
                    phase,
                    value,
                    None,
                );
            };
            publish_project_snapshot_with_progress(&normalized_repo_path, None, Some(&progress))
        });
        match &result {
            Ok(_) => {
                emit_project_load_progress(&app, &normalized_repo_path, "ready", "Ready", 100, None)
            }
            Err(error) => emit_project_load_progress(
                &app,
                &normalized_repo_path,
                "error",
                "Load failed",
                100,
                Some(error.clone()),
            ),
        }
        result
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn load_project_snapshot(
    project_id: String,
) -> Result<Option<ProjectSnapshotRecord>, String> {
    run_blocking(move || {
        let conn = open_visual_cache_connection()?;
        load_active_project_snapshot(&conn, &normalize_repo_path_id(&project_id))
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_project_cache(project_id: String) -> Result<(), String> {
    run_blocking(move || delete_project_cache_rows(&project_id)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn check_project_fingerprint(project_id: String) -> Result<FingerprintCheckResult, String> {
    run_blocking(move || check_project_fingerprint_blocking(project_id)).await
}

fn check_project_fingerprint_blocking(
    project_id: String,
) -> Result<FingerprintCheckResult, String> {
    let normalized_project_id = normalize_repo_path_id(&project_id);
    if project_is_deleted(&normalized_project_id)? {
        return Err("Project was removed".to_string());
    }
    let conn = open_visual_cache_connection()?;
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT repo_path, last_fingerprint FROM project_registry WHERE project_id = ?1",
            params![normalized_project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to lookup project registry row: {e}"))?;
    let repo_path = row
        .as_ref()
        .map(|(path, _)| path.clone())
        .unwrap_or_else(|| normalized_project_id.clone());
    let stored_fingerprint = row.and_then(|(_, fingerprint)| fingerprint);

    repo_git_gate::with_repo_git_lock(&repo_path, || {
        let probe = if let Some(cached) = repo_git_gate::cached_probe(&repo_path) {
            cached
        } else {
            compute_repo_change_probe_inner(&repo_path)?
        };
        let (current_fingerprint, changed) = if let Some(ref stored) = stored_fingerprint {
            if fingerprint_unchanged_via_probe(&repo_path, stored, &probe)? {
                (stored.clone(), false)
            } else if let Some(patched) = fingerprint_patch_via_probe(stored, &probe) {
                (patched.clone(), patched != *stored)
            } else {
                let (current, _) = compute_repo_fingerprint_inner(&repo_path)?;
                (current.clone(), current != *stored)
            }
        } else {
            let (current, _) = compute_repo_fingerprint_inner(&repo_path)?;
            (current, true)
        };

        conn.execute(
            "
            INSERT INTO project_registry(project_id, repo_path, active_snapshot_version, last_fingerprint, last_checked_at_ms)
            VALUES (?1, ?2, NULL, ?3, ?4)
            ON CONFLICT(project_id) DO UPDATE SET
                repo_path = excluded.repo_path,
                last_checked_at_ms = excluded.last_checked_at_ms
            ",
            params![
                normalized_project_id,
                repo_path,
                stored_fingerprint,
                Utc::now().timestamp_millis()
            ],
        )
        .map_err(|e| format!("Failed to update project registry timestamp: {e}"))?;
        Ok(FingerprintCheckResult {
            project_id: normalize_repo_path_id(&project_id),
            repo_path: repo_path.clone(),
            changed,
            current_fingerprint,
            stored_fingerprint,
        })
    })
}

#[tauri::command(rename_all = "camelCase")]
fn ack_project_fingerprint(project_id: String, fingerprint: String) -> Result<(), String> {
    let normalized_project_id = normalize_repo_path_id(&project_id);
    if project_is_deleted(&normalized_project_id)? {
        return Ok(());
    }
    let fingerprint = fingerprint.trim();
    if fingerprint.is_empty() {
        return Err("Fingerprint must not be empty".to_string());
    }
    let conn = open_visual_cache_connection()?;
    let now_ms = Utc::now().timestamp_millis();
    conn.execute(
        "
        INSERT INTO project_registry(project_id, repo_path, active_snapshot_version, last_fingerprint, last_checked_at_ms)
        VALUES (?1, ?1, NULL, ?2, ?3)
        ON CONFLICT(project_id) DO UPDATE SET
            last_fingerprint = excluded.last_fingerprint,
            last_checked_at_ms = excluded.last_checked_at_ms
        ",
        params![normalized_project_id, fingerprint, now_ms],
    )
    .map_err(|e| format!("Failed to ack project fingerprint: {e}"))?;
    Ok(())
}

fn refresh_project_if_changed_blocking(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<RefreshProjectResult, String> {
    let normalized_project_id = normalize_repo_path_id(&project_id);
    let check = check_project_fingerprint_blocking(normalized_project_id.clone())?;
    if !check.changed {
        return Ok(RefreshProjectResult {
            project_id: normalized_project_id,
            repo_path: check.repo_path,
            updated: false,
            snapshot: None,
        });
    }
    let snapshot = publish_project_snapshot(&check.repo_path, Some(&check.current_fingerprint))?;
    let _ = app.emit(
        "project-snapshot-updated",
        serde_json::json!({
            "projectId": snapshot.project_id,
            "repoPath": snapshot.repo_path,
            "snapshotVersion": snapshot.snapshot_version,
        }),
    );
    Ok(RefreshProjectResult {
        project_id: snapshot.project_id.clone(),
        repo_path: snapshot.repo_path.clone(),
        updated: true,
        snapshot: Some(snapshot),
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn refresh_project_if_changed(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<RefreshProjectResult, String> {
    run_blocking(move || refresh_project_if_changed_blocking(project_id, app)).await
}

fn persist_project_snapshot_blocking(
    project_id: String,
    force: bool,
    app: tauri::AppHandle,
) -> Result<PersistProjectSnapshotResult, String> {
    let normalized_project_id = normalize_repo_path_id(&project_id);
    let check = check_project_fingerprint_blocking(normalized_project_id)?;
    if !force && !check.changed {
        return Ok(PersistProjectSnapshotResult { persisted: false });
    }
    let snapshot = publish_project_snapshot(&check.repo_path, Some(&check.current_fingerprint))?;
    let _ = app.emit(
        "project-snapshot-updated",
        serde_json::json!({
            "projectId": snapshot.project_id,
            "repoPath": snapshot.repo_path,
            "snapshotVersion": snapshot.snapshot_version,
        }),
    );
    Ok(PersistProjectSnapshotResult { persisted: true })
}

#[tauri::command(rename_all = "camelCase")]
async fn persist_project_snapshot(
    project_id: String,
    force: Option<bool>,
    app: tauri::AppHandle,
) -> Result<PersistProjectSnapshotResult, String> {
    let force = force.unwrap_or(false);
    run_blocking(move || persist_project_snapshot_blocking(project_id, force, app)).await
}

#[tauri::command(rename_all = "camelCase")]
fn get_repo_layout_snapshot(
    repo_path: String,
    layout_key: String,
) -> Result<Option<String>, String> {
    load_cached_repo_layout_snapshot(&repo_path, &layout_key)
}

#[tauri::command(rename_all = "camelCase")]
fn store_repo_layout_snapshot(
    repo_path: String,
    layout_key: String,
    payload_json: String,
) -> Result<(), String> {
    upsert_repo_layout_snapshot(&repo_path, &layout_key, &payload_json)
}

#[tauri::command(rename_all = "camelCase")]
fn get_repo_node_positions(repo_path: String) -> Result<Option<String>, String> {
    load_cached_repo_node_positions(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
fn store_repo_node_positions(repo_path: String, payload_json: String) -> Result<(), String> {
    upsert_repo_node_positions(&repo_path, &payload_json)
}

#[tauri::command(rename_all = "camelCase")]
fn clear_repo_node_positions(repo_path: String) -> Result<(), String> {
    delete_repo_node_positions(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
fn get_repo_refresh_fingerprint(repo_path: String) -> Result<RepoRefreshFingerprint, String> {
    let (_, fingerprint) = compute_repo_fingerprint(&repo_path)?;
    Ok(fingerprint)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoWatcherActivityEpochs {
    git_epoch: u64,
    worktree_epoch: u64,
}

#[tauri::command(rename_all = "camelCase")]
fn get_repo_watcher_epochs(repo_path: String) -> Result<RepoWatcherActivityEpochs, String> {
    let normalized = normalize_repo_path_id(&repo_path);
    let map = WATCHER_ACTIVITY
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(entry) = map.get(&normalized) {
        Ok(RepoWatcherActivityEpochs {
            git_epoch: entry.last_git_event_epoch.load(Ordering::Relaxed),
            worktree_epoch: entry.last_worktree_event_epoch.load(Ordering::Relaxed),
        })
    } else {
        Ok(RepoWatcherActivityEpochs {
            git_epoch: 0,
            worktree_epoch: 0,
        })
    }
}

fn metadata_stamp(path: &Path) -> String {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| format!("{}:{}", duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_sync_tokens(repo_path: String) -> Result<RepoSyncTokens, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let git_dir = git::cli::run(path, &["rev-parse", "--absolute-git-dir"])
            .map_err(|error| error.to_string())?;
        let git_dir = PathBuf::from(git_dir.trim());
        let common_dir = git::cli::run(path, &["rev-parse", "--git-common-dir"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                let candidate = PathBuf::from(value);
                if candidate.is_absolute() {
                    candidate
                } else {
                    path.join(candidate)
                }
            })
            .unwrap_or_else(|| git_dir.clone());
        let head = git::cli::run(path, &["rev-parse", "HEAD"])
            .map_err(|error| error.to_string())?
            .trim()
            .to_string();
        let refs = git::cli::run(
            path,
            &[
                "for-each-ref",
                "--sort=refname",
                "--format=%(refname):%(objectname)",
                "refs/heads",
                "refs/remotes",
                "refs/stash",
            ],
        )
        .map_err(|error| error.to_string())?;
        let mut worktrees = git::list_worktrees(path).map_err(|error| error.to_string())?;
        worktrees.sort_by(|left, right| left.path.cmp(&right.path));

        // Sync the file watcher with any new worktrees that exist
        let normalized_repo_path = normalize_repo_path_id(&repo_path);
        let path_canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if let Some(lock) = WATCHER_STATE.get() {
            if let Ok(mut map) = lock.lock() {
                if let Some(watcher) = map.get_mut(&normalized_repo_path) {
                    for worktree in &worktrees {
                        if worktree.path_exists {
                            let wt_path = Path::new(&worktree.path);
                            let wt_path_canonical = wt_path
                                .canonicalize()
                                .unwrap_or_else(|_| wt_path.to_path_buf());
                            if wt_path_canonical.exists()
                                && !worktree_watch_roots_same(&path_canonical, &wt_path_canonical)
                            {
                                let _ = watcher.watch(&wt_path_canonical, RecursiveMode::Recursive);
                            }
                        }
                    }
                }
            }
        }

        let dirty_worktrees: Vec<RepoSyncWorktreeDirty> = worktrees
            .iter()
            .map(|worktree| RepoSyncWorktreeDirty {
                path: worktree.path.clone(),
                has_uncommitted_changes: worktree.has_uncommitted_changes,
            })
            .collect();
        let dirty_token = dirty_worktrees
            .iter()
            .map(|worktree| {
                format!(
                    "{}:{}",
                    worktree.path,
                    if worktree.has_uncommitted_changes {
                        "1"
                    } else {
                        "0"
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("|");
        let worktree_graph = worktrees
            .iter()
            .map(|worktree| {
                format!(
                    "{}:{}:{}:{}:{}:{}",
                    worktree.path,
                    worktree.head_sha,
                    worktree.branch_name.as_deref().unwrap_or(""),
                    worktree.parent_sha.as_deref().unwrap_or(""),
                    if worktree.path_exists { "1" } else { "0" },
                    if worktree.is_prunable { "1" } else { "0" },
                )
            })
            .collect::<Vec<_>>()
            .join("|");
        let graph_token = format!(
            "head={}@@refs={}@@packed={}@@worktrees={}",
            head,
            refs.trim(),
            metadata_stamp(&common_dir.join("packed-refs")),
            worktree_graph,
        );
        Ok(RepoSyncTokens {
            repo_path: normalize_repo_path_id(&repo_path),
            dirty_token,
            graph_token,
            dirty_worktrees,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_head_state(repo_path: String) -> Result<RepoHeadState, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let head_sha = git::cli::run(path, &["rev-parse", "HEAD"])
            .map_err(|e| e.to_string())?
            .trim()
            .to_string();
        let upstream_sha = git::cli::run(path, &["rev-parse", "--verify", "HEAD@{upstream}"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Ok(RepoHeadState {
            repo_path: repo_path.clone(),
            head_sha,
            upstream_sha,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_quick_state(repo_path: String) -> Result<RepoQuickState, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let head_sha = git::cli::run(path, &["rev-parse", "HEAD"])
            .map_err(|e| e.to_string())?
            .trim()
            .to_string();
        let upstream_sha = git::cli::run(path, &["rev-parse", "--verify", "HEAD@{upstream}"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let porcelain = git::cli::run(
            path,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        )
        .map_err(|e| e.to_string())?;
        Ok(RepoQuickState {
            repo_path: repo_path.clone(),
            head_sha,
            upstream_sha,
            has_uncommitted_changes: !porcelain.trim().is_empty(),
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_dirty_state(repo_path: String) -> Result<bool, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let porcelain = git::cli::run(
            path,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        )
        .map_err(|e| e.to_string())?;
        Ok(!porcelain.trim().is_empty())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedBranchDelta {
    name: String,
    old_head_sha: Option<String>,
    new_head_sha: String,
    new_commits: Vec<DirectCommit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoGraphDelta {
    fingerprint: String,
    checked_out_ref: CheckedOutRef,
    branches: Vec<Branch>,
    changed_branches: Vec<ChangedBranchDelta>,
    removed_branches: Vec<String>,
    unpushed_commit_shas_by_branch: HashMap<String, Vec<String>>,
    requires_full_refresh: bool,
}

fn branch_ref_entry_sig(branch: &Branch) -> String {
    format!(
        "{}:{}:{}:{}",
        branch.head_sha, branch.commits_ahead, branch.unpushed_commits, branch.remote_sync_status
    )
}

fn parse_branch_ref_sig_map(sig: &str) -> HashMap<String, String> {
    sig.split('|')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let name = entry.split(':').next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some((name.to_string(), entry.to_string()))
        })
        .collect()
}

fn branch_unpushed_shas_for_delta(path: &Path, branch: &str) -> Result<Vec<String>, String> {
    let range = if let Some(compare_ref) = get_branch_compare_ref(path, branch) {
        format!("{compare_ref}..{branch}")
    } else {
        let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
        format!("{default_branch}..{branch}")
    };
    let output =
        git::cli::run(path, &["rev-list", "--first-parent", &range]).map_err(|e| e.to_string())?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

fn get_repo_graph_delta_blocking(
    repo_path: String,
    stored_branch_ref_sig: Option<String>,
) -> Result<RepoGraphDelta, String> {
    repo_git_gate::with_repo_git_lock(&repo_path, || {
        get_repo_graph_delta_inner(&repo_path, stored_branch_ref_sig)
    })
}

fn get_repo_graph_delta_inner(
    repo_path: &str,
    stored_branch_ref_sig: Option<String>,
) -> Result<RepoGraphDelta, String> {
    let path = Path::new(repo_path);
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
    let checked_out_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
    let current_heads = git::list_local_branch_heads(path).map_err(|e| e.to_string())?;

    let stored_map = stored_branch_ref_sig
        .as_deref()
        .map(parse_branch_ref_sig_map)
        .unwrap_or_default();

    let current_names: HashSet<String> = current_heads
        .iter()
        .filter(|(name, _)| name != &default_branch)
        .map(|(name, _)| name.clone())
        .collect();

    let mut removed_branches = Vec::new();
    for name in stored_map.keys() {
        if !current_names.contains(name) {
            removed_branches.push(name.clone());
        }
    }

    let mut changed_branches = Vec::new();
    let mut unpushed_commit_shas_by_branch = HashMap::new();
    let mut requires_full_refresh = false;
    let mut branches = Vec::new();

    for (name, head_sha) in current_heads {
        if name == default_branch {
            continue;
        }

        let stored_entry = stored_map.get(&name);
        if stored_entry.is_none() {
            requires_full_refresh = true;
        }

        let stored_head = stored_entry.and_then(|entry| {
            entry
                .split(':')
                .nth(1)
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty())
        });

        let branch = if stored_entry.is_some() && stored_head.as_deref() == Some(head_sha.as_str())
        {
            if let Some(entry) = stored_entry {
                if let Some(partial) = git::branch_from_ref_sig_entry(&name, entry) {
                    let current_entry =
                        format!("{}:{}", partial.name, branch_ref_entry_sig(&partial));
                    if stored_entry.map(String::as_str) == Some(current_entry.as_str()) {
                        partial
                    } else {
                        git::get_branch_info_for_name(path, &name, &default_branch)
                            .map_err(|e| e.to_string())?
                    }
                } else {
                    git::get_branch_info_for_name(path, &name, &default_branch)
                        .map_err(|e| e.to_string())?
                }
            } else {
                git::get_branch_info_for_name(path, &name, &default_branch)
                    .map_err(|e| e.to_string())?
            }
        } else {
            git::get_branch_info_for_name(path, &name, &default_branch)
                .map_err(|e| e.to_string())?
        };

        let current_entry = format!("{}:{}", branch.name, branch_ref_entry_sig(&branch));
        if stored_entry.map(String::as_str) == Some(current_entry.as_str()) {
            branches.push(branch);
            continue;
        }

        let old_head_sha = stored_head;
        let new_commits = if old_head_sha.as_deref() != Some(branch.head_sha.as_str()) {
            match git::get_branch_commits_since(path, &branch.name, old_head_sha.as_deref(), 20) {
                Ok(commits) => commits,
                Err(_) => {
                    requires_full_refresh = true;
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        if new_commits
            .iter()
            .any(|commit| commit.parent_shas.len() > 1)
        {
            requires_full_refresh = true;
        }

        unpushed_commit_shas_by_branch.insert(
            branch.name.clone(),
            branch_unpushed_shas_for_delta(path, &branch.name)?,
        );

        changed_branches.push(ChangedBranchDelta {
            name: branch.name.clone(),
            old_head_sha,
            new_head_sha: branch.head_sha.clone(),
            new_commits,
        });
        branches.push(branch);
    }

    let worktrees = git::list_worktrees(path).map_err(|e| e.to_string())?;
    let stashes = git::list_stashes(path).map_err(|e| e.to_string())?;
    let upstream_sha = git::resolve_branch_upstream_ref(path, &default_branch)
        .and_then(|upstream_ref| git::cli::run(path, &["rev-parse", &upstream_ref]).ok())
        .map(|output| output.trim().to_string())
        .filter(|value| !value.is_empty());
    let remote_heads_digest = git::compute_remote_heads_digest(path).unwrap_or_default();
    let fingerprint = compose_repo_fingerprint(
        &default_branch,
        &checked_out_ref,
        &branches,
        &worktrees,
        &stashes,
        upstream_sha,
        remote_heads_digest,
    );

    Ok(RepoGraphDelta {
        fingerprint,
        checked_out_ref,
        branches,
        changed_branches,
        removed_branches,
        unpushed_commit_shas_by_branch,
        requires_full_refresh,
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn get_repo_graph_delta(
    repo_path: String,
    stored_branch_ref_sig: Option<String>,
) -> Result<RepoGraphDelta, String> {
    run_blocking(move || get_repo_graph_delta_blocking(repo_path, stored_branch_ref_sig)).await
}

#[tauri::command(rename_all = "camelCase")]
fn get_branch_head_sha(repo_path: String, branch: String) -> Result<String, String> {
    let path = Path::new(&repo_path);
    git::cli::run(path, &["rev-parse", &branch])
        .map(|output| output.trim().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn get_commit_parent_sha(repo_path: String, sha: String) -> Result<Option<String>, String> {
    let path = Path::new(&repo_path);
    let output = git::cli::run(path, &["rev-parse", &format!("{sha}^")])
        .map_err(|error| error.to_string())?;
    let parent = output.trim().to_string();
    if parent.is_empty() {
        Ok(None)
    } else {
        Ok(Some(parent))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSyncResult {
    fetched: bool,
    pulled: bool,
    changed: bool,
    remote_heads_digest: String,
}

#[tauri::command(rename_all = "camelCase")]
fn sync_remote_repository(
    repo_path: String,
    pull_ff_only: Option<bool>,
) -> Result<RemoteSyncResult, String> {
    let path = Path::new(&repo_path);
    let digest_before = git::compute_remote_heads_digest(path).unwrap_or_default();
    let fetched = git::fetch_remotes(path).unwrap_or(false);
    let pulled = if pull_ff_only.unwrap_or(true) {
        git::try_fast_forward_pull(path).unwrap_or(false)
    } else {
        false
    };
    let remote_heads_digest = git::compute_remote_heads_digest(path).unwrap_or_default();
    Ok(RemoteSyncResult {
        fetched,
        pulled,
        changed: pulled || remote_heads_digest != digest_before,
        remote_heads_digest,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn fetch_repo_remotes(repo_path: String) -> Result<bool, String> {
    let path = Path::new(&repo_path);
    git::fetch_remotes(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn get_remote_branch_head_sha(repo_path: String, branch: String) -> Result<Option<String>, String> {
    let path = Path::new(&repo_path);
    if let Some(upstream_ref) = git::resolve_branch_upstream_ref(path, &branch) {
        if let Ok(output) = git::cli::run(path, &["rev-parse", &upstream_ref]) {
            let sha = output.trim().to_string();
            if !sha.is_empty() {
                return Ok(Some(sha));
            }
        }
    }

    let (remote, has_upstream) = get_branch_push_remote(path, &branch)?;
    let remote_branch = if has_upstream {
        match git::cli::run(
            path,
            &[
                "rev-parse",
                "--abbrev-ref",
                &format!("{branch}@{{upstream}}"),
            ],
        ) {
            Ok(output) => output
                .trim()
                .split_once('/')
                .map(|(_, branch_name)| branch_name.to_string())
                .unwrap_or(branch),
            Err(_) => branch,
        }
    } else {
        branch
    };

    let output = git::cli::run(
        path,
        &["ls-remote", &remote, &format!("refs/heads/{remote_branch}")],
    )
    .map_err(|e| e.to_string())?;
    let sha = output
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(sha)
}

#[tauri::command(rename_all = "camelCase")]
fn get_commit_subject(repo_path: String, sha: String) -> Result<Option<String>, String> {
    let path = Path::new(&repo_path);
    let output =
        git::cli::run(path, &["show", "-s", "--format=%s", &sha]).map_err(|e| e.to_string())?;
    let subject = output.trim().to_string();
    if subject.is_empty() {
        Ok(None)
    } else {
        Ok(Some(subject))
    }
}

#[tauri::command(rename_all = "camelCase")]
fn check_network_available() -> bool {
    let hosts = [("github.com", 443u16), ("1.1.1.1", 53), ("8.8.8.8", 53)];
    let timeout = StdDuration::from_secs(2);
    hosts.iter().any(|(host, port)| {
        let addr = (*host, *port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.next());
        match addr {
            Some(ref a) => TcpStream::connect_timeout(a, timeout).is_ok(),
            None => false,
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitMetadata {
    subject: String,
    author: String,
}

#[tauri::command(rename_all = "camelCase")]
fn get_commit_metadata(repo_path: String, sha: String) -> Result<Option<CommitMetadata>, String> {
    let path = Path::new(&repo_path);
    let output = git::cli::run(path, &["show", "-s", "--format=%s%n%an", &sha])
        .map_err(|e| e.to_string())?;
    let mut lines = output.lines();
    let subject = lines.next().unwrap_or("").trim().to_string();
    let author = lines.next().unwrap_or("").trim().to_string();
    if subject.is_empty() {
        Ok(None)
    } else {
        Ok(Some(CommitMetadata { subject, author }))
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn get_merge_base(
    repo_path: String,
    left_sha: String,
    right_sha: String,
) -> Result<Option<String>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let output = git::cli::run(path, &["merge-base", &left_sha, &right_sha])
            .map_err(|e| e.to_string())?;
        let sha = output
            .lines()
            .next()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string());
        Ok(sha)
    })
    .await
}

#[tauri::command]
async fn get_merge_nodes(
    repo_path: String,
    branch: String,
    exclude_ref: Option<String>,
    page: u32,
    per_page: u32,
) -> Result<MergeNodesResponse, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let (nodes, has_more) =
            git::get_merge_commits(path, &branch, exclude_ref.as_deref(), page, per_page)
                .map_err(|e| e.to_string())?;
        Ok(MergeNodesResponse { nodes, has_more })
    })
    .await
}

#[tauri::command]
async fn get_default_branch(repo_path: String) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::get_default_branch(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn get_checked_out_ref(repo_path: String) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::get_checked_out_ref(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn stage_working_tree(repo_path: String) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::stage_working_tree(path).map_err(|e| e.to_string())?;
        git::get_checked_out_ref(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn list_worktrees(repo_path: String) -> Result<Vec<git::WorktreeInfo>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::list_worktrees(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::remove_git_worktree(path, &worktree_path, force).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn add_worktree(
    repo_path: String,
    worktree_path: String,
    branch_or_commit: Option<String>,
    new_branch_name: Option<String>,
) -> Result<git::WorktreeInfo, String> {
    run_blocking(move || {
        let repo = Path::new(&repo_path);
        let branch_ref = branch_or_commit.as_deref().unwrap_or("").trim();
        if let Some(stash_ref_body) = branch_ref
            .strip_prefix("stash@{")
            .and_then(|value| value.strip_suffix('}'))
        {
            let stash_index: u32 = stash_ref_body
                .parse()
                .map_err(|_| "Invalid stash index".to_string())?;
            let new_branch = new_branch_name.as_deref().unwrap_or("").trim();
            if new_branch.is_empty() {
                return Err(
                    "Creating a worktree from a stash requires a new branch name.".to_string(),
                );
            }
            let stash_ref = format!("stash@{{{stash_index}}}");
            let base_sha = git::cli::run(repo, &["rev-parse", &format!("{stash_ref}^1")])
                .map_err(|e| e.to_string())?;
            let base_sha = base_sha.trim();
            git::cli::run(
                repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    new_branch,
                    &worktree_path,
                    base_sha,
                ],
            )
            .map_err(|e| e.to_string())?;
            let wt_dir = Path::new(&worktree_path);
            if let Err(e) = git::cli::run(wt_dir, &["stash", "apply", &stash_ref]) {
                let _ = git::cli::run(repo, &["worktree", "remove", "--force", &worktree_path]);
                return Err(e.to_string());
            }
            git::cli::run(wt_dir, &["stash", "drop", &stash_ref]).map_err(|e| e.to_string())?;
            let worktrees = git::list_worktrees(repo).map_err(|e| e.to_string())?;
            let new_wt = worktrees
                .into_iter()
                .find(|wt| wt.path == worktree_path)
                .ok_or_else(|| "Worktree was created but not found in list".to_string())?;
            return Ok(new_wt);
        }

        let mut args: Vec<&str> = vec!["worktree", "add"];

        let new_branch = new_branch_name.as_deref().unwrap_or("").trim();
        if !new_branch.is_empty() {
            args.push("-b");
            args.push(new_branch);
        }

        args.push(&worktree_path);

        if !branch_ref.is_empty() {
            args.push(branch_ref);
        }

        git::cli::run(repo, &args).map_err(|e| e.to_string())?;

        let worktrees = git::list_worktrees(repo).map_err(|e| e.to_string())?;
        let new_wt = worktrees
            .into_iter()
            .find(|wt| wt.path == worktree_path)
            .ok_or_else(|| "Worktree was created but not found in list".to_string())?;
        Ok(new_wt)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn prepare_preview_target(
    repo_path: String,
    target: git::PreviewTarget,
) -> Result<git::PreparePreviewTargetResult, String> {
    run_blocking(move || {
        let storage_root = preview_worktree_storage_root()?;
        let path = Path::new(&repo_path);
        git::prepare_preview_target(path, &storage_root, target).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn preview_dependencies_need_install(
    preview_path: String,
    dependency_files_changed: bool,
) -> Result<bool, String> {
    run_blocking(move || {
        Ok(git::preview_path_needs_install(
            Path::new(&preview_path),
            dependency_files_changed,
        ))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalReadResult {
    session: terminal_host::TerminalSession,
    output: String,
}

#[tauri::command(rename_all = "camelCase")]
async fn save_terminal_attachment(
    file_name: String,
    mime_type: String,
    data_base64: String,
) -> Result<String, String> {
    run_blocking(move || {
        let base = dirs::data_local_dir()
            .or_else(dirs::cache_dir)
            .ok_or_else(|| "Unable to resolve terminal attachment directory".to_string())?;
        let directory = base.join("cobble").join("terminal-attachments");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Failed to create terminal attachment directory: {error}"))?;
        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                value.len() <= 12
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
            .map(str::to_ascii_lowercase)
            .or_else(|| match mime_type.as_str() {
                "image/png" => Some("png".to_string()),
                "image/jpeg" => Some("jpg".to_string()),
                "image/gif" => Some("gif".to_string()),
                "image/webp" => Some("webp".to_string()),
                "video/mp4" => Some("mp4".to_string()),
                "video/quicktime" => Some("mov".to_string()),
                "video/webm" => Some("webm".to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "bin".to_string());
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let path = directory.join(format!(
            "{}-{}.{}",
            stem.trim_matches('-'),
            timestamp,
            extension
        ));
        let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_base64)
            .map_err(|error| format!("Failed to decode terminal attachment: {error}"))?;
        fs::write(&path, data)
            .map_err(|error| format!("Failed to save terminal attachment: {error}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
async fn list_terminal_sessions() -> Result<Vec<terminal_host::TerminalSession>, String> {
    run_blocking(|| {
        let mut sessions = terminal_host::list_sessions()?;
        for session in &mut sessions {
            hydrate_preview_session_target(session);
        }
        Ok(sessions)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn create_terminal_session(
    session: terminal_host::TerminalSession,
) -> Result<terminal_host::TerminalSession, String> {
    run_blocking(move || terminal_host::create_session(session)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn read_terminal_session(id: String) -> Result<TerminalReadResult, String> {
    run_blocking(move || {
        let (mut session, output) = terminal_host::read_session(id)?;
        hydrate_preview_session_target_from_output(&mut session, &output);
        Ok(TerminalReadResult { session, output })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn write_terminal_session(id: String, data: String) -> Result<(), String> {
    run_blocking(move || terminal_host::write_session(id, data)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn resize_terminal_session(id: String, cols: u16, rows: u16) -> Result<(), String> {
    run_blocking(move || terminal_host::resize_session(id, cols, rows)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn set_terminal_session_label(id: String, label: String) -> Result<(), String> {
    run_blocking(move || terminal_host::set_session_label(id, label)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn set_terminal_session_target(
    id: String,
    target_id: String,
    target_kind: String,
) -> Result<terminal_host::TerminalSession, String> {
    run_blocking(move || terminal_host::set_session_target(id, target_id, target_kind)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn restart_terminal_session(
    id: String,
    command: String,
) -> Result<terminal_host::TerminalSession, String> {
    run_blocking(move || terminal_host::restart_session_command(id, command)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn terminate_terminal_session(id: String) -> Result<(), String> {
    run_blocking(move || terminal_host::terminate_session(id)).await
}

fn hydrate_preview_session_target(session: &mut terminal_host::TerminalSession) {
    if session.kind != "preview" {
        return;
    }
    if let Ok((_, output)) = terminal_host::read_session(session.id.clone()) {
        hydrate_preview_session_target_from_output(session, &output);
    }
}

fn hydrate_preview_session_target_from_output(
    session: &mut terminal_host::TerminalSession,
    output: &str,
) {
    if session.kind == "preview" && session.preview_url.is_none() {
        session.preview_url = git::detect_localhost_url(output);
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn activate_preview_target(
    id: String,
    url: Option<String>,
    app_name: Option<String>,
    reload: Option<bool>,
) -> Result<(), String> {
    let reload = reload.unwrap_or(false);
    run_blocking(move || {
        let (url, app_name) = match terminal_host::read_session(id) {
            Ok((mut session, output)) => {
                hydrate_preview_session_target_from_output(&mut session, &output);
                if is_native_preview_command(&session.command) {
                    return activate_native_preview_for_path(Path::new(&session.worktree_path));
                }
                (
                    session.preview_url.or(url),
                    session.preview_app_name.or(app_name),
                )
            }
            Err(_) => (url, app_name),
        };
        if let Some(url) = url {
            if !url.starts_with("http://localhost:")
                && !url.starts_with("https://localhost:")
                && !url.starts_with("http://127.0.0.1:")
                && !url.starts_with("https://127.0.0.1:")
            {
                return Err("Only loopback preview URLs can be opened".to_string());
            }
            if focus_existing_browser_tab(&url, reload) {
                return Ok(());
            }
            let output = std::process::Command::new("open")
                .arg(&url)
                .output()
                .map_err(|error| format!("Failed to open preview: {error}"))?;
            return if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            };
        }

        let app_name = app_name
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Preview target is not ready yet".to_string())?;
        activate_preview_app(&app_name)
    })
    .await
}

fn focus_existing_browser_tab(url: &str, reload: bool) -> bool {
    if try_focus_browser_tab(url, reload) {
        return true;
    }
    // Try the alternative loopback form (localhost <-> 127.0.0.1)
    let alt_url = if url.contains("://localhost:") {
        url.replace("://localhost:", "://127.0.0.1:")
    } else if url.contains("://127.0.0.1:") {
        url.replace("://127.0.0.1:", "://localhost:")
    } else {
        return false;
    };
    try_focus_browser_tab(&alt_url, reload)
}

fn try_focus_browser_tab(url: &str, reload: bool) -> bool {
    if focus_existing_dia_tab(url, reload) {
        return true;
    }
    for app_name in [
        "Google Chrome",
        "Google Chrome Canary",
        "Brave Browser",
        "Microsoft Edge",
        "Chromium",
    ] {
        if focus_existing_chromium_tab(app_name, url, reload) {
            return true;
        }
    }
    focus_existing_safari_tab(url, reload)
}

fn focus_existing_dia_tab(url: &str, reload: bool) -> bool {
    if !browser_process_is_running("Dia") {
        return false;
    }
    let script = format!(
        r#"{match_handler}
on run argv
  set targetUrl to item 1 of argv
  set shouldReload to (item 2 of argv is "true")
  tell application "Dia"
    repeat with browserWindow in windows
      repeat with browserTab in tabs of browserWindow
        if my urlMatches(URL of browserTab, targetUrl) then
          focus browserTab
          activate
          if shouldReload then
            try
              set origUrl to URL of browserTab
              if origUrl contains "?" then
                set URL of browserTab to (origUrl & "&_gv_reload")
              else
                set URL of browserTab to (origUrl & "?_gv_reload")
              end if
              delay 0.05
              set URL of browserTab to origUrl
            end try
          end if
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run"#,
        match_handler = browser_tab_match_script(),
    );
    run_browser_tab_focus_script(&script, url, reload)
}

fn browser_tab_match_script() -> &'static str {
    r##"on urlMatches(tabUrl, targetUrl)
  set cleanTab to tabUrl
  if cleanTab ends with "/" then
    set cleanTab to text 1 thru -2 of cleanTab
  end if
  set cleanTarget to targetUrl
  if cleanTarget ends with "/" then
    set cleanTarget to text 1 thru -2 of cleanTarget
  end if
  return cleanTab is cleanTarget or cleanTab starts with cleanTarget & "/" or cleanTab starts with cleanTarget & "?" or cleanTab starts with cleanTarget & "#"
end urlMatches"##
}

fn browser_process_is_running(app_name: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-x", app_name])
        .status()
        .is_ok_and(|status| status.success())
}

fn focus_existing_chromium_tab(app_name: &str, url: &str, reload: bool) -> bool {
    if !browser_process_is_running(app_name) {
        return false;
    }
    let script = format!(
        r#"{match_handler}
on run argv
  set targetUrl to item 1 of argv
  set shouldReload to (item 2 of argv is "true")
  tell application "{app_name}"
    repeat with browserWindow in windows
      set tabIndex to 0
      repeat with browserTab in tabs of browserWindow
        set tabIndex to tabIndex + 1
        if my urlMatches(URL of browserTab, targetUrl) then
          set active tab index of browserWindow to tabIndex
          set index of browserWindow to 1
          activate
          if shouldReload then
            try
              reload browserTab
            on error
              try
                set origUrl to URL of browserTab
                if origUrl contains "?" then
                  set URL of browserTab to (origUrl & "&_gv_reload")
                else
                  set URL of browserTab to (origUrl & "?_gv_reload")
                end if
                delay 0.05
                set URL of browserTab to origUrl
              end try
            end try
          end if
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run"#,
        match_handler = browser_tab_match_script(),
    );
    run_browser_tab_focus_script(&script, url, reload)
}

fn focus_existing_safari_tab(url: &str, reload: bool) -> bool {
    if !browser_process_is_running("Safari") {
        return false;
    }
    let script = format!(
        r#"{match_handler}
on run argv
  set targetUrl to item 1 of argv
  set shouldReload to (item 2 of argv is "true")
  tell application "Safari"
    repeat with browserWindow in windows
      repeat with browserTab in tabs of browserWindow
        if my urlMatches(URL of browserTab, targetUrl) then
          set current tab of browserWindow to browserTab
          set index of browserWindow to 1
          activate
          if shouldReload then
            try
              set origUrl to URL of browserTab
              if origUrl contains "?" then
                set URL of browserTab to (origUrl & "&_gv_reload")
              else
                set URL of browserTab to (origUrl & "?_gv_reload")
              end if
              delay 0.05
              set URL of browserTab to origUrl
            end try
          end if
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run"#,
        match_handler = browser_tab_match_script(),
    );
    run_browser_tab_focus_script(&script, url, reload)
}

fn run_browser_tab_focus_script(script: &str, url: &str, reload: bool) -> bool {
    let reload_str = if reload { "true" } else { "false" };
    std::process::Command::new("osascript")
        .args(["-e", script, url, reload_str])
        .output()
        .is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"focused"))
}

fn activate_native_preview_for_path(worktree_path: &Path) -> Result<(), String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .map_err(|error| format!("Failed to inspect Tauri preview processes: {error}"))?;
    let mut candidates = Vec::<i32>::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let Some(pid) = parts.next().and_then(|value| value.parse::<i32>().ok()) else {
            continue;
        };
        let command = parts.next().unwrap_or_default();
        if command.contains("target/debug/") || command.contains("target/release/") {
            candidates.push(pid);
        }
    }
    let cwd_by_pid = lsof_paths_for_pids(&candidates, "cwd");
    let pid = candidates
        .into_iter()
        .find(|pid| {
            cwd_by_pid.get(pid).is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| path == worktree_path || path.starts_with(worktree_path))
            })
        })
        .ok_or_else(|| "Tauri preview app is not ready yet".to_string())?;
    activate_preview_pid(pid)
}

fn activate_preview_pid(pid: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .ok_or_else(|| "Tauri preview app is not registered with macOS".to_string())?;
        let _ = app.unhide();
        let _ = app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
        for _ in 0..5 {
            std::thread::sleep(StdDuration::from_millis(40));
            if app.isActive() {
                return Ok(());
            }
        }
    }

    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"System Events\" to set frontmost of first process whose unix id is (item 1 of argv as integer) to true",
            "-e",
            "end run",
            &pid.to_string(),
        ])
        .output()
        .map_err(|error| format!("Failed to activate preview process: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    #[cfg(target_os = "macos")]
    {
        for _ in 0..5 {
            std::thread::sleep(StdDuration::from_millis(40));
            if NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .is_some_and(|app| app.processIdentifier() == pid)
            {
                return Ok(());
            }
        }
        return Err("Tauri preview app did not become frontmost".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

fn activate_preview_app(app_name: &str) -> Result<(), String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"System Events\" to set frontmost of first process whose name is item 1 of argv to true",
            "-e",
            "end run",
            app_name,
        ])
        .output()
        .map_err(|error| format!("Failed to activate preview app: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn preview_processes() -> &'static Mutex<HashMap<String, PreviewProcess>> {
    PREVIEW_PROCESS_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_process_key(repo_path: &str, target_id: &str, target_kind: &str) -> String {
    let repo_key = normalize_repo_path_id(repo_path);
    if target_kind == "worktree" {
        format!("{repo_key}::worktree::{target_id}")
    } else {
        format!("{repo_key}::commit")
    }
}

fn preview_process_key_is_for_repo(key: &str, repo_path: &str) -> bool {
    let repo_key = normalize_repo_path_id(repo_path);
    key == repo_key || key.starts_with(&format!("{repo_key}::"))
}

fn stop_project_preview_blocking(repo_path: &str) -> Result<(), String> {
    {
        let mut processes = preview_processes()
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?;
        let keys = processes
            .keys()
            .filter(|key| preview_process_key_is_for_repo(key, repo_path))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            let Some(mut process) = processes.remove(&key) else {
                continue;
            };
            terminate_preview_process(&mut process.child);
            let _ = process.child.wait();
        }
    }
    let storage_root = preview_worktree_storage_root()?;
    terminate_orphaned_preview_processes(&storage_root);
    git::clear_active_preview_target(&storage_root, Path::new(repo_path));
    Ok(())
}

fn stop_all_preview_processes() {
    let Ok(mut processes) = preview_processes().lock() else {
        return;
    };
    for (_, mut process) in processes.drain() {
        terminate_preview_process(&mut process.child);
        let _ = process.child.wait();
    }
}

fn schedule_stop_all_preview_processes() {
    if PREVIEW_SHUTDOWN_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(stop_all_preview_processes);
}

fn terminate_preview_process(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id().to_string();
        let pgid = format!("-{}", child.id());
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pgid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(StdDuration::from_millis(150));
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pgid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn terminate_process_id(pid: i32) {
    if pid <= 0 {
        return;
    }
    #[cfg(unix)]
    {
        let pgid = format!("-{pid}");
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pgid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(StdDuration::from_millis(150));
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pgid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn terminate_orphaned_preview_processes(storage_root: &Path) {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid="])
        .output();
    let Ok(output) = output else {
        return;
    };
    let Ok(raw) = std::str::from_utf8(&output.stdout) else {
        return;
    };
    let mut pids = raw
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0 && *pid != std::process::id() as i32)
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    let cwd_by_pid = lsof_paths_for_pids(&pids, "cwd");
    let mut pids_to_kill = HashSet::<i32>::new();
    for (pid, paths) in cwd_by_pid {
        if paths.iter().any(|path| path.starts_with(storage_root)) {
            pids_to_kill.insert(pid);
            for child_pid in collect_descendant_pids(pid, 512) {
                pids_to_kill.insert(child_pid);
            }
        }
    }
    let mut ordered = pids_to_kill.into_iter().collect::<Vec<_>>();
    ordered.sort_unstable_by(|a, b| b.cmp(a));
    for pid in ordered {
        terminate_process_id(pid);
    }
}

fn preview_log_tail(path: &Path) -> String {
    compact_preview_log_if_needed(path);
    read_bounded_log_tail(path, PREVIEW_LOG_TAIL_BYTES, PREVIEW_LOG_MAX_LINES)
}

fn read_bounded_log_tail(path: &Path, max_bytes: u64, max_lines: usize) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(metadata) = file.metadata() else {
        return String::new();
    };
    let len = metadata.len();
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buffer = Vec::with_capacity((len - start).min(max_bytes) as usize);
    if file.take(max_bytes).read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    if start > 0 {
        if let Some(newline_index) = buffer.iter().position(|byte| *byte == b'\n') {
            if newline_index + 1 < buffer.len() {
                buffer.drain(..=newline_index);
            }
        }
    }
    let raw = String::from_utf8_lossy(&buffer);
    let mut lines = raw.lines().rev().take(max_lines).collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn compact_preview_log_if_needed(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() <= PREVIEW_LOG_COMPACT_THRESHOLD_BYTES {
        return;
    }
    let tail = read_bounded_log_tail(path, PREVIEW_LOG_COMPACT_KEEP_BYTES, usize::MAX);
    let Ok(mut file) = OpenOptions::new().write(true).truncate(true).open(path) else {
        return;
    };
    let _ = file.write_all(tail.as_bytes());
    let _ = file.write_all(b"\n");
}

fn command_declares_port(command: &str) -> bool {
    let lowered = command.to_ascii_lowercase();
    lowered.contains("--port")
        || lowered.contains(" port ")
        || lowered.contains("port=")
        || lowered.contains("port:")
        || lowered.contains("vite --host")
}

fn find_available_preview_port() -> Option<u16> {
    for port in 4173..4300 {
        if preview_port_is_available(port) {
            return Some(port);
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn preview_port_is_available(port: u16) -> bool {
    TcpListener::bind(("::", port)).is_ok() && TcpListener::bind(("0.0.0.0", port)).is_ok()
}

fn is_native_preview_command(command: &str) -> bool {
    command.to_ascii_lowercase().contains("tauri dev")
}

fn shell_command(
    command: &str,
    cwd: &Path,
    log: Option<&Path>,
    detached_group: bool,
    port: Option<u16>,
) -> Result<std::process::Command, String> {
    let mut cmd = std::process::Command::new("zsh");
    cmd.args(["-lc", command]);
    if let Some(path) = user_shell_path() {
        cmd.env("PATH", path);
    }
    cmd.current_dir(cwd)
        .env("BROWSER", "none")
        .env("NO_OPEN", "1")
        .env_remove("npm_config_open")
        .env_remove("npm_config_verify_deps_before_run")
        .env_remove("npm_config__jsr_registry");
    if let Some(port) = port {
        cmd.env("PORT", port.to_string());
    }
    if let Some(log_path) = log {
        let file =
            File::create(log_path).map_err(|e| format!("Failed to create preview log: {e}"))?;
        let err = file
            .try_clone()
            .map_err(|e| format!("Failed to clone preview log: {e}"))?;
        cmd.stdout(Stdio::from(file)).stderr(Stdio::from(err));
    }
    #[cfg(unix)]
    if detached_group {
        cmd.process_group(0);
    }
    Ok(cmd)
}

/// Finder-launched macOS apps do not inherit the user's interactive shell PATH.
/// Preview commands commonly rely on tools installed by nvm, Homebrew, or a
/// package-manager shim, so use the user's login/interactive shell to resolve it.
fn user_shell_path() -> Option<String> {
    if let Ok(output) = std::process::Command::new("zsh")
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

fn run_preview_step_to_log(
    command: &str,
    cwd: &Path,
    log_path: &Path,
    port: Option<u16>,
) -> Result<bool, String> {
    let mut child = shell_command(command, cwd, Some(log_path), true, port)?
        .spawn()
        .map_err(|e| format!("Failed to start preview command: {e}"))?;
    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for preview command: {e}"))?;
    Ok(status.success())
}

fn detect_project_preview_defaults_blocking(
    repo_path: String,
) -> Result<ProjectPreviewDefaults, String> {
    let repo = Path::new(&repo_path);
    let package_json = repo.join("package.json");
    if repo.join("src-tauri/tauri.conf.json").exists() && package_json.exists() {
        if let Ok(raw) = fs::read_to_string(&package_json) {
            if raw.contains("\"tauri\"") {
                let install = if repo.join("pnpm-lock.yaml").exists() {
                    "pnpm install"
                } else if repo.join("yarn.lock").exists() {
                    "yarn install"
                } else if repo.join("bun.lockb").exists() {
                    "bun install"
                } else {
                    "npm install"
                };
                return Ok(ProjectPreviewDefaults {
                    install_command: install.to_string(),
                    run_command: match install {
                        "pnpm install" => "pnpm tauri dev",
                        "yarn install" => "yarn tauri dev",
                        "bun install" => "bun run tauri dev",
                        _ => "npm run tauri dev",
                    }
                    .to_string(),
                });
            }
        }
    }
    if repo.join("pnpm-lock.yaml").exists() {
        return Ok(ProjectPreviewDefaults {
            install_command: "pnpm install".to_string(),
            run_command: "pnpm run dev".to_string(),
        });
    }
    if repo.join("yarn.lock").exists() {
        return Ok(ProjectPreviewDefaults {
            install_command: "yarn install".to_string(),
            run_command: "yarn dev".to_string(),
        });
    }
    if repo.join("bun.lockb").exists() {
        return Ok(ProjectPreviewDefaults {
            install_command: "bun install".to_string(),
            run_command: "bun run dev".to_string(),
        });
    }
    Ok(ProjectPreviewDefaults {
        install_command: "npm install".to_string(),
        run_command: "npm run dev".to_string(),
    })
}

fn start_project_preview_blocking(
    repo_path: String,
    target: git::PreviewTarget,
    config: ProjectPreviewConfig,
) -> Result<ProjectPreviewResult, String> {
    let storage_root = preview_worktree_storage_root()?;
    let repo = Path::new(&repo_path);
    let target_id = target.target_id();
    let is_native_preview = is_native_preview_command(&config.run_command);
    let preview_mode = if is_native_preview { "native" } else { "web" }.to_string();
    let (preview_path, preview_path_string, target_kind, dependency_files_changed) = match target {
        git::PreviewTarget::Worktree { worktree_path, .. } => (
            PathBuf::from(&worktree_path),
            worktree_path,
            "worktree".to_string(),
            false,
        ),
        commit_target => {
            let prepared = git::prepare_preview_target(repo, &storage_root, commit_target)
                .map_err(|e| e.to_string())?;
            (
                PathBuf::from(&prepared.preview_path),
                prepared.preview_path,
                prepared.target_kind,
                prepared.dependency_files_changed,
            )
        }
    };
    let process_key = preview_process_key(&repo_path, &target_id, &target_kind);
    {
        let mut processes = preview_processes()
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?;
        if let Some(process) = processes.get_mut(&process_key) {
            if matches!(process.child.try_wait(), Ok(None)) {
                process.target_id = target_id.clone();
                process.preview_path = preview_path_string.clone();
                let logs = preview_log_tail(&process.log_path);
                let url = if process.preview_mode == "native" {
                    None
                } else {
                    git::detect_localhost_url(&logs)
                };
                return Ok(ProjectPreviewResult {
                    preview_path: preview_path_string,
                    target_id,
                    url,
                    status: "running".to_string(),
                    logs,
                    preview_mode: process.preview_mode.clone(),
                });
            }
            processes.remove(&process_key);
        }
    }
    let state_path = storage_root.join("logs");
    fs::create_dir_all(&state_path)
        .map_err(|e| format!("Failed to create preview log directory: {e}"))?;
    let log_path = state_path.join(format!(
        "{}-{}.log",
        normalize_repo_path_id(&repo_path).replace('/', "_"),
        target_id.replace(['/', ':'], "_")
    ));
    let install_log_path = state_path.join(format!(
        "{}-{}.install.log",
        normalize_repo_path_id(&repo_path).replace('/', "_"),
        target_id.replace(['/', ':'], "_")
    ));

    let install_needed =
        git::should_run_install(&storage_root, repo, &preview_path, dependency_files_changed);
    if install_needed && config.install_command.trim().is_empty() {
        return Ok(ProjectPreviewResult {
            preview_path: preview_path_string,
            target_id,
            url: None,
            status: "installFailed".to_string(),
            logs: "Install is required for this preview worktree, but no install command is configured.".to_string(),
            preview_mode,
        });
    }

    if install_needed {
        let _ = fs::remove_file(&install_log_path);
        let install_ok = run_preview_step_to_log(
            &config.install_command,
            &preview_path,
            &install_log_path,
            None,
        )?;
        if !install_ok {
            let logs = preview_log_tail(&install_log_path);
            return Ok(ProjectPreviewResult {
                preview_path: preview_path_string,
                target_id,
                url: git::detect_localhost_url(&logs),
                status: "installFailed".to_string(),
                logs,
                preview_mode,
            });
        }
        git::mark_install_success(&storage_root, repo).map_err(|e| e.to_string())?;
    }

    let _ = fs::remove_file(&log_path);
    let preview_port = if is_native_preview || command_declares_port(&config.run_command) {
        None
    } else {
        find_available_preview_port()
    };
    let mut child = shell_command(
        &config.run_command,
        &preview_path,
        Some(&log_path),
        true,
        preview_port,
    )?
    .spawn()
    .map_err(|e| format!("Failed to start preview command: {e}"))?;

    let started = Instant::now();
    let mut status = "running".to_string();
    let mut logs = String::new();
    let mut url = None;
    while started.elapsed() < StdDuration::from_millis(2500) {
        if let Ok(Some(_)) = child.try_wait() {
            status = "exited".to_string();
            break;
        }
        logs = preview_log_tail(&log_path);
        url = if is_native_preview {
            None
        } else {
            git::detect_localhost_url(&logs)
        };
        if url.is_some() || is_native_preview {
            break;
        }
        std::thread::sleep(StdDuration::from_millis(150));
    }
    if logs.is_empty() {
        logs = preview_log_tail(&log_path);
    }
    if url.is_none() {
        url = if is_native_preview {
            None
        } else {
            git::detect_localhost_url(&logs)
        };
    }

    preview_processes()
        .lock()
        .map_err(|_| "Preview process state is unavailable".to_string())?
        .insert(
            process_key,
            PreviewProcess {
                child,
                log_path: log_path.clone(),
                preview_path: preview_path_string.clone(),
                target_id: target_id.clone(),
                preview_mode: preview_mode.clone(),
            },
        );

    Ok(ProjectPreviewResult {
        preview_path: preview_path_string,
        target_id,
        url,
        status,
        logs,
        preview_mode,
    })
}

fn get_project_preview_status_blocking(
    repo_path: String,
) -> Result<Option<ProjectPreviewResult>, String> {
    let key = normalize_repo_path_id(&repo_path);
    let mut processes = preview_processes()
        .lock()
        .map_err(|_| "Preview process state is unavailable".to_string())?;
    let Some(process) = processes.get_mut(&key) else {
        return Ok(None);
    };
    let logs = preview_log_tail(&process.log_path);
    let url = if process.preview_mode == "native" {
        None
    } else {
        git::detect_localhost_url(&logs)
    };
    let status = match process.child.try_wait() {
        Ok(Some(_)) => "exited",
        Ok(None) => "running",
        Err(_) => "exited",
    }
    .to_string();
    let result = ProjectPreviewResult {
        preview_path: process.preview_path.clone(),
        target_id: process.target_id.clone(),
        url,
        status: status.clone(),
        logs,
        preview_mode: process.preview_mode.clone(),
    };
    if status == "exited" {
        processes.remove(&key);
    }
    Ok(Some(result))
}

fn get_project_preview_log_tail_blocking(
    repo_path: String,
) -> Result<ProjectPreviewLogTail, String> {
    let processes = preview_processes()
        .lock()
        .map_err(|_| "Preview process state is unavailable".to_string())?;
    let log_path = processes
        .iter()
        .find(|(key, _)| preview_process_key_is_for_repo(key, &repo_path))
        .map(|(_, process)| process.log_path.clone());
    drop(processes);

    let Some(log_path) = log_path else {
        return Ok(ProjectPreviewLogTail {
            logs: String::new(),
        });
    };
    Ok(ProjectPreviewLogTail {
        logs: preview_log_tail(&log_path),
    })
}

fn get_active_project_preview_target_blocking(
    repo_path: String,
) -> Result<Option<git::ActivePreviewTarget>, String> {
    Ok(get_active_project_preview_targets_blocking(repo_path)?
        .into_iter()
        .next())
}

fn get_active_project_preview_targets_blocking(
    repo_path: String,
) -> Result<Vec<git::ActivePreviewTarget>, String> {
    let mut processes = preview_processes()
        .lock()
        .map_err(|_| "Preview process state is unavailable".to_string())?;
    let keys = processes
        .keys()
        .filter(|key| preview_process_key_is_for_repo(key, &repo_path))
        .cloned()
        .collect::<Vec<_>>();
    let mut active = Vec::new();
    let mut removed_any = false;
    for key in keys {
        let Some(process) = processes.get_mut(&key) else {
            continue;
        };
        if matches!(process.child.try_wait(), Ok(Some(_)) | Err(_)) {
            processes.remove(&key);
            removed_any = true;
            continue;
        }
        let target_kind = if key.contains("::worktree::") {
            "worktree"
        } else {
            "commit"
        };
        active.push(git::ActivePreviewTarget {
            preview_path: process.preview_path.clone(),
            target_id: process.target_id.clone(),
            target_kind: target_kind.to_string(),
            effective_head_sha: process.target_id.clone(),
            overlay_applied: false,
        });
    }
    drop(processes);
    if removed_any {
        let storage_root = preview_worktree_storage_root()?;
        terminate_orphaned_preview_processes(&storage_root);
        git::clear_active_preview_target(&storage_root, Path::new(&repo_path));
    }
    Ok(active)
}

#[tauri::command(rename_all = "camelCase")]
async fn detect_project_preview_defaults(
    repo_path: String,
) -> Result<ProjectPreviewDefaults, String> {
    run_blocking(move || detect_project_preview_defaults_blocking(repo_path)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn start_project_preview(
    repo_path: String,
    target: git::PreviewTarget,
    config: ProjectPreviewConfig,
) -> Result<ProjectPreviewResult, String> {
    run_blocking(move || start_project_preview_blocking(repo_path, target, config)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_project_preview_status(
    repo_path: String,
) -> Result<Option<ProjectPreviewResult>, String> {
    run_blocking(move || get_project_preview_status_blocking(repo_path)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_project_preview_log_tail(repo_path: String) -> Result<ProjectPreviewLogTail, String> {
    run_blocking(move || get_project_preview_log_tail_blocking(repo_path)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_active_project_preview_target(
    repo_path: String,
) -> Result<Option<git::ActivePreviewTarget>, String> {
    run_blocking(move || get_active_project_preview_target_blocking(repo_path)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_active_project_preview_targets(
    repo_path: String,
) -> Result<Vec<git::ActivePreviewTarget>, String> {
    run_blocking(move || get_active_project_preview_targets_blocking(repo_path)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_project_preview(repo_path: String) -> Result<(), String> {
    run_blocking(move || stop_project_preview_blocking(&repo_path)).await
}

fn list_git_remotes(repo: &Path) -> Result<Vec<String>, String> {
    let output = git::cli::run(repo, &["remote"]).map_err(|e| e.to_string())?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

fn remote_ref_exists(repo: &Path, remote_ref: &str) -> bool {
    git::cli::run(repo, &["show-ref", "--verify", "--quiet", remote_ref]).is_ok()
}

fn get_branch_push_remote(repo: &Path, branch: &str) -> Result<(String, bool), String> {
    let upstream_query = format!("{branch}@{{upstream}}");
    if let Ok(output) = git::cli::run(repo, &["rev-parse", "--abbrev-ref", &upstream_query]) {
        let upstream = output.trim();
        if let Some((remote, _branch)) = upstream.split_once('/') {
            if !remote.is_empty() {
                return Ok((remote.to_string(), true));
            }
        }
    }

    let remotes = list_git_remotes(repo)?;
    if remotes.is_empty() {
        return Err("No git remote is configured for this repository.".to_string());
    }

    if remotes.iter().any(|remote| remote == "origin") {
        return Ok(("origin".to_string(), false));
    }

    Ok((remotes[0].clone(), false))
}

fn branch_has_unpushed_commits(repo: &Path, branch: &str) -> bool {
    branch_has_unpushed_commits_vs_ref(
        repo,
        branch,
        get_branch_compare_ref(repo, branch).as_deref(),
    )
}

fn branch_has_unpushed_commits_vs_ref(
    repo: &Path,
    branch: &str,
    compare_ref: Option<&str>,
) -> bool {
    let Some(compare_ref) = compare_ref else {
        return true;
    };

    let range = format!("{compare_ref}..{branch}");
    match git::cli::run(repo, &["rev-list", "--count", &range]) {
        Ok(output) => output
            .trim()
            .parse::<u32>()
            .map(|ahead| ahead > 0)
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn list_local_branch_names(repo: &Path) -> Result<Vec<String>, String> {
    let output =
        git::cli::run(repo, &["branch", "--format=%(refname:short)"]).map_err(|e| e.to_string())?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn branch_has_unique_commits(repo: &Path, branch: &str) -> Result<bool, String> {
    let local_ref = format!("refs/heads/{branch}");
    if git::cli::run(repo, &["show-ref", "--verify", "--quiet", &local_ref]).is_err() {
        return Ok(false);
    }

    let output = git::cli::run(
        repo,
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
    )
    .map_err(|e| e.to_string())?;
    let mut args = vec![
        "rev-list".to_string(),
        "--count".to_string(),
        branch.to_string(),
        "--not".to_string(),
    ];
    for line in output.lines() {
        let ref_name = line.trim();
        if ref_name.is_empty() || ref_name == local_ref {
            continue;
        }
        args.push(ref_name.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|arg| arg.as_str()).collect();
    let unique_count = git::cli::run(repo, &arg_refs)
        .map_err(|e| e.to_string())?
        .trim()
        .parse::<i32>()
        .unwrap_or(0);
    Ok(unique_count > 0)
}

fn delete_local_branch_if_exists(repo: &Path, branch_name: &str) -> Result<bool, String> {
    let local_ref = format!("refs/heads/{branch_name}");
    if git::cli::run(repo, &["show-ref", "--verify", "--quiet", &local_ref]).is_err() {
        return Ok(false);
    }
    git::cli::run(repo, &["branch", "-D", branch_name]).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Whether a local branch should be included in push-all (matches list_branches unpushed filter).
fn branch_needs_push(repo: &Path, branch: &str, default_branch: &str) -> bool {
    if let Some(compare_ref) = get_branch_compare_ref(repo, branch) {
        return branch_has_unpushed_commits_vs_ref(repo, branch, Some(compare_ref.as_str()));
    }
    if branch == default_branch {
        return false;
    }
    let range = format!("{default_branch}..{branch}");
    match git::cli::run(repo, &["rev-list", "--count", &range]) {
        Ok(output) => output
            .trim()
            .parse::<u32>()
            .map(|ahead| ahead > 0)
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn ensure_github_remote_git_auth(repo: &Path) -> Result<(), String> {
    let remote_url = match git::cli::run(repo, &["remote", "get-url", "origin"]) {
        Ok(url) => url,
        Err(_) => return Ok(()),
    };
    if !remote_url.contains("github.com") {
        return Ok(());
    }
    github::ensure_github_git_credentials()
}

fn push_branch_refs_batched(repo: &Path, targets: &[PushResult]) -> Result<(), String> {
    if targets.is_empty() {
        return Ok(());
    }

    ensure_github_remote_git_auth(repo)?;

    let mut groups: HashMap<(String, bool), Vec<String>> = HashMap::new();
    for target in targets {
        if target.target_sha.is_some() {
            push_branch_ref(repo, &target.branch_name, target.target_sha.as_deref())?;
            continue;
        }
        let (remote, has_upstream) = get_branch_push_remote(repo, &target.branch_name)?;
        groups
            .entry((remote, has_upstream))
            .or_default()
            .push(target.branch_name.clone());
    }

    for ((remote, has_upstream), branches) in groups {
        let mut args = vec!["push".to_string()];
        if !has_upstream {
            args.push("-u".to_string());
        }
        args.push(remote);
        for branch in branches {
            args.push(branch);
        }
        let arg_refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
        git::cli::run(repo, &arg_refs).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn get_branch_compare_ref(repo: &Path, branch: &str) -> Option<String> {
    if let Ok(output) = git::cli::run(
        repo,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    ) {
        let upstream = output.trim();
        if !upstream.is_empty() {
            return Some(upstream.to_string());
        }
    }
    if remote_ref_exists(repo, &format!("refs/remotes/origin/{branch}")) {
        return Some(format!("origin/{branch}"));
    }
    None
}

fn push_branch_ref(repo: &Path, branch: &str, target_sha: Option<&str>) -> Result<(), String> {
    let (remote, has_upstream) = get_branch_push_remote(repo, branch)?;
    let refspec = target_sha
        .map(|sha| format!("{sha}:refs/heads/{branch}"))
        .unwrap_or_else(|| branch.to_string());

    let args: Vec<String> = if has_upstream {
        vec!["push".to_string(), remote, refspec]
    } else {
        vec!["push".to_string(), "-u".to_string(), remote, refspec]
    };
    let arg_refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    git::cli::run(repo, &arg_refs).map_err(|e| e.to_string())?;
    Ok(())
}

fn local_branch_exists(repo: &Path, branch_name: &str) -> bool {
    git::cli::run(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ],
    )
    .is_ok()
}

fn unique_local_branch_name(repo: &Path, base_name: &str) -> String {
    if !local_branch_exists(repo, base_name) {
        return base_name.to_string();
    }

    for suffix in 2..1000 {
        let candidate = format!("{base_name}-{suffix}");
        if !local_branch_exists(repo, &candidate) {
            return candidate;
        }
    }

    format!("{base_name}-{}", Utc::now().timestamp())
}

fn validate_generated_branch_name(repo: &Path, branch_name: &str) -> Result<(), String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() || trimmed != branch_name {
        return Err("Generated branch name is empty or malformed.".to_string());
    }
    git::cli::run(repo, &["check-ref-format", "--branch", trimmed])
        .map(|_| ())
        .map_err(|_| format!("Invalid generated branch name: {trimmed}"))
}

#[tauri::command(rename_all = "camelCase")]
async fn pull_branch_with_strategy(
    repo_path: String,
    branch_name: String,
    rebase: bool,
) -> Result<(), String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        ensure_github_remote_git_auth(path)?;
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        } else {
            args.push("--no-rebase");
        }
        args.push("origin");
        args.push(&branch_name);
        git::cli::run(path, &args)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn checkout_ref(repo_path: String, ref_name: String) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::cli::run(path, &["checkout", "--detach", &ref_name]).map_err(|e| e.to_string())?;
        git::get_checked_out_ref(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn checkout_branch(repo_path: String, branch_name: String) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::cli::run(path, &["checkout", &branch_name]).map_err(|e| e.to_string())?;
        git::get_checked_out_ref(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
fn list_stashes(repo_path: String) -> Result<Vec<git::GitStashEntry>, String> {
    let path = Path::new(&repo_path);
    git::list_stashes(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
async fn stash_push(
    repo_path: String,
    include_untracked: bool,
    message: String,
) -> Result<StashPushResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let stash_message = message.trim();
        let stash_message = if stash_message.is_empty() {
            "cobble"
        } else {
            stash_message
        };
        opencode::validate_generated_message(stash_message, "Stash message")?;
        git::stash_push(path, include_untracked, stash_message).map_err(|e| e.to_string())?;
        let stashes = git::list_stashes(path).map_err(|e| e.to_string())?;
        let stash = stashes
            .into_iter()
            .find(|entry| entry.index == 0)
            .ok_or_else(|| "Stash push succeeded but stash@{0} was not found.".to_string())?;
        let checked_out_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
        Ok(StashPushResult {
            worktree_path: repo_path,
            stash,
            checked_out_ref,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_working_tree(
    repo_path: String,
    message: String,
    generated_branch_name: Option<String>,
) -> Result<CommitMutationResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let trimmed = message.trim();
        opencode::validate_generated_message(trimmed, "Commit message")?;
        let before_commit_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
        if before_commit_ref.branch_name.is_none() {
            let generated_branch_name = generated_branch_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "A generated branch name is required when committing from detached HEAD."
                        .to_string()
                })?;
            validate_generated_branch_name(path, generated_branch_name)?;
            let branch_name = unique_local_branch_name(path, generated_branch_name);
            git::cli::run(path, &["checkout", "-b", &branch_name]).map_err(|e| e.to_string())?;
        }
        git::commit_working_tree(path, trimmed).map_err(|e| e.to_string())?;
        let checked_out_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
        let branch_name = checked_out_ref
            .branch_name
            .clone()
            .ok_or_else(|| "Cannot resolve branch name after commit.".to_string())?;
        let output = git::cli::run(
            path,
            &["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P"],
        )
        .map_err(|e| e.to_string())?;
        let line = output
            .lines()
            .next()
            .ok_or_else(|| "Commit succeeded but log output was empty.".to_string())?;
        let parts: Vec<&str> = line.splitn(6, "\u{1f}").collect();
        if parts.len() < 6 {
            return Err("Failed to parse commit metadata.".to_string());
        }
        let parent_shas: Vec<String> = parts[5]
            .split_whitespace()
            .map(|value| value.to_string())
            .collect();
        let parent_sha = parent_shas.first().cloned();
        Ok(CommitMutationResult {
            worktree_path: repo_path,
            checked_out_ref,
            branch_name,
            full_sha: parts[0].to_string(),
            sha: parts[1].to_string(),
            message: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            parent_sha,
            parent_shas,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_working_tree_summary(repo_path: String) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::get_working_tree_summary(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn generate_commit_message(
    repo_path: String,
    previous_message: Option<String>,
) -> Result<GeneratedCommitDraftResult, String> {
    let path = repo_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repo = Path::new(&path);
        let summary = git::get_working_tree_summary(repo).map_err(|e| e.to_string())?;
        let previous = previous_message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let draft = opencode::generate_commit_draft(repo, &summary, previous)?;
        Ok(GeneratedCommitDraftResult {
            commit_message: draft.commit_message,
            branch_name: unique_local_branch_name(repo, &draft.branch_name),
        })
    })
    .await
    .map_err(|e| format!("Commit message task failed: {e}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn create_generated_branch(
    repo_path: String,
    branch_name: String,
) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let trimmed = branch_name.trim();
        validate_generated_branch_name(path, trimmed)?;
        let unique_name = unique_local_branch_name(path, trimmed);
        git::cli::run(path, &["checkout", "-b", &unique_name]).map_err(|e| e.to_string())?;
        git::get_checked_out_ref(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn generate_stash_message(
    repo_path: String,
    previous_message: Option<String>,
) -> Result<String, String> {
    let path = repo_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repo = Path::new(&path);
        let summary = git::get_working_tree_summary(repo).map_err(|e| e.to_string())?;
        let previous = previous_message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        opencode::generate_stash_message(repo, &summary, previous)
    })
    .await
    .map_err(|e| format!("Stash message task failed: {e}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn apply_stash_restore(
    repo_path: String,
    stash_index: u32,
) -> Result<StashRestoreResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::apply_stash_restore(path, stash_index).map_err(|e| e.to_string())?;
        let checked_out_ref = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
        Ok(StashRestoreResult {
            removed_index: stash_index,
            checked_out_ref,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn stash_drop(repo_path: String, stash_index: u32) -> Result<StashDropResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        git::stash_drop(path, stash_index).map_err(|e| e.to_string())?;
        Ok(StashDropResult {
            removed_index: stash_index,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
fn create_branch_from_uncommitted(
    repo_path: String,
    branch_name: String,
) -> Result<CheckedOutRef, String> {
    let path = Path::new(&repo_path);
    git::create_branch_from_uncommitted(path, &branch_name).map_err(|e| e.to_string())?;
    git::get_checked_out_ref(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn move_stash_to_new_branch(
    repo_path: String,
    stash_index: u32,
    branch_name: String,
) -> Result<CheckedOutRef, String> {
    let path = Path::new(&repo_path);
    git::move_stash_to_new_branch(path, stash_index, &branch_name).map_err(|e| e.to_string())?;
    git::get_checked_out_ref(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn create_root_branch(repo_path: String, branch_name: String) -> Result<CheckedOutRef, String> {
    let path = Path::new(&repo_path);
    git::create_root_branch(path, &branch_name).map_err(|e| e.to_string())?;
    git::get_checked_out_ref(path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
async fn overhaul_create_branch(
    repo_path: String,
    branch_name: String,
    target_node_id: String,
    worktree_path: Option<String>,
) -> Result<CheckedOutRef, String> {
    run_blocking(move || {
        let repo = Path::new(&repo_path);

        if target_node_id.is_empty() {
            // Root branch
            if let Some(wt_path) = worktree_path {
                git::cli::run(repo, &["worktree", "add", "--orphan", &wt_path, &branch_name])
                    .map_err(|e| e.to_string())?;
            } else {
                git::create_root_branch(repo, &branch_name).map_err(|e| e.to_string())?;
            }
        } else if let Some(stash_idx_str) = target_node_id.strip_prefix("STASH:") {
            // From stash
            let stash_index: u32 = stash_idx_str.parse().map_err(|_| "Invalid stash index".to_string())?;
            let stash_ref = format!("stash@{{{stash_index}}}");
            let base_sha = git::cli::run(repo, &["rev-parse", &format!("{stash_ref}^1")])
                .map_err(|e| e.to_string())?;
            let base_sha = base_sha.trim();

            if let Some(wt_path) = worktree_path {
                git::cli::run(repo, &["worktree", "add", "-b", &branch_name, &wt_path, base_sha])
                    .map_err(|e| e.to_string())?;

                let wt_dir = Path::new(&wt_path);
                git::cli::run(wt_dir, &["stash", "apply", &stash_ref]).map_err(|e| e.to_string())?;
                git::cli::run(wt_dir, &["stash", "drop", &stash_ref]).map_err(|e| e.to_string())?;
            } else {
                git::move_stash_to_new_branch(repo, stash_index, &branch_name).map_err(|e| e.to_string())?;
            }
        } else if target_node_id == "WORKING_TREE" || target_node_id.starts_with("WORKING_TREE:") {
            // From uncommitted changes
            if let Some(wt_path) = worktree_path {
                let temp_stash_msg = format!("cobble-temp-worktree-{}", branch_name);
                git::stash_push(repo, true, &temp_stash_msg).map_err(|e| e.to_string())?;

                if let Err(e) = git::cli::run(repo, &["worktree", "add", "-b", &branch_name, &wt_path]) {
                    // Try to pop/restore stash if worktree creation fails
                    let _ = git::cli::run(repo, &["stash", "pop"]);
                    return Err(e.to_string());
                }

                let wt_dir = Path::new(&wt_path);
                if let Err(e) = git::cli::run(wt_dir, &["stash", "apply", "stash@{0}"]) {
                    let _ = git::cli::run(wt_dir, &["stash", "drop", "stash@{0}"]);
                    return Err(format!("Worktree created but failed to apply uncommitted changes: {}", e));
                }
                if let Err(e) = git::cli::run(wt_dir, &["stash", "drop", "stash@{0}"]) {
                    return Err(format!("Worktree created and changes applied, but failed to drop temporary stash: {}", e));
                }
            } else {
                git::create_branch_from_uncommitted(repo, &branch_name).map_err(|e| e.to_string())?;
            }
        } else {
            // From normal commit
            if let Some(wt_path) = worktree_path {
                git::cli::run(repo, &["worktree", "add", "-b", &branch_name, &wt_path, &target_node_id])
                    .map_err(|e| e.to_string())?;
            } else {
                git::cli::run(repo, &["checkout", "-b", &branch_name, &target_node_id]).map_err(|e| e.to_string())?;
            }
        }

        git::get_checked_out_ref(repo).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_resizable(window: tauri::WebviewWindow, resizable: bool) -> Result<(), String> {
    window.set_resizable(resizable).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
async fn push_branch(
    repo_path: String,
    branch_name: String,
    target_sha: Option<String>,
) -> Result<PushResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        push_branch_ref(path, &branch_name, target_sha.as_deref())?;
        Ok(PushResult {
            branch_name,
            target_sha,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn push_current_branch(repo_path: String) -> Result<PushResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let checked_out = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
        let branch_name = checked_out
            .branch_name
            .ok_or_else(|| "Cannot push while HEAD is detached.".to_string())?;
        push_branch_ref(path, &branch_name, None)?;
        Ok(PushResult {
            branch_name,
            target_sha: None,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn push_all_unpushed_branches(repo_path: String) -> Result<Vec<PushResult>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
        let mut push_targets: Vec<PushResult> = list_local_branch_names(path)?
            .into_iter()
            .filter(|branch| branch_needs_push(path, branch, &default_branch))
            .map(|branch_name| PushResult {
                branch_name,
                target_sha: None,
            })
            .collect();

        if branch_has_unpushed_commits(path, &default_branch)
            && !push_targets
                .iter()
                .any(|target| target.branch_name == default_branch)
        {
            push_targets.push(PushResult {
                branch_name: default_branch.clone(),
                target_sha: None,
            });
        }

        push_branch_refs_batched(path, &push_targets)?;

        Ok(push_targets)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
fn delete_selected_elements(
    repo_path: String,
    branch_names: Vec<String>,
    discard_uncommitted_changes: bool,
) -> Result<DeleteSelectionResult, String> {
    let path = Path::new(&repo_path);
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;

    if discard_uncommitted_changes {
        git::cli::run(path, &["reset", "--hard", "HEAD"]).map_err(|e| e.to_string())?;
        git::cli::run(path, &["clean", "-fd"]).map_err(|e| e.to_string())?;
    }

    let mut unique_branch_names = Vec::new();
    let mut seen = HashSet::new();
    for branch_name in branch_names {
        let trimmed = branch_name.trim();
        if trimmed.is_empty() || trimmed == default_branch {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            unique_branch_names.push(trimmed.to_string());
        }
    }

    if unique_branch_names.is_empty() {
        return Ok(DeleteSelectionResult {
            deleted_branches: vec![],
            discarded_uncommitted_changes: discard_uncommitted_changes,
            checked_out_ref: git::get_checked_out_ref(path).ok(),
        });
    }

    let checked_out = git::get_checked_out_ref(path).map_err(|e| e.to_string())?;
    if let Some(current_branch) = checked_out.branch_name {
        if unique_branch_names
            .iter()
            .any(|branch_name| branch_name == &current_branch)
        {
            git::cli::run(path, &["checkout", &default_branch]).map_err(|e| e.to_string())?;
        }
    }

    // Linked worktrees that still have this branch checked out must be removed before `git branch -D`
    // (otherwise Git refuses or leaves stale registrations).
    if !unique_branch_names.is_empty() {
        let worktrees = git::list_worktrees(path).map_err(|e| e.to_string())?;
        let branch_set: HashSet<&str> = unique_branch_names.iter().map(|s| s.as_str()).collect();
        let mut removed_wt_paths = HashSet::<String>::new();
        for wt in &worktrees {
            if wt.is_current {
                continue;
            }
            let Some(bn) = wt.branch_name.as_deref() else {
                continue;
            };
            if !branch_set.contains(bn) {
                continue;
            }
            if !removed_wt_paths.insert(wt.path.clone()) {
                continue;
            }
            let force = wt.is_prunable || !wt.path_exists;
            git::remove_git_worktree(path, &wt.path, force).map_err(|e| e.to_string())?;
        }
    }

    for branch_name in &unique_branch_names {
        let local_ref = format!("refs/heads/{}", branch_name);
        let show_ref_res = git::cli::run(path, &["show-ref", "--verify", "--quiet", &local_ref]);
        let has_local = show_ref_res.is_ok();
        if has_local {
            let delete_res = git::cli::run(path, &["branch", "-D", branch_name]);
            delete_res.map_err(|e| e.to_string())?;
        }

        if let Ok(output) = git::cli::run(
            path,
            &["for-each-ref", "--format=%(refname)", "refs/remotes"],
        ) {
            for ref_line in output.lines() {
                let ref_name = ref_line.trim();
                if ref_name.starts_with("refs/remotes/") {
                    let stripped = &ref_name["refs/remotes/".len()..];
                    if let Some(slash_idx) = stripped.find('/') {
                        let remote_name = &stripped[..slash_idx];
                        let remote_branch_name = &stripped[slash_idx + 1..];
                        if remote_branch_name == branch_name {
                            // Resolve current SHA of this remote-tracking ref
                            let sha = if let Ok(rev_output) =
                                git::cli::run(path, &["rev-parse", ref_name])
                            {
                                rev_output.trim().to_string()
                            } else {
                                String::new()
                            };

                            // Persist deleted remote branch metadata in database
                            if !sha.is_empty() {
                                let normalized_repo_path = normalize_repo_path_id(&repo_path);
                                let now_ms = Utc::now().timestamp_millis();
                                if let Ok(conn) = open_visual_cache_connection() {
                                    let _ = conn.execute(
                                        "INSERT OR REPLACE INTO deleted_remote_branches (repo_path, branch_name, remote_ref, sha, deleted_at_ms)
                                         VALUES (?1, ?2, ?3, ?4, ?5)",
                                        params![normalized_repo_path, branch_name, ref_name, sha, now_ms],
                                    );
                                }
                            }

                            // Push the deletion to the remote repository (ignores failure if offline/no permissions)
                            let _ = git::cli::run(
                                path,
                                &["push", remote_name, "--delete", branch_name],
                            );

                            let del_ref_res = git::cli::run(path, &["update-ref", "-d", ref_name]);
                            del_ref_res.map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
    }

    let _ = git::cli::run(path, &["worktree", "prune"]);

    Ok(DeleteSelectionResult {
        deleted_branches: unique_branch_names,
        discarded_uncommitted_changes: discard_uncommitted_changes,
        checked_out_ref: git::get_checked_out_ref(path).ok(),
    })
}

#[tauri::command(rename_all = "camelCase")]
fn remove_worktree_and_empty_branch(
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<RemoveWorktreeResult, String> {
    let path = Path::new(&repo_path);
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
    let worktree = git::list_worktrees(path)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|worktree| {
            normalize_repo_path_id(&worktree.path) == normalize_repo_path_id(&worktree_path)
        });
    let branch_name = worktree
        .as_ref()
        .and_then(|worktree| worktree.branch_name.clone())
        .filter(|branch_name| branch_name != &default_branch);

    let should_delete_branch = branch_name
        .as_deref()
        .map(|branch_name| {
            branch_has_unique_commits(path, branch_name).map(|has_unique| !has_unique)
        })
        .transpose()?
        .unwrap_or(false);

    git::remove_git_worktree(path, &worktree_path, force).map_err(|e| e.to_string())?;

    let deleted_branch = if should_delete_branch {
        match branch_name.as_deref() {
            Some(branch_name) if delete_local_branch_if_exists(path, branch_name)? => {
                Some(branch_name.to_string())
            }
            _ => None,
        }
    } else {
        None
    };

    let _ = git::cli::run(path, &["worktree", "prune"]);

    Ok(RemoveWorktreeResult { deleted_branch })
}

#[tauri::command(rename_all = "camelCase")]
fn merge_branches(
    repo_path: String,
    source_branch: String,
    target_branch: String,
) -> Result<CheckedOutRef, String> {
    if source_branch == target_branch {
        return Err("Source and target branches must be different".to_string());
    }
    merge_ref_into_branch(repo_path, source_branch, target_branch)
}

#[tauri::command(rename_all = "camelCase")]
fn merge_ref_into_branch(
    repo_path: String,
    source_ref: String,
    target_branch: String,
) -> Result<CheckedOutRef, String> {
    if source_ref == target_branch {
        return Err("Source and target must be different".to_string());
    }
    let path = Path::new(&repo_path);
    git::cli::run(path, &["checkout", &target_branch]).map_err(|e| e.to_string())?;
    git::cli::run(path, &["merge", "--no-ff", "--no-edit", &source_ref])
        .map_err(|e| e.to_string())?;
    git::get_checked_out_ref(path).map_err(|e| e.to_string())
}

fn git_first_line(repo: &Path, args: &[&str]) -> Result<String, String> {
    git::cli::run(repo, args)
        .map_err(|e| e.to_string())?
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Git command returned no output: git {}", args.join(" ")))
}

fn restore_branch_after_failed_squash(repo: &Path, branch_name: &str, original_head: &str) {
    let _ = git::cli::run(repo, &["cherry-pick", "--abort"]);
    let _ = git::cli::run(repo, &["reset", "--hard", original_head]);
    let _ = git::cli::run(repo, &["branch", "-f", branch_name, original_head]);
}

#[tauri::command(rename_all = "camelCase")]
async fn squash_commit_range(
    repo_path: String,
    branch_name: String,
    commit_shas: Vec<String>,
) -> Result<SquashCommitRangeResult, String> {
    run_blocking(move || {
        let repo = Path::new(&repo_path);
        let branch_name = branch_name.trim().to_string();
        if branch_name.is_empty() {
            return Err("Select commits on a named branch to squash.".to_string());
        }

        let mut selected = Vec::<String>::new();
        let mut seen = HashSet::<String>::new();
        for sha in commit_shas {
            let trimmed = sha.trim();
            if trimmed.is_empty() {
                continue;
            }
            let full = git_first_line(repo, &["rev-parse", &format!("{trimmed}^{{commit}}")])?;
            if seen.insert(full.clone()) {
                selected.push(full);
            }
        }
        if selected.len() < 2 {
            return Err("Select at least two adjacent commits to squash.".to_string());
        }

        let status = git::cli::run(repo, &["status", "--porcelain"]).map_err(|e| e.to_string())?;
        if !status.trim().is_empty() {
            return Err("Commit or stash local changes before squashing commits.".to_string());
        }

        let branch_ref = format!("refs/heads/{branch_name}");
        git::cli::run(repo, &["show-ref", "--verify", "--quiet", &branch_ref])
            .map_err(|_| format!("Branch \"{branch_name}\" does not exist locally."))?;
        let original_head = git_first_line(repo, &["rev-parse", &branch_name])?;

        let rev_list_output = git::cli::run(
            repo,
            &["rev-list", "--first-parent", "--reverse", &branch_name],
        )
        .map_err(|e| e.to_string())?;
        let branch_chain: Vec<String> = rev_list_output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
        let selected_set: HashSet<&str> = selected.iter().map(|sha| sha.as_str()).collect();
        let mut selected_indexes: Vec<usize> = branch_chain
            .iter()
            .enumerate()
            .filter_map(|(index, sha)| selected_set.contains(sha.as_str()).then_some(index))
            .collect();
        if selected_indexes.len() != selected.len() {
            return Err(
                "Selected commits must all belong to the selected branch first-parent history."
                    .to_string(),
            );
        }
        selected_indexes.sort_unstable();
        for pair in selected_indexes.windows(2) {
            if pair[1] != pair[0] + 1 {
                return Err("Selected commits must be adjacent on the same branch.".to_string());
            }
        }

        let oldest = branch_chain[selected_indexes[0]].clone();
        let newest = branch_chain[*selected_indexes.last().unwrap()].clone();
        let base = git_first_line(repo, &["rev-parse", &format!("{oldest}^")])?;
        let descendants: Vec<String> = branch_chain
            .iter()
            .skip(selected_indexes.last().unwrap() + 1)
            .cloned()
            .collect();

        let commits_output = git::cli::run(
            repo,
            &[
                "log",
                "--reverse",
                "--format=%h %s",
                &format!("{base}..{newest}"),
            ],
        )
        .map_err(|e| e.to_string())?;
        let diff_stat =
            git::cli::run(repo, &["diff", "--stat", &base, &newest]).unwrap_or_default();
        let summary = format!(
            "Squash {} adjacent commits on branch \"{}\".\n\nCommits:\n{}\n\nDiff stat:\n{}",
            selected.len(),
            branch_name,
            commits_output.trim(),
            diff_stat.trim(),
        );
        let message = opencode::generate_squash_message(repo, &summary)
            .map_err(|e| format!("Failed to generate squash message with OpenCode: {e}"))?;
        opencode::validate_generated_message(&message, "Squash message")?;

        git::cli::run(repo, &["checkout", &branch_name]).map_err(|e| e.to_string())?;
        let result = (|| -> Result<SquashCommitRangeResult, String> {
            git::cli::run(repo, &["reset", "--hard", &newest]).map_err(|e| e.to_string())?;
            git::cli::run(repo, &["reset", "--soft", &base]).map_err(|e| e.to_string())?;
            git::cli::run(repo, &["commit", "-m", &message]).map_err(|e| e.to_string())?;
            let squashed_sha = git_first_line(repo, &["rev-parse", "HEAD"])?;
            for descendant in descendants {
                git::cli::run(repo, &["cherry-pick", &descendant]).map_err(|e| e.to_string())?;
            }
            Ok(SquashCommitRangeResult {
                branch_name: branch_name.clone(),
                squashed_sha,
                commit_count: selected.len(),
            })
        })();

        match result {
            Ok(result) => {
                record_repo_change(repo_path.as_str(), REPO_CHANGE_GRAPH | REPO_CHANGE_LOCAL);
                Ok(result)
            }
            Err(error) => {
                restore_branch_after_failed_squash(repo, &branch_name, &original_head);
                Err(format!(
                    "Failed to squash commits; branch was restored. {error}"
                ))
            }
        }
    })
    .await
}

#[tauri::command]
fn get_repo_info(repo_path: String) -> Result<RepoInfo, String> {
    let path = Path::new(&repo_path);
    let (name, full_path) = git::get_repo_info(path).map_err(|e| e.to_string())?;
    Ok(RepoInfo {
        name,
        path: full_path,
    })
}

// =============================================================================
// GitHub Integration
// =============================================================================

#[tauri::command]
fn get_github_info(repo_path: String) -> Result<GitHubInfo, String> {
    let path = Path::new(&repo_path);
    github::get_github_info(path)
}

#[tauri::command]
fn get_github_auth_status() -> Result<GitHubAuthStatus, String> {
    let status = github::get_github_auth_status();
    if status.authenticated {
        github::ensure_github_git_credentials()?;
    }
    Ok(status)
}

#[tauri::command]
fn authenticate_github() -> Result<(), String> {
    github::authenticate_github()
}

#[tauri::command(rename_all = "camelCase")]
fn get_merged_prs(
    owner: String,
    repo: String,
    base_branch: String,
    limit: Option<usize>,
) -> Result<Vec<MergedPR>, String> {
    let limit = limit.unwrap_or(50);
    github::get_merged_prs(&owner, &repo, &base_branch, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_open_prs(owner: String, repo: String) -> Result<Vec<OpenPR>, String> {
    github::get_open_prs(&owner, &repo)
}

#[tauri::command(rename_all = "camelCase")]
fn get_pr_commits(
    owner: String,
    repo: String,
    pr_numbers: Vec<i64>,
) -> Result<std::collections::HashMap<i64, Vec<String>>, String> {
    github::get_pr_commits(&owner, &repo, &pr_numbers)
}

#[tauri::command(rename_all = "camelCase")]
fn get_branch_diff(
    repo_path: String,
    branch: String,
    base_branch: String,
    merge_commit_sha: Option<String>,
) -> Result<String, String> {
    let path = Path::new(&repo_path);
    let diff = if let Some(sha) = merge_commit_sha {
        // Historical diff: show what this PR added when it was merged
        let parent = format!("{}^1", sha);
        git::cli::run(path, &["diff", &parent, &sha, "--unified=3"]).map_err(|e| e.to_string())?
    } else {
        // Current diff: unmerged changes ahead of base branch
        let range = format!("{}...{}", base_branch, branch);
        git::cli::run(path, &["diff", &range, "--unified=3"]).map_err(|e| e.to_string())?
    };
    const MAX_CHARS: usize = 60_000;
    if diff.len() > MAX_CHARS {
        Ok(format!(
            "{}\n\n[diff truncated at {} chars]",
            &diff[..MAX_CHARS],
            MAX_CHARS
        ))
    } else {
        Ok(diff)
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    full_sha: String,
    sha: String,
    parent_sha: Option<String>,
    message: String,
    author: String,
    date: String,
    prompt_window_start: Option<String>,
    prompt_window_end: Option<String>,
    agent_prompts: Vec<AgentPrompt>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrompt {
    id: String,
    agent: String,
    prompt: String,
    timestamp: String,
    source: String,
}

#[derive(Clone)]
struct PromptRecord {
    id: String,
    agent: String,
    prompt: String,
    timestamp: DateTime<Utc>,
    source: String,
}

#[derive(Clone)]
struct PromptCache {
    repo_path: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    records: Vec<PromptRecord>,
    collected_at: DateTime<Utc>,
}

static PROMPT_CACHE: OnceLock<Mutex<Option<PromptCache>>> = OnceLock::new();
const LOG_FIELD_SEPARATOR: &str = "\u{1f}";
/// Guard against serde / prompt parsing blowing the native stack on deeply nested JSON.
const MAX_JSON_NESTING_DEPTH: usize = 128;

fn json_nesting_depth_exceeds_limit(raw: &str, max_depth: usize) -> bool {
    let mut depth = 0usize;
    let mut max_seen = 0usize;
    let mut in_string = false;
    let mut escape = false;

    for ch in raw.chars() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            match ch {
                '\\' => escape = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '[' | '{' => {
                depth += 1;
                if depth > max_seen {
                    max_seen = depth;
                    if max_seen > max_depth {
                        return true;
                    }
                }
            }
            ']' | '}' => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }

    false
}

fn parse_json_value_bounded(raw: &str) -> Option<serde_json::Value> {
    if json_nesting_depth_exceeds_limit(raw, MAX_JSON_NESTING_DEPTH) {
        return None;
    }
    serde_json::from_str(raw).ok()
}

fn parse_iso_to_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn normalize_path_for_compare(path: &str) -> String {
    path.trim()
        .trim_end_matches('/')
        .replace('\\', "/")
        .to_lowercase()
}

fn paths_match(repo_path: &Path, candidate: &str) -> bool {
    let repo_norm = normalize_path_for_compare(&repo_path.to_string_lossy());
    let cand_norm = normalize_path_for_compare(candidate);
    !repo_norm.is_empty() && !cand_norm.is_empty() && repo_norm == cand_norm
}

fn extract_tag_text(raw: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = raw.find(&open)? + open.len();
    let rest = &raw[start..];
    let end_rel = rest.find(&close).unwrap_or(rest.len());
    Some(rest[..end_rel].trim().to_string())
}

fn normalize_prompt_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(query) = extract_tag_text(trimmed, "user_query") {
        if !query.is_empty() {
            return normalize_prompt_text(&query);
        }
    }

    if trimmed.starts_with("# AGENTS.md instructions for ")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<INSTRUCTIONS>")
    {
        return None;
    }

    if trimmed.starts_with("<attached_files>") {
        return None;
    }

    let normalized = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    let collapsed = normalized.trim();
    if collapsed.is_empty() {
        return None;
    }

    if collapsed.starts_with("@/") && collapsed.contains("/terminals/") {
        return Some("Shared terminal selection".to_string());
    }

    const MAX_PROMPT_CHARS: usize = 4000;
    if collapsed.len() > MAX_PROMPT_CHARS {
        let mut truncated = collapsed[..MAX_PROMPT_CHARS].to_string();
        truncated.push_str("…");
        return Some(truncated);
    }

    Some(collapsed.to_string())
}

fn extract_text_chunks(content: &serde_json::Value) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut stack = vec![content];

    while let Some(current) = stack.pop() {
        if let Some(arr) = current.as_array() {
            for item in arr {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    chunks.push(text.to_string());
                }
                if let Some(inner) = item.get("content") {
                    stack.push(inner);
                }
            }
            continue;
        }

        if let Some(text) = current.as_str() {
            chunks.push(text.to_string());
        }
    }

    chunks
}

fn insert_prompt(
    out: &mut Vec<PromptRecord>,
    seen: &mut HashSet<String>,
    agent: &str,
    source: &str,
    timestamp: DateTime<Utc>,
    prompt: String,
) {
    let dedupe_key = format!("{agent}|{}|{prompt}", timestamp.to_rfc3339());
    if !seen.insert(dedupe_key) {
        return;
    }

    let id = format!(
        "{}-{}-{}",
        agent.to_lowercase().replace(' ', "-"),
        timestamp.timestamp_millis(),
        out.len() + 1
    );

    out.push(PromptRecord {
        id,
        agent: agent.to_string(),
        prompt,
        timestamp,
        source: source.to_string(),
    });
}

fn parse_generic_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    for key in [
        "timestamp",
        "time",
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
    ] {
        if let Some(ts) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(parsed) = parse_iso_to_utc(ts) {
                return Some(parsed);
            }
        }
    }
    None
}

fn collect_jsonl_files(root: &Path, out: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                out.push(path);
            }
        }
    }
}

fn collect_codex_prompts(
    repo_path: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    out: &mut Vec<PromptRecord>,
    seen: &mut HashSet<String>,
) {
    let Some(home) = dirs::home_dir() else { return };
    let roots = [
        home.join(".codex/sessions"),
        home.join(".codex/archived_sessions"),
    ];

    let mut files = Vec::new();
    for root in roots {
        collect_jsonl_files(&root, &mut files);
    }

    for path in files {
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let reader = BufReader::new(file);
        let mut matches_repo = false;
        let source = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("codex-session")
            .to_string();

        for line in reader.lines().map_while(Result::ok) {
            let Some(value) = parse_json_value_bounded(&line) else {
                continue;
            };
            let event_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            if event_type == "session_meta" {
                let cwd = value
                    .pointer("/payload/cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                matches_repo = paths_match(repo_path, cwd);
                continue;
            }

            if !matches_repo {
                continue;
            }

            if event_type == "response_item"
                && value.pointer("/payload/type").and_then(|v| v.as_str()) == Some("message")
                && value.pointer("/payload/role").and_then(|v| v.as_str()) == Some("user")
            {
                let timestamp = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_iso_to_utc);
                let Some(ts) = timestamp else { continue };
                if ts < start || ts > end {
                    continue;
                }

                let content = value
                    .pointer("/payload/content")
                    .unwrap_or(&serde_json::Value::Null);
                for chunk in extract_text_chunks(content) {
                    if let Some(prompt) = normalize_prompt_text(&chunk) {
                        insert_prompt(out, seen, "Codex", &source, ts, prompt);
                    }
                }
            }
        }
    }
}

fn collect_claude_prompts(
    repo_path: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    out: &mut Vec<PromptRecord>,
    seen: &mut HashSet<String>,
) {
    let Some(home) = dirs::home_dir() else { return };
    let projects_root = home.join(".claude/projects");
    let Ok(project_dirs) = fs::read_dir(projects_root) else {
        return;
    };

    for dir_entry in project_dirs.flatten() {
        let project_dir = dir_entry.path();
        if !project_dir.is_dir() {
            continue;
        }

        let index_path = project_dir.join("sessions-index.json");
        if !index_path.exists() {
            continue;
        }

        let Ok(index_raw) = fs::read_to_string(&index_path) else {
            continue;
        };
        let Some(index_json) = parse_json_value_bounded(&index_raw) else {
            continue;
        };
        let Some(entries) = index_json.get("entries").and_then(|v| v.as_array()) else {
            continue;
        };

        for entry in entries {
            let project_path = entry
                .get("projectPath")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !paths_match(repo_path, project_path) {
                continue;
            }

            let Some(full_path) = entry.get("fullPath").and_then(|v| v.as_str()) else {
                continue;
            };
            let session_path = Path::new(full_path);
            let Ok(file) = File::open(session_path) else {
                continue;
            };
            let reader = BufReader::new(file);
            let source = session_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("claude-session")
                .to_string();

            for line in reader.lines().map_while(Result::ok) {
                let Some(value) = parse_json_value_bounded(&line) else {
                    continue;
                };
                let is_user = value.get("type").and_then(|v| v.as_str()) == Some("user")
                    && value.pointer("/message/role").and_then(|v| v.as_str()) == Some("user");
                if !is_user {
                    continue;
                }

                let cwd = value
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if !cwd.is_empty() && !paths_match(repo_path, cwd) {
                    continue;
                }

                let timestamp = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_iso_to_utc);
                let Some(ts) = timestamp else { continue };
                if ts < start || ts > end {
                    continue;
                }

                let content = value
                    .pointer("/message/content")
                    .unwrap_or(&serde_json::Value::Null);
                for chunk in extract_text_chunks(content) {
                    if let Some(prompt) = normalize_prompt_text(&chunk) {
                        insert_prompt(out, seen, "Claude Code", &source, ts, prompt);
                    }
                }
            }
        }
    }
}

fn cursor_project_dir_name(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "-")
}

fn collect_cursor_prompts(
    repo_path: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    out: &mut Vec<PromptRecord>,
    seen: &mut HashSet<String>,
) {
    let Some(home) = dirs::home_dir() else { return };
    let projects_root = home.join(".cursor/projects");
    let Ok(project_dirs) = fs::read_dir(&projects_root) else {
        return;
    };

    let canonical_repo = fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
    let mut candidates = HashSet::new();
    candidates.insert(cursor_project_dir_name(repo_path));
    candidates.insert(cursor_project_dir_name(&canonical_repo));
    let repo_leaf = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    for dir_entry in project_dirs.flatten() {
        let project_dir = dir_entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let Some(project_name) = project_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let project_name_lc = project_name.to_lowercase();
        let maybe_matches_leaf = !repo_leaf.is_empty() && project_name_lc.contains(&repo_leaf);
        if !candidates.contains(project_name) && !maybe_matches_leaf {
            continue;
        }

        let transcript_root = project_dir.join("agent-transcripts");
        let mut files = Vec::new();
        collect_jsonl_files(&transcript_root, &mut files);

        for path in files {
            let file_meta = fs::metadata(&path).ok();
            let modified = file_meta
                .and_then(|m| m.modified().ok())
                .map(DateTime::<Utc>::from)
                .unwrap_or(end);

            // Cursor transcript lines currently do not include message timestamps.
            // We anchor prompts to file mtime and spread entries backward.
            let Ok(file) = File::open(&path) else {
                continue;
            };
            let reader = BufReader::new(file);
            let source = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("cursor-session")
                .to_string();

            let mut prompts = Vec::new();
            for line in reader.lines().map_while(Result::ok) {
                let Some(value) = parse_json_value_bounded(&line) else {
                    continue;
                };
                if value.get("role").and_then(|v| v.as_str()) != Some("user") {
                    continue;
                }
                let content = value
                    .pointer("/message/content")
                    .unwrap_or(&serde_json::Value::Null);
                for chunk in extract_text_chunks(content) {
                    if let Some(prompt) = normalize_prompt_text(&chunk) {
                        prompts.push(prompt);
                    }
                }
            }

            let total = prompts.len();
            if total == 0 {
                continue;
            }

            for (idx, prompt) in prompts.into_iter().enumerate() {
                let offset = (total.saturating_sub(idx + 1) as i64) * 30;
                let ts = modified - Duration::seconds(offset);
                if ts < start || ts > end {
                    continue;
                }
                insert_prompt(out, seen, "Cursor", &source, ts, prompt);
            }
        }
    }
}

fn collect_generic_jsonl_prompts(
    repo_path: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    out: &mut Vec<PromptRecord>,
    seen: &mut HashSet<String>,
) {
    let mut roots = vec![
        repo_path.join("agent-transcripts"),
        repo_path.join(".agent-transcripts"),
        repo_path.join(".ai-transcripts"),
    ];

    if let Ok(extra) = std::env::var("AGENT_TRANSCRIPT_PATHS") {
        for segment in extra.split(':') {
            if !segment.trim().is_empty() {
                roots.push(PathBuf::from(segment.trim()));
            }
        }
    }

    for root in roots {
        let mut files = Vec::new();
        collect_jsonl_files(&root, &mut files);
        for path in files {
            let Ok(file) = File::open(&path) else {
                continue;
            };
            let reader = BufReader::new(file);
            let source = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("transcript")
                .to_string();

            for line in reader.lines().map_while(Result::ok) {
                let Some(value) = parse_json_value_bounded(&line) else {
                    continue;
                };

                let role = value
                    .get("role")
                    .and_then(|v| v.as_str())
                    .or_else(|| value.pointer("/message/role").and_then(|v| v.as_str()))
                    .or_else(|| value.pointer("/payload/role").and_then(|v| v.as_str()));
                if role != Some("user") {
                    continue;
                }

                if let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) {
                    if !cwd.is_empty() && !paths_match(repo_path, cwd) {
                        continue;
                    }
                }

                let timestamp = parse_generic_timestamp(&value).or_else(|| {
                    fs::metadata(&path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .map(DateTime::<Utc>::from)
                });
                let Some(ts) = timestamp else { continue };
                if ts < start || ts > end {
                    continue;
                }

                let content = value
                    .pointer("/message/content")
                    .or_else(|| value.pointer("/payload/content"))
                    .or_else(|| value.get("content"))
                    .unwrap_or(&serde_json::Value::Null);

                for chunk in extract_text_chunks(content) {
                    if let Some(prompt) = normalize_prompt_text(&chunk) {
                        insert_prompt(out, seen, "Agent", &source, ts, prompt);
                    }
                }
            }
        }
    }
}

fn collect_agent_prompts_for_repo(
    repo_path: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<PromptRecord> {
    let repo_key = normalize_path_for_compare(&repo_path.to_string_lossy());
    let cache_cell = PROMPT_CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(cache_guard) = cache_cell.lock() {
        if let Some(cache) = cache_guard.as_ref() {
            let cache_is_fresh = Utc::now() - cache.collected_at <= Duration::minutes(3);
            let range_inside_cache = start >= cache.start && end <= cache.end;
            if cache.repo_path == repo_key && cache_is_fresh && range_inside_cache {
                return cache
                    .records
                    .iter()
                    .filter(|record| record.timestamp >= start && record.timestamp <= end)
                    .cloned()
                    .collect();
            }
        }
    }

    let mut records = Vec::new();
    let mut seen = HashSet::new();

    collect_codex_prompts(repo_path, start, end, &mut records, &mut seen);
    collect_claude_prompts(repo_path, start, end, &mut records, &mut seen);
    collect_cursor_prompts(repo_path, start, end, &mut records, &mut seen);
    collect_generic_jsonl_prompts(repo_path, start, end, &mut records, &mut seen);

    records.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    if let Ok(mut cache_guard) = cache_cell.lock() {
        *cache_guard = Some(PromptCache {
            repo_path: repo_key,
            start,
            end,
            records: records.clone(),
            collected_at: Utc::now(),
        });
    }

    records
}

fn hydrate_commit_prompt_windows(path: &Path, commits: &mut [CommitInfo]) {
    if commits.is_empty() {
        return;
    }

    let mut parent_dates: HashMap<String, DateTime<Utc>> = HashMap::new();
    for commit in commits.iter() {
        let Some(parent_sha) = &commit.parent_sha else {
            continue;
        };
        if parent_dates.contains_key(parent_sha) {
            continue;
        }
        let Ok(parent_date_raw) = git::cli::run(path, &["log", "-1", "--format=%cI", parent_sha])
        else {
            continue;
        };
        let parsed = parse_iso_to_utc(parent_date_raw.trim());
        if let Some(parent_date) = parsed {
            parent_dates.insert(parent_sha.clone(), parent_date);
        }
    }

    let mut windows: Vec<(Option<DateTime<Utc>>, Option<DateTime<Utc>>)> =
        Vec::with_capacity(commits.len());
    let mut global_start: Option<DateTime<Utc>> = None;
    let mut global_end: Option<DateTime<Utc>> = None;

    for commit in commits.iter() {
        let end_dt = parse_iso_to_utc(&commit.date);
        let start_dt = commit
            .parent_sha
            .as_ref()
            .and_then(|sha| parent_dates.get(sha).copied());

        if let Some(end_ts) = end_dt {
            let bounded_start = start_dt.unwrap_or(end_ts - Duration::hours(12));
            global_start = Some(global_start.map_or(bounded_start, |cur| cur.min(bounded_start)));
            global_end = Some(global_end.map_or(end_ts, |cur| cur.max(end_ts)));
        }

        windows.push((start_dt, end_dt));
    }

    let prompts = if let (Some(start), Some(end)) = (global_start, global_end) {
        collect_agent_prompts_for_repo(path, start, end)
    } else {
        Vec::new()
    };

    for (idx, commit) in commits.iter_mut().enumerate() {
        let (start_dt, end_dt) = windows[idx];
        commit.prompt_window_start = start_dt.map(|dt| dt.to_rfc3339());
        commit.prompt_window_end = end_dt.map(|dt| dt.to_rfc3339());

        let Some(end_ts) = end_dt else { continue };

        let mut matched: Vec<AgentPrompt> = prompts
            .iter()
            .filter(|record| {
                let in_upper = record.timestamp <= end_ts;
                let in_lower = start_dt.map_or(true, |start_ts| record.timestamp > start_ts);
                in_upper && in_lower
            })
            .map(|record| AgentPrompt {
                id: record.id.clone(),
                agent: record.agent.clone(),
                prompt: record.prompt.clone(),
                timestamp: record.timestamp.to_rfc3339(),
                source: record.source.clone(),
            })
            .collect();

        const MAX_PROMPTS_PER_COMMIT: usize = 40;
        if matched.len() > MAX_PROMPTS_PER_COMMIT {
            let to_drop = matched.len() - MAX_PROMPTS_PER_COMMIT;
            matched.drain(0..to_drop);
        }
        commit.agent_prompts = matched;
    }
}

#[tauri::command(rename_all = "camelCase")]
fn get_branch_commits(
    repo_path: String,
    branch: String,
    base_branch: String,
    merge_commit_sha: Option<String>,
    include_prompts: Option<bool>,
) -> Result<Vec<CommitInfo>, String> {
    let path = Path::new(&repo_path);
    let range = if let Some(sha) = merge_commit_sha {
        // Commits that were part of this merged branch side (exclude merge commit itself).
        format!("{}^1..{}^2", sha, sha)
    } else {
        // Commits on this branch not yet in base
        format!("{}..{}", base_branch, branch)
    };
    let output = git::cli::run(
        path,
        &["log", &range, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P"],
    )
    .map_err(|e| e.to_string())?;

    let mut commits: Vec<CommitInfo> = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, LOG_FIELD_SEPARATOR).collect();
            if parts.len() < 6 {
                return None;
            }
            let parent_sha = parts[5].split_whitespace().next().map(|p| p.to_string());
            Some(CommitInfo {
                full_sha: parts[0].to_string(),
                sha: parts[1].to_string(),
                parent_sha,
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].to_string(),
                prompt_window_start: None,
                prompt_window_end: None,
                agent_prompts: Vec::new(),
            })
        })
        .collect();

    if include_prompts.unwrap_or(true) {
        hydrate_commit_prompt_windows(path, &mut commits);
    }

    Ok(commits)
}

#[tauri::command(rename_all = "camelCase")]
fn get_commit_diff(
    repo_path: String,
    commit_sha: String,
    base_sha: Option<String>,
) -> Result<String, String> {
    let path = Path::new(&repo_path);
    let base = base_sha.unwrap_or_else(|| format!("{}^1", commit_sha));
    let diff = git::cli::run(path, &["diff", &base, &commit_sha, "--unified=3"])
        .map_err(|e| e.to_string())?;
    const MAX_CHARS: usize = 60_000;
    if diff.len() > MAX_CHARS {
        Ok(format!(
            "{}\n\n[diff truncated at {} chars]",
            &diff[..MAX_CHARS],
            MAX_CHARS
        ))
    } else {
        Ok(diff)
    }
}

#[tauri::command(rename_all = "camelCase")]
fn get_direct_commits(
    repo_path: String,
    branch: String,
    limit: Option<u32>,
) -> Result<Vec<DirectCommit>, String> {
    let path = Path::new(&repo_path);
    git::get_direct_commits(path, &branch, limit).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn get_all_repo_commits(repo_path: String) -> Result<Vec<DirectCommit>, String> {
    let path = Path::new(&repo_path);
    let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
    let mut branches = git::list_branches(path, &default_branch).map_err(|e| e.to_string())?;
    // Sort branches by creation date (oldest first) so that older branches retain
    // commit ownership priority in case of identical HEAD commits.
    branches.sort_by(|a, b| {
        let a_date = a.created_date.as_ref().unwrap_or(&a.last_commit_date);
        let b_date = b.created_date.as_ref().unwrap_or(&b.last_commit_date);
        match a_date.cmp(b_date) {
            std::cmp::Ordering::Equal => a.name.cmp(&b.name),
            other => other,
        }
    });
    let merge_nodes =
        fetch_all_merge_nodes_for_branches_internal(&repo_path, &branches, &default_branch)?;
    let merge_target_branch_by_commit_sha: HashMap<String, String> = merge_nodes
        .iter()
        .map(|node| (node.target_commit_sha.clone(), node.target_branch.clone()))
        .collect();
    let all_branch_names: Vec<String> = std::iter::once(default_branch.clone())
        .chain(branches.iter().map(|branch| branch.name.clone()))
        .collect();
    let mut branch_created_dates = HashMap::<String, String>::new();
    for branch in &branches {
        let date = branch
            .created_date
            .as_ref()
            .unwrap_or(&branch.last_commit_date)
            .clone();
        branch_created_dates.insert(branch.name.clone(), date);
    }
    if let Ok(default_date_output) =
        git::cli::run(path, &["show", "-s", "--format=%cI", &default_branch])
    {
        let default_date = default_date_output.trim().to_string();
        if !default_date.is_empty() {
            branch_created_dates.insert(default_branch.clone(), default_date);
        }
    }
    git::get_all_repo_commits(
        path,
        &default_branch,
        &all_branch_names,
        &branch_created_dates,
        &merge_target_branch_by_commit_sha,
    )
    .map_err(|e| e.to_string())
}

fn get_unpushed_direct_commits_blocking(
    repo_path: String,
    branch: String,
) -> Result<Vec<DirectCommit>, String> {
    let path = Path::new(&repo_path);
    let range = if let Some(compare_ref) = get_branch_compare_ref(path, &branch) {
        format!("{compare_ref}..{branch}")
    } else {
        branch.clone()
    };
    let output = git::cli::run(
        path,
        &[
            "log",
            "--first-parent",
            "--max-count=2000",
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P",
            &range,
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut commits: Vec<DirectCommit> = output
        .lines()
        .filter(|s| !s.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, LOG_FIELD_SEPARATOR).collect();
            if parts.len() < 6 {
                return None;
            }
            let parent_sha = parts[5]
                .split_whitespace()
                .next()
                .map(|value| value.to_string());
            Some(DirectCommit {
                full_sha: parts[0].to_string(),
                sha: parts[1].to_string(),
                parent_sha,
                parent_shas: parts[5]
                    .split_whitespace()
                    .map(|value| value.to_string())
                    .collect(),
                child_shas: Vec::new(),
                cluster_key: None,
                branch: branch.clone(),
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].to_string(),
                is_remote: false,
            })
        })
        .collect();

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
        commit.child_shas = child_shas_by_parent
            .get(&commit.full_sha)
            .cloned()
            .unwrap_or_default();
    }

    Ok(commits)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_unpushed_direct_commits(
    repo_path: String,
    branch: String,
) -> Result<Vec<DirectCommit>, String> {
    run_blocking(move || get_unpushed_direct_commits_blocking(repo_path, branch)).await
}

fn get_branch_unpushed_commit_shas_blocking(
    repo_path: String,
    branch: String,
) -> Result<Vec<String>, String> {
    let path = Path::new(&repo_path);
    let range = if let Some(compare_ref) = get_branch_compare_ref(path, &branch) {
        format!("{compare_ref}..{branch}")
    } else {
        let default_branch = git::get_default_branch(path).map_err(|e| e.to_string())?;
        format!("{default_branch}..{branch}")
    };
    let output = git::cli::run(
        path,
        &["rev-list", "--first-parent", "--max-count=2000", &range],
    )
    .map_err(|e| e.to_string())?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
async fn get_branch_unpushed_commit_shas(
    repo_path: String,
    branch: String,
) -> Result<Vec<String>, String> {
    run_blocking(move || get_branch_unpushed_commit_shas_blocking(repo_path, branch)).await
}

/// Recent commits on a branch (no base filtering — just git log -N <branch>).
#[tauri::command(rename_all = "camelCase")]
fn get_recent_log(
    repo_path: String,
    branch: String,
    limit: Option<u32>,
    first_parent: Option<bool>,
    include_prompts: Option<bool>,
) -> Result<Vec<CommitInfo>, String> {
    let path = Path::new(&repo_path);
    let limit_str = limit.unwrap_or(20).to_string();
    let mut args: Vec<String> = vec!["log".to_string()];
    if first_parent.unwrap_or(true) {
        args.push("--first-parent".to_string());
    }
    args.push(branch);
    args.push(format!("--max-count={}", limit_str));
    args.push("--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P".to_string());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = git::cli::run(path, &arg_refs).map_err(|e| e.to_string())?;
    let mut commits: Vec<CommitInfo> = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, LOG_FIELD_SEPARATOR).collect();
            if parts.len() < 6 {
                return None;
            }
            let parent_sha = parts[5].split_whitespace().next().map(|p| p.to_string());
            Some(CommitInfo {
                full_sha: parts[0].to_string(),
                sha: parts[1].to_string(),
                parent_sha,
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].to_string(),
                prompt_window_start: None,
                prompt_window_end: None,
                agent_prompts: Vec::new(),
            })
        })
        .collect();
    if include_prompts.unwrap_or(true) {
        hydrate_commit_prompt_windows(path, &mut commits);
    }
    Ok(commits)
}

// =============================================================================
// App Preview Screenshots
// =============================================================================

/// Extract the first `http://localhost:PORT` URL from a server startup log.
/// Works for Vite ("Local: http://localhost:5175/") and
/// Next.js ("- Local: http://localhost:3000").
fn parse_localhost_url(log: &str) -> Option<String> {
    let start = log.find("localhost:")?;
    let after = &log[start + 10..]; // skip "localhost:"
    let end = after
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after.len());
    let port: u16 = after[..end].parse().ok()?;
    Some(format!("http://localhost:{port}"))
}

/// Normalize any naming convention to lowercase alphanumeric only, so that
/// `DesignOnboarding`, `design-onboarding`, and `design_onboarding` all compare equal.
fn normalize_name(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// All page routes that exist in the repo at HEAD (used for fuzzy matching).
fn all_page_routes(repo_path: &Path) -> Vec<String> {
    let Ok(output) = git::cli::run(
        repo_path,
        &[
            "ls-tree",
            "-r",
            "--name-only",
            "HEAD",
            "--",
            "app",
            "pages",
            "src/app",
            "src/pages",
            "src/routes",
        ],
    ) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(file_to_route)
        .filter(|r| seen.insert(r.clone()))
        .collect()
}

/// For changed files that aren't page files themselves, fuzzy-match their
/// base name against route path segments.
///
/// Example: `components/DesignOnboarding.tsx` → normalize `designonboarding`
///          → matches route `/design-onboarding` (segment normalizes the same).
fn fuzzy_matched_routes<'a>(changed_files: &[&str], all_routes: &'a [String]) -> Vec<&'a String> {
    let mut matched: Vec<&String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for &file in changed_files {
        if file_to_route(file).is_some() {
            continue;
        } // already handled directly

        // Build candidate names to match against route segments:
        //   (a) file stem — catches component files e.g. TarotCard.tsx → "tarotcard"
        //   (b) intermediate directory segments (skip first and last) — catches
        //       content/data/public changes e.g. content/tarot/card.md → "tarot"
        let mut names: Vec<String> = Vec::new();

        let stem = std::path::Path::new(file)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if stem.len() >= 5 {
            names.push(normalize_name(stem));
        }

        let parts: Vec<&str> = file.split('/').collect();
        // parts[0] = top-level dir (content/public/app/etc), parts[last] = filename
        // Intermediate parts are meaningful directory names that often mirror routes
        if parts.len() > 2 {
            for seg in &parts[1..parts.len() - 1] {
                if seg.len() >= 3 && !seg.starts_with('(') && !seg.starts_with('[') {
                    names.push(normalize_name(seg));
                }
            }
        }

        if names.is_empty() {
            continue;
        }

        for route in all_routes {
            if seen.contains(route.as_str()) {
                continue;
            }
            let hit = route.split('/').filter(|s| !s.is_empty()).any(|seg| {
                let norm_seg = normalize_name(seg);
                names
                    .iter()
                    .any(|n| norm_seg == *n || (norm_seg.len() >= 8 && n.starts_with(&norm_seg)))
            });
            if hit {
                seen.insert(route.as_str());
                matched.push(route);
            }
        }
    }
    matched
}

/// Debug: return raw git diff --name-only output so we can see which files changed.
#[tauri::command(rename_all = "camelCase")]
fn debug_diff_files(repo_path: String, branch: String, base_branch: String) -> String {
    let path = Path::new(&repo_path);
    let range = format!("{}...{}", base_branch, branch);
    match git::cli::run(path, &["diff", "--name-only", &range]) {
        Ok(s) => format!("OK: {:?}", s),
        Err(e) => format!("ERR: {e}"),
    }
}

/// For non-page files inside an app route directory, extract the route from
/// the first non-special path segment under `app/`.
///
/// Examples:
///   app/design-onboarding/DesignOnboardingPanel.tsx  →  /design-onboarding
///   app/design-onboarding/components/Card.tsx         →  /design-onboarding
///   app/api/users/route.ts                             →  None (api skipped)
fn app_dir_to_route(file: &str) -> Option<String> {
    if file_to_route(file).is_some() {
        return None;
    } // already a page file
    let rest = file
        .strip_prefix("app/")
        .or_else(|| file.strip_prefix("src/app/"))?;
    let slash_pos = rest.find('/')?; // must be inside a subdirectory
    let first_seg = &rest[..slash_pos];
    // Skip route groups, dynamic segs, parallel routes, private dirs, and api
    if first_seg.starts_with('(')
        || first_seg.starts_with('[')
        || first_seg.starts_with('@')
        || first_seg.starts_with('_')
        || first_seg == "api"
    {
        return None;
    }
    Some(format!("/{first_seg}"))
}

/// Return the URL paths most likely affected by the branch's diff.
///
/// Three-pass detection:
/// 1. Direct: changed files that ARE page files (app/**/page.tsx, pages/*.tsx).
/// 2. Directory: non-page files inside app route dirs (app/design-onboarding/X.tsx → /design-onboarding).
/// 3. Fuzzy: changed component filenames matched against all page routes in
///    the repo — e.g. `DesignOnboarding.tsx` → `/design-onboarding`.
#[tauri::command(rename_all = "camelCase")]
fn get_changed_routes(
    repo_path: String,
    branch: String,
    base_branch: String,
) -> Result<Vec<String>, String> {
    let path = Path::new(&repo_path);
    let output = git::cli::run(
        path,
        &[
            "diff",
            "--name-only",
            &format!("{}...{}", base_branch, branch),
        ],
    )
    .map_err(|e| e.to_string())?;

    let changed_files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();

    let mut seen = std::collections::HashSet::new();

    // Pass 1: direct page file matches
    let mut routes: Vec<String> = changed_files
        .iter()
        .filter_map(|f| file_to_route(f))
        .filter(|r| seen.insert(r.clone()))
        .collect();

    // Pass 2: non-page files inside app route directories → extract containing route
    for &file in &changed_files {
        if let Some(route) = app_dir_to_route(file) {
            if seen.insert(route.clone()) {
                routes.push(route);
            }
        }
    }

    // Pass 3: fuzzy-match filenames and directory segments against all repo routes.
    // This catches content/data/public changes: content/tarot/card.md → /tarot
    let all_routes = all_page_routes(path);
    for r in fuzzy_matched_routes(&changed_files, &all_routes) {
        if seen.insert(r.clone()) {
            routes.push(r.clone());
        }
    }

    // Cap at 4 routes to avoid starting excessive dev servers
    if routes.len() > 4 {
        routes.truncate(4);
    }

    // Pass 4: fallback — if nothing was detected, sample the repo's top-level
    // routes so broad changes (shared components, utils, styles) still get
    // multiple screenshots instead of just '/'.
    if routes.is_empty() {
        // Routes likely behind auth or not useful to screenshot
        let skip = [
            "login",
            "signin",
            "signup",
            "register",
            "auth",
            "logout",
            "callback",
            "verify",
            "reset",
            "forgot",
            "404",
            "500",
            "error",
            "not-found",
            "api",
            "onboarding",
        ];

        // Collect top-level routes only (one non-empty path segment)
        let mut candidates: Vec<&String> = all_routes
            .iter()
            .filter(|r| {
                let segs: Vec<&str> = r.split('/').filter(|s| !s.is_empty()).collect();
                if segs.len() != 1 {
                    return false;
                }
                let lower = r.to_lowercase();
                !skip.iter().any(|k| lower.contains(k))
            })
            .collect();

        // Sort so shorter names (likely more important pages) come first
        candidates.sort_by_key(|r| r.len());

        let mut fallback = vec!["/".to_string()];
        for route in candidates {
            if fallback.len() >= 4 {
                break;
            }
            fallback.push(route.clone());
        }
        return Ok(fallback);
    }

    Ok(routes)
}

/// Return the URL paths most likely affected by a specific commit.
/// Defaults to first-parent diff: `commit^1..commit`.
#[tauri::command(rename_all = "camelCase")]
fn get_changed_routes_for_commit(
    repo_path: String,
    commit_sha: String,
    base_sha: Option<String>,
) -> Result<Vec<String>, String> {
    let path = Path::new(&repo_path);
    let base = base_sha.unwrap_or_else(|| format!("{}^1", commit_sha));
    let output = git::cli::run(path, &["diff", "--name-only", &base, &commit_sha])
        .map_err(|e| e.to_string())?;

    let changed_files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();

    let mut seen = std::collections::HashSet::new();

    // Pass 1: direct page file matches
    let mut routes: Vec<String> = changed_files
        .iter()
        .filter_map(|f| file_to_route(f))
        .filter(|r| seen.insert(r.clone()))
        .collect();

    // Pass 2: non-page files inside app route directories → extract containing route
    for &file in &changed_files {
        if let Some(route) = app_dir_to_route(file) {
            if seen.insert(route.clone()) {
                routes.push(route);
            }
        }
    }

    // Pass 3: fuzzy-match filenames and directory segments against all repo routes.
    let all_routes = all_page_routes(path);
    for r in fuzzy_matched_routes(&changed_files, &all_routes) {
        if seen.insert(r.clone()) {
            routes.push(r.clone());
        }
    }

    if routes.len() > 4 {
        routes.truncate(4);
    }

    if routes.is_empty() {
        return Ok(vec!["/".to_string()]);
    }

    Ok(routes)
}

/// Map a changed file path to a URL route, or None if not a page file.
fn file_to_route(file: &str) -> Option<String> {
    const PAGE_EXTS: &[&str] = &["page.tsx", "page.jsx", "page.ts", "page.js"];

    // Next.js App Router: app/**/page.{tsx,jsx,ts,js}  (also src/app/**)
    let app_rest = file
        .strip_prefix("app/")
        .or_else(|| file.strip_prefix("src/app/"));
    if let Some(rest) = app_rest {
        for &suffix in PAGE_EXTS {
            if rest == suffix {
                return Some("/".to_string());
            }
            if let Some(route_part) = rest.strip_suffix(&format!("/{suffix}")) {
                return app_route_to_url(route_part);
            }
        }
    }

    // Next.js Pages Router: pages/**/*.{tsx,jsx,ts,js}  (also src/pages/**)
    let pages_rest = file
        .strip_prefix("pages/")
        .or_else(|| file.strip_prefix("src/pages/"));
    if let Some(rest) = pages_rest {
        if rest.starts_with('_') || rest.starts_with("api/") {
            return None;
        }
        for &ext in &[".tsx", ".jsx", ".ts", ".js"] {
            if let Some(route) = rest.strip_suffix(ext) {
                if route == "index" {
                    return Some("/".to_string());
                }
                let route = route.strip_suffix("/index").unwrap_or(route);
                // Skip dynamic segments
                if route.contains('[') {
                    return None;
                }
                return Some(format!("/{route}"));
            }
        }
    }

    // File-based routing under src/routes/ or app/routes/ (TanStack Router, Remix, SvelteKit, etc.)
    // e.g. src/routes/design-onboarding.tsx → /design-onboarding
    let routes_rest = file
        .strip_prefix("src/routes/")
        .or_else(|| file.strip_prefix("app/routes/"));
    if let Some(rest) = routes_rest {
        // Skip special files: __root, _layout, leading underscores, api routes
        if rest.starts_with('_') || rest.starts_with("api/") || rest.starts_with("api.") {
            return None;
        }
        const EXTS: &[&str] = &[".tsx", ".jsx", ".ts", ".js", ".svelte", ".vue"];
        for &ext in EXTS {
            if let Some(route) = rest.strip_suffix(ext) {
                let route = route.strip_suffix("/index").unwrap_or(route);
                let route = route.strip_suffix("/route").unwrap_or(route);
                let route = route.strip_suffix("/page").unwrap_or(route);
                if route == "index" || route.is_empty() {
                    return Some("/".to_string());
                }
                // Skip dynamic ($param or [param]) and layout groups
                if route.contains('$') || route.contains('[') || route.contains('(') {
                    return None;
                }
                return Some(format!("/{route}"));
            }
        }
    }

    None
}

/// Convert an App Router directory path to a URL, stripping route groups
/// `(group)` and parallel routes `@slot`, skipping dynamic segments `[id]`.
fn app_route_to_url(path: &str) -> Option<String> {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|s| {
            !s.starts_with('(') // route groups
                && !s.starts_with('@') // parallel routes
                && !s.starts_with('[') // dynamic segments — skip whole route
        })
        .collect();

    // If any dynamic segment was present, the original split had more parts
    if path.split('/').any(|s| s.starts_with('[')) {
        return None;
    }

    if segments.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", segments.join("/")))
    }
}

/// Screenshot a single path (convenience wrapper around `generate_preview_routes`).
#[tauri::command(rename_all = "camelCase")]
async fn generate_preview(
    repo_path: String,
    branch: String,
    port: u16,
    path: Option<String>,
) -> Result<String, String> {
    let paths = vec![path.unwrap_or_else(|| "/".to_string())];
    let mut results = tauri::async_runtime::spawn_blocking(move || {
        run_previews_blocking(repo_path, branch, port, paths)
    })
    .await
    .map_err(|e| format!("Spawn error: {e}"))??;
    results
        .pop()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "No screenshot generated".to_string())
}

/// Screenshot multiple paths in a single server startup — one data URL per path.
/// Empty-string entries indicate a screenshot failure for that specific route.
#[tauri::command(rename_all = "camelCase")]
async fn generate_preview_routes(
    repo_path: String,
    branch: String,
    port: u16,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_previews_blocking(repo_path, branch, port, paths)
    })
    .await
    .map_err(|e| format!("Spawn error: {e}"))?
}

/// Opens a visible Chrome window pointed at the branch's dev server so the user
/// can authenticate. The session is stored in `~/.git-viz-preview-auth/setup`
/// and is automatically seeded into CDP screenshot profiles on the next run.
fn run_open_browser_blocking(repo_path: String, branch: String, port: u16) -> Result<(), String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let repo = Path::new(&repo_path);

    let slug: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let preview_dir = std::env::temp_dir().join(format!("git-viz-preview-{slug}-{port}"));

    let _ = std::fs::remove_dir_all(&preview_dir);
    std::fs::create_dir_all(&preview_dir)
        .map_err(|e| format!("Failed to create preview dir: {e}"))?;

    let archive_path = std::env::temp_dir().join(format!("git-viz-archive-{port}.tar"));
    let _ = std::fs::remove_file(&archive_path);

    let arch_out = std::process::Command::new("git")
        .args(["-C", &repo_path, "archive", "--format=tar", &branch])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .output()
        .map_err(|e| format!("git archive failed to start: {e}"))?;

    if !arch_out.status.success() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err(format!(
            "git archive failed for branch '{}': {}",
            branch,
            String::from_utf8_lossy(&arch_out.stderr).trim()
        ));
    }

    std::fs::write(&archive_path, &arch_out.stdout)
        .map_err(|e| format!("Failed to write archive: {e}"))?;

    let tar_out = std::process::Command::new("tar")
        .args([
            "-xf",
            archive_path.to_str().unwrap_or(""),
            "-C",
            preview_dir.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| format!("tar failed to start: {e}"))?;

    let _ = std::fs::remove_file(&archive_path);

    if !tar_out.status.success() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err(format!(
            "tar extraction failed: {}",
            String::from_utf8_lossy(&tar_out.stderr).trim()
        ));
    }

    if !preview_dir.join("package.json").exists() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err("No package.json — not a Node.js project".to_string());
    }

    for name in &[
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".env.production",
        ".env.production.local",
    ] {
        let src = repo.join(name);
        if src.exists() {
            let _ = std::fs::copy(&src, preview_dir.join(name));
        }
    }

    let pm = if preview_dir.join("bun.lockb").exists() {
        "bun"
    } else if preview_dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if preview_dir.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };

    let main_modules = repo.join("node_modules");
    if main_modules.exists() {
        let _ = std::fs::remove_dir_all(main_modules.join(".vite"));
        let link = preview_dir.join("node_modules");
        if !link.exists() {
            let _ = std::os::unix::fs::symlink(&main_modules, &link);
        }
    }

    let port_str = port.to_string();
    let pm_args: Vec<&str> = match pm {
        "yarn" => vec!["dev", "--port", &port_str],
        "pnpm" => vec!["run", "dev", "--port", &port_str],
        _ => vec!["run", "dev", "--", "--port", &port_str],
    };

    let log_path = std::env::temp_dir().join(format!("git-viz-dev-{port}.log"));
    let (stdout_sink, stderr_sink) = match std::fs::File::create(&log_path) {
        Ok(f) => {
            let f2 = f
                .try_clone()
                .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());
            (Stdio::from(f), Stdio::from(f2))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut server = std::process::Command::new(pm)
        .args(&pm_args)
        .env("PORT", &port_str)
        // Prevent framework dev servers from auto-opening a browser window/tab.
        .env("BROWSER", "none")
        .env("NO_OPEN", "1")
        .env("npm_config_open", "false")
        .env("npm_config_browser", "none")
        .current_dir(&preview_dir)
        .stdout(stdout_sink)
        .stderr(stderr_sink)
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&preview_dir);
            format!("Failed to start dev server ({pm}): {e}")
        })?;

    let requested_url = format!("http://localhost:{port}");
    let start = Instant::now();
    let live_url: Option<String> = loop {
        if start.elapsed() > Duration::from_secs(90) {
            break None;
        }

        if let Ok(Some(_)) = server.try_wait() {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            let tail = log
                .lines()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let _ = std::fs::remove_file(&log_path);
            let _ = std::fs::remove_dir_all(&preview_dir);
            return Err(format!("Dev server crashed.\nLog:\n{tail}"));
        }

        std::thread::sleep(Duration::from_millis(500));

        if ureq::get(&requested_url).call().is_ok() {
            break Some(requested_url.clone());
        }

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if let Some(actual) = parse_localhost_url(&log) {
            if ureq::get(&actual).call().is_ok() {
                break Some(actual);
            }
        }
    };

    let _ = std::fs::remove_file(&log_path);

    let url = match live_url {
        Some(u) => u,
        None => {
            let _ = server.kill();
            let _ = std::fs::remove_dir_all(&preview_dir);
            return Err(format!(
                "Dev server did not respond within 90s (tried port {port})"
            ));
        }
    };

    let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if !Path::new(chrome).exists() {
        let _ = server.kill();
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err("Google Chrome not found — install Chrome to generate previews".to_string());
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let auth_dir = format!("{home}/.git-viz-preview-auth/setup");

    let mut chrome_proc = std::process::Command::new(chrome)
        .args([
            "--no-sandbox",
            "--disable-extensions",
            "--disable-default-apps",
            "--window-size=1440,900",
            &format!("--user-data-dir={auth_dir}"),
            &url,
        ])
        .spawn()
        .map_err(|e| {
            let _ = server.kill();
            let _ = std::fs::remove_dir_all(&preview_dir);
            format!("Failed to launch Chrome: {e}")
        })?;

    // Block until the user closes Chrome
    let _ = chrome_proc.wait();

    let _ = server.kill();
    let _ = std::fs::remove_dir_all(&preview_dir);
    Ok(())
}

/// Open a visible Chrome window for the given branch so the user can log in.
/// Returns when Chrome is closed. On the next preview run, the CDP script will
/// seed its profile from `~/.git-viz-preview-auth/setup`.
#[tauri::command(rename_all = "camelCase")]
async fn open_preview_browser(repo_path: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_open_browser_blocking(repo_path, branch, 3493))
        .await
        .map_err(|e| format!("Spawn error: {e}"))?
}

/// Node.js script that uses Chrome DevTools Protocol to screenshot a URL.
///
/// Unlike `chrome --screenshot` (which fires at the browser `load` event, before
/// React's useEffect data fetches), this script waits for **network idle** — no
/// in-flight requests for 2 s — before capturing.  That means the screenshot
/// shows fully-loaded data, not loading skeletons.
///
/// Uses only Node.js built-in modules so it works without npm install.
const CDP_SCREENSHOT_SCRIPT: &str = r#"
'use strict';
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');
const { spawn } = require('child_process');

// urlsJson is a JSON array of full URLs to screenshot in sequence.
// Screenshots are saved as outDir/0.png, outDir/1.png, …
const [,, urlsJson, chromePath, outDir, cdpPortStr] = process.argv;
const urls = JSON.parse(urlsJson);
const CDP_PORT = parseInt(cdpPortStr, 10);

const userDataDir = require('os').tmpdir() + '/git-viz-chrome-' + CDP_PORT;
const chrome = spawn(chromePath, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,900', '--disable-extensions', '--disable-default-apps',
  // Allow any origin to connect via CDP (required in Chrome 112+).
  '--remote-allow-origins=*',
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${CDP_PORT}`,
  'about:blank',
], { stdio: 'ignore' });
chrome.on('error', err => { process.stderr.write('Chrome error: ' + err.message + '\n'); process.exit(1); });
let chromeDead = false;
let chromeExitError = null;
chrome.on('exit', (code, signal) => {
  if (!chromeDead) {
    chromeDead = true;
    chromeExitError = new Error('Chrome exited unexpectedly (code=' + code + ', signal=' + signal + ')');
    process.stderr.write(chromeExitError.message + '\n');
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function waitForTarget(timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (chromeDead) throw chromeExitError || new Error('Chrome exited before CDP was ready');
    try {
      const data = await httpGet(`http://localhost:${CDP_PORT}/json/list`);
      const targets = JSON.parse(data);
      const page = targets.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch(_) {}
    await sleep(200);
  }
  throw new Error('Timeout waiting for Chrome CDP on port ' + CDP_PORT);
}

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const { hostname: host, port, pathname, search } = new URL(wsUrl);
    const wsPath = pathname + (search || '');
    const key    = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection(parseInt(port, 10), host);

    const handlers = new Map();
    const listeners = [];
    let wsOpen = false;
    let httpBuf = Buffer.alloc(0);
    let frameBuf = Buffer.alloc(0);
    let nextId = 1;

    socket.on('connect', () => {
      socket.write([
        `GET ${wsPath} HTTP/1.1`, `Host: ${host}:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });

    socket.on('data', chunk => {
      if (!wsOpen) {
        httpBuf = Buffer.concat([httpBuf, chunk]);
        const sep = httpBuf.indexOf('\r\n\r\n');
        if (sep !== -1) {
          const statusLine = httpBuf.slice(0, sep).toString().split('\r\n')[0];
          if (!statusLine.includes('101')) {
            return reject(new Error('WebSocket upgrade failed: ' + statusLine));
          }
          wsOpen = true;
          const rest = httpBuf.slice(sep + 4);
          if (rest.length) processFrames(rest);
          resolve(ws);
        }
        return;
      }
      processFrames(chunk);
    });

    function processFrames(data) {
      frameBuf = Buffer.concat([frameBuf, data]);
      while (frameBuf.length >= 2) {
        const opcode = frameBuf[0] & 0x0f;
        let len = frameBuf[1] & 0x7f, off = 2;
        if (len === 126) {
          if (frameBuf.length < 4) break;
          len = frameBuf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (frameBuf.length < 10) break;
          len = frameBuf.readUInt32BE(2) * 0x100000000 + frameBuf.readUInt32BE(6); off = 10;
        }
        if (frameBuf.length < off + len) break;
        const payload = frameBuf.slice(off, off + len);
        frameBuf = frameBuf.slice(off + len);
        if (opcode === 1) {
          try {
            const msg = JSON.parse(payload.toString());
            if (msg.id != null && handlers.has(msg.id)) {
              const h = handlers.get(msg.id); handlers.delete(msg.id);
              msg.error ? h.reject(new Error(JSON.stringify(msg.error))) : h.resolve(msg.result);
            } else if (msg.method) {
              listeners.forEach(fn => fn(msg));
            }
          } catch(_) {}
        } else if (opcode === 8) { socket.destroy(); }
      }
    }

    function sendFrame(text) {
      const payload = Buffer.from(text);
      const mask = crypto.randomBytes(4);
      let hdr;
      if (payload.length < 126) {
        hdr = Buffer.alloc(6); hdr[0] = 0x81; hdr[1] = 0x80 | payload.length; mask.copy(hdr, 2);
      } else if (payload.length < 65536) {
        hdr = Buffer.alloc(8); hdr[0] = 0x81; hdr[1] = 0xfe; hdr.writeUInt16BE(payload.length, 2); mask.copy(hdr, 4);
      } else {
        hdr = Buffer.alloc(14); hdr[0] = 0x81; hdr[1] = 0xff;
        hdr.writeUInt32BE(0, 2); hdr.writeUInt32BE(payload.length, 6); mask.copy(hdr, 10);
      }
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([hdr, masked]));
    }

    const ws = {
      send(method, params) {
        return new Promise((res, rej) => {
          if (chromeDead) { return rej(chromeExitError || new Error('Chrome is not running')); }
          const id = nextId++;
          handlers.set(id, { resolve: res, reject: rej });
          sendFrame(JSON.stringify({ id, method, params: params || {} }));
          const timeoutMs = method === 'Runtime.evaluate' ? 10000 : 30000;
          setTimeout(() => {
            if (handlers.has(id)) { handlers.delete(id); rej(new Error('CDP timeout: ' + method)); }
          }, timeoutMs);
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { socket.destroy(); } catch(_) {} },
    };

    socket.on('error', err => { if (!wsOpen) reject(err); });
    socket.on('close', () => {
      if (chromeDead) {
        const err = chromeExitError || new Error('Chrome connection closed');
        handlers.forEach(h => h.reject(err));
        handlers.clear();
      }
    });
  });
}

async function main() {
  let ws;
  try {
    const wsUrl = await waitForTarget(20000);
    ws = await wsConnect(wsUrl);

    await ws.send('Network.enable', {});
    await ws.send('Page.enable', {});
    await ws.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });;

    const inFlight = new Set();
    let lastActivity = Date.now();

    ws.on(msg => {
      if (msg.method === 'Network.requestWillBeSent') {
        inFlight.add(msg.params.requestId); lastActivity = Date.now();
      } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
        inFlight.delete(msg.params.requestId); lastActivity = Date.now();
      }
    });

    const IDLE_MS = 2000, MAX_MS = 30000;
    const { join } = require('path');

    for (let i = 0; i < urls.length; i++) {
      // Reset network tracking for each new page load
      inFlight.clear();
      lastActivity = Date.now();

      await ws.send('Page.navigate', { url: urls[i] });
      lastActivity = Date.now();

      const started = Date.now();
      while (Date.now() - started < MAX_MS) {
        if (chromeDead) throw chromeExitError || new Error('Chrome exited during page load');
        await sleep(250);
        if (inFlight.size === 0 && Date.now() - lastActivity >= IDLE_MS) break;
      }
      if (chromeDead) throw chromeExitError || new Error('Chrome exited during page load');

      // Try to click an entry-point button (e.g. "START") to reveal the main content.
      // Matches buttons/links whose full visible text is a single common CTA word.
      await sleep(400);
      const clickResult = await ws.send('Runtime.evaluate', {
        expression: `(() => {
          const re = /^\\s*(start|begin|enter|open|launch|go|continue|next|let's go|get started)\\s*$/i;
          const el = Array.from(document.querySelectorAll('button, a, [role="button"]'))
            .find(el => re.test(el.textContent));
          if (el) { el.click(); return el.textContent.trim(); }
          return null;
        })()`,
        returnByValue: true,
      });

      const didClick = clickResult && clickResult.result && clickResult.result.value != null;
      if (didClick) {
        // Wait for post-click navigation + animations to settle
        await sleep(300);
        inFlight.clear();
        lastActivity = Date.now();
        const postClick = Date.now();
        while (Date.now() - postClick < 12000) {
          if (chromeDead) throw chromeExitError || new Error('Chrome exited during page load');
          await sleep(250);
          if (inFlight.size === 0 && Date.now() - lastActivity >= IDLE_MS) break;
        }
        await sleep(1200);
      } else {
        await sleep(400);
      }

      const shot = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      if (!shot || !shot.data) throw new Error('No screenshot data for URL ' + i);

      fs.writeFileSync(join(outDir, i + '.png'), Buffer.from(shot.data, 'base64'));
    }

    ws.close(); chrome.kill(); process.exit(0);
  } catch(err) {
    process.stderr.write('Error: ' + err.message + '\n');
    if (ws) try { ws.close(); } catch(_) {}
    chrome.kill(); process.exit(1);
  }
}
main();
"#;

/// Recursively copy `src` dir into `dst`, skipping symlinks (e.g. Chrome's
/// SingletonLock) and known large cache directories that aren't needed for
/// preserving web-app session state.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    const SKIP: &[&str] = &[
        "Cache",
        "Code Cache",
        "GPUCache",
        "ShaderCache",
        "Crashpad",
        "CrashpadMetrics-active.pma",
        "BrowserMetrics",
        "GrShaderCache",
    ];
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];

    while let Some((src_dir, dst_dir)) = stack.pop() {
        std::fs::create_dir_all(&dst_dir)?;
        let entries = match std::fs::read_dir(&src_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if SKIP.contains(&name.to_string_lossy().as_ref()) {
                continue;
            }
            let ty = match entry.file_type() {
                Ok(ty) => ty,
                Err(_) => continue,
            };
            let dst_path = dst_dir.join(&name);
            if ty.is_dir() {
                stack.push((entry.path(), dst_path));
            } else if ty.is_file() {
                // ty.is_symlink() is false here because is_file() is false for symlinks
                let _ = std::fs::copy(entry.path(), dst_path);
            }
            // Symlinks (SingletonLock, etc.) are skipped — is_dir and is_file both false
        }
    }

    Ok(())
}

/// Returns true if the project at `dir` uses hash-based client-side routing
/// (React HashRouter, Vue createWebHashHistory, etc.). For these apps all paths
/// serve the same HTML — routes live in the URL fragment, e.g. `/#/tarot`.
fn uses_hash_routing(dir: &Path) -> bool {
    const PATTERNS: &[&str] = &[
        "createHashRouter",
        "HashRouter",
        "createHashHistory",
        "createWebHashHistory", // Vue Router
        "useHash: true",
        "\"hash\"", // generic router hash mode config
        "'hash'",
    ];
    let candidates = [
        "src/main.tsx",
        "src/main.ts",
        "src/main.jsx",
        "src/main.js",
        "src/App.tsx",
        "src/App.ts",
        "src/App.jsx",
        "src/App.js",
        "src/router.ts",
        "src/router.tsx",
        "src/router/index.ts",
        "src/router/index.tsx",
        "src/routes.ts",
        "src/routes.tsx",
        "app/router.ts",
        "app/router.tsx",
    ];
    for rel in &candidates {
        if let Ok(content) = std::fs::read_to_string(dir.join(rel)) {
            if PATTERNS.iter().any(|p| content.contains(p)) {
                return true;
            }
        }
    }
    false
}

/// Blocking core: starts a dev server for `branch`, screenshots each `path` in
/// sequence via the CDP script, and returns one base64 data URL per path.
/// Empty strings indicate that a particular screenshot failed.
fn run_previews_blocking(
    repo_path: String,
    branch: String,
    port: u16,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    use base64::Engine;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let repo = Path::new(&repo_path);

    // Sanitise branch name for the temp directory name
    let slug: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    // Include port in the dir name so concurrent calls for the same branch
    // (e.g. from React StrictMode double-effect) use separate directories.
    let preview_dir = std::env::temp_dir().join(format!("git-viz-preview-{slug}-{port}"));

    // Always start clean
    let _ = std::fs::remove_dir_all(&preview_dir);
    std::fs::create_dir_all(&preview_dir)
        .map_err(|e| format!("Failed to create preview dir: {e}"))?;

    // ── Extract branch files via git archive ─────────────────────────────────
    // More reliable than git worktrees (no locking, no registration state).
    // We buffer to a temp .tar file instead of piping, avoiding macOS pipe
    // edge cases where tar can exit before git flushes its stdout.
    let archive_path = std::env::temp_dir().join(format!("git-viz-archive-{port}.tar"));
    let _ = std::fs::remove_file(&archive_path);

    let arch_out = std::process::Command::new("git")
        .args(["-C", &repo_path, "archive", "--format=tar", &branch])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .output()
        .map_err(|e| format!("git archive failed to start: {e}"))?;

    if !arch_out.status.success() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err(format!(
            "git archive failed for branch '{}': {}",
            branch,
            String::from_utf8_lossy(&arch_out.stderr).trim()
        ));
    }

    std::fs::write(&archive_path, &arch_out.stdout)
        .map_err(|e| format!("Failed to write archive: {e}"))?;

    let tar_out = std::process::Command::new("tar")
        .args([
            "-xf",
            archive_path.to_str().unwrap_or(""),
            "-C",
            preview_dir.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| format!("tar failed to start: {e}"))?;

    let _ = std::fs::remove_file(&archive_path);

    if !tar_out.status.success() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err(format!(
            "tar extraction failed: {}",
            String::from_utf8_lossy(&tar_out.stderr).trim()
        ));
    }

    // Must be a Node.js project
    if !preview_dir.join("package.json").exists() {
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err("No package.json — not a Node.js project".to_string());
    }

    // Copy .env files from the real repo into the temp dir.
    // git archive excludes them (they're gitignored) but the app needs them
    // to authenticate and load data — without them the app shows loading
    // skeletons or blank pages indefinitely.
    for name in &[
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".env.production",
        ".env.production.local",
    ] {
        let src = repo.join(name);
        if src.exists() {
            let _ = std::fs::copy(&src, preview_dir.join(name));
        }
    }

    // Inject a MutationObserver script into index.html that removes the
    // Vite error overlay element before the screenshot is taken.
    // We're modifying a temp copy so the real repo is untouched.
    let index_html_path = preview_dir.join("index.html");
    if index_html_path.exists() {
        if let Ok(html) = std::fs::read_to_string(&index_html_path) {
            let inject = concat!(
                "<script>",
                "!function(){",
                "var mo=new MutationObserver(function(){",
                "var el=document.querySelector('vite-error-overlay');",
                "if(el)el.remove();",
                "});",
                "document.addEventListener('DOMContentLoaded',function(){",
                "if(document.body)mo.observe(document.body,{childList:true,subtree:true});",
                "});",
                "}();",
                "</script>"
            );
            let patched = if html.contains("</body>") {
                html.replace("</body>", &format!("{inject}</body>"))
            } else {
                format!("{html}{inject}")
            };
            let _ = std::fs::write(&index_html_path, patched);
        }
    }

    // Detect package manager from lockfile
    let pm = if preview_dir.join("bun.lockb").exists() {
        "bun"
    } else if preview_dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if preview_dir.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };

    // Symlink node_modules from the live repo checkout to skip install
    let main_modules = repo.join("node_modules");
    if main_modules.exists() {
        // Clear Vite's dependency cache before starting the preview server.
        // Previous parallel preview runs share this cache and can corrupt it.
        // Vite automatically rebuilds it on next startup — clearing is safe.
        let _ = std::fs::remove_dir_all(main_modules.join(".vite"));

        let link = preview_dir.join("node_modules");
        if !link.exists() {
            let _ = std::os::unix::fs::symlink(&main_modules, &link);
        }
    }

    // Launch dev server (PORT env var + --port flag for belt-and-suspenders)
    let port_str = port.to_string();
    // npm and bun strip '--' before forwarding to the script.
    // pnpm does NOT — it passes '--' literally, so 'pnpm run dev -- --port X'
    // becomes 'vite -- --port X' which vite ignores.  Omit '--' for pnpm.
    let pm_args: Vec<&str> = match pm {
        "yarn" => vec!["dev", "--port", &port_str],
        "pnpm" => vec!["run", "dev", "--port", &port_str],
        _ => vec!["run", "dev", "--", "--port", &port_str],
    };

    // Capture BOTH stdout and stderr to a log file.
    // Next.js writes its "ready on port X" message to stdout, not stderr.
    let log_path = std::env::temp_dir().join(format!("git-viz-dev-{port}.log"));
    let (stdout_sink, stderr_sink) = match std::fs::File::create(&log_path) {
        Ok(f) => {
            let f2 = f
                .try_clone()
                .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());
            (Stdio::from(f), Stdio::from(f2))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut server = std::process::Command::new(pm)
        .args(&pm_args)
        .env("PORT", &port_str)
        // Prevent framework dev servers from auto-opening a browser window/tab.
        .env("BROWSER", "none")
        .env("NO_OPEN", "1")
        .env("npm_config_open", "false")
        .env("npm_config_browser", "none")
        .current_dir(&preview_dir)
        .stdout(stdout_sink)
        .stderr(stderr_sink)
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&preview_dir);
            format!("Failed to start dev server ({pm}): {e}")
        })?;

    // Poll until the server responds.  We try two URLs:
    // 1. The port we asked for (via --port flag).
    // 2. Whatever port the server actually logged (fallback for frameworks that
    //    ignore --port or choose a different port due to conflicts).
    let requested_url = format!("http://localhost:{port}");
    let start = Instant::now();
    let live_url: Option<String> = loop {
        if start.elapsed() > Duration::from_secs(90) {
            break None;
        }

        // Bail early on crash rather than waiting the full 90s
        if let Ok(Some(_)) = server.try_wait() {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            let tail = log
                .lines()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let _ = std::fs::remove_file(&log_path);
            let _ = std::fs::remove_dir_all(&preview_dir);
            return Err(format!("Dev server crashed.\nLog:\n{tail}"));
        }

        std::thread::sleep(Duration::from_millis(500));

        // 1. Check the port we asked for
        if ureq::get(&requested_url).call().is_ok() {
            break Some(requested_url.clone());
        }

        // 2. Parse the log to find what port the server actually chose
        //    (e.g. Vite prints "Local: http://localhost:5175/")
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if let Some(actual) = parse_localhost_url(&log) {
            if ureq::get(&actual).call().is_ok() {
                break Some(actual);
            }
        }
    };

    let url = match live_url {
        Some(u) => u,
        None => {
            let _ = server.kill();
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            let tail = log
                .lines()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let _ = std::fs::remove_file(&log_path);
            let _ = std::fs::remove_dir_all(&preview_dir);
            return Err(if tail.is_empty() {
                format!("Dev server did not respond within 90s (tried port {port})")
            } else {
                format!("Dev server timed out. Last log output:\n{tail}")
            });
        }
    };
    let _ = std::fs::remove_file(&log_path);

    // Locate Chrome
    let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if !Path::new(chrome).exists() {
        let _ = server.kill();
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err("Google Chrome not found — install Chrome to generate previews".to_string());
    }

    // Locate Node.js — check common macOS install paths
    let node_bin = [
        "node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ]
    .iter()
    .find(|&&n| {
        if n.starts_with('/') {
            Path::new(n).exists()
        } else {
            std::process::Command::new(n)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
    })
    .copied();

    if node_bin.is_none() {
        let _ = server.kill();
        let _ = std::fs::remove_dir_all(&preview_dir);
        return Err("Node.js not found — install Node.js to generate previews".to_string());
    }
    let node_bin = node_bin.unwrap();

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let cdp_port_num = port + 1000;

    // Use a fresh temp dir for each Chrome instance — guarantees no stale
    // SingletonLock/SingletonCookie symlinks from previous crashed sessions.
    let temp_profile = std::env::temp_dir().join(format!("git-viz-chrome-{cdp_port_num}"));
    let _ = std::fs::remove_dir_all(&temp_profile);

    // Copy the full auth session profile (cookies, localStorage, IndexedDB, etc.)
    // so logged-in state carries over. copy_dir_all skips symlinks automatically,
    // so SingletonLock is never transferred to the fresh temp dir.
    let shared_auth = Path::new(&home).join(".git-viz-preview-auth/setup");
    if shared_auth.exists() {
        let _ = copy_dir_all(&shared_auth, &temp_profile);
    } else {
        let _ = std::fs::create_dir_all(&temp_profile);
    }

    // Detect hash-based routing (e.g. React Router HashRouter, Vue createWebHashHistory).
    // These apps serve the same HTML at every path; routes live in the URL fragment (#/tarot).
    let hash_routing = uses_hash_routing(&preview_dir);

    // Build the full URL for each requested path.
    let nav_paths = if paths.is_empty() {
        vec!["/".to_string()]
    } else {
        paths
    };
    let full_urls: Vec<String> = nav_paths
        .iter()
        .map(|p| {
            let p = if p.starts_with('/') { p.as_str() } else { "/" };
            if p == "/" {
                url.clone()
            } else if hash_routing {
                format!("{url}/#{p}") // e.g. http://localhost:3492/#/tarot
            } else {
                format!("{url}{p}") // e.g. http://localhost:3492/tarot
            }
        })
        .collect();

    let urls_json = serde_json::to_string(&full_urls).map_err(|e| format!("JSON error: {e}"))?;

    // Output directory: one PNG per path (0.png, 1.png, …)
    let out_dir = std::env::temp_dir().join(format!("git-viz-shots-{port}"));
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create output dir: {e}"))?;

    // Write CDP script and invoke it.
    // The script starts Chrome with --remote-debugging-port, navigates to each
    // URL in sequence, waits for network idle (2 s quiet), then screenshots.
    let script_path = std::env::temp_dir().join(format!("git-viz-cdp-{port}.js"));
    std::fs::write(&script_path, CDP_SCREENSHOT_SCRIPT)
        .map_err(|e| format!("Failed to write CDP script: {e}"))?;

    // CDP debug port offset: 3491 → 4491, 3492 → 4492
    let cdp_port = (port + 1000).to_string();

    let node_out = std::process::Command::new(node_bin)
        .args([
            script_path.to_str().unwrap_or(""),
            &urls_json,
            chrome,
            out_dir.to_str().unwrap_or(""),
            &cdp_port,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();

    let _ = std::fs::remove_file(&script_path);
    let _ = server.kill();
    let _ = std::fs::remove_dir_all(&preview_dir);

    match node_out {
        Ok(out) => {
            let mut results: Vec<String> = Vec::with_capacity(full_urls.len());
            for i in 0..full_urls.len() {
                let png = out_dir.join(format!("{i}.png"));
                if png.exists() {
                    match std::fs::read(&png) {
                        Ok(bytes) if !bytes.is_empty() => {
                            let _ = std::fs::remove_file(&png);
                            results.push(format!(
                                "data:image/png;base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(&bytes)
                            ));
                        }
                        Ok(_) => results.push(String::new()), // 0-byte = skip
                        Err(_) => results.push(String::new()),
                    }
                } else {
                    results.push(String::new());
                }
            }
            let _ = std::fs::remove_dir_all(&out_dir);
            if results.iter().all(|s| s.is_empty()) {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(format!("Screenshot failed: {}", stderr.trim()))
            } else {
                Ok(results)
            }
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&out_dir);
            Err(format!("Node.js launch failed: {e}"))
        }
    }
}

/// Capture the main webview window and save as a PNG.
/// Uses macOS `screencapture -R x,y,w,h` with the window's exact bounds.
#[tauri::command]
fn screenshot(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let region = format!("{},{},{},{}", pos.x, pos.y, size.width, size.height);
    std::process::Command::new("screencapture")
        .args(["-x", "-R", &region, &path]) // -x = silent, -R = region
        .status()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    macos_traffic_lights::schedule_reapply_after_screen_capture(&app);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn summarize_diff(diff: String, api_key: String) -> Result<String, String> {
    let prompt = format!(
        "Analyze this git diff and return a plain-English summary grouped by area of the codebase.\n\n\
         Return ONLY valid JSON, no markdown fences:\n\
         [\n  {{\n    \"section\": \"Area or component name\",\n    \"changes\": [\n      \
         {{\"type\": \"add\", \"description\": \"What was added or improved\"}},\n      \
         {{\"type\": \"remove\", \"description\": \"What was removed or changed\"}}\n    ]\n  }}\n]\n\n\
         Rules:\n\
         - Group by feature area, not by file\n\
         - Keep descriptions under 55 chars\n\
         - Use \"add\" for additions/improvements, \"remove\" for removals/regressions\n\
         - Max 6 sections, max 4 changes per section\n\n\
         Git diff:\n{}",
        diff
    );
    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": prompt }]
    });
    let result = ureq::post("https://api.anthropic.com/v1/messages")
        .set("Content-Type", "application/json")
        .set("x-api-key", &api_key)
        .set("anthropic-version", "2023-06-01")
        .send_json(&body);
    match result {
        Ok(resp) => {
            let data: serde_json::Value = resp
                .into_json()
                .map_err(|e| format!("Failed to parse response: {e}"))?;
            Ok(data["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body: serde_json::Value = resp.into_json().unwrap_or_default();
            let msg = body["error"]["message"].as_str().unwrap_or("Unknown error");
            Err(format!("{code}: {msg}"))
        }
        Err(e) => Err(format!("Network error: {e}")),
    }
}

#[tauri::command]
fn get_anthropic_key() -> Option<String> {
    // Compile-time key (set ANTHROPIC_API_KEY when running pnpm tauri build)
    if let Some(key) = option_env!("ANTHROPIC_API_KEY") {
        if !key.is_empty() {
            return Some(key.to_string());
        }
    }
    // Fallback to runtime env var for local development
    std::env::var("ANTHROPIC_API_KEY").ok()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRepoEventPayload {
    path: String,
    source_app: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct OpenRepoDetectionCacheEntry {
    payload: OpenRepoEventPayload,
    captured_at: Instant,
}

#[cfg(target_os = "macos")]
static OPEN_REPO_DETECTION_CACHE: OnceLock<Mutex<Option<OpenRepoDetectionCacheEntry>>> =
    OnceLock::new();
#[cfg(target_os = "macos")]
static OPEN_REPO_DETECTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn open_repo_detection_cache() -> &'static Mutex<Option<OpenRepoDetectionCacheEntry>> {
    OPEN_REPO_DETECTION_CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "macos")]
fn take_cached_open_repo_detection() -> Option<OpenRepoEventPayload> {
    let mut cache = open_repo_detection_cache().lock().ok()?;
    let entry = cache.as_ref()?;
    if entry.captured_at.elapsed() <= OPEN_REPO_DETECTION_CACHE_TTL {
        return Some(entry.payload.clone());
    }
    *cache = None;
    None
}

#[cfg(target_os = "macos")]
fn cache_open_repo_detection(payload: OpenRepoEventPayload) {
    if let Ok(mut cache) = open_repo_detection_cache().lock() {
        *cache = Some(OpenRepoDetectionCacheEntry {
            payload,
            captured_at: Instant::now(),
        });
    }
}

#[cfg(target_os = "macos")]
fn emit_or_queue_open_repo(app_handle: &tauri::AppHandle, payload: OpenRepoEventPayload) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("gitviz://open-repo", &payload);
        return;
    }
    if let Ok(mut pending) = pending_open_repo().lock() {
        *pending = Some(payload);
    }
}

#[cfg(target_os = "macos")]
fn detect_open_repo_cached() -> Option<OpenRepoEventPayload> {
    if let Some(cached) = take_cached_open_repo_detection() {
        return Some(cached);
    }

    let detected = detect_repo_from_frontmost_process();
    if let Some(payload) = detected.clone() {
        cache_open_repo_detection(payload);
    }
    detected
}

#[cfg(target_os = "macos")]
fn parse_frontmost_process(output: &str) -> Option<(String, i32)> {
    let trimmed = output.trim();
    let mut parts = trimmed.splitn(2, "||");
    let app_name = parts.next()?.trim().to_string();
    let pid = parts.next()?.trim().parse::<i32>().ok()?;
    if app_name.is_empty() || pid <= 0 {
        return None;
    }
    Some((app_name, pid))
}

#[cfg(target_os = "macos")]
fn frontmost_process_via_nsworkspace() -> Option<(String, i32)> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid = app.processIdentifier() as i32;
    if pid <= 0 {
        return None;
    }
    let app_name = if let Some(name) = app.localizedName() {
        let name_str = name.to_string();
        if !name_str.is_empty() {
            name_str
        } else {
            "Frontmost App".to_string()
        }
    } else {
        "Frontmost App".to_string()
    };
    Some((app_name, pid))
}

#[cfg(target_os = "macos")]
fn frontmost_process_via_system_events() -> Option<(String, i32)> {
    let script = r#"tell application "System Events"
  tell first application process whose frontmost is true
    return (name as text) & "||" & (unix id as text)
  end tell
end tell"#;
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_frontmost_process(std::str::from_utf8(&output.stdout).ok()?)
}

#[cfg(target_os = "macos")]
fn frontmost_process_via_swift() -> Option<(String, i32)> {
    let script = r#"import AppKit
if let app = NSWorkspace.shared.frontmostApplication {
    print("\(app.localizedName ?? "")||\(app.processIdentifier)")
}"#;
    let output = std::process::Command::new("swift")
        .args(["-e", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_frontmost_process(std::str::from_utf8(&output.stdout).ok()?)
}

#[cfg(target_os = "macos")]
fn get_frontmost_process() -> Option<(String, i32)> {
    frontmost_process_via_nsworkspace()
        .or_else(frontmost_process_via_system_events)
        .or_else(frontmost_process_via_swift)
}

#[cfg(target_os = "macos")]
fn parse_lsof_paths_by_pid(raw: &str) -> HashMap<i32, Vec<PathBuf>> {
    let mut by_pid: HashMap<i32, Vec<PathBuf>> = HashMap::new();
    let mut current_pid: Option<i32> = None;

    for line in raw.lines() {
        if let Some(pid_text) = line.strip_prefix('p') {
            current_pid = pid_text.trim().parse::<i32>().ok();
            continue;
        }
        let Some(path_text) = line.strip_prefix('n') else {
            continue;
        };
        let Some(pid) = current_pid else {
            continue;
        };
        let path = path_text.trim();
        if !path.starts_with('/') {
            continue;
        }
        by_pid.entry(pid).or_default().push(PathBuf::from(path));
    }

    by_pid
}

#[cfg(target_os = "macos")]
fn is_noise_system_path(path: &Path) -> bool {
    let raw = path.to_string_lossy();
    raw.starts_with("/System/")
        || raw.starts_with("/usr/")
        || raw.starts_with("/private/var/")
        || raw.starts_with("/Library/")
        || raw.starts_with("/Applications/")
}

#[cfg(target_os = "macos")]
fn git_root_for_path(path: &Path) -> Option<PathBuf> {
    let mut cursor = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };

    loop {
        if cursor.join(".git").exists() {
            return Some(cursor);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn lsof_paths_for_pids(pids: &[i32], descriptor_filter: &str) -> HashMap<i32, Vec<PathBuf>> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let mut unique_pids = pids
        .iter()
        .copied()
        .filter(|pid| *pid > 0)
        .collect::<Vec<_>>();
    unique_pids.sort_unstable();
    unique_pids.dedup();
    if unique_pids.is_empty() {
        return HashMap::new();
    }

    let pid_list = unique_pids
        .iter()
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let output = std::process::Command::new("lsof")
        .args([
            "-n",
            "-P",
            "-a",
            "-p",
            &pid_list,
            "-d",
            descriptor_filter,
            "-Fn",
        ])
        .output();
    let Ok(output) = output else {
        return HashMap::new();
    };
    let Ok(raw) = std::str::from_utf8(&output.stdout) else {
        return HashMap::new();
    };
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    parse_lsof_paths_by_pid(raw)
}

#[cfg(target_os = "macos")]
fn parse_tty_list(raw: &str) -> Vec<String> {
    raw.split(|ch: char| ch == ',' || ch.is_whitespace())
        .map(str::trim)
        .filter(|token| token.starts_with("/dev/tty"))
        .map(|tty| tty.to_string())
        .collect()
}

#[cfg(target_os = "macos")]
fn terminal_front_tty() -> Option<String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"tell application "Terminal"
  if (count of windows) is 0 then return ""
  return tty of selected tab of front window
end tell"#,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = std::str::from_utf8(&output.stdout).ok()?;
    parse_tty_list(raw).into_iter().next()
}

#[cfg(target_os = "macos")]
fn terminal_all_ttys() -> Vec<String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"tell application "Terminal"
  if (count of windows) is 0 then return ""
  return tty of every tab of every window
end tell"#,
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let Ok(raw) = std::str::from_utf8(&output.stdout) else {
        return Vec::new();
    };
    parse_tty_list(raw)
}

#[cfg(target_os = "macos")]
fn pids_for_ttys(ttys: &[String]) -> Vec<i32> {
    if ttys.is_empty() {
        return Vec::new();
    }
    let mut tty_values = ttys
        .iter()
        .filter(|tty| tty.starts_with("/dev/tty"))
        .cloned()
        .collect::<Vec<_>>();
    tty_values.sort();
    tty_values.dedup();
    if tty_values.is_empty() {
        return Vec::new();
    }

    let output = std::process::Command::new("lsof")
        .arg("-n")
        .arg("-P")
        .arg("-t")
        .args(tty_values.iter().map(String::as_str))
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let Ok(raw) = std::str::from_utf8(&output.stdout) else {
        return Vec::new();
    };

    let mut pids = raw
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(target_os = "macos")]
fn detect_repo_from_terminal_sessions(home_dir: Option<&PathBuf>) -> Option<PathBuf> {
    let front_tty = terminal_front_tty();
    let mut ttys = front_tty.clone().into_iter().collect::<Vec<_>>();
    ttys.extend(terminal_all_ttys());
    ttys.sort();
    ttys.dedup();

    let pids = pids_for_ttys(&ttys);
    if pids.is_empty() {
        return None;
    }

    let mut scores: HashMap<PathBuf, i32> = HashMap::new();
    let cwd_by_pid = lsof_paths_for_pids(&pids, "cwd");
    for path in cwd_by_pid.values().flatten() {
        if !path_allowed_for_detection(path, home_dir) {
            continue;
        }
        if let Some(root) = git_root_for_path(path) {
            *scores.entry(root).or_insert(0) += 28;
        }
    }

    let files_by_pid = lsof_paths_for_pids(&pids, "0-256");
    for path in files_by_pid.values().flatten() {
        if !path_allowed_for_detection(path, home_dir) {
            continue;
        }
        if let Some(root) = git_root_for_path(path) {
            *scores.entry(root).or_insert(0) += 2;
        }
    }

    if let Some(front_tty) = front_tty {
        let front_pids = pids_for_ttys(&[front_tty]);
        let front_cwds = lsof_paths_for_pids(&front_pids, "cwd");
        for path in front_cwds.values().flatten() {
            if !path_allowed_for_detection(path, home_dir) {
                continue;
            }
            if let Some(root) = git_root_for_path(path) {
                *scores.entry(root).or_insert(0) += 48;
            }
        }
    }

    best_scored_repo(scores)
}

#[cfg(target_os = "macos")]
fn percent_decode_component(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[(index + 1)..(index + 3)]).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            decoded.push(value);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).ok()
}

#[cfg(target_os = "macos")]
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let encoded_path = uri.strip_prefix("file://")?;
    if !encoded_path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode_component(encoded_path)?;
    if decoded.is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded))
}

#[cfg(target_os = "macos")]
fn detect_repo_from_editor_storage(home_dir: Option<&PathBuf>) -> Option<PathBuf> {
    let home = home_dir?;
    let storage_files = [
        home.join("Library/Application Support/Cursor/User/globalStorage/storage.json"),
        home.join("Library/Application Support/Antigravity/User/globalStorage/storage.json"),
        home.join("Library/Application Support/Code/User/globalStorage/storage.json"),
    ];

    let mut scores: HashMap<PathBuf, i32> = HashMap::new();

    for storage_path in storage_files {
        let Ok(raw) = fs::read_to_string(&storage_path) else {
            continue;
        };
        let Some(json) = parse_json_value_bounded(&raw) else {
            continue;
        };
        let Some(folders) = json
            .pointer("/backupWorkspaces/folders")
            .and_then(|value| value.as_array())
        else {
            continue;
        };

        for (idx, folder) in folders.iter().enumerate() {
            let Some(uri) = folder.get("folderUri").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(folder_path) = file_uri_to_path(uri) else {
                continue;
            };
            if !path_allowed_for_detection(&folder_path, home_dir) {
                continue;
            }
            let Some(root) = git_root_for_path(&folder_path) else {
                continue;
            };
            let position_weight = (40_i32 - (idx as i32 * 6)).max(8);
            *scores.entry(root).or_insert(0) += position_weight;
        }
    }

    best_scored_repo(scores)
}

#[cfg(target_os = "macos")]
fn collect_descendant_pids(root_pid: i32, max_nodes: usize) -> Vec<i32> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let Ok(raw) = std::str::from_utf8(&output.stdout) else {
        return Vec::new();
    };

    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(ppid_text) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<i32>() else {
            continue;
        };
        let Ok(ppid) = ppid_text.parse::<i32>() else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }

    let mut result = Vec::new();
    let mut queue = vec![root_pid];
    let mut cursor = 0usize;
    let mut seen: HashSet<i32> = HashSet::new();
    seen.insert(root_pid);

    while cursor < queue.len() && result.len() < max_nodes {
        let current = queue[cursor];
        cursor += 1;
        let Some(next_children) = children.get(&current) else {
            continue;
        };
        for child in next_children {
            if seen.insert(*child) {
                result.push(*child);
                queue.push(*child);
                if result.len() >= max_nodes {
                    break;
                }
            }
        }
    }

    result
}

#[cfg(target_os = "macos")]
fn parse_etime_to_seconds(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    let (day_part, time_part) = if let Some((days, rest)) = trimmed.split_once('-') {
        (days.parse::<i64>().ok()?, rest)
    } else {
        (0_i64, trimmed)
    };
    let pieces = time_part
        .split(':')
        .map(|part| part.parse::<i64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let (hours, minutes, seconds) = match pieces.as_slice() {
        [h, m, s] => (*h, *m, *s),
        [m, s] => (0, *m, *s),
        [s] => (0, 0, *s),
        _ => return None,
    };
    Some(day_part * 86_400 + hours * 3_600 + minutes * 60 + seconds)
}

#[cfg(target_os = "macos")]
fn parse_ps_pid_elapsed_command(line: &str) -> Option<(i32, i64, String)> {
    let trimmed = line.trim_start();
    let pid_end = trimmed.find(char::is_whitespace)?;
    let pid = trimmed[..pid_end].trim().parse::<i32>().ok()?;
    let rest = trimmed[pid_end..].trim_start();
    let etime_end = rest.find(char::is_whitespace)?;
    let elapsed = parse_etime_to_seconds(rest[..etime_end].trim())?;
    let command = rest[etime_end..].trim_start().to_string();
    if command.is_empty() {
        return None;
    }
    Some((pid, elapsed, command))
}

#[cfg(target_os = "macos")]
fn process_command_weight(command_lower: &str) -> i32 {
    if command_lower.contains("pnpm tauri dev")
        || command_lower.contains("npm run tauri")
        || command_lower.contains("tauri dev")
    {
        return 90;
    }
    if command_lower.contains("cursor")
        || command_lower.contains("visual studio code")
        || command_lower.contains("/code ")
        || command_lower.contains("claude")
        || command_lower.contains("codex")
        || command_lower.contains("dia")
    {
        return 64;
    }
    if command_lower.contains("pnpm")
        || command_lower.contains("npm")
        || command_lower.contains("yarn")
        || command_lower.contains("bun")
        || command_lower.contains("node")
        || command_lower.contains("cargo")
        || command_lower.contains("python")
        || command_lower.contains("uv ")
        || command_lower.contains("go ")
    {
        return 46;
    }
    if command_lower.contains("terminal")
        || command_lower.contains("iterm")
        || command_lower.contains("wezterm")
        || command_lower.contains("alacritty")
        || command_lower.contains("/zsh")
        || command_lower.contains("/bash")
        || command_lower.contains("/fish")
    {
        return 30;
    }
    12
}

#[cfg(target_os = "macos")]
fn should_scan_process_command(command_lower: &str) -> bool {
    command_lower.contains("tauri")
        || command_lower.contains("git")
        || command_lower.contains("pnpm")
        || command_lower.contains("npm")
        || command_lower.contains("yarn")
        || command_lower.contains("bun")
        || command_lower.contains("node")
        || command_lower.contains("cargo")
        || command_lower.contains("python")
        || command_lower.contains("uv ")
        || command_lower.contains("zsh")
        || command_lower.contains("bash")
        || command_lower.contains("fish")
        || command_lower.contains("terminal")
        || command_lower.contains("iterm")
        || command_lower.contains("wezterm")
        || command_lower.contains("alacritty")
}

#[cfg(target_os = "macos")]
fn best_scored_repo(scores: HashMap<PathBuf, i32>) -> Option<PathBuf> {
    scores
        .into_iter()
        .max_by(|(path_a, score_a), (path_b, score_b)| {
            score_a
                .cmp(score_b)
                .then_with(|| path_a.as_os_str().len().cmp(&path_b.as_os_str().len()))
        })
        .map(|(path, _)| path)
}

#[cfg(target_os = "macos")]
fn path_allowed_for_detection(path: &Path, home_dir: Option<&PathBuf>) -> bool {
    if is_noise_system_path(path) {
        return false;
    }
    if let Some(home) = home_dir {
        return path.starts_with(home);
    }
    true
}

#[cfg(target_os = "macos")]
fn detect_repo_from_active_dev_processes(home_dir: Option<&PathBuf>) -> Option<PathBuf> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,etime=,command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = std::str::from_utf8(&output.stdout).ok()?;

    let mut process_rows: Vec<(i32, i64, String)> = raw
        .lines()
        .filter_map(parse_ps_pid_elapsed_command)
        .filter_map(|(pid, elapsed, command)| {
            let command_lower = command.to_lowercase();
            if !should_scan_process_command(&command_lower) {
                return None;
            }
            Some((pid, elapsed, command_lower))
        })
        .collect();

    process_rows.sort_by_key(|(_, elapsed, _)| *elapsed);
    if process_rows.len() > 180 {
        process_rows.truncate(180);
    }

    let pid_list: Vec<i32> = process_rows.iter().map(|(pid, _, _)| *pid).collect();
    let cwd_by_pid = lsof_paths_for_pids(&pid_list, "cwd");
    let mut scores: HashMap<PathBuf, i32> = HashMap::new();

    for (pid, elapsed, command_lower) in process_rows {
        let Some(paths) = cwd_by_pid.get(&pid) else {
            continue;
        };
        let base_weight = process_command_weight(&command_lower);
        let recency_bonus = (900_i64.saturating_sub(elapsed.min(900)) / 45) as i32; // 0..20
        let total_weight = base_weight + recency_bonus;
        for path in paths {
            if !path_allowed_for_detection(path, home_dir) {
                continue;
            }
            let Some(root) = git_root_for_path(path) else {
                continue;
            };
            *scores.entry(root).or_insert(0) += total_weight;
        }
    }

    best_scored_repo(scores)
}

#[cfg(target_os = "macos")]
fn detect_repo_from_process_cwd() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    git_root_for_path(&cwd)
}

#[cfg(target_os = "macos")]
fn detect_repo_from_frontmost_process() -> Option<OpenRepoEventPayload> {
    let frontmost = get_frontmost_process();
    let mut scores: HashMap<PathBuf, i32> = HashMap::new();
    let home_dir = dirs::home_dir();
    let source_app = frontmost.as_ref().map(|(name, _)| name.clone());

    if let Some((_, pid)) = frontmost {
        let mut pids = vec![pid];
        pids.extend(collect_descendant_pids(pid, 280));

        let cwd_by_pid = lsof_paths_for_pids(&pids, "cwd");
        for (owner_pid, paths) in cwd_by_pid {
            let weight = if owner_pid == pid { 24 } else { 14 };
            for path in paths {
                if !path_allowed_for_detection(&path, home_dir.as_ref()) {
                    continue;
                }
                if let Some(root) = git_root_for_path(&path) {
                    *scores.entry(root).or_insert(0) += weight;
                }
            }
        }

        let file_by_pid = lsof_paths_for_pids(&pids, "0-256");
        for (owner_pid, paths) in file_by_pid {
            let weight = if owner_pid == pid { 2 } else { 1 };
            for path in paths {
                if !path_allowed_for_detection(&path, home_dir.as_ref()) {
                    continue;
                }
                if let Some(root) = git_root_for_path(&path) {
                    *scores.entry(root).or_insert(0) += weight;
                }
            }
        }
    }

    if let Some(terminal_repo) = detect_repo_from_terminal_sessions(home_dir.as_ref()) {
        *scores.entry(terminal_repo).or_insert(0) += 80;
    }
    if let Some(storage_repo) = detect_repo_from_editor_storage(home_dir.as_ref()) {
        *scores.entry(storage_repo).or_insert(0) += 55;
    }

    let best = best_scored_repo(scores)
        .or_else(|| detect_repo_from_active_dev_processes(home_dir.as_ref()))
        .or_else(detect_repo_from_process_cwd)?;

    Some(OpenRepoEventPayload {
        path: best.to_string_lossy().to_string(),
        source_app,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "check_for_updates" => {
                    let _ = app.emit("cobble://check-for-updates", ());
                }
                "report_bug" => {
                    let _ = app.emit("cobble://report-bug", ());
                }
                _ => {}
            }
        });
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos_traffic_lights::init_plugin());

    builder
        .on_window_event(|_, event| match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                schedule_stop_all_preview_processes();
            }
            _ => {}
        })
        .setup(|app| {
            terminal_ai_titles::start_terminal_ai_title_loop();
            if let Some(menu) = app.menu() {
                if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) =
                    menu.items()?.into_iter().next()
                {
                    let check_for_updates = tauri::menu::MenuItem::with_id(
                        app,
                        "check_for_updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?;
                    app_menu.insert(&check_for_updates, 1)?;
                    let report_bug = tauri::menu::MenuItem::with_id(
                        app,
                        "report_bug",
                        "Report a Bug…",
                        true,
                        None::<&str>,
                    )?;
                    app_menu.insert(&report_bug, 2)?;
                }
            }
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                if let Some(window) = app.get_webview_window("main") {
                    #[cfg(not(any(target_os = "android", target_os = "ios")))]
                    let _ = window.restore_state(StateFlags::all());
                    macos_traffic_lights::install(&window);
                    let _ = window.show();
                }
                let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyM);
                app.global_shortcut()
                    .on_shortcut(shortcut, move |app_handle, _shortcut, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }

                        if let Some(cached) = take_cached_open_repo_detection() {
                            emit_or_queue_open_repo(app_handle, cached);
                            return;
                        }

                        if OPEN_REPO_DETECTION_IN_FLIGHT.swap(true, Ordering::AcqRel) {
                            return;
                        }

                        let app_handle = app_handle.clone();
                        std::thread::spawn(move || {
                            let detected = detect_open_repo_cached();
                            OPEN_REPO_DETECTION_IN_FLIGHT.store(false, Ordering::Release);
                            if let Some(payload) = detected {
                                emit_or_queue_open_repo(&app_handle, payload);
                            }
                        });
                    })
                    .map_err(|e| format!("Failed to register Option+M: {e}"))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_main_window_opacity,
            start_window_drag,
            set_window_resizable,
            get_branches,
            get_repo_visual_snapshot,
            add_project_and_ingest,
            load_project_snapshot,
            delete_project_cache,
            check_project_fingerprint,
            ack_project_fingerprint,
            refresh_project_if_changed,
            persist_project_snapshot,
            get_repo_layout_snapshot,
            store_repo_layout_snapshot,
            get_repo_node_positions,
            store_repo_node_positions,
            clear_repo_node_positions,
            get_repo_quick_state,
            get_repo_dirty_state,
            get_repo_head_state,
            get_repo_sync_tokens,
            get_repo_change_signal,
            get_repo_graph_delta,
            get_repo_refresh_fingerprint,
            sync_remote_repository,
            fetch_repo_remotes,
            get_branch_head_sha,
            get_commit_parent_sha,
            get_remote_branch_head_sha,
            get_commit_subject,
            get_commit_metadata,
            get_merge_base,
            get_merge_nodes,
            get_default_branch,
            get_checked_out_ref,
            list_worktrees,
            remove_worktree,
            add_worktree,
            prepare_preview_target,
            preview_dependencies_need_install,
            save_terminal_attachment,
            list_terminal_sessions,
            create_terminal_session,
            read_terminal_session,
            write_terminal_session,
            resize_terminal_session,
            set_terminal_session_label,
            set_terminal_session_target,
            restart_terminal_session,
            terminate_terminal_session,
            activate_preview_target,
            detect_project_preview_defaults,
            start_project_preview,
            get_project_preview_status,
            get_project_preview_log_tail,
            get_active_project_preview_target,
            get_active_project_preview_targets,
            stop_project_preview,
            checkout_ref,
            checkout_branch,
            list_stashes,
            stash_push,
            commit_working_tree,
            get_working_tree_summary,
            generate_commit_message,
            generate_stash_message,
            create_generated_branch,
            stage_working_tree,
            apply_stash_restore,
            stash_drop,
            create_branch_from_uncommitted,
            move_stash_to_new_branch,
            create_root_branch,
            overhaul_create_branch,
            push_branch,
            push_current_branch,
            push_all_unpushed_branches,
            pull_branch_with_strategy,
            delete_selected_elements,
            remove_worktree_and_empty_branch,
            merge_branches,
            merge_ref_into_branch,
            squash_commit_range,
            get_repo_info,
            get_github_info,
            get_github_auth_status,
            authenticate_github,
            get_merged_prs,
            get_open_prs,
            get_pr_commits,
            list_directory,
            search_directories,
            get_home_dir,
            get_branch_diff,
            get_branch_commits,
            get_commit_diff,
            get_direct_commits,
            get_all_repo_commits,
            get_anthropic_key,
            summarize_diff,
            screenshot,
            get_recent_log,
            get_unpushed_direct_commits,
            get_branch_unpushed_commit_shas,
            generate_preview,
            generate_preview_routes,
            open_preview_browser,
            get_changed_routes,
            get_changed_routes_for_commit,
            debug_diff_files,
            take_pending_open_repo,
            reveal_in_finder,
            watch_repo,
            unwatch_repo,
            get_repo_watcher_epochs,
            check_network_available,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                schedule_stop_all_preview_processes();
            }
        });
}

#[tauri::command]
fn set_main_window_opacity(app: tauri::AppHandle, alpha: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        return macos_traffic_lights::set_window_opacity(&window, alpha);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, alpha);
        Ok(())
    }
}

static PENDING_OPEN_REPO: OnceLock<Mutex<Option<OpenRepoEventPayload>>> = OnceLock::new();

fn pending_open_repo() -> &'static Mutex<Option<OpenRepoEventPayload>> {
    PENDING_OPEN_REPO.get_or_init(|| Mutex::new(None))
}

fn consume_pending_open_repo() -> Option<OpenRepoEventPayload> {
    pending_open_repo().lock().ok()?.take()
}

#[tauri::command]
fn take_pending_open_repo() -> Option<OpenRepoEventPayload> {
    consume_pending_open_repo()
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod preview_log_tests {
    use super::{compact_preview_log_if_needed, read_bounded_log_tail};
    use std::{
        fs,
        io::{Seek, SeekFrom, Write},
    };

    fn temp_log(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gv-preview-log-{name}-{}-{}.log",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn bounded_log_tail_returns_small_log_unchanged() {
        let path = temp_log("small");
        fs::write(&path, "one\ntwo\nthree\n").expect("write log");
        assert_eq!(
            read_bounded_log_tail(&path, 64 * 1024, 200),
            "one\ntwo\nthree"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bounded_log_tail_caps_huge_log() {
        let path = temp_log("huge");
        let mut file = fs::File::create(&path).expect("create log");
        for index in 0..10_000 {
            writeln!(file, "line-{index:05}").expect("write line");
        }
        let tail = read_bounded_log_tail(&path, 64 * 1024, 200);
        assert!(tail.len() <= 64 * 1024);
        assert!(tail.lines().count() <= 200);
        assert!(tail.contains("line-09999"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bounded_log_tail_caps_huge_single_line() {
        let path = temp_log("single-line");
        fs::write(&path, vec![b'x'; 2 * 1024 * 1024]).expect("write log");
        let tail = read_bounded_log_tail(&path, 64 * 1024, 200);
        assert!(tail.len() <= 64 * 1024);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bounded_log_tail_tolerates_invalid_utf8() {
        let path = temp_log("invalid-utf8");
        fs::write(&path, [0xff, b'\n', b'o', b'k']).expect("write log");
        let tail = read_bounded_log_tail(&path, 64 * 1024, 200);
        assert!(tail.contains("ok"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bounded_log_tail_missing_file_is_empty() {
        let path = temp_log("missing");
        assert_eq!(read_bounded_log_tail(&path, 64 * 1024, 200), "");
    }

    #[test]
    fn compact_preview_log_keeps_recent_output() {
        let path = temp_log("compact");
        let mut file = fs::File::create(&path).expect("create log");
        file.seek(SeekFrom::Start(3 * 1024 * 1024)).expect("seek");
        writeln!(file, "recent-line").expect("write line");
        drop(file);
        compact_preview_log_if_needed(&path);
        let metadata = fs::metadata(&path).expect("metadata");
        assert!(metadata.len() <= 1024 * 1024 + 128);
        assert!(read_bounded_log_tail(&path, 64 * 1024, 200).contains("recent-line"));
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod snapshot_remote_branch_tests {
    use super::compute_repo_visual_snapshot;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn run_git(repo: &PathBuf, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn repo_sync_tokens_split_dirty_and_graph_changes() {
        let repo = std::env::temp_dir().join(format!("gv-token-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&repo);
        fs::create_dir_all(&repo).expect("create repo");
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test User"]);
        fs::write(repo.join("file.txt"), "one\n").expect("write initial file");
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let repo_path = repo.to_string_lossy().to_string();
        let clean = tauri::async_runtime::block_on(super::get_repo_sync_tokens(repo_path.clone()))
            .expect("clean tokens");
        fs::write(repo.join("file.txt"), "two\n").expect("dirty file");
        let dirty = tauri::async_runtime::block_on(super::get_repo_sync_tokens(repo_path.clone()))
            .expect("dirty tokens");
        assert_ne!(clean.dirty_token, dirty.dirty_token);
        assert_eq!(clean.graph_token, dirty.graph_token);

        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "change"]);
        let committed = tauri::async_runtime::block_on(super::get_repo_sync_tokens(repo_path))
            .expect("committed tokens");
        assert_ne!(dirty.graph_token, committed.graph_token);

        let _ = fs::remove_dir_all(&repo);
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    #[test]
    fn snapshot_includes_remote_cursor_branch_commit() {
        let repo = repo_root();
        let _ = crate::git::fetch_remotes(&repo);
        let branch_name = "cursor/commit-app-previews-7896";
        if crate::git::cli::run(
            &repo,
            &["rev-parse", "--verify", &format!("origin/{branch_name}")],
        )
        .is_err()
        {
            return;
        }

        let _ = crate::git::fetch_remotes(&repo);
        let snapshot = compute_repo_visual_snapshot(repo.to_string_lossy().as_ref())
            .expect("repo visual snapshot");
        let branch_name = "cursor/commit-app-previews-7896";
        let branch = snapshot
            .branches
            .iter()
            .find(|branch| branch.name == branch_name)
            .unwrap_or_else(|| {
                panic!(
                    "missing remote branch {branch_name} in {:?}",
                    snapshot
                        .branches
                        .iter()
                        .map(|b| &b.name)
                        .collect::<Vec<_>>()
                )
            });
        assert!(
            branch.commits_ahead >= 1,
            "expected commits_ahead >= 1, got {}",
            branch.commits_ahead
        );

        let expected_sha = crate::git::cli::run(
            &repo,
            &["rev-parse", "origin/cursor/commit-app-previews-7896"],
        )
        .expect("rev-parse origin head")
        .trim()
        .to_string();

        let remote_commit = snapshot
            .direct_commits
            .iter()
            .find(|commit| commit.branch == branch_name && commit.is_remote);
        assert!(
            remote_commit.is_some(),
            "missing remote commit on {branch_name}"
        );
        assert_eq!(
            remote_commit.unwrap().full_sha,
            expected_sha,
            "unexpected remote tip"
        );

        let previews = snapshot
            .branch_commit_previews
            .get(branch_name)
            .cloned()
            .unwrap_or_default();
        assert!(
            previews
                .iter()
                .any(|preview| preview.full_sha == expected_sha && preview.is_remote),
            "missing remote preview for {branch_name}"
        );
        assert!(
            snapshot
                .branch_unique_ahead_counts
                .get(branch_name)
                .copied()
                .unwrap_or(0)
                >= 1
        );
    }

    #[test]
    fn test_deleted_remote_branches_db_roundtrip() {
        let repo_path = "/path/to/test/repo".to_string();
        let normalized = super::normalize_repo_path_id(&repo_path);
        let branch_name = "test-branch-name";
        let remote_ref = "refs/remotes/origin/test-branch-name";
        let sha = "1234567890abcdef1234567890abcdef12345678";
        let now = chrono::Utc::now().timestamp_millis();

        let conn = super::open_visual_cache_connection().unwrap();
        // Insert
        let insert_res = conn.execute(
            "INSERT OR REPLACE INTO deleted_remote_branches (repo_path, branch_name, remote_ref, sha, deleted_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![normalized, branch_name, remote_ref, sha, now],
        );
        assert!(insert_res.is_ok());

        // Select and verify
        let mut stmt = conn.prepare("SELECT branch_name, remote_ref, sha FROM deleted_remote_branches WHERE repo_path = ?1").unwrap();
        let mut rows = stmt
            .query_map(rusqlite::params![normalized], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap();

        let first = rows.next().unwrap().unwrap();
        assert_eq!(first.0, branch_name);
        assert_eq!(first.1, remote_ref);
        assert_eq!(first.2, sha);

        // Cleanup
        let delete_res = conn.execute(
            "DELETE FROM deleted_remote_branches WHERE repo_path = ?1 AND remote_ref = ?2",
            rusqlite::params![normalized, remote_ref],
        );
        assert!(delete_res.is_ok());
    }
}
