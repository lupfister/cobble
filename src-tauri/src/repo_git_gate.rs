use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

// Full graph loads can consume substantial CPU and memory. A small global cap
// keeps background ingests from saturating the machine.
const MAX_CONCURRENT_GIT_OPS: usize = 2;
const PROBE_CACHE_TTL: Duration = Duration::from_millis(1500);

struct ProbeCacheEntry {
    probe: super::RepoChangeProbe,
    fetched_at: Instant,
}

static GIT_PERMITS: OnceLock<Arc<(Mutex<usize>, Condvar)>> = OnceLock::new();
static REPO_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static PROBE_CACHE: OnceLock<Mutex<HashMap<String, ProbeCacheEntry>>> = OnceLock::new();

fn git_permits() -> Arc<(Mutex<usize>, Condvar)> {
    GIT_PERMITS
        .get_or_init(|| Arc::new((Mutex::new(MAX_CONCURRENT_GIT_OPS), Condvar::new())))
        .clone()
}

fn repo_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_cache() -> &'static Mutex<HashMap<String, ProbeCacheEntry>> {
    PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn normalize_repo_gate_key(repo_path: &str) -> String {
    repo_path.trim_end_matches('/').to_lowercase()
}

pub fn with_git_work_permit<T, F>(f: F) -> T
where
    F: FnOnce() -> T,
{
    let permits = git_permits();
    let (mutex, cvar) = &*permits;
    let mut available = mutex.lock().expect("git permit mutex poisoned");
    while *available == 0 {
        available = cvar.wait(available).expect("git permit condvar poisoned");
    }
    *available -= 1;
    drop(available);

    let result = f();

    let mut available = mutex.lock().expect("git permit mutex poisoned");
    *available += 1;
    cvar.notify_one();
    result
}

pub fn with_repo_git_lock<T, F>(repo_path: &str, f: F) -> T
where
    F: FnOnce() -> T,
{
    let key = normalize_repo_gate_key(repo_path);
    let lock = {
        let mut locks = repo_locks().lock().expect("repo locks mutex poisoned");
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().expect("repo git lock poisoned");
    with_git_work_permit(f)
}

pub fn cached_probe(repo_path: &str) -> Option<super::RepoChangeProbe> {
    let key = normalize_repo_gate_key(repo_path);
    let cache = probe_cache().lock().expect("probe cache mutex poisoned");
    let entry = cache.get(&key)?;
    if entry.fetched_at.elapsed() > PROBE_CACHE_TTL {
        return None;
    }
    Some(entry.probe.clone())
}

pub fn store_probe(repo_path: &str, probe: &super::RepoChangeProbe) {
    let key = normalize_repo_gate_key(repo_path);
    let mut cache = probe_cache().lock().expect("probe cache mutex poisoned");
    cache.insert(
        key,
        ProbeCacheEntry {
            probe: probe.clone(),
            fetched_at: Instant::now(),
        },
    );
}

pub fn invalidate_probe_signature(repo_path: &str) {
    let key = normalize_repo_gate_key(repo_path);
    let mut cache = probe_cache().lock().expect("probe cache mutex poisoned");
    cache.remove(&key);
}
