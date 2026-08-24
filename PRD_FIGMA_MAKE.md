# Git Visualizer — Product Requirements Document (PRD)

## 1) Product Summary

Git Visualizer is an interactive desktop-first Git graph explorer that turns a repository into a manipulable branch-and-commit map.  
The core value is not just visualization; it is **graph-native Git operations** (checkout, merge, push, stash, branch creation, delete, and worktree switching) performed directly from nodes and branch lanes.

This PRD is designed for Figma Make prompt ingestion and for rebuilding the product conceptually.

---

## 2) Problem Statement

Developers struggle to reason about:
- stacked branches and their real parentage
- merged vs fresh-copy branches
- local-only state (uncommitted changes, stashes, unpushed commits)
- multi-worktree realities where a branch is checked out elsewhere
- dense timelines where many commits overlap visually

Existing tools either:
- emphasize raw git logs (accurate but cognitively heavy), or
- simplify too aggressively (pretty but operationally weak).

Git Visualizer solves this by combining:
- accurate graph semantics
- density management via clumping
- direct manipulation workflows
- real-time repo refresh

---

## 3) Goals and Non-Goals

### Goals
- Render branch and commit history with stable, comprehensible layout.
- Support high-density histories with clumping/expand transitions.
- Visualize synthetic local states (working tree + stash) as first-class nodes.
- Let users run critical git operations from the map.
- Keep branch semantics accurate across parent-branch ambiguity and merges.
- Handle multi-worktree scenarios safely and visibly.

### Non-Goals
- Full code review UI.
- Full remote issue/PR management suite.
- Replacement for terminal-level advanced conflict resolution UX.

---

## 4) Primary Users

- Individual developers managing stacked feature branches.
- Teams using many short-lived branches and frequent rebases/merges.
- Power users working with multiple linked worktrees.

---

## 5) Platform and Architecture

### Frontend
- React + TypeScript (Vite)
- SVG custom canvas renderer (not React Flow)
- Framer Motion for overlays/transitions

### Desktop Runtime
- Tauri shell with Rust commands exposed via `invoke()`

### Data Sources
- Local Git commands via Tauri backend
- Optional GitHub metadata via `gh`/GitHub API integration

---

## 6) Information Model (Core Entities)

- **Branch**
  - name, head sha, ahead/behind, status (fresh/stale), parent metadata, remote sync status
- **DirectCommit**
  - mainline commit objects (default branch lane), includes synthetic local markers
- **BranchCommitPreview**
  - per-branch unique commit previews, includes synthetic kinds (`uncommitted`, `stash`, `branch-created`)
- **MergeNode**
  - merge commits and their parents; used for merge-back paths and merged-branch detection
- **CheckedOutRef**
  - current branch/head + dirty status
- **WorktreeInfo**
  - worktree paths, branch ownership, path validity, current-ness
- **GitStashEntry**
  - stash index + base SHA + message

---

## 7) Core UX Flows

1. Open repo (picker or typed path)
2. Graph loads incrementally:
   - branch list + direct commits + checked-out ref first
   - merge nodes and richer metadata after first paint
3. User interacts with nodes:
   - click commit/branch to checkout
   - multi-select via shift/cmd + marquee
   - merge selected refs into target branch
   - push selected ranges or entire branch sets
   - drag local synthetic nodes to create/move branch context
4. Graph auto-refreshes from file/git activity events and polling monitor

---

## 8) Branching Logic (Authoritative Rules)

### Parent Branch Resolution
- Use declared `parentBranch` if valid.
- Fallback to default branch when parent is absent/self.
- If declared parent does not contain fork SHA/date match, attempt resolution on default branch before falling back to parent tip.

### Fresh-Copy Branch Detection
Branch is treated as fresh copy (not true merged history) when:
- multiple branches share identical HEAD SHA; all but oldest become fresh copies, and/or
- `commitsAhead == 0` with no merge-node evidence and no children.

### Merged Branch Detection
- `commitsAhead == 0` and not fresh-copy can be merged candidate.
- Merge node mapping by merged-head parent SHA confirms merge-back behavior.

### Unique Ahead Count Source of Truth
- Prefer computed `branchUniqueAheadCounts[branchName]`.
- Fallback to branch `commitsAhead` when explicit unique count unavailable.

---

## 9) Node Logic (Real + Synthetic)

### Real Nodes
- Default branch (main lane) uses `DirectCommit` lineage.
- Branch lanes use renderable preview commits:
  - concrete commits only (exclude `branch-created` placeholders)
  - clipped to unique-ahead window

### Synthetic Nodes

#### Working Tree Node (`WORKING_TREE`)
- Created when `checkedOutRef.hasUncommittedChanges`.
- Anchored using lane-tip ownership rules:
  - if checked out on default tip -> append to direct main lane
  - if checked out on branch tip -> prepend to that branch preview and increment ahead counters
  - otherwise create synthetic branch `*Uncommitted`

#### Stash Nodes (`STASH:<index>`)
- Folded into graph in index order (newest-to-oldest handling preserved by staged fold pass).
- Uses same lane-tip placement strategy as uncommitted node:
  - default tip -> direct lane synthetic marker
  - branch tip -> inject into branch previews and adjust branch ahead count
  - else synthetic branch `*Stash:<index>`

### Worktree-Aware Checkout Behavior
- Clicking a branch commit that is checked out in another worktree switches app target to that worktree path instead of force-checkout in current path.

---

## 10) Clumping / Density Management Logic

This is the key system for map readability at scale.

### Why Clumping Exists
- Dense histories can contain many sequential nodes with low explanatory value when fully expanded.
- Clumping collapses adjacent commit markers into summarized boxes while preserving chronology and branch semantics.

### Clump Construction Rules
- Clumping never crosses lanes.
- Split boundaries are derived from:
  - child-fork points (critical)
  - uncommitted synthetic markers (isolated as singleton)
  - merge boundaries / lineage breaks on main
  - forced visibility constraints (checked-out/latest commits)

### Fork-Safe Segmentation
- `clusterByForkPoints()` splits after fork indices so fork commits remain with left segment.
- `pruneForkSplitIndices()` removes split points that would create singleton garbage clumps, except protected splits that must preserve semantic boundaries.

### Mainline Clump Splits
- Split on parent-sha discontinuities.
- Split around merge events with nuanced behavior:
  - merge joins newer work clump
  - avoid splitting merge-at-head incorrectly
- Force split around important visible SHAs (e.g., checked-out or latest) to avoid hiding key state.

### Clump Rendering States
- collapsed / expanding / expanded / collapsing
- member rows can remain reserved during transition to prevent branch path jumpiness.

### Clump Anchor and Motion
- Each clump has animated anchor state (current + target position).
- Each member has anchor state for smooth expand/collapse interpolation.
- Branch connector geometry is animated in sync with clump transitions.

### Synthetic Clump Styling
- collapsed clump stroke becomes:
  - blue if any uncommitted node inside
  - yellow if stash-only
  - neutral otherwise

### Count Labels
- Collapsed clumps show count labels, capped by max display threshold.

---

## 11) Lane / Grid / Row Allocation Logic

## Timeline Mapping
- Build chronological anchors from merge/direct/branch events.
- Convert timestamp to nearest prior anchor row (fallback to nearest future if needed).
- Keep chronology monotonic.

## Branch Column Allocation
- Branches claim columns lazily.
- Prefer parent+1 column when parent visible.
- Column reuse only allowed when branch time intervals do not overlap (with separation tolerance factor).

## Grid Row Allocation for Clumps
- Rows are claimed with lane-aware sharing policy:
  - allow share when temporal proximity and lane constraints permit
  - reserve exclusive rows for strict cases
- Parent-child floor constraints:
  - child clumps are shifted to avoid appearing below impossible fork rows
  - synthetic branches apply gentler displacement rules

## Row Densification
- After placement, remove unused phantom rows.
- Preserve row stability during active clump transitions; densify when stable.

---

## 12) Branch Path and Merge Path Geometry

### Branch Path
- Orthogonal route:
  - start at parent/fork X
  - horizontal move to lane X
  - rounded corner
  - vertical move to branch tip

### Merge-Back Path
- Orthogonal route from lane tip to merge node:
  - vertical then horizontal (rounded turn)
- Forced merge junction placement guarantees merge marker appears after branch tip in time order.

---

## 13) Interaction Model

### Selection
- Single click selects commit/branch target.
- Shift/Cmd modifies selection sets.
- Marquee drag supports additive selection.

### Drag Interactions
- Drag `WORKING_TREE` or `STASH:*` node to:
  - create new branch from node
  - move back to branch sharing HEAD context

### Git Operations from UI
- checkout commit/branch
- merge selected refs into branch
- push all / current / selected ranges
- stash local changes
- commit/stage local changes
- delete selected branches/stashes + optional discard uncommitted
- remove worktree
- switch to worktree

---

## 14) Refresh and Data Loading Strategy

### Initial Load
- fast metadata first, map shell visible immediately
- graph core data next
- GitHub optional enrichment non-blocking

### Continuous Sync
- file watcher triggers `git-activity` events
- debounced refresh bursts for heavy updates
- lightweight checked-out ref monitor at interval
- signature diffing prevents redundant state churn

---

## 15) UI Composition

- **Landing View**: repo selection + recent repos
- **Map View**: full-screen SVG graph + floating controls/panels
- **Alternate Group Views**:
  - by status
  - by creator

Key overlays:
- feedback pill (success/error action results)
- branch errors panel (active/inactive stale split)
- action menus (git/worktree)

---

## 16) Visual Language (Implementation Intent)

- BossUI minimal depth language
- Tokenized theming for app surfaces
- SVG geometry colors for lane/node semantics
- Distinct semantic strokes:
  - checked-out (primary blue)
  - user-selected (separate blue)
  - stash (yellow)
  - other-worktree checkout (teal)
  - unpushed/local neutral variants

---

## 17) Rebuild Blueprint (How to Recreate)

## Step 1: Foundation
- Build React + TypeScript + Vite app.
- Integrate Tauri command bridge.
- Define shared graph types (`Branch`, `DirectCommit`, `MergeNode`, `CheckedOutRef`, `WorktreeInfo`, stash models).

## Step 2: Data Adapters
- Implement async loaders:
  - branches
  - merge nodes (paginated)
  - direct commits + unpushed direct commits
  - per-branch unpushed SHAs
  - checked-out ref, worktrees, stashes
- Add optional GitHub auth + open PR fetch.

## Step 3: Graph Preprocessing
- Build derived branch metadata:
  - parent resolution
  - fresh-copy detection
  - merged-branch detection
  - unique ahead counts
- Fold synthetic nodes:
  - stash fold pass
  - working tree injection

## Step 4: Timeline + Lane Engine
- Construct timeline anchors (time -> row).
- Allocate branch columns with interval conflict rules.
- Assign clump rows with share/exclusive behavior and parent floor constraints.
- Densify rows after layout settles.

## Step 5: Clump Engine
- Segment entries by fork/synthetic/merge split points.
- Prune bad singleton splits while preserving protected boundaries.
- Maintain expanded/collapsed clump state machine.
- Animate clump anchors and branch line geometry.

## Step 6: Renderer
- Render SVG layers:
  - main lane, branch lanes, merge connectors
  - commit nodes/clumps
  - labels and tooltips
  - hit areas for interaction
- Add orientation projection (vertical/horizontal via axis transform).

## Step 7: Interaction Layer
- selection + marquee
- click-to-checkout
- drag-to-branch for synthetic nodes
- context menus for merge/push/delete/worktree actions

## Step 8: Runtime Sync
- attach filesystem/git activity listeners
- maintain lightweight polling for checked-out state
- debounce and burst-refresh heavy graph reads

## Step 9: Quality Gates
- test scenarios:
  - stacked branches with shared parents
  - fresh-copy branches
  - merged branches with merge nodes
  - uncommitted + stash combinations
  - multi-worktree checked-out conflicts
  - dense histories to validate clump stability

---

## 18) Functional Requirements Checklist (Figma Make Friendly)

- [ ] Full-screen interactive graph canvas
- [ ] Branch lanes + merge paths + default branch spine
- [ ] Commit node rendering with clumps and count labels
- [ ] Synthetic `WORKING_TREE` and `STASH:*` nodes
- [ ] Branch parent/fork correctness handling with fallbacks
- [ ] Fresh-copy branch detection and special treatment
- [ ] Multi-worktree aware checkout behavior
- [ ] Selection (single, multi, marquee)
- [ ] Drag actions for synthetic nodes
- [ ] Merge/push/delete/stash/commit/stage/worktree actions
- [ ] Real-time graph updates from git activity
- [ ] Error/state feedback overlays
- [ ] Orientation toggle (vertical/horizontal)

---

## 19) Prompt Snippet for Figma Make

Design a desktop Git visualization app called "Git Visualizer" with a full-screen SVG branch map.  
It must show a main lane plus branch lanes, merge-back connectors, and commit nodes that can collapse into clumps with numeric labels.  
Include synthetic nodes for uncommitted changes (`WORKING_TREE`, blue semantics) and stash entries (`STASH:n`, yellow semantics).  
Implement lane assignment based on branch parentage, fork points, and column reuse with temporal conflict checks.  
Implement clumping that never crosses lanes, splits at fork points, isolates uncommitted markers, and avoids bad singleton clumps while preserving fork integrity.  
Provide interactions: click to checkout, shift/cmd multi-select, marquee selection, drag synthetic nodes to create/move branch context, merge selected refs into branch, push current/all/selected ranges, delete selected branches/stashes, and worktree switch/remove actions.  
Support real-time refresh from repository activity, plus smooth clump expand/collapse and connector animations.  
Use minimal modern UI with floating controls, feedback pills, and side overlays.

