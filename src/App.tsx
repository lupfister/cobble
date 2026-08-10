import { useState, useEffect, useRef, useMemo, useCallback, startTransition, useDeferredValue } from 'react';
import { flushSync } from 'react-dom';
import type { SetStateAction } from 'react';
import { invoke } from './timedInvoke';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import BranchGridMapView from '../components/grid/MapViewGrid';
import MapGridLoadingTiles from '../components/grid/MapGridLoadingTiles';
import TerminalPanel, { type TerminalPanelPlacement } from '../components/TerminalPanel';
import CobblePlusIcon from '../components/CobblePlusIcon';
import { mapGridCameraStorageKey, readHasSavedMapGridCamera } from '../components/grid/useMapGridCamera';
import DenseBranchSidebar from '../components/DenseBranchSidebar';
import type { Node, NodePositionOverrides } from '../components/grid/LayoutGrid';
import {
  assignNodePositionOverride,
  getNodePositionOverride,
  isWorktreePositionOverrideKeyFor,
  laneBranchNamesForPositionOverrides,
} from '../components/grid/nodePositionOverrides';
import type { BranchGridLayoutModel } from '../components/grid/branchGridLayoutModel';
import { hydrateBranchGridLayoutModel, serializeBranchGridLayoutModel } from '../components/grid/layoutSnapshot';
import { buildGraphLayoutFingerprint, hashCommitShaList } from '../components/grid/graphLayoutFingerprint';
import {
  useBranchGridLayoutFromRevision,
  type BranchGridLayoutStatus,
} from '../components/grid/useBranchGridLayoutFromRevision';
import { layoutModelHasWorkingTree } from '../components/grid/workingTreeLayout';
import type { Branch, BranchCommitPreview, BranchPromptMeta, CheckedOutRef, CommitMutationData, DeleteSelectionMutationData, DirectCommit, GitHubAuthStatus, GitHubInfo, GitStashEntry, MergeNode, OpenPR, RepoMutationOutcome, RepoVisualSnapshot, StashPushMutationData, StashRestoreMutationData, TerminalSession, WorktreeInfo, RepoQuickState } from '../types';
import {
  mergeCheckedOutRefWithQuickState,
  mergeSnapshotCheckedOutRefWithQuickState,
  snapshotContainsCommitSha,
  type MergeCheckedOutRefOptions,
} from './reconcileCheckedOutHead';
import { visibleWorktrees } from '../lib/worktreePaths';
import {
  applyMutationPatch,
  outcomeFromCheckout,
  outcomeFromCommitData,
  outcomeFromDeleteSelection,
  outcomeFromDiscardDirty,
  outcomeFromMarkDirty,
  outcomeFromPush,
  outcomeFromStashDrops,
  outcomeFromStashPush,
  outcomeFromStashRestore,
  outcomeFromUpstreamSync,
  outcomeFromWorktreeRemove,
  outcomeFromWorktreeSync,
} from './repoMutationPatches';
import { isNetworkAvailable } from './isNetworkAvailable';
import { syncRemoteRepo } from './remoteRepoSync';
import {
  formatWorktreeLayoutSignature,
  formatWorktreeSyncSignature,
  formatWorktreeSessionLayoutSignature,
} from './worktreeSignature';
import { canApplyActiveRepoSnapshot } from './activeRepoGuard';
import {
  shouldBlockIncomingSnapshotApply as shouldBlockIncomingSnapshotApplyGuard,
} from './postCommitSnapshotGuard';
import { consumeReloadSyncRequest } from './reloadIntercept';
import {
  applyBranchParents,
  isNewerBranchAsParent,
  isParallelEmptyBranchParent,
} from '../lib/branchParents';
import { foldStashNodesIntoGraph } from './placeStashNode';
import { stripWorkingTreeFromPreviews, injectWorktreeUncommittedPreviews } from '../lib/injectWorktreeUncommitted';
import {
  buildWorktreeSessions,
  isWorkingTreeCommitId,
  persistWorktreeFocusSha,
  resolveActiveWorktreeFocusSha,
  resolveTerminalSessionFocusId,
  shaMatches,
  workingTreeIdForPath,
  worktreeStableKey,
  determineWorktreePromptDefaults,
} from '../lib/worktreeSessions';
import { deriveRepoVisualState } from './repoVisualState';
import { setMapGridBackgroundActivity } from '../components/grid/mapGridBackgroundActivity';
import { useWorktreeDraftMessages } from './useWorktreeDraftMessages';
import { createRepoSyncScheduler } from './repoSyncScheduler';
import {
  repoSyncGraphHead,
  repoSyncTokenChanged,
  summarizeRepoSyncToken,
  type RepoSyncTokens,
} from './repoSyncTokens';
import {
  detectProjectPreviewDefaults,
  previewDependenciesNeedInstall,
  preparePreviewTarget,
  type PreviewTarget,
  type ProjectPreviewConfig,
} from '../lib/git';
import {
  createTerminalSession,
  isNativePreviewCommand,
  listTerminalSessions,
  activatePreviewTarget,
  restartTerminalSession,
  setTerminalSessionTarget,
  terminateTerminalSession,
  readTerminalSession,
  terminalSessionMetadataEqual,
} from '../lib/terminal';

const PROJECTS_STORAGE_KEY = 'cobble:projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'cobble:active-project';
const MAX_PROJECTS = 12;
type OpenRepoEventPayload = {
  path: string;
  sourceApp?: string | null;
};
type GitActivityEventPayload = {
  repoPath: string;
  kind: 'graph' | 'local';
};
type ProjectLoadProgressEvent = {
  repoPath: string;
  status: 'loading' | 'ready' | 'error';
  phase: string;
  progress: number;
  error?: string | null;
};
type ProjectLoadState = Omit<ProjectLoadProgressEvent, 'repoPath'>;
const COMMIT_SWITCH_FEEDBACK_VISIBLE_MS = 1400;
const COMMIT_SWITCH_FEEDBACK_FADE_MS = 180;
const SIDEBAR_WIDTH_STORAGE_KEY = 'cobble:sidebar-width';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'cobble:sidebar-collapsed';
const TERMINAL_PANEL_PLACEMENT_STORAGE_KEY = 'cobble:terminal-panel-placement';
const GRID_CLUMPS_STORAGE_KEY = 'cobble:grid-clumps';
const NODE_POSITIONS_STORAGE_KEY_PREFIX = 'cobble:node-positions:v2:';
const SIDEBAR_DEFAULT_WIDTH_PX = 360;
const SIDEBAR_MIN_WIDTH_PX = 180;
const SIDEBAR_MAX_WIDTH_PX = 360;
const EMPTY_PROJECT_MIN_SIZE = { width: 320, height: 160 };
const ACTIVE_PROJECT_MIN_SIZE = { width: 960, height: 620 };
const WINDOW_OPACITY_FADE_MS = 120;
const WINDOW_OPACITY_FADE_STEPS = 8;
/** Wait this long after map pan/marquee ends before applying background git snapshot updates. */
const MAP_REPO_REFRESH_SETTLE_MS = 200;
/** Defer SQLite snapshot persist so git CPU work does not contend with map layout. */
const PERSIST_SNAPSHOT_DEFER_MS = 3000;
/** Keep optimistic post-commit HEAD on the map until background probes catch up. */
const POST_COMMIT_HEAD_PROTECT_MS = 8000;

function terminalSessionsEqual(left: readonly TerminalSession[], right: readonly TerminalSession[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const candidate = right[index];
    return candidate != null && terminalSessionMetadataEqual(session, candidate);
  });
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
const POST_COMMIT_RELEASE_MAX_ATTEMPTS = 15;
type PushTarget = {
  branchName: string;
  targetSha?: string;
};
type RepoScopedClumpState = Record<string, Set<string>>;
type MapPresentationState = 'loading' | 'ready' | 'error';
type RemoveWorktreeResult = { deletedBranch?: string | null };

type ProjectRecord = {
  path: string;
  name: string;
  lastOpenedAt: number;
  branchName?: string;
  previewConfig?: ProjectPreviewConfig;
  worktreeOrder?: string[];
  terminalOrderMap?: Record<string, string[]>;
};

type ProjectSnapshot = RepoVisualSnapshot;

type RepoHeadState = {
  repoPath: string;
  headSha: string;
  upstreamSha?: string | null;
};
type ProjectSnapshotRecord = {
  projectId: string;
  repoPath: string;
  snapshotVersion: number;
  fingerprint: string;
  schemaVersion: number;
  createdAtMs: number;
  payload: {
    repoVisualSnapshot: RepoVisualSnapshot;
  };
};
type RefreshProjectResult = {
  projectId: string;
  repoPath: string;
  updated: boolean;
  snapshot?: ProjectSnapshotRecord | null;
};
type FingerprintCheckResult = {
  projectId: string;
  repoPath: string;
  changed: boolean;
  currentFingerprint: string;
  storedFingerprint?: string | null;
};
type CommitMetadata = { subject: string; author: string };

function normalizePath(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/, '');
}

function sameRepoPath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase();
}

function projectLoadKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

function sortWorktrees(worktrees: WorktreeInfo[], order?: string[]): WorktreeInfo[] {
  const displayWorktrees = visibleWorktrees(worktrees);
  if (!order || order.length === 0) return displayWorktrees;
  const orderMap = new Map(order.map((path, idx) => [normalizePath(path).toLowerCase(), idx]));
  return [...displayWorktrees].sort((left, right) => {
    const leftPath = normalizePath(left.path).toLowerCase();
    const rightPath = normalizePath(right.path).toLowerCase();
    const leftIdx = orderMap.has(leftPath) ? orderMap.get(leftPath)! : Infinity;
    const rightIdx = orderMap.has(rightPath) ? orderMap.get(rightPath)! : Infinity;
    if (leftIdx !== rightIdx) {
      return leftIdx - rightIdx;
    }
    return leftPath.localeCompare(rightPath);
  });
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function basenameFromPath(path: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? '';
}

function setSignature(set: Set<string>): string {
  if (set.size === 0) return '__none__';
  return Array.from(set).sort().join(',');
}

function nodePositionsStorageKey(repoPath: string): string {
  return `${NODE_POSITIONS_STORAGE_KEY_PREFIX}${encodeURIComponent(normalizePath(repoPath))}`;
}

function easeInOutSine(t: number): number {
  return (1 - Math.cos(Math.PI * t)) / 2;
}

function makeLayoutCacheKey(
  path: string,
  _orientation: 'horizontal',
  manuallyOpenedClumps: Set<string>,
  manuallyClosedClumps: Set<string>,
  graphSignature = '',
  nodePositionOverrides: NodePositionOverrides = {},
): string {
  return [
    'layout-v11-branch-owner-fingerprint',
    path,
    'horizontal',
    setSignature(manuallyOpenedClumps),
    setSignature(manuallyClosedClumps),
    graphSignature,
    JSON.stringify(Object.entries(nodePositionOverrides).sort(([left], [right]) => left.localeCompare(right))),
  ].join('|');
}



function getRepoVisualSnapshotSignature(snapshot: RepoVisualSnapshot): string {
  return [
    snapshot.path,
    snapshot.name,
    snapshot.defaultBranch,
    snapshot.branches.map((branch) => [
      branch.name,
      branch.headSha,
      branch.commitsAhead,
      branch.commitsBehind,
      branch.unpushedCommits,
      branch.remoteSyncStatus,
      branch.status,
      branch.lastCommitDate,
    ].join(':')).join('|'),
    snapshot.mergeNodes.map((node) => [node.fullSha, node.targetBranch, node.targetCommitSha].join(':')).join('|'),
    snapshot.directCommits.map((commit) => `${commit.branch}:${commit.fullSha}`).join('|'),
    snapshot.unpushedDirectCommits.map((commit) => `${commit.branch}:${commit.fullSha}`).join('|'),
    snapshot.checkedOutRef
      ? [
          snapshot.checkedOutRef.branchName ?? '',
          snapshot.checkedOutRef.headSha,
          snapshot.checkedOutRef.parentSha ?? '',
          snapshot.checkedOutRef.hasUncommittedChanges ? '1' : '0',
        ].join(':')
      : '__none__',
    Object.entries(snapshot.unpushedCommitShasByBranch)
      .map(([branchName, shas]) => `${branchName}:${shas.join(',')}`)
      .join('|'),
    Object.entries(snapshot.branchCommitPreviews)
      .map(([branchName, previews]) => `${branchName}:${previews.map((preview) => preview.fullSha).join(',')}`)
      .join('|'),
    Object.entries(snapshot.branchParentByName).map(([branchName, parentName]) => `${branchName}:${parentName ?? ''}`).join('|'),
    Object.entries(snapshot.laneByBranch).map(([branchName, lane]) => `${branchName}:${lane}`).join('|'),
    Object.entries(snapshot.branchUniqueAheadCounts).map(([branchName, count]) => `${branchName}:${count}`).join('|'),
    formatWorktreeSyncSignature(snapshot.worktrees),
  ].join('@@');
}

function toRepoVisualSnapshot(record: ProjectSnapshotRecord | null | undefined): RepoVisualSnapshot | null {
  return record?.payload?.repoVisualSnapshot ?? null;
}

function parseNodePositionOverrides(payloadJson: string | null | undefined): NodePositionOverrides {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: NodePositionOverrides = {};
    for (const [nodeId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const point = value as { row?: unknown; column?: unknown; x?: unknown; y?: unknown };
      const row = typeof point.row === 'number' ? point.row : Number(point.row);
      const column = typeof point.column === 'number' ? point.column : Number(point.column);
      if (Number.isFinite(row) && Number.isFinite(column)) {
        next[nodeId] = { row, column };
        continue;
      }
      const x = typeof point.x === 'number' ? point.x : Number(point.x);
      const y = typeof point.y === 'number' ? point.y : Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      next[nodeId] = { x, y };
    }
    return next;
  } catch {
    return {};
  }
}

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoName, setRepoName] = useState<string>('');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectSnapshots, setProjectSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [projectTreeLoading, setProjectTreeLoading] = useState(false);
  const [projectLoadStates, setProjectLoadStates] = useState<Record<string, ProjectLoadState>>({});
  const [branches, setBranches] = useState<Branch[]>([]);
  const [mergeNodes, setMergeNodes] = useState<MergeNode[]>([]);
  const [directCommits, setDirectCommits] = useState<DirectCommit[]>([]);
  const [unpushedDirectCommits, setUnpushedDirectCommits] = useState<DirectCommit[]>([]);
  const [unpushedCommitShasByBranch, setUnpushedCommitShasByBranch] = useState<Record<string, string[]>>({});
  const [defaultBranch, setDefaultBranch] = useState<string>('main');
  const [checkedOutRef, setCheckedOutRef] = useState<CheckedOutRef | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [gridSearchQuery, setGridSearchQuery] = useState('');
  const [gridSearchJumpToken, setGridSearchJumpToken] = useState(0);
  const [gridSearchJumpDirection, setGridSearchJumpDirection] = useState<1 | -1>(1);
  const [manuallyOpenedGridClumpsByRepo, setManuallyOpenedGridClumpsByRepo] = useState<RepoScopedClumpState>({});
  const [manuallyClosedGridClumpsByRepo, setManuallyClosedGridClumpsByRepo] = useState<RepoScopedClumpState>({});
  const [gridSearchResultCount, setGridSearchResultCount] = useState<number | null>(null);
  const [gridSearchResultIndex, setGridSearchResultIndex] = useState<number | null>(null);
  const [gridFocusSha, setGridFocusSha] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSwitchEpoch, setMapSwitchEpoch] = useState(0);
  const [mapReadyForDisplay, setMapReadyForDisplay] = useState(false);
  const [mapPresentationState, setMapPresentationState] = useState<MapPresentationState>('loading');
  const [mapLayoutStatus, setMapLayoutStatus] = useState<BranchGridLayoutStatus>({
    state: 'idle',
    source: 'none',
    nodeEstimate: 0,
    durationMs: null,
    error: null,
  });
  const [pendingInitialProjectPath, setPendingInitialProjectPath] = useState<string | null>(null);
  const [isEmptyAddProjectHovered, setIsEmptyAddProjectHovered] = useState(false);
  const [projectsHydrated, setProjectsHydrated] = useState(false);

  // Lock window resizing while in the empty-project state.
  useEffect(() => {
    if (!projectsHydrated) return;
    if (projects.length > 0) return;
    void invoke('set_window_resizable', { resizable: false });
    return () => {
      void invoke('set_window_resizable', { resizable: true });
    };
  }, [projects.length, projectsHydrated]);

  const [error, setError] = useState<string | null>(null);
  const [diagnosticsCopyFeedback, setDiagnosticsCopyFeedback] = useState<string | null>(null);
  const [previewSetupOpen, setPreviewSetupOpen] = useState(false);
  const [previewDraftConfig, setPreviewDraftConfig] = useState<ProjectPreviewConfig | null>(null);
  const [pendingPreviewTarget, setPendingPreviewTarget] = useState<PreviewTarget | null>(null);
  const [pendingPreviewNodeId, setPendingPreviewNodeId] = useState<string | null>(null);
  const [previewedWorktreeNodeIds, setPreviewedWorktreeNodeIds] = useState<string[]>([]);
  const [previewInProgress, setPreviewInProgress] = useState(false);
  const [previewedNodeId, setPreviewedNodeId] = useState<string | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [worktreePromptOpen, setWorktreePromptOpen] = useState(false);
  const [worktreePromptProjectPath, setWorktreePromptProjectPath] = useState('');
  const [worktreePromptBranchOrCommit, setWorktreePromptBranchOrCommit] = useState('');
  const [worktreePromptBranchOrCommitEditable, setWorktreePromptBranchOrCommitEditable] = useState(false);
  const [worktreePromptFolderName, setWorktreePromptFolderName] = useState('');
  const [worktreePromptCreateBranch, setWorktreePromptCreateBranch] = useState(false);
  const [worktreePromptCreateBranchDisabled, setWorktreePromptCreateBranchDisabled] = useState(false);
  const lastActiveTerminalIdByWorktreePathRef = useRef<Map<string, string>>(new Map());
  const [terminalPanelPlacement, setTerminalPanelPlacement] = useState<TerminalPanelPlacement>('right');
  // scrollRequest.seq increments on each click so the same branch re-triggers the effect
  const scrollRequest: { branch: Branch; seq: number } | null = null;
  const focusedErrorBranch: Branch | null = null;
  const [githubAuthStatus, setGithubAuthStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubAuthLoading, setGithubAuthLoading] = useState(false);
  const [githubAuthMessage, setGithubAuthMessage] = useState<string | null>(null);
  const [commitSwitchFeedback, setCommitSwitchFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const [isCommitSwitchFeedbackVisible, setIsCommitSwitchFeedbackVisible] = useState(false);
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'project' | 'worktree' | 'worktree-plus' | 'commit' | 'stash' | 'empty-branch';
    projectPath: string;
    worktreePath?: string;
    worktree?: WorktreeInfo;
    commitSha?: string;
    commitLabel?: string;
    commitText?: string;
    branchName?: string;
  } | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [contextMenu]);

  const showContextMenu = useCallback((
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus' | 'commit' | 'stash' | 'empty-branch',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo,
    commitSha?: string,
    commitLabel?: string,
    commitText?: string,
    branchName?: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    
    const menuWidth = 192;
    const menuHeight = (() => {
      if (type === 'project') return 198;
      if (type === 'commit') return 140;
      if (type === 'stash') return 110;
      if (type === 'worktree') {
        let buttons = 6;
        if (worktree?.branchName) buttons++;
        if (commitText) buttons++;
        return buttons * 28 + 30;
      }
      return 80;
    })();
    
    let x = event.clientX;
    let y = event.clientY;
    
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }
    
    setContextMenu({
      x,
      y,
      type,
      projectPath,
      worktreePath,
      worktree,
      commitSha,
      commitLabel,
      commitText,
      branchName,
    });
  }, []);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [squashInProgress, setSquashInProgress] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [branchPromptMeta, setBranchPromptMeta] = useState<Record<string, BranchPromptMeta>>({});
  const [branchCommitPreviews, setBranchCommitPreviews] = useState<Record<string, BranchCommitPreview[]>>({});
  const [branchParentByName, setBranchParentByName] = useState<Record<string, string | null>>({});
  const [laneByBranch, setLaneByBranch] = useState<Record<string, number>>({});
  const [nodePositionOverridesByRepo, setNodePositionOverridesByRepo] = useState<Record<string, NodePositionOverrides>>({});
  /** Monotonic write tokens prevent older failed/successful saves from changing the dirty state for newer edits. */
  const nodePositionPersistVersionByRepoRef = useRef<Record<string, number>>({});
  /** Repo has local card edits not yet flushed to disk; stale `get_repo_node_positions` results must not overwrite them. */
  const userDirtyNodePositionsRef = useRef<Set<string>>(new Set());
  const [branchUniqueAheadCounts, setBranchUniqueAheadCounts] = useState<Record<string, number>>({});
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [openPRs, setOpenPRs] = useState<OpenPR[]>([]);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [commitInProgress, setCommitInProgress] = useState(false);
  const [stageInProgress, setStageInProgress] = useState(false);
  const [createBranchFromNodeInProgress, setCreateBranchFromNodeInProgress] = useState(false);
  const isMutationBusy =
    commitInProgress ||
    stageInProgress ||
    stashInProgress ||
    pushInProgress ||
    deleteInProgress ||
    mergeInProgress ||
    createBranchFromNodeInProgress;
  const [isMapInteracting, setIsMapInteracting] = useState(false);
  const mapGridOrientation = 'horizontal' as const;
  const [remoteDefaultTipSha, setRemoteDefaultTipSha] = useState<string | null>(null);
  const [remoteDefaultTipMetadata, setRemoteDefaultTipMetadata] = useState<CommitMetadata | null>(null);
  const [remoteDefaultTipParentSha, setRemoteDefaultTipParentSha] = useState<string | null>(null);
  const [isRemoteTipHydrated, setIsRemoteTipHydrated] = useState(false);
  const [isGridDebugOpen, setIsGridDebugOpen] = useState(false);
  const [softUpdateDebugEvents, setSoftUpdateDebugEvents] = useState<string[]>([]);
  const [sidebarWidthPx, setSidebarWidthPx] = useState(SIDEBAR_DEFAULT_WIDTH_PX);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const autoFocusSyncKeyRef = useRef<string | null>(null);
  const focusCameraOnActiveWorktreeRef = useRef<(() => void) | null>(null);
  const isFirstLoadSessionRef = useRef(true);
  const loadRepoRequestIdRef = useRef(0);
  const mapSwitchEpochRef = useRef(0);
  const githubFetchRequestIdRef = useRef(0);
  const projectSnapshotSignatureRef = useRef<Record<string, string>>({});
  const activeSnapshotSignatureRef = useRef<string | null>(null);
  const lastSyncedGitEpochRef = useRef<Record<string, number>>({});
  const lastSyncedWorktreeEpochRef = useRef<Record<string, number>>({});
  const runAuthoritativeRepoSyncInFlightRef = useRef(false);
  const runAuthoritativeRepoSyncPendingRef = useRef(false);
  const gitActivityEpochRef = useRef(0);
  const lastHandledGitActivityEpochRef = useRef(0);
  const lastFullGraphRefreshAtRef = useRef<Record<string, number>>({});
  const wasMapInteractingRef = useRef(false);
  const projectHeadStateRef = useRef<Record<string, string>>({});
  const projectQuickStateRef = useRef<Record<string, string>>({});
  const repoSyncTokensRef = useRef<Record<string, RepoSyncTokens>>({});
  const isRepoSwitchingRef = useRef(false);
  const currentRepoPathRef = useRef<string | null>(null);
  const sidebarDragRef = useRef<{
    startX: number;
    startWidth: number;
    pendingWidth: number;
    pointerId: number;
  } | null>(null);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH_PX);
  const sidebarShellRef = useRef<HTMLDivElement | null>(null);

  const branchMetaLoadKeyRef = useRef<string | null>(null);
  const isMapInteractingRef = useRef(false);
  const mapInteractionEpochRef = useRef(0);
  /** Bumped at the start of local git mutations so in-flight background refreshes cannot apply stale snapshots. */
  const repoMutationGenerationRef = useRef(0);
  /** True while a user-initiated git mutation is running through to snapshot apply. */
  const repoMutationInFlightRef = useRef(false);
  const getPreparedCommitMessageRef = useRef<(worktreePath: string) => string | null>(() => null);
  const waitForPreparedCommitMessageRef = useRef<(worktreePath: string) => Promise<string | null>>(
    async () => null,
  );
  const waitForPreparedBranchNameRef = useRef<(worktreePath: string) => Promise<string | null>>(
    async () => null,
  );
  const getPreparedStashMessageRef = useRef<(worktreePath: string) => string | null>(() => null);
  const seedWorktreeDraftForPathRef = useRef<(worktreePath: string, message: string) => void>(() => {});
  const clearWorktreeDraftForPathRef = useRef<(worktreePath: string) => void>(() => {});
  /** Optimistic commit HEAD — blocks stale quick-state / DB refresh from regressing the checkout tip. */
  const postCommitProtectedHeadShaRef = useRef<Record<string, string>>({});
  const postCommitProtectTimeoutRef = useRef<Record<string, number>>({});
  /** False while panning and for {@link MAP_REPO_REFRESH_SETTLE_MS} after pan stops. */
  const canApplyRepoRefreshRef = useRef(true);
  const mapRefreshSettleTimeoutRef = useRef<number | null>(null);
  const scheduleDeferredRepoRefreshRef = useRef<((reason: string) => void) | null>(null);
  const rebuildPollIntervalsRef = useRef<Map<string, any>>(new Map());
  const runRepoRefreshRef = useRef<((reason?: 'graph' | 'local' | 'timer' | 'initial' | 'quick' | 'focus' | 'clean-detected') => Promise<void>) | null>(null);
  const reconcileInFlightRef = useRef(false);
  const pendingRefreshAfterInteractionRef = useRef(false);
  const reloadRepoSnapshotInFlightRef = useRef(false);
  const reloadRepoSnapshotPendingRef = useRef(false);
  const lastRemoteTipShaRef = useRef<string | null>(null);
  const lastRemoteHeadsDigestRef = useRef<string | null>(null);
  const remoteSyncInFlightRef = useRef(false);
  const hasAttemptedAutoRestoreRef = useRef(false);
  const loadRepoInFlightPathRef = useRef<string | null>(null);
  const suppressNextProjectWindowResizeRef = useRef(false);
  const hasPreparedInitialWindowRef = useRef(false);
  /** Cancels stale in-flight `get_repo_node_positions` results when a newer load starts. */
  const loadNodePositionsSeqRef = useRef(0);
  const loadingProjectSnapshotsRef = useRef<Set<string>>(new Set());
  const inflightProjectSnapshotsRef = useRef<Map<string, Promise<RepoVisualSnapshot | null>>>(new Map());
  const pendingFingerprintChecksRef = useRef<Set<string>>(new Set());
  const [initialProjectSnapshotsReady, setInitialProjectSnapshotsReady] = useState(false);
  const latestBranchesRef = useRef<Branch[]>([]);
  const latestDirectCommitsRef = useRef<DirectCommit[]>([]);
  const latestBranchCommitPreviewsRef = useRef<Record<string, BranchCommitPreview[]>>({});
  const latestCheckedOutRef = useRef<CheckedOutRef | null>(null);
  const latestUnpushedDirectCommitsRef = useRef<DirectCommit[]>([]);
  const latestWorktreesRef = useRef<WorktreeInfo[]>([]);
  const latestStashesRef = useRef<GitStashEntry[]>([]);
  const latestUnpushedCommitShasByBranchRef = useRef<Record<string, string[]>>({});
  const latestMergeNodesRef = useRef<MergeNode[]>([]);
  const latestBranchParentByNameRef = useRef<Record<string, string | null>>({});
  const branchHeadByNameRef = useRef<Record<string, string>>({});
  const layoutModelCacheRef = useRef<Map<string, BranchGridLayoutModel>>(new Map());
  const persistedLayoutKeysRef = useRef<Set<string>>(new Set());
  const persistedLayoutPayloadHashRef = useRef<Map<string, string>>(new Map());
  const lastResolvedLayoutModelRef = useRef<BranchGridLayoutModel | null>(null);
  const [hydratedLayoutModel, setHydratedLayoutModel] = useState<BranchGridLayoutModel | null>(null);
  const [hydratedLayoutKey, setHydratedLayoutKey] = useState<string | null>(null);
  /** Bumped when the working tree becomes clean so layout cache keys and MapGrid fully refresh. */
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const activeRepoScopedKey = repoPath ?? '__no-repo__';
  const activeProject = useMemo(() => {
    return repoPath ? projects.find((project) => sameRepoPath(project.path, repoPath)) ?? null : null;
  }, [projects, repoPath]);
  const sortedWorktrees = useMemo(() => {
    return sortWorktrees(worktrees, activeProject?.worktreeOrder);
  }, [worktrees, activeProject?.worktreeOrder]);

  const resizeProjectWindow = useCallback(async (hasProjects: boolean, options: { reveal?: boolean } = {}) => {
    const nextMinSize = hasProjects ? ACTIVE_PROJECT_MIN_SIZE : EMPTY_PROJECT_MIN_SIZE;
    const windowRef = getCurrentWindow();
    const isInitialPreparation = !hasPreparedInitialWindowRef.current;
    const fadeWindowOpacity = async (from: number, to: number) => {
      for (let step = 0; step <= WINDOW_OPACITY_FADE_STEPS; step += 1) {
        const progress = easeInOutSine(step / WINDOW_OPACITY_FADE_STEPS);
        const alpha = from + (to - from) * progress;
        await invoke('set_main_window_opacity', { alpha }).catch((error) => {
          console.warn('Failed to set window opacity:', error);
        });
        if (step < WINDOW_OPACITY_FADE_STEPS) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, WINDOW_OPACITY_FADE_MS / WINDOW_OPACITY_FADE_STEPS);
          });
        }
      }
    };
    const setWindowOpacity = (alpha: number) =>
      invoke('set_main_window_opacity', { alpha }).catch((error) => {
        console.warn('Failed to set window opacity:', error);
      });

    try {
      const [physicalSize, physicalPosition, scaleFactor] = await Promise.all([
        windowRef.innerSize(),
        windowRef.outerPosition(),
        windowRef.scaleFactor(),
      ]);

      const logicalSize = physicalSize.toLogical(scaleFactor);
      const logicalPosition = physicalPosition.toLogical(scaleFactor);
      const center = {
        x: logicalPosition.x + logicalSize.width / 2,
        y: logicalPosition.y + logicalSize.height / 2,
      };
      const frameForSize = (size: { width: number; height: number }) => ({
        x: center.x - size.width / 2,
        y: center.y - size.height / 2,
        width: size.width,
        height: size.height,
      });

      if (!hasProjects) {
        if (!isInitialPreparation) {
          await fadeWindowOpacity(1, 0);
        }
        await windowRef.setMinSize(new LogicalSize(nextMinSize.width, nextMinSize.height));
        const nextFrame = frameForSize(nextMinSize);
        await Promise.all([
          windowRef.setPosition(new LogicalPosition(nextFrame.x, nextFrame.y)),
          windowRef.setSize(new LogicalSize(nextFrame.width, nextFrame.height)),
        ]);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (options.reveal) {
          await windowRef.show();
        }
        hasPreparedInitialWindowRef.current = true;
        if (!isInitialPreparation) {
          await fadeWindowOpacity(0, 1);
        } else {
          await setWindowOpacity(1);
        }
        return;
      }

      const nextWidth = Math.max(logicalSize.width, nextMinSize.width);
      const nextHeight = Math.max(logicalSize.height, nextMinSize.height);
      if (nextWidth !== logicalSize.width || nextHeight !== logicalSize.height) {
        await fadeWindowOpacity(1, 0);
        const nextFrame = frameForSize({ width: nextWidth, height: nextHeight });
        await Promise.all([
          windowRef.setPosition(new LogicalPosition(nextFrame.x, nextFrame.y)),
          windowRef.setSize(new LogicalSize(nextFrame.width, nextFrame.height)),
        ]);
        await windowRef.setMinSize(new LogicalSize(nextMinSize.width, nextMinSize.height));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (options.reveal) {
          await windowRef.show();
        }
        hasPreparedInitialWindowRef.current = true;
        if (!isInitialPreparation) {
          await fadeWindowOpacity(0, 1);
        } else {
          await setWindowOpacity(1);
        }
        return;
      }
      await windowRef.setMinSize(new LogicalSize(nextMinSize.width, nextMinSize.height));
      if (options.reveal) {
        await windowRef.show();
      }
      hasPreparedInitialWindowRef.current = true;
      await setWindowOpacity(1);
    } catch (error) {
      if (options.reveal) {
        await windowRef.show().catch(() => undefined);
      }
      hasPreparedInitialWindowRef.current = true;
      await setWindowOpacity(1);
      console.warn('Failed to update window minimum size:', error);
    }
  }, []);

  useEffect(() => {
    if (!projectsHydrated) return;
    if (suppressNextProjectWindowResizeRef.current) {
      suppressNextProjectWindowResizeRef.current = false;
      return;
    }
    void resizeProjectWindow(projects.length > 0, { reveal: !hasPreparedInitialWindowRef.current });
  }, [projects.length, projectsHydrated, resizeProjectWindow]);

  useEffect(() => {
    if (projects.length !== 0 || !error) return;
    const timeout = window.setTimeout(() => {
      setError(null);
    }, 4200);
    return () => window.clearTimeout(timeout);
  }, [error, projects.length]);

  function noteSoftUpdateDebug(label: string, details: Record<string, unknown> = {}) {
    const now = new Date().toLocaleTimeString();
    const body = Object.entries(details)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    setSoftUpdateDebugEvents((previous) => [`${now} ${label}${body ? ` ${body}` : ''}`, ...previous].slice(0, 80));
  }
  const persistGridClumps = (opened: RepoScopedClumpState, closed: RepoScopedClumpState) => {
    try {
      const serialized = {
        opened: Object.fromEntries(
          Object.entries(opened).map(([projectPath, clumps]) => [projectPath, Array.from(clumps)]),
        ),
        closed: Object.fromEntries(
          Object.entries(closed).map(([projectPath, clumps]) => [projectPath, Array.from(clumps)]),
        ),
      };
      window.localStorage.setItem(GRID_CLUMPS_STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // ignore storage failures
    }
  };
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GRID_CLUMPS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const opened: RepoScopedClumpState = {};
      const closed: RepoScopedClumpState = {};
      const asRecord = parsed as {
        opened?: Record<string, string[]>;
        closed?: Record<string, string[]>;
      };
      for (const [projectPath, clumps] of Object.entries(asRecord.opened ?? {})) {
        if (!Array.isArray(clumps)) continue;
        opened[projectPath] = new Set(clumps.filter((value): value is string => typeof value === 'string'));
      }
      for (const [projectPath, clumps] of Object.entries(asRecord.closed ?? {})) {
        if (!Array.isArray(clumps)) continue;
        closed[projectPath] = new Set(clumps.filter((value): value is string => typeof value === 'string'));
      }
      setManuallyOpenedGridClumpsByRepo(opened);
      setManuallyClosedGridClumpsByRepo(closed);
    } catch {
      // ignore storage failures
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      persistGridClumps(manuallyOpenedGridClumpsByRepo, manuallyClosedGridClumpsByRepo);
    }, 500);
    return () => clearTimeout(timer);
  }, [manuallyClosedGridClumpsByRepo, manuallyOpenedGridClumpsByRepo]);
  const manuallyOpenedGridClumps = useMemo(
    () => manuallyOpenedGridClumpsByRepo[activeRepoScopedKey] ?? new Set<string>(),
    [activeRepoScopedKey, manuallyOpenedGridClumpsByRepo],
  );
  const manuallyClosedGridClumps = useMemo(
    () => manuallyClosedGridClumpsByRepo[activeRepoScopedKey] ?? new Set<string>(),
    [activeRepoScopedKey, manuallyClosedGridClumpsByRepo],
  );
  const setManuallyOpenedGridClumps = useCallback(
    (updater: SetStateAction<Set<string>>) => {
      setManuallyOpenedGridClumpsByRepo((previous) => {
        const previousSet = previous[activeRepoScopedKey] ?? new Set<string>();
        const nextSet = typeof updater === 'function' ? updater(previousSet) : updater;
        return { ...previous, [activeRepoScopedKey]: new Set(nextSet) };
      });
    },
    [activeRepoScopedKey],
  );
  const setManuallyClosedGridClumps = useCallback(
    (updater: SetStateAction<Set<string>>) => {
      setManuallyClosedGridClumpsByRepo((previous) => {
        const previousSet = previous[activeRepoScopedKey] ?? new Set<string>();
        const nextSet = typeof updater === 'function' ? updater(previousSet) : updater;
        return { ...previous, [activeRepoScopedKey]: new Set(nextSet) };
      });
    },
    [activeRepoScopedKey],
  );
  const projectCards = useMemo(
    () => projects.map((project) => {
      const isActiveProject = (() => {
        if (!repoPath) return false;
        const left = normalizePath(project.path).toLowerCase();
        const right = normalizePath(repoPath).toLowerCase();
        return left === right;
      })();
      const snapshot = projectSnapshots[project.path] ?? {};
      const rawWorktrees = isActiveProject ? worktrees : (snapshot.worktrees ?? []);
      const sortedProjectWorktrees = sortWorktrees(rawWorktrees, project.worktreeOrder);

      if (isActiveProject) {
        return {
          ...project,
          name: repoName || snapshot.name || project.name,
          branches,
          mergeNodes,
          directCommits,
          unpushedDirectCommits,
          unpushedCommitShasByBranch,
          checkedOutRef,
          worktrees: sortedProjectWorktrees,
          stashes,
          branchCommitPreviews,
          laneByBranch,
          branchUniqueAheadCounts,
          branchParentByName,
          defaultBranch,
          treeLoaded: snapshot.loaded === true,
          worktreeOrder: project.worktreeOrder,
          terminalOrderMap: project.terminalOrderMap,
        };
      }
      return {
        ...project,
        ...snapshot,
        branches: snapshot.branches ?? [],
        mergeNodes: snapshot.mergeNodes ?? [],
        directCommits: snapshot.directCommits ?? [],
        unpushedDirectCommits: snapshot.unpushedDirectCommits ?? [],
        unpushedCommitShasByBranch: snapshot.unpushedCommitShasByBranch ?? {},
        checkedOutRef: snapshot.checkedOutRef ?? null,
        worktrees: sortedProjectWorktrees,
        stashes: snapshot.stashes ?? [],
        branchCommitPreviews: snapshot.branchCommitPreviews ?? {},
        laneByBranch: snapshot.laneByBranch ?? {},
        branchUniqueAheadCounts: snapshot.branchUniqueAheadCounts ?? {},
        defaultBranch: snapshot.defaultBranch ?? project.branchName ?? 'main',
        treeLoaded: snapshot.loaded ?? false,
        branchParentByName: snapshot.branchParentByName ?? {},
        worktreeOrder: project.worktreeOrder,
        terminalOrderMap: project.terminalOrderMap,
      };
    }),
    [
      projects,
      projectSnapshots,
      repoPath,
      checkedOutRef,
      branchParentByName,
      branches,
      mergeNodes,
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch,
      worktrees,
      stashes,
      branchCommitPreviews,
      laneByBranch,
      branchUniqueAheadCounts,
      repoName,
      defaultBranch,
    ],
  );
  const gridHudProps = useMemo(
    () => ({
      githubAuthStatus,
      githubAuthLoading,
      onGitHubAuthSetup: handleGitHubAuthSetup,
      gridSearchQuery,
      setGridSearchQuery,
      gridSearchResultCount,
      gridSearchResultIndex,
      setGridSearchJumpDirection,
      setGridSearchJumpToken,
      setIsGridDebugOpen,
      githubAuthMessage,
      commitSwitchFeedback,
      isCommitSwitchFeedbackVisible,
    }),
    [
      commitSwitchFeedback,
      githubAuthLoading,
      githubAuthMessage,
      githubAuthStatus,
      gridSearchQuery,
      gridSearchResultCount,
      gridSearchResultIndex,
      handleGitHubAuthSetup,
      isCommitSwitchFeedbackVisible,
      setGridSearchQuery,
      setGridSearchJumpDirection,
      setGridSearchJumpToken,
      setIsGridDebugOpen,
    ],
  );

  function upsertProjectSnapshot(path: string, snapshot: RepoVisualSnapshot, options?: { force?: boolean }) {
    const signature = getRepoVisualSnapshotSignature(snapshot);
    const force = options?.force === true;
    const previousSignature = projectSnapshotSignatureRef.current[path];
    if (!force && previousSignature === signature) return false;
    projectSnapshotSignatureRef.current = {
      ...projectSnapshotSignatureRef.current,
      [path]: signature,
    };
    setProjectSnapshots((previous) => {
      if (previous[path] === snapshot) return previous;
      return {
        ...previous,
        [path]: snapshot,
      };
    });
    return true;
  }

  const loadNodePositionsForRepo = useCallback(async (targetPath: string) => {
    const normalizedPath = normalizePath(targetPath);
    if (!normalizedPath) return;
    const seq = ++loadNodePositionsSeqRef.current;
    let localOverrides: NodePositionOverrides | null = null;
    try {
      const localPayload = window.localStorage.getItem(nodePositionsStorageKey(normalizedPath));
      if (localPayload) {
        localOverrides = parseNodePositionOverrides(localPayload);
        setNodePositionOverridesByRepo((previous) => ({
          ...previous,
          [normalizedPath]: localOverrides ?? {},
        }));
      }
    } catch {
      // The SQLite cache below remains available when localStorage is blocked.
    }
    let payloadJson: string | null = null;
    try {
      payloadJson = await invoke<string | null>('get_repo_node_positions', {
        repoPath: normalizedPath,
      });
    } catch (error) {
      if (localOverrides) return;
      const message = error instanceof Error ? error.message : String(error);
      setCommitSwitchFeedback({
        kind: 'error',
        message: `Could not load saved node positions: ${message}`,
      });
      console.error('Failed to load node positions:', error);
      return;
    }
    if (seq !== loadNodePositionsSeqRef.current) return;
    if (userDirtyNodePositionsRef.current.has(normalizedPath)) return;
    if (localOverrides && Object.keys(localOverrides).length > 0) return;
    const overrides = parseNodePositionOverrides(payloadJson);
    setNodePositionOverridesByRepo((previous) => ({
      ...previous,
      [normalizedPath]: overrides,
    }));
    if (Object.keys(overrides).length > 0) {
      try {
        window.localStorage.setItem(nodePositionsStorageKey(normalizedPath), JSON.stringify(overrides));
      } catch {
        // ignore localStorage failures; SQLite remains the durable backend
      }
    }
  }, []);

  const persistRepoNodePositions = useCallback((normalizedPath: string, overrides: NodePositionOverrides) => {
    try {
      window.localStorage.setItem(nodePositionsStorageKey(normalizedPath), JSON.stringify(overrides));
    } catch {
      // ignore localStorage failures; the Tauri write below will report errors
    }
    const version = (nodePositionPersistVersionByRepoRef.current[normalizedPath] ?? 0) + 1;
    nodePositionPersistVersionByRepoRef.current = {
      ...nodePositionPersistVersionByRepoRef.current,
      [normalizedPath]: version,
    };
    void invoke('store_repo_node_positions', {
      repoPath: normalizedPath,
      payloadJson: JSON.stringify(overrides),
    })
      .then(() => {
        if (nodePositionPersistVersionByRepoRef.current[normalizedPath] !== version) return;
        userDirtyNodePositionsRef.current.delete(normalizedPath);
      })
      .catch((error) => {
        if (nodePositionPersistVersionByRepoRef.current[normalizedPath] !== version) return;
        const message = error instanceof Error ? error.message : String(error);
        setCommitSwitchFeedback({
          kind: 'error',
          message: `Could not save node positions: ${message}`,
        });
        console.error('Failed to save node positions:', error);
      });
  }, []);

  const handleNodePositionOverridesChange = useCallback(
    (overrides: NodePositionOverrides) => {
      if (!repoPath) return;
      const normalizedPath = normalizePath(repoPath);
      userDirtyNodePositionsRef.current.add(normalizedPath);
      setNodePositionOverridesByRepo((previous) => ({
        ...previous,
        [normalizedPath]: overrides,
      }));
      persistRepoNodePositions(normalizedPath, overrides);
    },
    [persistRepoNodePositions, repoPath],
  );

  const resetProjectNodePositions = useCallback(
    (targetPath: string) => {
      const normalizedPath = normalizePath(targetPath);
      userDirtyNodePositionsRef.current.delete(normalizedPath);
      nodePositionPersistVersionByRepoRef.current = {
        ...nodePositionPersistVersionByRepoRef.current,
        [normalizedPath]: (nodePositionPersistVersionByRepoRef.current[normalizedPath] ?? 0) + 1,
      };
      setNodePositionOverridesByRepo((previous) => ({
        ...previous,
        [normalizedPath]: {},
      }));
      try {
        window.localStorage.removeItem(nodePositionsStorageKey(normalizedPath));
      } catch {
        // ignore localStorage failures
      }
      void invoke('clear_repo_node_positions', { repoPath: normalizedPath });
    },
    [],
  );


  function quickStateSignature(state: RepoQuickState): string {
    return [
      state.repoPath,
      state.headSha,
      state.upstreamSha ?? '',
      state.hasUncommittedChanges ? '1' : '0',
    ].join('|');
  }

  function headStateSignature(state: RepoHeadState): string {
    return [
      state.repoPath,
      state.headSha,
      state.upstreamSha ?? '',
    ].join('|');
  }

  function markGitActivityHandled() {
    lastHandledGitActivityEpochRef.current = gitActivityEpochRef.current;
    pendingRefreshAfterInteractionRef.current = false;
  }


function quickStateFromSnapshot(path: string, snapshot: RepoVisualSnapshot): RepoQuickState {
    return {
      repoPath: path,
      headSha: snapshot.checkedOutRef?.headSha ?? '',
      upstreamSha: snapshot.checkedOutRef?.parentSha ?? null,
      hasUncommittedChanges: snapshot.checkedOutRef?.hasUncommittedChanges ?? false,
    };
  }

  function seedProjectSnapshotFromRecord(
    normalizedPath: string,
    snapshot: RepoVisualSnapshot,
  ) {
    projectQuickStateRef.current = {
      ...projectQuickStateRef.current,
      [normalizedPath]: quickStateSignature(quickStateFromSnapshot(normalizedPath, snapshot)),
    };
  }


  function isIncomingSnapshotStaleComparedToLive(
    incoming: RepoVisualSnapshot,
    live: RepoVisualSnapshot,
  ): boolean {
    const liveHead = live.checkedOutRef?.headSha ?? null;
    if (!liveHead || isWorkingTreeCommitId(liveHead)) return false;
    if (!snapshotContainsCommitSha(incoming, liveHead) && snapshotContainsCommitSha(live, liveHead)) {
      return true;
    }
    const liveClean = !(live.checkedOutRef?.hasUncommittedChanges ?? false);
    const incomingDirty = incoming.checkedOutRef?.hasUncommittedChanges ?? false;
    if (liveClean && incomingDirty && liveHead === incoming.checkedOutRef?.headSha) {
      return true;
    }
    return false;
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) {
        setProjectsHydrated(true);
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setProjectsHydrated(true);
        return;
      }
      const next = parsed.filter((project): project is ProjectRecord => (
        typeof project === 'object' &&
        project !== null &&
        typeof project.path === 'string' &&
        typeof project.name === 'string' &&
        typeof project.lastOpenedAt === 'number'
      ));
      setProjects(next.slice(0, MAX_PROJECTS));
      setProjectsHydrated(true);
    } catch {
      setProjects([]);
      setProjectsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (hasAttemptedAutoRestoreRef.current) return;
    if (repoPath) return;
    if (projects.length === 0) return;
    if (!initialProjectSnapshotsReady) return;

    const storedActiveProjectPath = (() => {
      try {
        return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    const restoredProject = storedActiveProjectPath
      ? projects.find((project) => normalizePath(project.path).toLowerCase() === normalizePath(storedActiveProjectPath).toLowerCase())
      : null;

    hasAttemptedAutoRestoreRef.current = true;
    void loadRepo(restoredProject?.path ?? projects[0]!.path);
  }, [initialProjectSnapshotsReady, projects, repoPath]);

  useEffect(() => {
    if (!repoPath) return;
    try {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, repoPath);
    } catch {
      // ignore storage failures
    }
  }, [repoPath]);

  useEffect(() => {
    let isDisposed = false;
    let unlisten: (() => void) | null = null;
    listen<ProjectLoadProgressEvent>('project-load-progress', (event) => {
      if (isDisposed) return;
      const payload = event.payload;
      const key = projectLoadKey(payload.repoPath);
      setProjectLoadStates((previous) => ({
        ...previous,
        [key]: {
          status: payload.status,
          phase: payload.phase,
          progress: payload.progress,
          error: payload.error,
        },
      }));
    }).then((fn) => {
      if (isDisposed) fn();
      else unlisten = fn;
    }).catch(console.error);
    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, []);

  const mergeTargetBranchByCommitSha = useMemo(
    () =>
      mergeNodes.reduce<Record<string, string>>((map, node) => {
        map[node.targetCommitSha] = node.targetBranch;
        return map;
      }, {}),
    [mergeNodes],
  );

  useEffect(() => {
    if (!repoPath) return;
    if (isRepoSwitchingRef.current) return;
    setProjectSnapshots((previous) => ({
      ...previous,
      [repoPath]: {
        path: repoPath,
        name: repoName || basenameFromPath(repoPath),
        branches,
        mergeNodes,
        directCommits,
        unpushedDirectCommits,
        mergeTargetBranchByCommitSha: mergeNodes.reduce<Record<string, string>>((map, node) => {
          map[node.targetCommitSha] = node.targetBranch;
          return map;
        }, {}),
        unpushedCommitShasByBranch,
        checkedOutRef,
        worktrees,
        stashes,
        branchCommitPreviews,
        branchParentByName,
        laneByBranch,
        branchUniqueAheadCounts,
        defaultBranch,
        loaded: true,
        cacheSchemaVersion: previous[repoPath]?.cacheSchemaVersion ?? 1,
        updatedAtMs: previous[repoPath]?.updatedAtMs ?? Date.now(),
      },
    }));
  }, [
    repoPath,
    repoName,
    branches,
    mergeNodes,
    directCommits,
    unpushedDirectCommits,
    mergeTargetBranchByCommitSha,
    unpushedCommitShasByBranch,
    checkedOutRef,
    worktrees,
    stashes,
    branchCommitPreviews,
    branchParentByName,
    laneByBranch,
    branchUniqueAheadCounts,
    defaultBranch,
  ]);

  const activeSnapshot = repoPath ? projectSnapshots[repoPath] : null;

  useEffect(() => {
    if (!repoPath || !activeSnapshot || !activeSnapshot.loaded) return;
    try {
      window.localStorage.setItem(`optimistic_snapshot:${repoPath}`, JSON.stringify(activeSnapshot));

      const prefix = 'optimistic_snapshot:';
      const keys: { key: string; time: number }[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          try {
            const raw = window.localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              keys.push({ key, time: parsed.updatedAtMs ?? 0 });
            }
          } catch {
            // ignore
          }
        }
      }
      if (keys.length > 5) {
        keys.sort((a, b) => b.time - a.time);
        for (let i = 5; i < keys.length; i++) {
          window.localStorage.removeItem(keys[i].key);
        }
      }
    } catch {
      // ignore storage failures
    }
  }, [repoPath, activeSnapshot]);

  async function loadProjectSnapshot(
    path: string,
    forceRefresh = false,
    checkFingerprint = false,
  ): Promise<RepoVisualSnapshot | null> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return null;

    if (checkFingerprint) {
      pendingFingerprintChecksRef.current.add(normalizedPath);
    }

    if (!forceRefresh && !checkFingerprint && projectSnapshots[normalizedPath]?.loaded) {
      return projectSnapshots[normalizedPath] ?? null;
    }
    const inflight = inflightProjectSnapshotsRef.current.get(normalizedPath);
    if (inflight) return inflight;

    const task = (async (): Promise<RepoVisualSnapshot | null> => {
      if (loadingProjectSnapshotsRef.current.has(normalizedPath)) return projectSnapshots[normalizedPath] ?? null;
      loadingProjectSnapshotsRef.current.add(normalizedPath);
      if (normalizedPath === repoPath) {
        setProjectTreeLoading(true);
      }

      // Yield to let other concurrent calls in the same tick register their fingerprint check needs
      await Promise.resolve();

      try {
        const shouldCheckFingerprint = checkFingerprint || pendingFingerprintChecksRef.current.has(normalizedPath);
        pendingFingerprintChecksRef.current.delete(normalizedPath);

        let record: ProjectSnapshotRecord | null = null;
        if (forceRefresh) {
          record = await invoke<ProjectSnapshotRecord>('add_project_and_ingest', {
            repoPath: normalizedPath,
            forceRefresh: true,
          });
        } else {
          let needsIngest = false;
          if (shouldCheckFingerprint) {
            const check = await invoke<FingerprintCheckResult>('check_project_fingerprint', {
              projectId: normalizedPath,
            }).catch(() => null);
            if (check?.changed) {
              needsIngest = true;
            }
          }

          if (needsIngest) {
            record = await invoke<ProjectSnapshotRecord>('add_project_and_ingest', {
              repoPath: normalizedPath,
              forceRefresh: false,
            });
          } else {
            if (shouldCheckFingerprint && projectSnapshots[normalizedPath]?.loaded) {
              return projectSnapshots[normalizedPath] ?? null;
            }
            record = await invoke<ProjectSnapshotRecord | null>('load_project_snapshot', {
              projectId: normalizedPath,
            });
            if (!record) {
              record = await invoke<ProjectSnapshotRecord>('add_project_and_ingest', {
                repoPath: normalizedPath,
                forceRefresh: false,
              });
            }
          }
        }
        const snapshot = toRepoVisualSnapshot(record);
        if (!snapshot) {
          throw new Error('Missing repo visual snapshot payload');
        }
        upsertProjectSnapshot(normalizedPath, snapshot);
        seedProjectSnapshotFromRecord(normalizedPath, snapshot);
        return snapshot;
      } finally {
        loadingProjectSnapshotsRef.current.delete(normalizedPath);
        if (normalizedPath === repoPath && loadingProjectSnapshotsRef.current.size === 0) {
          setProjectTreeLoading(false);
        }
        pendingFingerprintChecksRef.current.delete(normalizedPath);
      }
    })();

    inflightProjectSnapshotsRef.current.set(normalizedPath, task);
    try {
      return await task;
    } finally {
      inflightProjectSnapshotsRef.current.delete(normalizedPath);
      pendingFingerprintChecksRef.current.delete(normalizedPath);
    }
  }

  async function refreshProjectSnapshotFromGit(
    path: string,
    options?: { force?: boolean; honorReloadSync?: boolean },
  ): Promise<RepoVisualSnapshot | null> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return null;

    const requestedReloadSync = options?.honorReloadSync === true && consumeReloadSyncRequest();
    const check = await invoke<FingerprintCheckResult>('check_project_fingerprint', {
      projectId: normalizedPath,
    }).catch(() => null);
    if (!options?.force && !requestedReloadSync && !check?.changed) {
      return projectSnapshots[normalizedPath] ?? null;
    }

    await invoke('persist_project_snapshot', { projectId: normalizedPath, force: true }).catch((error) => {
      console.warn('Project snapshot persist failed:', error);
    });
    const record = await invoke<ProjectSnapshotRecord | null>('load_project_snapshot', {
      projectId: normalizedPath,
    }).catch(() => null);
    const snapshot = record ? toRepoVisualSnapshot(record) : null;
    if (!snapshot) return null;
    upsertProjectSnapshot(normalizedPath, snapshot, { force: true });
    seedProjectSnapshotFromRecord(normalizedPath, snapshot);
    return snapshot;
  }

  useEffect(() => {
    if (projects.length === 0) {
      setInitialProjectSnapshotsReady(true);
      return;
    }

    setInitialProjectSnapshotsReady(true);

    let isDisposed = false;

    void (async () => {
      try {
        const storedActivePath = (() => {
          try {
            return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
          } catch {
            return null;
          }
        })();
        const activePath = (storedActivePath
          ? projects.find(
              (project) =>
                normalizePath(project.path).toLowerCase() === normalizePath(storedActivePath).toLowerCase(),
            )?.path
          : projects[0]?.path) ?? projects[0]?.path;
        const otherProjects = projects.filter(
          (project) => !activePath || normalizePath(project.path) !== normalizePath(activePath),
        );
        if (otherProjects.length > 0) {
          void (async () => {
            for (const project of otherProjects) {
              if (isDisposed) return;
              const record = await invoke<ProjectSnapshotRecord | null>('load_project_snapshot', {
                projectId: project.path,
              }).catch(() => null);
              const snapshot = toRepoVisualSnapshot(record);
              if (snapshot?.loaded) {
                upsertProjectSnapshot(normalizePath(project.path), snapshot);
                seedProjectSnapshotFromRecord(normalizePath(project.path), snapshot);
              }
              await yieldToPaint();
            }
          })();
        }
      } catch (error) {
        console.error('Failed to preload project snapshots:', error);
        if (!isDisposed) setProjectTreeLoading(false);
      }
    })();

    return () => {
      isDisposed = true;
    };
  }, [projects]);

  useEffect(() => {
    let isDisposed = false;
    let unlisten: (() => void) | null = null;

    listen<GitActivityEventPayload>('git-activity', (event) => {
      if (isDisposed) return;
      if (event.payload.kind === 'local') return;
      const changedPath = normalizePath(event.payload.repoPath);
      if (!changedPath || sameRepoPath(changedPath, repoPath)) return;
      // Keep sidebar/project cache DB-first; active repo updates use snapshot refresh commands.
      void loadProjectSnapshot(changedPath, false);
    }).then((fn) => {
      if (isDisposed) fn();
      else unlisten = fn;
    }).catch(console.error);

    return () => {
      isDisposed = true;
      if (unlisten) unlisten();
    };
  }, [repoPath]);

  useEffect(() => {
    if (mapLoading || isRepoSwitchingRef.current) return;
    if (projects.length === 0) return;
    let isDisposed = false;

    const hydrateProjectLayout = async (project: ProjectRecord, allowCompute: boolean) => {
      const normalizedPath = normalizePath(project.path);
      const snapshot = projectSnapshots[normalizedPath];
      if (!snapshot?.loaded) return;
      const projectOpenedClumps = manuallyOpenedGridClumpsByRepo[normalizedPath] ?? new Set<string>();
      const projectClosedClumps = manuallyClosedGridClumpsByRepo[normalizedPath] ?? new Set<string>();
      const layoutKey = makeLayoutCacheKey(
        normalizedPath,
        mapGridOrientation,
        projectOpenedClumps,
        projectClosedClumps,
      );
      if (layoutModelCacheRef.current.has(layoutKey)) return;
      const payloadJson = await invoke<string | null>('get_repo_layout_snapshot', {
        repoPath: normalizedPath,
        layoutKey,
      }).catch(() => null);
      if (isDisposed) return;
      if (payloadJson) {
        try {
          const parsed = JSON.parse(payloadJson);
          const hydrated = hydrateBranchGridLayoutModel(parsed);
          if (snapshot.branches.length > 0 && (hydrated.allCommits.length === 0 || hydrated.renderNodes.length === 0)) {
            return;
          }
          layoutModelCacheRef.current.set(layoutKey, hydrated);
          persistedLayoutKeysRef.current.add(layoutKey);
          return;
        } catch {
          // fall through to recompute when persisted payload is invalid
        }
      }
      if (!allowCompute) return;
      const computedState = deriveRepoVisualState({
        branches: snapshot.branches,
        mergeNodes: snapshot.mergeNodes,
        directCommits: snapshot.directCommits,
        unpushedDirectCommits: snapshot.unpushedDirectCommits,
        unpushedCommitShasByBranch: snapshot.unpushedCommitShasByBranch ?? {},
        defaultBranch: snapshot.defaultBranch,
        branchCommitPreviews: snapshot.branchCommitPreviews,
        branchParentByName: snapshot.branchParentByName,
        branchUniqueAheadCounts: snapshot.branchUniqueAheadCounts,
        checkedOutRef: snapshot.checkedOutRef,
        worktrees: snapshot.worktrees,
        currentRepoPath: normalizedPath,
        stashes: snapshot.stashes,
        manuallyOpenedClumps: projectOpenedClumps,
        manuallyClosedClumps: projectClosedClumps,
        gridSearchQuery: '',
        gridFocusSha: null,
        orientation: mapGridOrientation,
      });
      const computedLayoutModel = computedState.sharedGridLayoutModel;
      if (
        (snapshot.branches.length > 0 || snapshot.directCommits.length > 0 || snapshot.unpushedDirectCommits.length > 0) &&
        (computedLayoutModel.allCommits.length === 0 || computedLayoutModel.renderNodes.length === 0)
      ) {
        return;
      }
      layoutModelCacheRef.current.set(layoutKey, computedLayoutModel);
      persistedLayoutKeysRef.current.add(layoutKey);
      const serialized = JSON.stringify(serializeBranchGridLayoutModel(computedLayoutModel));
      void invoke('store_repo_layout_snapshot', {
        repoPath: normalizedPath,
        layoutKey,
        payloadJson: serialized,
      }).catch(() => {
        persistedLayoutKeysRef.current.delete(layoutKey);
      });
      await yieldToPaint();
    };

    void (async () => {
      const activeProject = repoPath
        ? projects.find((project) => sameRepoPath(project.path, repoPath))
        : null;
      const deferredProjects = activeProject
        ? projects.filter((project) => !sameRepoPath(project.path, activeProject.path))
        : projects;

      if (activeProject) {
        await hydrateProjectLayout(activeProject, false);
      }
      if (isDisposed) return;

      for (const project of deferredProjects) {
        if (isDisposed) return;
        await hydrateProjectLayout(project, false);
      }
    })();
    return () => {
      isDisposed = true;
    };
  }, [
    projects,
    projectSnapshots,
    mapGridOrientation,
    manuallyOpenedGridClumpsByRepo,
    manuallyClosedGridClumpsByRepo,
    mapLoading,
    repoPath,
  ]);

  function persistProject(project: ProjectRecord) {
    setProjects((previous) => {
      const normalizedPath = normalizePath(project.path);
      if (!normalizedPath) return previous;
      const normalizedProject: ProjectRecord = {
        ...project,
        path: normalizedPath,
      };
      const existing = previous.find((item) => item.path === normalizedPath);
      if (!normalizedProject.previewConfig && existing?.previewConfig) {
        normalizedProject.previewConfig = existing.previewConfig;
      }
      if (!normalizedProject.worktreeOrder && existing?.worktreeOrder) {
        normalizedProject.worktreeOrder = existing.worktreeOrder;
      }
      if (!normalizedProject.terminalOrderMap && existing?.terminalOrderMap) {
        normalizedProject.terminalOrderMap = existing.terminalOrderMap;
      }
      const next = previous.some((item) => item.path === normalizedPath)
        ? previous.map((item) => (item.path === normalizedPath ? normalizedProject : item))
        : [...previous, normalizedProject];
      const trimmed = next.slice(-MAX_PROJECTS);
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(trimmed));
      } catch {
        // ignore storage failures
      }
      return trimmed;
    });
  }

  function updateProjectPreviewConfig(path: string, previewConfig: ProjectPreviewConfig) {
    const normalizedPath = normalizePath(path);
    setProjects((previous) => {
      const next = previous.map((project) => (
        normalizePath(project.path) === normalizedPath ? { ...project, previewConfig } : project
      ));
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  function reorderProjects(nextOrder: string[]) {
    setProjects((previous) => {
      const byPath = new Map(previous.map((project) => [project.path, project]));
      const next: ProjectRecord[] = [];
      for (const path of nextOrder) {
        const project = byPath.get(path);
        if (!project) continue;
        next.push(project);
        byPath.delete(path);
      }
      for (const project of previous) {
        if (byPath.has(project.path)) next.push(project);
      }
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
      } catch {
        // ignore storage failures
      }
      return next.slice(0, MAX_PROJECTS);
    });
  }

  function reorderWorktrees(projectPath: string, nextOrder: string[]) {
    const normalizedPath = normalizePath(projectPath);
    setProjects((previous) => {
      const next = previous.map((project) => {
        if (normalizePath(project.path) === normalizedPath) {
          return { ...project, worktreeOrder: nextOrder };
        }
        return project;
      });
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  function reorderTerminals(projectPath: string, worktreePath: string, nextOrder: string[]) {
    const normalizedPath = normalizePath(projectPath);
    setProjects((previous) => {
      const next = previous.map((project) => {
        if (normalizePath(project.path) === normalizedPath) {
          const terminalOrderMap = { ...(project.terminalOrderMap ?? {}) };
          terminalOrderMap[worktreePath] = nextOrder;
          return { ...project, terminalOrderMap };
        }
        return project;
      });
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  async function addProject(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    setError(null);
    try {
      const [info, resolvedDefaultBranch] = await Promise.all([
        invoke<{ name: string; path: string }>('get_repo_info', { repoPath: normalizedPath }),
        invoke<string>('get_default_branch', { repoPath: normalizedPath }).catch(() => 'main'),
      ]);
      if (projects.length === 0) {
        setPendingInitialProjectPath(normalizedPath);
        await resizeProjectWindow(true);
        suppressNextProjectWindowResizeRef.current = true;
      }
      persistProject({
        path: normalizedPath,
        name: info.name,
        lastOpenedAt: Date.now(),
        branchName: resolvedDefaultBranch,
      });
      inflightProjectSnapshotsRef.current.delete(normalizedPath);
      loadingProjectSnapshotsRef.current.delete(normalizedPath);
      setProjectSnapshots((previous) => {
        if (!(normalizedPath in previous)) return previous;
        const next = { ...previous };
        delete next[normalizedPath];
        return next;
      });
      invalidateRepoLayoutCacheForPath(normalizedPath);
      await loadRepo(normalizedPath);
      setPendingInitialProjectPath(null);
    } catch (e) {
      setPendingInitialProjectPath(null);
      await invoke('set_main_window_opacity', { alpha: 1 }).catch(() => undefined);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeProject(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    try {
      await invoke('delete_project_cache', { projectId: normalizedPath });
    } catch (error) {
      console.error('Failed to delete project cache:', error);
      setError(`Could not remove project: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    invalidateRepoLayoutCacheForPath(normalizedPath);
    loadNodePositionsSeqRef.current += 1;
    userDirtyNodePositionsRef.current.delete(normalizedPath);
    nodePositionPersistVersionByRepoRef.current = {
      ...nodePositionPersistVersionByRepoRef.current,
      [normalizedPath]: (nodePositionPersistVersionByRepoRef.current[normalizedPath] ?? 0) + 1,
    };
    setNodePositionOverridesByRepo((previous) => {
      if (!(normalizedPath in previous)) return previous;
      const next = { ...previous };
      delete next[normalizedPath];
      return next;
    });
    setManuallyOpenedGridClumpsByRepo((previous) => {
      if (!(normalizedPath in previous)) return previous;
      const next = { ...previous };
      delete next[normalizedPath];
      return next;
    });
    setManuallyClosedGridClumpsByRepo((previous) => {
      if (!(normalizedPath in previous)) return previous;
      const next = { ...previous };
      delete next[normalizedPath];
      return next;
    });
    try {
      window.localStorage.removeItem(nodePositionsStorageKey(normalizedPath));
    } catch {
      // ignore storage failures
    }
    setProjects((previous) => {
      const next = previous.filter((project) => project.path !== normalizedPath);
      try {
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
    try {
      if (repoPath && normalizePath(repoPath).toLowerCase() === normalizedPath.toLowerCase()) {
        window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures
    }
    setProjectSnapshots((previous) => {
      if (!(normalizedPath in previous)) return previous;
      const next = { ...previous };
      delete next[normalizedPath];
      return next;
    });
    delete projectSnapshotSignatureRef.current[normalizedPath];
    delete projectHeadStateRef.current[normalizedPath];
    delete projectQuickStateRef.current[normalizedPath];
    if (repoPath === normalizedPath) {
      const nextPath = projects.find((project) => project.path !== normalizedPath)?.path ?? null;
      if (nextPath) {
        void loadRepo(nextPath);
      } else {
        setRepoPath(null);
        setRepoName('');
        setBranches([]);
        setMergeNodes([]);
        setDirectCommits([]);
        setUnpushedDirectCommits([]);
        setUnpushedCommitShasByBranch({});
        setCheckedOutRef(null);
        setWorktrees([]);
        setStashes([]);
        setBranchCommitPreviews({});
        setBranchParentByName({});
        setLaneByBranch({});
        setBranchUniqueAheadCounts({});
      }
    }
  }

  async function revealProjectInFinder(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    try {
      await invoke('reveal_in_finder', { path: normalizedPath });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copyProjectDiagnostics(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const isActive = sameRepoPath(repoPath, normalizedPath);
    const snapshot = isActive
      ? (() => {
          try {
            return buildActiveRepoSnapshot(normalizedPath);
          } catch {
            return projectSnapshots[normalizedPath] ?? null;
          }
        })()
      : projectSnapshots[normalizedPath] ?? null;
    const project = projects.find((candidate) => sameRepoPath(candidate.path, normalizedPath));
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const appVersion = await getVersion().catch(() => 'unknown');
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      app: {
        version: appVersion,
        userAgent: navigator.userAgent,
      },
      project: {
        name: project?.name ?? snapshot?.name ?? basenameFromPath(normalizedPath),
        path: normalizedPath,
        active: isActive,
        loaded: snapshot?.loaded ?? false,
        snapshotUpdatedAtMs: snapshot?.updatedAtMs ?? null,
        cacheSchemaVersion: snapshot?.cacheSchemaVersion ?? null,
      },
      counts: {
        branches: snapshot?.branches.length ?? 0,
        commits: snapshot?.directCommits.length ?? 0,
        unpushedCommits: snapshot?.unpushedDirectCommits.length ?? 0,
        mergeNodes: snapshot?.mergeNodes.length ?? 0,
        worktrees: snapshot?.worktrees.length ?? 0,
        dirtyWorktrees: snapshot?.worktrees.filter((worktree) => worktree.hasUncommittedChanges).length ?? 0,
        stashes: snapshot?.stashes.length ?? 0,
      },
      loading: projectLoadStates[projectLoadKey(normalizedPath)] ?? null,
      map: isActive ? {
        presentationState: mapPresentationState,
        loading: mapLoading,
        readyForDisplay: mapReadyForDisplay,
        switchEpoch: mapSwitchEpochRef.current,
        layout: mapLayoutStatus,
        renderedNodes: gridLayoutModelForView.renderNodes.length,
        allCommits: gridLayoutModelForView.allCommits.length,
        connectors: gridLayoutModelForView.connectors.length,
        mergeConnectors: gridLayoutModelForView.mergeConnectors.length,
      } : null,
      memory: memory ? {
        usedJSHeapBytes: memory.usedJSHeapSize,
        totalJSHeapBytes: memory.totalJSHeapSize,
        heapLimitBytes: memory.jsHeapSizeLimit,
      } : null,
      recentMapEvents: isActive ? softUpdateDebugEvents.slice(-25) : [],
      currentError: isActive ? error : null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsCopyFeedback('Diagnostics copied');
      window.setTimeout(() => setDiagnosticsCopyFeedback(null), 1800);
    } catch (copyError) {
      console.error('Failed to copy diagnostics:', copyError);
      setDiagnosticsCopyFeedback('Copy failed');
    }
  }

  const handleAddProject = () => {
    void (async () => {
      try {
        const selected = await open({ directory: true, multiple: false, defaultPath: projects[0]?.path ?? undefined });
        if (typeof selected === 'string' && selected) await addProject(selected);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };






  function beginRepoMutation() {
    repoMutationGenerationRef.current += 1;
    repoMutationInFlightRef.current = true;
  }

  function endRepoMutation() {
    repoMutationInFlightRef.current = false;
    pendingRefreshAfterInteractionRef.current = false;
  }

  function buildActiveRepoSnapshot(path: string): RepoVisualSnapshot {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      throw new Error(`Invalid repo path: ${path}`);
    }
    const cached = projectSnapshots[normalizedPath];
    return {
      path: normalizedPath,
      name: repoName,
      defaultBranch,
      branches,
      mergeNodes,
      directCommits,
      unpushedDirectCommits,
      mergeTargetBranchByCommitSha,
      unpushedCommitShasByBranch,
      checkedOutRef,
      worktrees,
      stashes,
      branchCommitPreviews,
      branchParentByName,
      laneByBranch,
      branchUniqueAheadCounts,
      loaded: true,
      cacheSchemaVersion: cached?.cacheSchemaVersion ?? 1,
      updatedAtMs: Date.now(),
    };
  }

  function getSnapshotForMutation(path: string): RepoVisualSnapshot {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      throw new Error(`Invalid repo path: ${path}`);
    }
    if (sameRepoPath(repoPath, normalizedPath)) {
      const snapshot = buildActiveRepoSnapshot(normalizedPath);
      if (latestCheckedOutRef.current) {
        snapshot.checkedOutRef = latestCheckedOutRef.current;
      }
      if (latestWorktreesRef.current.length > 0) {
        snapshot.worktrees = latestWorktreesRef.current;
      }
      return snapshot;
    }
    const cached = projectSnapshots[normalizedPath];
    if (cached?.loaded) {
      return {
        ...cached,
        branches: [...cached.branches],
        mergeNodes: [...cached.mergeNodes],
        directCommits: [...cached.directCommits],
        unpushedDirectCommits: [...cached.unpushedDirectCommits],
        worktrees: [...cached.worktrees],
        stashes: [...cached.stashes],
        branchCommitPreviews: { ...cached.branchCommitPreviews },
        branchParentByName: { ...cached.branchParentByName },
        laneByBranch: { ...cached.laneByBranch },
        branchUniqueAheadCounts: { ...cached.branchUniqueAheadCounts },
        unpushedCommitShasByBranch: { ...cached.unpushedCommitShasByBranch },
        mergeTargetBranchByCommitSha: { ...cached.mergeTargetBranchByCommitSha },
        checkedOutRef: cached.checkedOutRef ? { ...cached.checkedOutRef } : null,
      };
    }
    throw new Error(`No snapshot available for ${normalizedPath}`);
  }

  function isPostCommitProtectionActive(path: string): boolean {
    const normalizedPath = normalizePath(path);
    return Boolean(normalizedPath && postCommitProtectedHeadShaRef.current[normalizedPath]);
  }

  function invalidateRepoLayoutCacheForPath(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    for (const key of layoutModelCacheRef.current.keys()) {
      if (key.split('|')[1] === normalizedPath) {
        layoutModelCacheRef.current.delete(key);
      }
    }
    for (const key of persistedLayoutKeysRef.current) {
      if (key.split('|')[1] === normalizedPath) {
        persistedLayoutKeysRef.current.delete(key);
      }
    }
    for (const key of persistedLayoutPayloadHashRef.current.keys()) {
      if (key.split('|')[1] === normalizedPath) {
        persistedLayoutPayloadHashRef.current.delete(key);
      }
    }
    if (sameRepoPath(repoPath, normalizedPath)) {
      setHydratedLayoutModel(null);
      setHydratedLayoutKey(null);
    }
  }

  /** Drop cached layout/clumps and recompute the map from current React graph state. */
  function redrawRepoGraph(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    invalidateRepoLayoutCacheForPath(normalizedPath);
    lastResolvedLayoutModelRef.current = null;
    setLayoutEpoch((epoch) => epoch + 1);
  }

  async function syncCheckedOutRefFromQuickGitState(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || !sameRepoPath(repoPath, normalizedPath)) return;
    const quickState = await invoke<RepoQuickState>('get_repo_quick_state', { repoPath: path }).catch(() => null);
    if (!quickState) return;
    flushSync(() => {
      setCheckedOutRef((previous) => {
        if (!previous) return previous;
        let snapshot: RepoVisualSnapshot;
        try {
          snapshot = getSnapshotForMutation(normalizedPath);
        } catch {
          return previous;
        }
        const merged = mergeCheckedOutRefWithQuickState(previous, quickState, snapshot);
        if (
          previous.headSha === merged.headSha
          && previous.hasUncommittedChanges === merged.hasUncommittedChanges
          && (previous.parentSha ?? null) === (merged.parentSha ?? null)
        ) {
          return previous;
        }
        latestCheckedOutRef.current = merged;
        return merged;
      });
    });
    projectQuickStateRef.current = {
      ...projectQuickStateRef.current,
      [normalizedPath]: quickStateSignature(quickState),
    };
  }

  function bustRepoSyncCachesForPath(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    if (normalizedPath in projectQuickStateRef.current) {
      const next = { ...projectQuickStateRef.current };
      delete next[normalizedPath];
      projectQuickStateRef.current = next;
    }
    if (normalizedPath in lastFullGraphRefreshAtRef.current) {
      const next = { ...lastFullGraphRefreshAtRef.current };
      delete next[normalizedPath];
      lastFullGraphRefreshAtRef.current = next;
    }
  }

  async function releasePostCommitProtectionAfterReconcile(
    path: string,
    protectedSha: string,
    attempt = 0,
  ) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || postCommitProtectedHeadShaRef.current[normalizedPath] !== protectedSha) {
      return;
    }
    try {
      const snapshot = getSnapshotForMutation(normalizedPath);
      if (!snapshotContainsCommitSha(snapshot, protectedSha)) {
        if (attempt >= POST_COMMIT_RELEASE_MAX_ATTEMPTS) {
          clearPostCommitProtectionForPath(normalizedPath);
          if (sameRepoPath(repoPath, normalizedPath)) {
            gitActivityEpochRef.current += 1;
            void runRepoRefreshRef.current?.('graph');
          }
          return;
        }
        window.setTimeout(() => {
          void releasePostCommitProtectionAfterReconcile(normalizedPath, protectedSha, attempt + 1);
        }, 2000);
        return;
      }
    } catch {
      return;
    }
    clearPostCommitProtectionForPath(normalizedPath);
    if (sameRepoPath(repoPath, normalizedPath)) {
      focusCameraOnActiveWorktreeRef.current?.();
      if (pendingRefreshAfterInteractionRef.current) {
        pendingRefreshAfterInteractionRef.current = false;
        void runRepoRefreshRef.current?.('quick');
      }
    }
  }

  async function clearStalePostCommitProtectionFromLiveHead(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return false;
    const protectedSha = postCommitProtectedHeadShaRef.current[normalizedPath];
    if (!protectedSha) return false;
    const quickState = await invoke<RepoQuickState>('get_repo_quick_state', { repoPath: normalizedPath }).catch(
      () => null,
    );
    const liveHead = quickState?.headSha?.trim();
    if (!liveHead || isWorkingTreeCommitId(liveHead) || liveHead === protectedSha) return false;
    clearPostCommitProtectionForPath(normalizedPath);
    gitActivityEpochRef.current += 1;
    return true;
  }

  function schedulePostCommitGraphReconcile(path: string, protectedSha: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    pendingRefreshAfterInteractionRef.current = false;
    invalidateRepoLayoutCacheForPath(normalizedPath);
    if (sameRepoPath(repoPath, normalizedPath)) {
      try {
        const live = getSnapshotForMutation(normalizedPath);
        if (snapshotContainsCommitSha(live, protectedSha)) {
          clearPostCommitProtectionForPath(normalizedPath);
          setLayoutEpoch((epoch) => epoch + 1);
          autoFocusSyncKeyRef.current = null;
          focusCameraOnActiveWorktreeRef.current?.();
          return;
        }
      } catch {
        // fall through to graph refresh when live snapshot is unavailable
      }
    }
    if (!sameRepoPath(repoPath, normalizedPath)) return;
    setLayoutEpoch((epoch) => epoch + 1);
    autoFocusSyncKeyRef.current = null;
    gitActivityEpochRef.current += 1;
    void runRepoRefreshRef.current?.('graph').then(() => {
      void releasePostCommitProtectionAfterReconcile(normalizedPath, protectedSha);
    });
  }

  function clearPostCommitProtectionTimeout(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const timeoutId = postCommitProtectTimeoutRef.current[normalizedPath];
    if (timeoutId == null) return;
    window.clearTimeout(timeoutId);
    delete postCommitProtectTimeoutRef.current[normalizedPath];
  }

  function clearPostCommitProtectionForPath(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    clearPostCommitProtectionTimeout(normalizedPath);
    const next = { ...postCommitProtectedHeadShaRef.current };
    delete next[normalizedPath];
    postCommitProtectedHeadShaRef.current = next;
  }

  function protectPostCommitHead(path: string, headSha: string | null | undefined) {
    const normalizedPath = normalizePath(path);
    const sha = headSha?.trim();
    if (!normalizedPath || !sha || isWorkingTreeCommitId(sha)) return;
    if (postCommitProtectedHeadShaRef.current[normalizedPath] === sha) return;
    clearPostCommitProtectionTimeout(normalizedPath);
    postCommitProtectedHeadShaRef.current = {
      ...postCommitProtectedHeadShaRef.current,
      [normalizedPath]: sha,
    };
    postCommitProtectTimeoutRef.current[normalizedPath] = window.setTimeout(() => {
      delete postCommitProtectTimeoutRef.current[normalizedPath];
      if (postCommitProtectedHeadShaRef.current[normalizedPath] !== sha) return;
      schedulePostCommitGraphReconcile(normalizedPath, sha);
    }, POST_COMMIT_HEAD_PROTECT_MS);
  }

function shouldBlockIncomingSnapshotApply(path: string, incoming: RepoVisualSnapshot): boolean {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return false;
    let guard: string | undefined = postCommitProtectedHeadShaRef.current[normalizedPath];
    try {
      const live = getSnapshotForMutation(normalizedPath);
      const liveBranch = live.checkedOutRef?.branchName ?? null;
      const incomingBranch = incoming.checkedOutRef?.branchName ?? null;
      if (guard && liveBranch && incomingBranch && liveBranch !== incomingBranch) {
        clearPostCommitProtectionForPath(normalizedPath);
        guard = undefined;
      }
      return shouldBlockIncomingSnapshotApplyGuard(live, incoming, guard);
    } catch {
      return false;
    }
  }

function mergeOptionsForRepo(path: string): MergeCheckedOutRefOptions | undefined {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return undefined;
    const guard = postCommitProtectedHeadShaRef.current[normalizedPath];
    return guard ? { protectedHeadSha: guard } : undefined;
  }

  function mutationChangesWorktreeLayout(
    previous: RepoVisualSnapshot | null,
    next: RepoVisualSnapshot,
  ): boolean {
    if ((previous?.worktrees.length ?? 0) === 0 && next.worktrees.length === 0) return false;
    if (formatWorktreeLayoutSignature(previous?.worktrees ?? []) !== formatWorktreeLayoutSignature(next.worktrees)) {
      return true;
    }
    const prevRef = previous?.checkedOutRef;
    const nextRef = next.checkedOutRef;
    if (!prevRef || !nextRef) return next.worktrees.length > 0;
    return (
      prevRef.headSha !== nextRef.headSha
      || prevRef.branchName !== nextRef.branchName
      || (prevRef.parentSha ?? null) !== (nextRef.parentSha ?? null)
    );
  }

  function schedulePostMutationGraphReconcile(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    window.setTimeout(() => {
      void reconcileProjectSnapshotAfterMutation(normalizedPath);
    }, 50);
  }

  async function reloadRepoSnapshotFromGit(
    path: string,
  ): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || !sameRepoPath(repoPath, normalizedPath)) return false;

    if (reloadRepoSnapshotInFlightRef.current) {
      reloadRepoSnapshotPendingRef.current = true;
      pendingRefreshAfterInteractionRef.current = true;
      scheduleDeferredRepoRefreshRef.current?.('reload in flight');
      return false;
    }

    if (repoMutationInFlightRef.current || reconcileInFlightRef.current) {
      pendingRefreshAfterInteractionRef.current = true;
      scheduleDeferredRepoRefreshRef.current?.('reload mutation');
      return false;
    }
    if (isMapInteractingRef.current || !canApplyRepoRefreshRef.current) {
      pendingRefreshAfterInteractionRef.current = true;
      scheduleDeferredRepoRefreshRef.current?.('reload blocked');
      setMapGridBackgroundActivity('git-refresh-pending', 'Git refresh queued', true, 'blocked');
      return false;
    }

    reloadRepoSnapshotInFlightRef.current = true;
    bustRepoSyncCachesForPath(normalizedPath);
    setMapGridBackgroundActivity('git-refresh', 'Reload repo from git', true, 'git-activity');

    try {
      await invoke('persist_project_snapshot', { projectId: normalizedPath, force: true }).catch((error) => {
        console.warn('Git reload persist failed:', error);
      });

      const record = await invoke<ProjectSnapshotRecord | null>('load_project_snapshot', {
        projectId: normalizedPath,
      }).catch(() => null);
      let nextSnapshot = toRepoVisualSnapshot(record);
      if (!nextSnapshot) return false;

      // Abort if a mutation started during the async database call
      if (repoMutationInFlightRef.current || reconcileInFlightRef.current) {
        pendingRefreshAfterInteractionRef.current = true;
        scheduleDeferredRepoRefreshRef.current?.('reload mutation during persist');
        return false;
      }

      if (shouldBlockIncomingSnapshotApply(normalizedPath, nextSnapshot)) {
        const clearedStaleProtection = await clearStalePostCommitProtectionFromLiveHead(normalizedPath);
        if (!clearedStaleProtection) {
          pendingRefreshAfterInteractionRef.current = true;
          scheduleDeferredRepoRefreshRef.current?.('reload protected-head block');
          return false;
        }
      }

      nextSnapshot = await reconcileSnapshotForProjectSwitch(normalizedPath, nextSnapshot);
      if (shouldBlockIncomingSnapshotApply(normalizedPath, nextSnapshot)) {
        const clearedStaleProtection = await clearStalePostCommitProtectionFromLiveHead(normalizedPath);
        if (!clearedStaleProtection) {
          pendingRefreshAfterInteractionRef.current = true;
          scheduleDeferredRepoRefreshRef.current?.('reload protected-head block after reconcile');
          return false;
        }
      }

      // Abort if a mutation started during the async reconciliation call
      if (repoMutationInFlightRef.current || reconcileInFlightRef.current) {
        pendingRefreshAfterInteractionRef.current = true;
        scheduleDeferredRepoRefreshRef.current?.('reload mutation during reconcile');
        return false;
      }

      const prevCheckedOutRef = latestCheckedOutRef.current;
      flushSync(() => {
        applyPatchedSnapshot(normalizedPath, nextSnapshot, true, {
          force: true,
          skipLayoutRebuild: false,
        });
      });
      await syncCheckedOutRefFromQuickGitState(path);

      const nextCheckedOutRef = latestCheckedOutRef.current;
      const headChanged = prevCheckedOutRef && nextCheckedOutRef && nextCheckedOutRef.headSha !== prevCheckedOutRef.headSha;
      const branchChanged = prevCheckedOutRef && nextCheckedOutRef && nextCheckedOutRef.branchName !== prevCheckedOutRef.branchName;
      if (headChanged || branchChanged) {
        autoFocusSyncKeyRef.current = null;
        focusCameraOnActiveWorktreeRef.current?.();
      }

      pendingRefreshAfterInteractionRef.current = false;
      markGitActivityHandled();
      return true;
    } catch (error) {
      console.warn('Git snapshot reload failed:', error);
      return false;
    } finally {
      setMapGridBackgroundActivity('git-refresh', 'Reload repo from git', false);
      reloadRepoSnapshotInFlightRef.current = false;
      if (reloadRepoSnapshotPendingRef.current) {
        reloadRepoSnapshotPendingRef.current = false;
        window.setTimeout(() => {
          void reloadRepoSnapshotFromGit(path);
        }, 50);
      }
    }
  }

  async function reconcileProjectSnapshotAfterMutation(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || !sameRepoPath(repoPath, normalizedPath)) return;
    if (repoMutationInFlightRef.current || reconcileInFlightRef.current) return;
    reconcileInFlightRef.current = true;
    try {
      gitActivityEpochRef.current += 1;
      await reloadRepoSnapshotFromGit(normalizedPath);
    } finally {
      reconcileInFlightRef.current = false;
      pendingRefreshAfterInteractionRef.current = false;
    }
  }

  function applyPatchedSnapshot(
    path: string,
    patched: RepoVisualSnapshot,
    layoutTopologyChanged: boolean,
    options?: { force?: boolean; previousSnapshot?: RepoVisualSnapshot | null; skipLayoutRebuild?: boolean },
  ) {
    const normalizedPath = normalizePath(path);
    const force = options?.force === true;
    const patchedSignature = getRepoVisualSnapshotSignature(patched);
    if (
      sameRepoPath(repoPath, normalizedPath)
      && activeSnapshotSignatureRef.current === patchedSignature
    ) {
      upsertProjectSnapshot(normalizedPath, patched, { force });
      projectQuickStateRef.current = {
        ...projectQuickStateRef.current,
        [normalizedPath]: quickStateSignature(quickStateFromSnapshot(normalizedPath, patched)),
      };
      return;
    }
    let previousSnapshot = options?.previousSnapshot ?? null;
    if (previousSnapshot === null) {
      try {
        previousSnapshot = getSnapshotForMutation(normalizedPath);
      } catch {
        previousSnapshot = null;
      }
    }
    const needsLayoutRebuild = !options?.skipLayoutRebuild
      && (layoutTopologyChanged || mutationChangesWorktreeLayout(previousSnapshot, patched));
    const previousUnpushedSignature = previousSnapshot
      ? previousSnapshot.unpushedDirectCommits.map((commit) => commit.fullSha).sort().join('|')
      : '';
    const nextUnpushedSignature = patched.unpushedDirectCommits.map((commit) => commit.fullSha).sort().join('|');
    const unpushedStateChanged = previousUnpushedSignature !== nextUnpushedSignature;
    noteSoftUpdateDebug('applyPatchedSnapshot', {
      path: normalizedPath.split('/').pop() ?? normalizedPath,
      force,
      layoutTopologyChanged,
      needsLayoutRebuild,
      skipLayoutRebuild: options?.skipLayoutRebuild === true,
      worktreeSig: formatWorktreeLayoutSignature(patched.worktrees),
    });
    upsertProjectSnapshot(normalizedPath, patched, { force });
    projectQuickStateRef.current = {
      ...projectQuickStateRef.current,
      [normalizedPath]: quickStateSignature(quickStateFromSnapshot(normalizedPath, patched)),
    };
    if (sameRepoPath(repoPath, normalizedPath)) {
      const applied = applySnapshotToActiveState(normalizedPath, patched, {
        force,
        allowIncomingDirty: force,
        needsLayoutRebuild,
      });
      if (applied && !force && needsLayoutRebuild) {
        redrawRepoGraph(normalizedPath);
      } else if (applied && unpushedStateChanged && !force) {
        invalidateRepoLayoutCacheForPath(normalizedPath);
        setHydratedLayoutModel(null);
        setHydratedLayoutKey(null);
      }
    }
  }

  const mutationOutcomeNeedsImmediateApply = (outcomes: RepoMutationOutcome[]): boolean =>
    outcomes.some((outcome) => (
      outcome.kind === 'commit'
      || outcome.kind === 'push'
      || outcome.kind === 'discardDirty'
      || outcome.kind === 'markDirty'
      || outcome.kind === 'checkout'
      || outcome.kind === 'stashPush'
      || outcome.kind === 'stashRestore'
      || outcome.kind === 'branchDelete'
    ));

  async function refreshRepoAfterMutationFull(
    path: string,
    options?: { immediate?: boolean; forceApply?: boolean },
  ) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const immediate = options?.immediate === true;
    const forceApply = options?.forceApply === true;

    const applyGeneration = repoMutationGenerationRef.current;
    const result = await invoke<RefreshProjectResult>('refresh_project_if_changed', {
      projectId: normalizedPath,
    }).catch(() => null);
    if (!result) return;
    if (!forceApply && applyGeneration !== repoMutationGenerationRef.current) return;

    const quickState = await invoke<RepoQuickState>('get_repo_quick_state', {
      repoPath: normalizedPath,
    }).catch(() => null);

    const applyReconciledSnapshot = async (base: RepoVisualSnapshot, layoutTopologyChanged = true) => {
      const nextSnapshot = await reconcileSnapshotForProjectSwitch(normalizedPath, base);
      if (!forceApply && applyGeneration !== repoMutationGenerationRef.current) return;
      await yieldToPaint();
      if (!forceApply && applyGeneration !== repoMutationGenerationRef.current) return;
      const applySnapshot = () => {
        applyPatchedSnapshot(normalizedPath, nextSnapshot, layoutTopologyChanged, { force: true });
      };
      if (immediate) flushSync(applySnapshot);
      else startTransition(applySnapshot);
    };

    if (!result.updated) {
      if (forceApply && sameRepoPath(repoPath, normalizedPath)) {
        try {
          await applyReconciledSnapshot(getSnapshotForMutation(normalizedPath), true);
          return;
        } catch {
          // fall through to quick ref sync
        }
      }
      if (quickState && sameRepoPath(repoPath, normalizedPath)) {
        projectQuickStateRef.current = {
          ...projectQuickStateRef.current,
          [normalizedPath]: quickStateSignature(quickState),
        };
        const syncRef = () => {
          setCheckedOutRef((previous) => {
            if (!previous) return previous;
            return {
              ...previous,
              headSha: quickState.headSha,
              hasUncommittedChanges: quickState.hasUncommittedChanges,
              parentSha: quickState.upstreamSha ?? previous.parentSha,
            };
          });
        };
        if (immediate) flushSync(syncRef);
        else startTransition(syncRef);
      }
      return;
    }

    const incoming = toRepoVisualSnapshot(result.snapshot ?? null);
    if (!incoming) return;

    await applyReconciledSnapshot(incoming, true);
  }

  async function finalizeRepoMutation(path: string, ...outcomes: RepoMutationOutcome[]) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || outcomes.length === 0) {
      endRepoMutation();
      return;
    }

    const applyGeneration = repoMutationGenerationRef.current;
    try {
      if (outcomes.some((outcome) => outcome.kind === 'fullRefresh')) {
        await refreshRepoAfterMutationFull(normalizedPath);
        return;
      }

      const previousSnapshot = getSnapshotForMutation(normalizedPath);
      let snapshot = previousSnapshot;
      for (const outcome of outcomes) {
        snapshot = applyMutationPatch(snapshot, outcome);
      }
      const layoutTopologyChanged = outcomes.some((outcome) => outcome.layoutTopologyChanged);
      const isCommit = outcomes.some((outcome) => outcome.kind === 'commit');
      const isStashPush = outcomes.some((outcome) => outcome.kind === 'stashPush');
      const isPush = outcomes.some((outcome) => outcome.kind === 'push');
      const commitOutcome = isCommit
        ? outcomes.find((outcome): outcome is RepoMutationOutcome & { kind: 'commit' } => outcome.kind === 'commit')
        : undefined;

      if (isCommit || isStashPush) {
        const worktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath: normalizedPath }).catch(
          () => [] as WorktreeInfo[],
        );
        noteSoftUpdateDebug(isCommit ? 'post-commit worktree sync' : 'post-stash worktree sync', {
          count: worktrees.length,
          worktrees: worktrees.map((worktree) => ({
            path: normalizePath(worktree.path).split('/').pop() ?? worktree.path,
            branch: worktree.branchName,
            head: worktree.headSha.slice(0, 7),
            parent: worktree.parentSha?.slice(0, 7) ?? 'none',
            dirty: worktree.hasUncommittedChanges,
            current: worktree.isCurrent,
          })),
        });
        snapshot = applyMutationPatch(snapshot, outcomeFromWorktreeSync(worktrees));
      }

      if (isCommit) {
        protectPostCommitHead(
          normalizedPath,
          snapshot.checkedOutRef?.headSha ?? commitOutcome?.commit.fullSha ?? null,
        );
      }

      // Push uses optimistic patchPush; background reconcile refreshes metadata without blocking here.

      await yieldToPaint();
      if (!isCommit && !isPush && !isStashPush && applyGeneration !== repoMutationGenerationRef.current) return;

      const immediateApply = mutationOutcomeNeedsImmediateApply(outcomes);
      const patchApplyOptions = {
        force: true as const,
        previousSnapshot,
        skipLayoutRebuild: outcomes.every((outcome) => outcome.kind === 'stashSync'),
      };
      noteSoftUpdateDebug('apply mutation snapshot', {
        kinds: outcomes.map((outcome) => outcome.kind).join(','),
        immediate: immediateApply,
        layoutTopologyChanged,
        checkedOut: snapshot.checkedOutRef
          ? `${snapshot.checkedOutRef.branchName ?? 'detached'}@${snapshot.checkedOutRef.headSha.slice(0, 7)} parent=${snapshot.checkedOutRef.parentSha?.slice(0, 7) ?? 'none'} dirty=${snapshot.checkedOutRef.hasUncommittedChanges}`
          : 'none',
      });
      if (immediateApply) {
        flushSync(() => {
          for (const outcome of outcomes) {
            if (outcome.kind === 'commit') migrateCommittedWorktreeNodePosition(outcome.commit);
          }
          applyPatchedSnapshot(normalizedPath, snapshot, layoutTopologyChanged, patchApplyOptions);
        });
      } else {
        startTransition(() => {
          for (const outcome of outcomes) {
            if (outcome.kind === 'commit') migrateCommittedWorktreeNodePosition(outcome.commit);
          }
          applyPatchedSnapshot(normalizedPath, snapshot, layoutTopologyChanged, patchApplyOptions);
        });
      }

      if (isCommit || isPush || isStashPush) {
        if (isCommit) {
          autoFocusSyncKeyRef.current = null;
          const focusSha = resolveActiveWorktreeFocusSha(
            buildWorktreeSessions(snapshot.worktrees, normalizedPath, snapshot.checkedOutRef),
            normalizedPath,
          ) ?? commitOutcome?.commit.fullSha ?? null;
          if (focusSha && !readHasSavedMapGridCamera(normalizedPath, mapGridOrientation)) {
            setGridFocusSha(focusSha);
            setGridSearchJumpToken((token) => token + 1);
          }
          schedulePostCommitQuickReconcile(normalizedPath);
        }
        markGitActivityHandled();
        if (!isStashPush) {
          schedulePostMutationGraphReconcile(normalizedPath);
        } else {
          window.setTimeout(() => {
            void invoke('persist_project_snapshot', { projectId: normalizedPath }).catch((error) => {
              console.warn('Background snapshot persist failed:', error);
            });
          }, PERSIST_SNAPSHOT_DEFER_MS);
        }
      } else {
        const hasBranchDeleteOutcome = outcomes.some((o) => o.kind === 'branchDelete');
        window.setTimeout(() => {
          const persistArgs: Record<string, unknown> = { projectId: normalizedPath };
          if (hasBranchDeleteOutcome) persistArgs.force = true;
          void invoke('persist_project_snapshot', persistArgs).catch((error) => {
            console.warn('Background snapshot persist failed:', error);
          });
        }, PERSIST_SNAPSHOT_DEFER_MS);
      }
    } finally {
      endRepoMutation();
    }
  }

  function schedulePostCommitQuickReconcile(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const delaysMs = [200, 600, 1500];
    for (const delayMs of delaysMs) {
      window.setTimeout(() => {
        if (repoMutationInFlightRef.current) return;
        void (async () => {
          const quickState = await invoke<RepoQuickState>('get_repo_quick_state', {
            repoPath: normalizedPath,
          }).catch(() => null);
          if (!quickState) return;
          let snapshot: RepoVisualSnapshot;
          try {
            snapshot = getSnapshotForMutation(normalizedPath);
          } catch {
            return;
          }
          const ref = snapshot.checkedOutRef;
          if (!ref || quickState.headSha !== ref.headSha) return;
          projectQuickStateRef.current = {
            ...projectQuickStateRef.current,
            [normalizedPath]: quickStateSignature(quickState),
          };
        })();
      }, delayMs);
    }
  }

  function reconcileCheckedOutRefFromQuickState(
    snapshot: RepoVisualSnapshot,
    quickState: RepoQuickState | null,
    path: string,
    options?: { trustLiveGitDirty?: boolean },
  ): CheckedOutRef | null {
    if (!quickState) return snapshot.checkedOutRef;
    const base = snapshot.checkedOutRef ?? {
      branchName: null,
      headSha: quickState.headSha,
      hasUncommittedChanges: quickState.hasUncommittedChanges,
      parentSha: quickState.upstreamSha ?? null,
    };
    const mergeOpts = options?.trustLiveGitDirty ? undefined : mergeOptionsForRepo(path);
    return mergeCheckedOutRefWithQuickState(base, quickState, snapshot, mergeOpts);
  }

async function reconcileSnapshotForProjectSwitch(
    path: string,
    snapshot: RepoVisualSnapshot,
  ): Promise<RepoVisualSnapshot> {
    void syncActivePreviewTarget(path);
    const [quickState, worktrees] = await Promise.all([
      invoke<RepoQuickState>('get_repo_quick_state', { repoPath: path }).catch(() => null),
      invoke<WorktreeInfo[]>('list_worktrees', { repoPath: path }).catch(() => [] as WorktreeInfo[]),
    ]);

    let next = mergeSnapshotCheckedOutRefWithQuickState(snapshot, quickState, mergeOptionsForRepo(path));
    next = applyMutationPatch(next, outcomeFromWorktreeSync(worktrees));

    const reconciledRef = reconcileCheckedOutRefFromQuickState(next, quickState, path);
    if (!reconciledRef || !quickState) {
      return next;
    }

    const wasDirty = next.checkedOutRef?.hasUncommittedChanges ?? false;
    const isDirty = reconciledRef.hasUncommittedChanges;
    if (wasDirty !== isDirty) {
      return applyMutationPatch(
        next,
        isDirty ? outcomeFromMarkDirty(reconciledRef) : outcomeFromDiscardDirty(reconciledRef),
      );
    }

    if (
      next.checkedOutRef?.headSha !== reconciledRef.headSha
      || (next.checkedOutRef?.parentSha ?? null) !== (reconciledRef.parentSha ?? null)
    ) {
      return applyMutationPatch(next, outcomeFromUpstreamSync(reconciledRef));
    }

    return next;
  }

  async function resolveSnapshotForProjectSwitch(path: string): Promise<RepoVisualSnapshot> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      throw new Error(`Invalid repo path: ${path}`);
    }

    try {
      const localRaw = window.localStorage.getItem(`optimistic_snapshot:${normalizedPath}`);
      if (localRaw) {
        const localSnapshot = JSON.parse(localRaw) as RepoVisualSnapshot;
        if (localSnapshot?.loaded) {
          return reconcileSnapshotForProjectSwitch(normalizedPath, localSnapshot);
        }
      }
    } catch (e) {
      console.warn('[optimistic-cache] failed to load or validate from localStorage:', e);
    }

    let snapshot = await loadProjectSnapshot(normalizedPath, false, true);
    if (!snapshot?.loaded) {
      snapshot = await loadProjectSnapshot(normalizedPath, true);
    }
    if (!snapshot?.loaded) {
      throw new Error(`No snapshot available for ${normalizedPath}`);
    }

    return reconcileSnapshotForProjectSwitch(normalizedPath, snapshot);
  }

function finalizeProjectSwitchSnapshot(path: string, snapshot: RepoVisualSnapshot) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    upsertProjectSnapshot(normalizedPath, snapshot, { force: true });
    projectQuickStateRef.current = {
      ...projectQuickStateRef.current,
      [normalizedPath]: quickStateSignature(quickStateFromSnapshot(normalizedPath, snapshot)),
    };
    lastHandledGitActivityEpochRef.current = gitActivityEpochRef.current;

    window.setTimeout(() => {
      void invoke('persist_project_snapshot', { projectId: normalizedPath }).catch((error) => {
        console.warn('Project switch snapshot persist failed:', error);
      });
    }, PERSIST_SNAPSHOT_DEFER_MS);
  }




  async function yieldToPaint() {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function beginMapSwitch() {
    const nextEpoch = mapSwitchEpochRef.current + 1;
    mapSwitchEpochRef.current = nextEpoch;
    lastResolvedLayoutModelRef.current = null;
    setHydratedLayoutModel(null);
    setHydratedLayoutKey(null);
    setMapSwitchEpoch(nextEpoch);
    setMapReadyForDisplay(false);
    setMapPresentationState('loading');
    return nextEpoch;
  }

  function finishMapSwitch(epoch: number, nextState: MapPresentationState = 'ready') {
    if (epoch !== mapSwitchEpochRef.current) return;
    setMapLoading(false);
    isRepoSwitchingRef.current = false;
    if (nextState === 'ready') {
      setMapReadyForDisplay(true);
    }
    setMapPresentationState(nextState);
  }



  function applySnapshotToActiveState(
    path: string,
    snapshot: RepoVisualSnapshot,
    options?: { force?: boolean; allowIncomingDirty?: boolean; allowProjectSwitch?: boolean; needsLayoutRebuild?: boolean },
  ) {
    if (!canApplyActiveRepoSnapshot(path, currentRepoPathRef.current, options?.allowProjectSwitch === true)) {
      return false;
    }
    if (
      sameRepoPath(repoPath, path)
      && options?.force !== true
    ) {
      try {
        const live = buildActiveRepoSnapshot(path);
        if (isIncomingSnapshotStaleComparedToLive(snapshot, live)) {
          setMapGridBackgroundActivity('snapshot-apply', 'Apply repo snapshot', false);
          return false;
        }
      } catch {
        // keep applying when live snapshot cannot be built
      }
    }
    if (!options?.force && (isMapInteractingRef.current || !canApplyRepoRefreshRef.current)) {
      pendingRefreshAfterInteractionRef.current = true;
      setMapGridBackgroundActivity('git-refresh-pending', 'Git refresh queued', true, 'snapshot deferred');
      return false;
    }
    const signature = getRepoVisualSnapshotSignature(snapshot);
    if (
      activeSnapshotSignatureRef.current === signature
      && options?.force !== true
    ) {
      return false;
    }
    if (shouldBlockIncomingSnapshotApply(path, snapshot)) {
      setMapGridBackgroundActivity('snapshot-apply', 'Apply repo snapshot', false);
      return false;
    }
    setMapGridBackgroundActivity('snapshot-apply', 'Apply repo snapshot', true);
    latestBranchesRef.current = snapshot.branches;
    latestDirectCommitsRef.current = snapshot.directCommits;
    latestBranchCommitPreviewsRef.current = stripWorkingTreeFromPreviews(snapshot.branchCommitPreviews);
    latestUnpushedDirectCommitsRef.current = snapshot.unpushedDirectCommits;
    latestWorktreesRef.current = snapshot.worktrees;
    latestStashesRef.current = snapshot.stashes;
    latestUnpushedCommitShasByBranchRef.current = snapshot.unpushedCommitShasByBranch;
    latestMergeNodesRef.current = snapshot.mergeNodes;
    latestBranchParentByNameRef.current = snapshot.branchParentByName ?? {};
    activeSnapshotSignatureRef.current = signature;
    setRepoName(snapshot.name || basenameFromPath(path));
    setDefaultBranch(snapshot.defaultBranch || 'main');
    setBranches(snapshot.branches);
    setMergeNodes(snapshot.mergeNodes);
    setDirectCommits(snapshot.directCommits);
    setUnpushedDirectCommits(snapshot.unpushedDirectCommits);
    setUnpushedCommitShasByBranch(snapshot.unpushedCommitShasByBranch);

    const previousCheckedOutRef = latestCheckedOutRef.current;
    const incomingCheckedOutRef = snapshot.checkedOutRef;
    const isProjectSwitch = !sameRepoPath(path, repoPath);
    let nextCheckedOutRef = incomingCheckedOutRef;
    if (
      !isProjectSwitch &&
      !options?.allowIncomingDirty &&
      incomingCheckedOutRef &&
      previousCheckedOutRef &&
      !previousCheckedOutRef.hasUncommittedChanges &&
      incomingCheckedOutRef.hasUncommittedChanges
    ) {
      nextCheckedOutRef = {
        ...incomingCheckedOutRef,
        headSha: previousCheckedOutRef.headSha || incomingCheckedOutRef.headSha,
        hasUncommittedChanges: false,
        parentSha: previousCheckedOutRef.parentSha ?? incomingCheckedOutRef.parentSha,
      };
    }
    latestCheckedOutRef.current = nextCheckedOutRef;
    setCheckedOutRef(nextCheckedOutRef);
    setWorktrees(snapshot.worktrees);
    setStashes(snapshot.stashes);
    setBranchCommitPreviews(stripWorkingTreeFromPreviews(snapshot.branchCommitPreviews));
    setBranchParentByName(snapshot.branchParentByName ?? {});
    setLaneByBranch(snapshot.laneByBranch ?? {});
    setBranchUniqueAheadCounts(snapshot.branchUniqueAheadCounts);
    const normalizedPath = normalizePath(path);
    if (normalizedPath) {
      currentRepoPathRef.current = normalizedPath;
    }
    setRepoPath(path);
    setMapGridBackgroundActivity('snapshot-apply', 'Apply repo snapshot', false);
    setMapGridBackgroundActivity('git-refresh-pending', 'Git refresh queued', false);
    const switchedProject = options?.allowProjectSwitch === true && isProjectSwitch;
    if (options?.force === true && (options?.needsLayoutRebuild === true || switchedProject)) {
      setLayoutEpoch((epoch) => epoch + 1);
      redrawRepoGraph(path);
      void syncCheckedOutRefFromQuickGitState(path);
    }

    return true;
  }


  async function loadRepo(path: string, options?: { allowSamePathInFlight?: boolean }) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    if (!options?.allowSamePathInFlight && sameRepoPath(loadRepoInFlightPathRef.current, normalizedPath)) return;
    loadRepoInFlightPathRef.current = normalizedPath;
    const requestId = ++loadRepoRequestIdRef.current;
    const loadKey = projectLoadKey(normalizedPath);
    setProjectLoadStates((previous) => ({
      ...previous,
      [loadKey]: { status: 'loading', phase: 'Loading snapshot', progress: 1 },
    }));

    const previousPath = repoPath ? normalizePath(repoPath) : null;
    const keepCurrentRepoVisible = Boolean(previousPath && !sameRepoPath(previousPath, normalizedPath));
    if (previousPath && !sameRepoPath(previousPath, normalizedPath)) {
      clearPostCommitProtectionForPath(normalizedPath);
      try {
        upsertProjectSnapshot(previousPath, buildActiveRepoSnapshot(previousPath), { force: true });
      } catch {
        // Active repo state unavailable — cached snapshot remains as-is.
      }
    }

    let switchEpoch: number | null = null;
    const ensureMapSwitchStarted = () => {
      if (switchEpoch != null) return switchEpoch;
      activeSnapshotSignatureRef.current = null;
      switchEpoch = beginMapSwitch();
      setHydratedLayoutModel(null);
      setHydratedLayoutKey(null);
      isRepoSwitchingRef.current = true;
      setMapLoading(true);
      return switchEpoch;
    };
    let hasError = false;
    if (repoPath && sharedGridLayoutCacheKey) {
      layoutModelCacheRef.current.set(sharedGridLayoutCacheKey, sharedGridLayoutModel);
    }
    if (!keepCurrentRepoVisible) {
      ensureMapSwitchStarted();
    }
    setLoading(!keepCurrentRepoVisible);
    setError(null);
    await yieldToPaint();
    if (requestId !== loadRepoRequestIdRef.current) {
      if (sameRepoPath(loadRepoInFlightPathRef.current, normalizedPath)) loadRepoInFlightPathRef.current = null;
      return;
    }

    let cachedSnapshot: RepoVisualSnapshot | null = null;
    let snapshotResolveError: unknown = null;
    try {
      cachedSnapshot = await resolveSnapshotForProjectSwitch(normalizedPath);
    } catch (loadError) {
      snapshotResolveError = loadError;
      cachedSnapshot = projectSnapshots[normalizedPath] ?? null;
    }
    if (requestId !== loadRepoRequestIdRef.current) {
      return;
    }
    if (!cachedSnapshot?.loaded && snapshotResolveError) {
      const message = snapshotResolveError instanceof Error ? snapshotResolveError.message : String(snapshotResolveError);
      setError(message);
      setLoading(false);
      setProjectLoadStates((previous) => ({
        ...previous,
        [loadKey]: {
          status: 'error',
          phase: 'Load failed',
          progress: 100,
          error: message,
        },
      }));
      if (!keepCurrentRepoVisible && switchEpoch != null) finishMapSwitch(switchEpoch, 'error');
      if (sameRepoPath(loadRepoInFlightPathRef.current, normalizedPath)) loadRepoInFlightPathRef.current = null;
      return;
    }
    if (cachedSnapshot?.loaded) {
      try {
        await loadNodePositionsForRepo(normalizedPath);
        if (requestId !== loadRepoRequestIdRef.current) {
          return;
        }
        ensureMapSwitchStarted();
        const applied = applySnapshotToActiveState(normalizedPath, cachedSnapshot, {
          force: true,
          allowIncomingDirty: true,
          allowProjectSwitch: true,
          needsLayoutRebuild: true,
        });
        if (!applied) {
          throw new Error(`Failed to apply cached snapshot for ${normalizedPath}`);
        }
        finalizeProjectSwitchSnapshot(normalizedPath, cachedSnapshot);
        persistProject({
          path: normalizedPath,
          name: cachedSnapshot.name || basenameFromPath(normalizedPath),
          lastOpenedAt: Date.now(),
          branchName: cachedSnapshot.defaultBranch,
        });
        await yieldToPaint();
        await yieldToPaint();
        if (requestId !== loadRepoRequestIdRef.current) {
          return;
        }
        setLoading(false);
        setProjectLoadStates((previous) => ({
          ...previous,
          [loadKey]: { status: 'loading', phase: 'Building map', progress: 95 },
        }));
        void fetchGitHubData(normalizedPath);
        void (async () => {
          if (requestId !== loadRepoRequestIdRef.current) return;
          if (!sameRepoPath(currentRepoPathRef.current, normalizedPath)) return;
          const refreshedSnapshot = await refreshProjectSnapshotFromGit(normalizedPath, { honorReloadSync: true });
          if (requestId !== loadRepoRequestIdRef.current) return;
          if (!refreshedSnapshot?.loaded) return;
          if (!sameRepoPath(currentRepoPathRef.current, normalizedPath)) return;
          applySnapshotToActiveState(normalizedPath, refreshedSnapshot, {
            force: true,
            allowIncomingDirty: true,
            needsLayoutRebuild: true,
          });
          finalizeProjectSwitchSnapshot(normalizedPath, refreshedSnapshot);
        })();
      } catch (e) {
        console.error('Failed to load cached repo snapshot:', e);
        setError(e instanceof Error ? e.message : String(e));
        if (!keepCurrentRepoVisible) setRepoPath(null);
        setLoading(false);
        setProjectLoadStates((previous) => ({
          ...previous,
          [loadKey]: {
            status: 'error',
            phase: 'Load failed',
            progress: 100,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
        if (switchEpoch != null) finishMapSwitch(switchEpoch, 'error');
      } finally {
        if (sameRepoPath(loadRepoInFlightPathRef.current, normalizedPath)) loadRepoInFlightPathRef.current = null;
      }
      return;
    }

    // Yield to the browser paint cycle so the map shell and loader are painted
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (requestId !== loadRepoRequestIdRef.current) {
      return;
    }

    try {
      // Phase 1: fast metadata — show the map shell immediately
      const [info, def] = await Promise.all([
        invoke<{ name: string; path: string }>('get_repo_info', { repoPath: normalizedPath }),
        invoke<string>('get_default_branch', { repoPath: normalizedPath }),
      ]);
      if (requestId !== loadRepoRequestIdRef.current) {
        return;
      }
      const record = await invoke<ProjectSnapshotRecord>('add_project_and_ingest', {
        repoPath: normalizedPath,
      });
      const snapshot = toRepoVisualSnapshot(record);
      if (!snapshot) {
        throw new Error('Missing repo visual snapshot payload');
      }
      if (requestId !== loadRepoRequestIdRef.current) {
        return;
      }
      await loadNodePositionsForRepo(normalizedPath);
      if (requestId !== loadRepoRequestIdRef.current) {
        return;
      }
      ensureMapSwitchStarted();
      setRepoName(info.name);
      setDefaultBranch(def);
      upsertProjectSnapshot(normalizedPath, snapshot);
      projectQuickStateRef.current = {
        ...projectQuickStateRef.current,
        [normalizedPath]: quickStateSignature(quickStateFromSnapshot(normalizedPath, snapshot)),
      };
      applySnapshotToActiveState(normalizedPath, snapshot, {
        force: true,
        allowIncomingDirty: true,
        allowProjectSwitch: true,
      });
      lastHandledGitActivityEpochRef.current = gitActivityEpochRef.current;
      void invoke<RepoHeadState>('get_repo_head_state', { repoPath: normalizedPath })
        .then((headState) => {
          if (!headState) return;
          projectHeadStateRef.current = {
            ...projectHeadStateRef.current,
            [normalizedPath]: headStateSignature(headState),
          };
        })
        .catch(() => undefined);
      persistProject({
        path: normalizedPath,
        name: info.name,
        lastOpenedAt: Date.now(),
        branchName: def,
      });
      await yieldToPaint();
      await yieldToPaint();
      if (requestId !== loadRepoRequestIdRef.current) {
        return;
      }
      setLoading(false); // unblock the landing button
      setProjectLoadStates((previous) => ({
        ...previous,
        [loadKey]: { status: 'loading', phase: 'Building map', progress: 95 },
      }));

      // Phase 3: GitHub data (non-blocking)
      void fetchGitHubData(normalizedPath);
    } catch (e) {
      hasError = true;
      if (requestId !== loadRepoRequestIdRef.current) return;
      console.error('Failed to load repo:', e);
      setError(e instanceof Error ? e.message : String(e));
      if (!keepCurrentRepoVisible) setRepoPath(null);
      setLoading(false);
      setProjectLoadStates((previous) => ({
        ...previous,
        [loadKey]: {
          status: 'error',
          phase: 'Load failed',
          progress: 100,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    } finally {
      if (sameRepoPath(loadRepoInFlightPathRef.current, normalizedPath)) loadRepoInFlightPathRef.current = null;
      if (requestId !== loadRepoRequestIdRef.current) return;
      if (hasError && switchEpoch != null) finishMapSwitch(switchEpoch, 'error');
    }
  }

  async function fetchGitHubData(path: string) {
    const requestId = ++githubFetchRequestIdRef.current;
    try {
      if (requestId !== githubFetchRequestIdRef.current) return;
      setGithubAuthMessage(null);
      const ghInfo = await invoke<GitHubInfo>('get_github_info', { repoPath: path });
      const authStatus = await invoke<GitHubAuthStatus>('get_github_auth_status');
      if (requestId !== githubFetchRequestIdRef.current) return;
      setGithubAuthStatus(authStatus);
      if (!authStatus.ghAvailable || !authStatus.authenticated) {
        return;
      }

      const open = await invoke<OpenPR[]>('get_open_prs', {
        owner: ghInfo.owner,
        repo: ghInfo.repo,
      });
      if (requestId !== githubFetchRequestIdRef.current) return;
      setOpenPRs(open);
    } catch (e) {
      if (requestId !== githubFetchRequestIdRef.current) return;
      // GitHub data is optional, don't show error to user
      console.log('GitHub data not available:', e);
      setGithubAuthMessage(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    let isDisposed = false;
    const windowLabel = (() => {
      try {
        return getCurrentWindow().label;
      } catch {
        return null;
      }
    })();

    const openPath = async (payload?: OpenRepoEventPayload | null) => {
      const nextPath = payload?.path?.trim();
      if (!nextPath || isDisposed) return;
      if (repoPath === nextPath) {
        return;
      }
      await loadRepo(nextPath);
    };

    const attach = async () => {
      if (windowLabel === 'main') {
        unlisten = await listen<OpenRepoEventPayload>('gitviz://open-repo', async (event) => {
          await openPath(event.payload);
        });
      }
      const pending = await invoke<OpenRepoEventPayload | null>('take_pending_open_repo');
      await openPath(pending);
    };

    void attach();
    return () => {
      isDisposed = true;
      if (unlisten) unlisten();
    };
  }, [repoPath]);

  useEffect(() => {
    currentRepoPathRef.current = repoPath;
  }, [repoPath]);

  useEffect(() => {
    latestBranchesRef.current = branches;
  }, [branches]);

  useEffect(() => {
    latestDirectCommitsRef.current = directCommits;
  }, [directCommits]);

  useEffect(() => {
    latestCheckedOutRef.current = checkedOutRef;
  }, [checkedOutRef]);

  useEffect(() => {
    latestUnpushedDirectCommitsRef.current = unpushedDirectCommits;
  }, [unpushedDirectCommits]);

  useEffect(() => {
    latestWorktreesRef.current = worktrees;
  }, [worktrees]);

  useEffect(() => {
    latestStashesRef.current = stashes;
  }, [stashes]);

  useEffect(() => {
    latestUnpushedCommitShasByBranchRef.current = unpushedCommitShasByBranch;
  }, [unpushedCommitShasByBranch]);

  useEffect(() => {
    latestMergeNodesRef.current = mergeNodes;
  }, [mergeNodes]);

  useEffect(() => {
    latestBranchParentByNameRef.current = branchParentByName;
  }, [branchParentByName]);

  useEffect(() => {
    isMapInteractingRef.current = isMapInteracting;
    if (isMapInteracting) {
      wasMapInteractingRef.current = true;
      mapInteractionEpochRef.current += 1;
      canApplyRepoRefreshRef.current = false;
      setMapGridBackgroundActivity('git-refresh-settle', 'Git refresh settle wait', false);
      if (mapRefreshSettleTimeoutRef.current != null) {
        window.clearTimeout(mapRefreshSettleTimeoutRef.current);
        mapRefreshSettleTimeoutRef.current = null;
      }
      return;
    }

    if (!wasMapInteractingRef.current) {
      canApplyRepoRefreshRef.current = true;
      return;
    }
    wasMapInteractingRef.current = false;

    if (mapRefreshSettleTimeoutRef.current != null) {
      window.clearTimeout(mapRefreshSettleTimeoutRef.current);
    }
    setMapGridBackgroundActivity(
      'git-refresh-settle',
      'Git refresh settle wait',
      true,
      `${MAP_REPO_REFRESH_SETTLE_MS}ms after pan`,
    );
    mapRefreshSettleTimeoutRef.current = window.setTimeout(() => {
      mapRefreshSettleTimeoutRef.current = null;
      canApplyRepoRefreshRef.current = true;
      setMapGridBackgroundActivity('git-refresh-settle', 'Git refresh settle wait', false);
      if (pendingRefreshAfterInteractionRef.current) {
        const gitStillPending = gitActivityEpochRef.current !== lastHandledGitActivityEpochRef.current;
        console.debug('[repo-sync] draining queued refresh after map settle', {
          gitStillPending,
          repoPath,
        });
        runRepoRefreshRef.current?.(gitStillPending ? 'local' : 'timer');
      }
    }, MAP_REPO_REFRESH_SETTLE_MS);

    return () => {
      if (mapRefreshSettleTimeoutRef.current != null) {
        window.clearTimeout(mapRefreshSettleTimeoutRef.current);
        mapRefreshSettleTimeoutRef.current = null;
      }
    };
  }, [isMapInteracting]);

  useEffect(() => {
    if (!repoPath || !defaultBranch) return;
    invoke('watch_repo', { repoPath }).catch(console.error);
    gitActivityEpochRef.current = 0;
    lastHandledGitActivityEpochRef.current = 0;

    let isDisposed = false;
    let deferredSyncTimeout: number | null = null;
    const isStaleRepoRefresh = () =>
      isDisposed || isRepoSwitchingRef.current || !sameRepoPath(currentRepoPathRef.current, repoPath);
    const isRepoRefreshBlocked = () =>
      isMapInteractingRef.current || !canApplyRepoRefreshRef.current;
    const logDeferred = (source: string, blocker: string) => {
      console.log('[repo-sync] deferred', {
        source,
        blocker,
        repoPath,
        repoMutationInFlight: repoMutationInFlightRef.current,
        reconcileInFlight: reconcileInFlightRef.current,
        mapInteracting: isMapInteractingRef.current,
        inFlight: runAuthoritativeRepoSyncInFlightRef.current,
      });
    };
    const scheduleDeferredRepoRefresh = (reason: string) => {
      pendingRefreshAfterInteractionRef.current = true;
      if (deferredSyncTimeout != null) return;
      deferredSyncTimeout = window.setTimeout(() => {
        deferredSyncTimeout = null;
        if (isDisposed || !pendingRefreshAfterInteractionRef.current) return;
        void runTokenSync('manual', { triggerDetail: `deferred:${reason}` });
      }, MAP_REPO_REFRESH_SETTLE_MS + 250);
    };
    scheduleDeferredRepoRefreshRef.current = scheduleDeferredRepoRefresh;
    let repoSyncScheduler: ReturnType<typeof createRepoSyncScheduler> | null = null;
    let pollingPausedForUpdate = false;

    const pausePollingForUpdate = () => {
      if (pollingPausedForUpdate) return;
      pollingPausedForUpdate = true;
      repoSyncScheduler?.dispose();
      console.log('[repo-sync] polling paused');
    };

    const resumePollingAfterUpdate = () => {
      if (!pollingPausedForUpdate) return;
      pollingPausedForUpdate = false;
      if (!isDisposed) {
        repoSyncScheduler?.start();
      }
      console.log('[repo-sync] polling resumed');
    };

    const syncRemoteFromOrigin = async (): Promise<boolean> => {
      if (isDisposed || !defaultBranch || remoteSyncInFlightRef.current) return false;
      const online = await isNetworkAvailable();
      if (!online) return false;
      remoteSyncInFlightRef.current = true;
      try {
        const checkedOutHead = latestCheckedOutRef.current?.headSha ?? null;
        const result = await syncRemoteRepo(
          repoPath,
          defaultBranch,
          lastRemoteHeadsDigestRef.current,
          checkedOutHead,
          { pullFfOnly: false },
        );
        lastRemoteHeadsDigestRef.current = result.sync.remoteHeadsDigest || lastRemoteHeadsDigestRef.current;
        lastRemoteTipShaRef.current = result.tipState.tipSha;
        setRemoteDefaultTipSha(result.tipState.tipSha);
        setRemoteDefaultTipMetadata((current) => {
          const next = result.tipState.metadata;
          if (current === next) return current;
          if (!current || !next) return next;
          return current.subject === next.subject && current.author === next.author ? current : next;
        });
        setRemoteDefaultTipParentSha(result.tipState.parentSha);
        setIsRemoteTipHydrated(result.tipState.hydrated);
        return result.sync.changed;
      } catch (error) {
        console.warn('[repo-sync] remote fetch failed', error);
        return false;
      } finally {
        remoteSyncInFlightRef.current = false;
      }
    };

    const applyGraphSnapshot = async (normalizedPath: string): Promise<boolean> => {
      const startedAt = performance.now();
      const snapshot = await invoke<RepoVisualSnapshot>('get_repo_visual_snapshot', {
        repoPath: normalizedPath,
        forceRefresh: true,
      });
      if (isStaleRepoRefresh()) return false;
      if (repoMutationInFlightRef.current || reconcileInFlightRef.current || isRepoRefreshBlocked()) {
        logDeferred('graph', 'blocked-before-apply');
        scheduleDeferredRepoRefresh('graph blocked before apply');
        return false;
      }
      const prevCheckedOutRef = latestCheckedOutRef.current;
      const applied = applySnapshotToActiveState(normalizedPath, snapshot, {
        force: true,
        allowIncomingDirty: true,
        needsLayoutRebuild: true,
      });
      console.log('[repo-sync] graph snapshot', {
        applied,
        branches: snapshot.branches.length,
        worktrees: snapshot.worktrees.length,
        stashes: snapshot.stashes.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (!applied) return false;
      upsertProjectSnapshot(normalizedPath, snapshot, { force: true });
      const nextCheckedOutRef = latestCheckedOutRef.current;
      const headChanged = prevCheckedOutRef && nextCheckedOutRef && nextCheckedOutRef.headSha !== prevCheckedOutRef.headSha;
      const branchChanged = prevCheckedOutRef && nextCheckedOutRef && nextCheckedOutRef.branchName !== prevCheckedOutRef.branchName;
      if (headChanged || branchChanged) {
        autoFocusSyncKeyRef.current = null;
        focusCameraOnActiveWorktreeRef.current?.();
      }
      return true;
    };

    const runTokenSync = async (
      source: 'timer' | 'watcher' | 'focus' | 'manual',
      options?: { fetchRemote?: boolean; triggerDetail?: string },
    ) => {
      if (isStaleRepoRefresh()) return;
      const normalizedPath = normalizePath(repoPath);
      if (!normalizedPath) return;
      console.log('[repo-sync] trigger', {
        source,
        detail: options?.triggerDetail ?? null,
        repoPath: normalizedPath,
      });
      if (runAuthoritativeRepoSyncInFlightRef.current) {
        runAuthoritativeRepoSyncPendingRef.current = true;
        logDeferred(source, 'in-flight');
        return;
      }
      if (repoMutationInFlightRef.current || reconcileInFlightRef.current) {
        logDeferred(source, 'mutation');
        scheduleDeferredRepoRefresh(`${source}: mutation`);
        return;
      }
      if (isRepoRefreshBlocked()) {
        logDeferred(source, 'map-interaction');
        scheduleDeferredRepoRefresh(`${source}: map interaction`);
        return;
      }

      runAuthoritativeRepoSyncInFlightRef.current = true;
      try {
        if (options?.fetchRemote) {
          await syncRemoteFromOrigin();
          if (isStaleRepoRefresh()) return;
        }

        const previousTokens = repoSyncTokensRef.current[normalizedPath] ?? null;
        const nextTokens = await invoke<RepoSyncTokens>('get_repo_sync_tokens', {
          repoPath: normalizedPath,
        });
        if (isStaleRepoRefresh()) return;
        const tokenHead = repoSyncGraphHead(nextTokens);
        const renderedHead = latestCheckedOutRef.current?.headSha ?? null;
        const renderedHeadBehind = Boolean(tokenHead && renderedHead && tokenHead !== renderedHead);
        const changed = repoSyncTokenChanged(previousTokens, nextTokens) || renderedHeadBehind;
        console.log('[repo-sync] tokens', {
          changed,
          renderedHeadBehind,
          renderedHead: renderedHead?.slice(0, 7) ?? null,
          tokenHead: tokenHead?.slice(0, 7) ?? null,
          previousDirty: summarizeRepoSyncToken(previousTokens?.dirtyToken ?? ''),
          nextDirty: summarizeRepoSyncToken(nextTokens.dirtyToken),
          previousGraph: summarizeRepoSyncToken(previousTokens?.graphToken ?? ''),
          nextGraph: summarizeRepoSyncToken(nextTokens.graphToken),
        });

        if (!changed) {
          console.log('[repo-sync] noop');
          pendingRefreshAfterInteractionRef.current = false;
          markGitActivityHandled();
          return;
        }

        pausePollingForUpdate();
        const applied = await applyGraphSnapshot(normalizedPath);
        if (applied) {
          repoSyncTokensRef.current = {
            ...repoSyncTokensRef.current,
            [normalizedPath]: nextTokens,
          };
          pendingRefreshAfterInteractionRef.current = false;
          markGitActivityHandled();
          window.setTimeout(() => {
            void invoke('persist_project_snapshot', { projectId: normalizedPath }).catch((error) => {
              console.warn('Background snapshot persist failed:', error);
            });
          }, PERSIST_SNAPSHOT_DEFER_MS);
        } else {
          pendingRefreshAfterInteractionRef.current = true;
        }
      } catch (error) {
        console.error('[repo-sync] token sync failed', error);
      } finally {
        runAuthoritativeRepoSyncInFlightRef.current = false;
        resumePollingAfterUpdate();
        if (runAuthoritativeRepoSyncPendingRef.current) {
          runAuthoritativeRepoSyncPendingRef.current = false;
          void runTokenSync('manual', { triggerDetail: 'pending' });
        }
      }
    };

    runRepoRefreshRef.current = (reason = 'timer') => {
      if (reason === 'focus') return runTokenSync('focus', { fetchRemote: true });
      if (reason === 'graph' || reason === 'local' || reason === 'quick' || reason === 'clean-detected') {
        return runTokenSync('watcher', { triggerDetail: reason });
      }
      return runTokenSync(reason === 'initial' ? 'manual' : 'timer', { triggerDetail: reason });
    };

    repoSyncScheduler = createRepoSyncScheduler({
      isDisposed: () => isDisposed,
      canRun: () =>
        !isMapInteractingRef.current
        && canApplyRepoRefreshRef.current
        && !repoMutationInFlightRef.current
        && !reconcileInFlightRef.current
        && !runAuthoritativeRepoSyncInFlightRef.current,
      onReconcile: () => {
        void runTokenSync('timer');
      },
      onRepair: () => {
        void runTokenSync('timer', { fetchRemote: true, triggerDetail: 'repair' });
      },
    });

    let unlistenActivity: (() => void) | null = null;
    listen<GitActivityEventPayload>('git-activity', (event) => {
      if (isDisposed) return;
      const changedPath = normalizePath(event.payload.repoPath);
      if (!changedPath || !sameRepoPath(changedPath, repoPath)) return;
      if (runAuthoritativeRepoSyncInFlightRef.current) {
        runAuthoritativeRepoSyncPendingRef.current = true;
        return;
      }
      void runTokenSync('watcher', { triggerDetail: event.payload.kind });
    }).then((fn) => {
      if (isDisposed) fn();
      else unlistenActivity = fn;
    }).catch(console.error);

    repoSyncScheduler.start();
    repoSyncScheduler.kickVisibleCatchUp();

    return () => {
      isDisposed = true;
      void invoke('unwatch_repo', { repoPath }).catch(() => undefined);
      runRepoRefreshRef.current = null;
      scheduleDeferredRepoRefreshRef.current = null;
      repoSyncScheduler?.dispose();
      if (unlistenActivity) unlistenActivity();
      if (deferredSyncTimeout != null) window.clearTimeout(deferredSyncTimeout);
    };
  }, [repoPath, defaultBranch]);

  async function handleGitHubAuthSetup() {
    if (!repoPath) return;
    setGithubAuthLoading(true);
    setGithubAuthMessage(null);
    try {
      await invoke('authenticate_github');
      const authStatus = await invoke<GitHubAuthStatus>('get_github_auth_status');
      setGithubAuthStatus(authStatus);
      if (authStatus.authenticated) {
        await fetchGitHubData(repoPath);
      } else if (authStatus.message) {
        setGithubAuthMessage(authStatus.message);
      }
    } catch (e) {
      setGithubAuthMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setGithubAuthLoading(false);
    }
  }

  // Reset when a new repo is loaded
  useEffect(() => {
    // Keep loaded graph/snapshot state intact while switching repos.
    // We only clear ephemeral UI state that should not carry over.
    setBranchPromptMeta({});
    branchMetaLoadKeyRef.current = null;
    branchHeadByNameRef.current = {};
    setGithubAuthLoading(false);
    setGithubAuthStatus(null);
    setGithubAuthMessage(null);
    setOpenPRs([]);
    setCommitSwitchFeedback(null);
    lastRemoteTipShaRef.current = null;
    lastRemoteHeadsDigestRef.current = null;
    setRemoteDefaultTipSha(null);
    setRemoteDefaultTipMetadata(null);
    setRemoteDefaultTipParentSha(null);
    setIsRemoteTipHydrated(false);
    lastSyncedGitEpochRef.current = {};
    lastSyncedWorktreeEpochRef.current = {};
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath || !defaultBranch) {
      setBranchPromptMeta({});
      setBranchCommitPreviews({});
      setBranchParentByName({});
      setLaneByBranch({});
      setBranchUniqueAheadCounts({});
      branchMetaLoadKeyRef.current = null;
      branchHeadByNameRef.current = {};
      return;
    }

    const branchHeadKey = branches
      .map((branch) => `${branch.name}:${branch.headSha}`)
      .join('|');
    const mergeNodesKey = mergeNodes
      .map((node) => `${node.fullSha}:${node.parentShas?.[1] ?? ''}`)
      .join('|');
    const directCommitsKey = String(directCommits.length);
    const branchMetaLoadKey = `${repoPath}|${defaultBranch}|${branchHeadKey}|${mergeNodesKey}|${directCommitsKey}`;
    if (branchMetaLoadKeyRef.current === branchMetaLoadKey) {
      return;
    }
    branchMetaLoadKeyRef.current = branchMetaLoadKey;
    const nextCommitPreviews: Record<string, BranchCommitPreview[]> = {};
    const nextUniqueAheadCounts: Record<string, number> = {};
    const directOwnerBySha = new Map<string, string>();
    const directCommitsByBranch = new Map<string, DirectCommit[]>();
    for (const commit of directCommits) {
      directOwnerBySha.set(commit.fullSha, commit.branch);
      directOwnerBySha.set(commit.sha, commit.branch);
      const branchCommits = directCommitsByBranch.get(commit.branch) ?? [];
      branchCommits.push(commit);
      directCommitsByBranch.set(commit.branch, branchCommits);
    }
    const previewOwner = (preview: BranchCommitPreview): string | null =>
      directOwnerBySha.get(preview.fullSha) ?? directOwnerBySha.get(preview.sha) ?? null;
    for (const branch of branches) {
      if (branch.name === defaultBranch) continue;
      const previewsFromDirect = (directCommitsByBranch.get(branch.name) ?? [])
        .map((commit) => ({
          fullSha: commit.fullSha,
          sha: commit.sha,
          parentSha: commit.parentSha ?? null,
          message: commit.message,
          author: commit.author,
          date: commit.date,
          kind: 'commit' as const,
          isRemote: commit.isRemote ?? false,
        }));
      const directPreviewShas = new Set(previewsFromDirect.map((preview) => preview.fullSha));
      const preservedPreviews = (latestBranchCommitPreviewsRef.current[branch.name] ?? []).filter(
        (preview) => {
          const owner = previewOwner(preview);
          return preview.kind !== 'branch-created'
            && (owner == null || owner === branch.name)
            && (preview.isRemote || branch.remoteSyncStatus === 'on-github')
            && !directPreviewShas.has(preview.fullSha);
        },
      );
      const mergedPreviews = [...previewsFromDirect, ...preservedPreviews];
      nextCommitPreviews[branch.name] = mergedPreviews;
      nextUniqueAheadCounts[branch.name] = mergedPreviews.length;
    }

    const commitBranchesBySha = new Map<string, Set<string>>();
    for (const commit of directCommits) {
      for (const sha of [commit.fullSha, commit.sha]) {
        const known = commitBranchesBySha.get(sha) ?? new Set<string>();
        known.add(commit.branch);
        commitBranchesBySha.set(sha, known);
      }
    }
    const knownBranchNames = new Set(branches.map((branch) => branch.name));
    const isValidParentBranch = (candidate: string | null | undefined, selfName: string): candidate is string => {
      if (!candidate) return false;
      if (candidate === selfName) return false;
      if (candidate === defaultBranch) return true;
      return knownBranchNames.has(candidate);
    };
    const declaredParentByBranch = new Map(branches.map((branch) => [branch.name, branch.parentBranch ?? null]));
    const branchDepthByName = new Map<string, number>();
    const resolveBranchDepth = (branchName: string, visiting = new Set<string>()): number => {
      if (branchName === defaultBranch) return 0;
      const cached = branchDepthByName.get(branchName);
      if (cached != null) return cached;
      if (visiting.has(branchName)) return Number.MAX_SAFE_INTEGER;
      visiting.add(branchName);
      const parent = declaredParentByBranch.get(branchName) ?? null;
      const depth = parent && parent !== branchName
        ? resolveBranchDepth(parent, visiting) + 1
        : 1;
      visiting.delete(branchName);
      branchDepthByName.set(branchName, depth);
      return depth;
    };
    const branchCreatedAtByName = new Map(
      branches.map((branch) => [branch.name, new Date(branch.createdDate ?? branch.divergedFromDate ?? branch.lastCommitDate).getTime()]),
    );
    const pickCanonicalParentBranch = (candidates: Iterable<string>): string | null => {
      const valid = Array.from(candidates).filter((candidate) => knownBranchNames.has(candidate));
      if (valid.length === 0) return null;
      if (valid.includes(defaultBranch)) return defaultBranch;
      valid.sort((left, right) => {
        const depthDelta = resolveBranchDepth(left) - resolveBranchDepth(right);
        if (depthDelta !== 0) return depthDelta;
        const leftTime = branchCreatedAtByName.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightTime = branchCreatedAtByName.get(right) ?? Number.MAX_SAFE_INTEGER;
        if (leftTime !== rightTime) return leftTime - rightTime;
        return left.localeCompare(right);
      });
      return valid[0] ?? null;
    };
    const resolveParentBranchForSha = (sha: string | null | undefined): string | null => {
      if (!sha) return null;
      const exact = commitBranchesBySha.get(sha);
      if (exact) return pickCanonicalParentBranch(exact);
      const prefixMatches = new Set<string>();
      if (sha.length >= 7) {
        for (const [knownSha, branchNames] of commitBranchesBySha.entries()) {
          if (!knownSha.startsWith(sha)) continue;
          for (const name of branchNames) prefixMatches.add(name);
        }
      }
      return pickCanonicalParentBranch(prefixMatches);
    };
    const nextBranchParentByName: Record<string, string | null> = { [defaultBranch]: null };
    const nextBranchHeadByName: Record<string, string> = {};
    const branchesByName = new Map(branches.map((item) => [item.name, item] as const));
    for (const branch of branches) {
      nextBranchHeadByName[branch.name] = branch.headSha;
      if (branch.name === defaultBranch) {
        nextBranchParentByName[branch.name] = null;
        continue;
      }
      const previousHead = branchHeadByNameRef.current[branch.name];
      const previousParent = latestBranchParentByNameRef.current[branch.name];
      if (
        previousHead === branch.headSha
        && previousParent !== undefined
        && isValidParentBranch(previousParent, branch.name)
      ) {
        nextBranchParentByName[branch.name] = previousParent;
        continue;
      }
      const branchCommits = directCommitsByBranch.get(branch.name) ?? [];
      const branchCommitShas = new Set(branchCommits.map((commit) => commit.fullSha));
      const graphParentSha = branchCommits
        .filter((commit) => {
          const parentSha = commit.parentSha ?? null;
          return !parentSha || !branchCommitShas.has(parentSha);
        })
        .sort((a, b) => {
          const dt = new Date(a.date).getTime() - new Date(b.date).getTime();
          if (dt !== 0) return dt;
          return a.fullSha.localeCompare(b.fullSha);
        })[0]?.parentSha ?? null;
      const parentFromGraph = resolveParentBranchForSha(graphParentSha);
      const parentFromForkSha = resolveParentBranchForSha(
        branch.presidesFromSha ?? branch.divergedFromSha ?? branch.createdFromSha ?? null,
      );
      const parentFromBranchMeta = isValidParentBranch(branch.parentBranch ?? null, branch.name)
        ? branch.parentBranch!
        : null;
      const parentFromLatest = isValidParentBranch(latestBranchParentByNameRef.current[branch.name] ?? null, branch.name)
        ? latestBranchParentByNameRef.current[branch.name]!
        : null;
      let resolvedParent =
        parentFromBranchMeta ??
        parentFromForkSha ??
        parentFromGraph ??
        parentFromLatest ??
        null;
      if (isParallelEmptyBranchParent(branch, resolvedParent, branchesByName, defaultBranch)) {
        resolvedParent = defaultBranch;
      } else if (
        resolvedParent &&
        isNewerBranchAsParent(branch, resolvedParent, branchesByName)
      ) {
        resolvedParent = defaultBranch;
      } else if (
        branch.commitsAhead <= 0
        && branch.remoteSyncStatus !== 'on-github'
        && resolvedParent
        && resolvedParent !== defaultBranch
      ) {
        resolvedParent = defaultBranch;
      }
      if (!resolvedParent && isValidParentBranch(branch.parentBranch ?? null, branch.name)) {
        resolvedParent = branch.parentBranch!;
      }
      nextBranchParentByName[branch.name] = resolvedParent;
    }

    branchHeadByNameRef.current = nextBranchHeadByName;
    setBranchPromptMeta({});
    latestBranchCommitPreviewsRef.current = nextCommitPreviews;
    setBranchCommitPreviews(nextCommitPreviews);
    setBranchParentByName(nextBranchParentByName);
    setLaneByBranch((previous) => {
      const next: Record<string, number> = {};
      for (const branch of branches) {
        const lane = previous[branch.name];
        if (lane != null && Number.isFinite(lane)) {
          next[branch.name] = lane;
        }
      }
      return next;
    });
    setBranchUniqueAheadCounts(nextUniqueAheadCounts);
  }, [repoPath, defaultBranch, branches, mergeNodes, directCommits]);

  useEffect(() => {
    if (!commitSwitchFeedback) {
      setIsCommitSwitchFeedbackVisible(false);
      return;
    }

    setIsCommitSwitchFeedbackVisible(true);
    const hideTimer = window.setTimeout(() => {
      setIsCommitSwitchFeedbackVisible(false);
    }, COMMIT_SWITCH_FEEDBACK_VISIBLE_MS);
    const clearTimer = window.setTimeout(() => {
      setCommitSwitchFeedback(null);
    }, COMMIT_SWITCH_FEEDBACK_VISIBLE_MS + COMMIT_SWITCH_FEEDBACK_FADE_MS);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [commitSwitchFeedback]);

  // ── Cmd+Shift+S: capture screenshots of main timeline ──
  useEffect(() => {
    if (!repoPath || branches.length === 0) return;
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    async function captureScreenshots() {
      const homeDir = await invoke<string>('get_home_dir');
      const outDir = `${homeDir}/Desktop/git-viz-screenshots/${repoName}`;
      console.log(`📸 Saving screenshots to ${outDir}`);

      await sleep(800);
      await invoke('screenshot', { path: `${outDir}/main-timeline.png` });
      console.log(`📸 Done — screenshot saved to ${outDir}`);
    }

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsSidebarCollapsed((value) => !value);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        captureScreenshots();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [repoPath, repoName, branches]);

  async function handleMapCommitClick(target: {
    commitSha: string;
    branchName?: string;
    worktreePath: string;
  }) {
    if (!repoPath) return;
    setCommitSwitchFeedback(null);

    const pathsProbablyEqual = (left: string, right: string): boolean => {
      const normalizedLeft = left.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedRight = right.replace(/\\/g, '/').replace(/\/+$/, '');
      return (
        normalizedLeft === normalizedRight
        || normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      );
    };

    const effectiveRepoPath = target.worktreePath;
    const isOtherWorktree = !pathsProbablyEqual(effectiveRepoPath, repoPath);

    const finishCheckoutMutation = async (outcomes: RepoMutationOutcome[]) => {
      if (isOtherWorktree) {
        if (repoPath) {
          await finalizeRepoMutation(repoPath, { kind: 'fullRefresh', layoutTopologyChanged: true });
        } else {
          endRepoMutation();
        }
        return;
      }
      await finalizeRepoMutation(effectiveRepoPath, ...outcomes);
    };

    const stashRestore = /^STASH:(\d+)$/.exec(target.commitSha);
    if (stashRestore) {
      try {
        beginRepoMutation();
        const stashIndex = parseInt(stashRestore[1], 10);
        const restoredStashMessage = stashes.find((stash) => stash.index === stashIndex)?.message.trim() ?? '';
        const result = await invoke<StashRestoreMutationData>('apply_stash_restore', {
          repoPath: effectiveRepoPath,
          stashIndex,
        });
        await finishCheckoutMutation([outcomeFromStashRestore(result)]);
        seedWorktreeDraftForPathRef.current(effectiveRepoPath, restoredStashMessage);
        const label = `Stash ${stashIndex + 1}`;
        setCommitSwitchFeedback({
          kind: 'success',
          message: `Restored ${label}; stash applied and dropped (uncommitted changes).`,
        });
      } catch (e) {
        endRepoMutation();
        const message = e instanceof Error ? e.message : String(e);
        setCommitSwitchFeedback({
          kind: 'error',
          message,
        });
        console.error('Failed to apply stash:', message);
      }
      return;
    }

    try {
      beginRepoMutation();
      let stashedPrefix = '';
      const checkoutOutcomes: RepoMutationOutcome[] = [];
      const refBefore = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: effectiveRepoPath });
      if (refBefore.hasUncommittedChanges) {
        const preparedStashMessage = getPreparedStashMessageRef.current(effectiveRepoPath);
        const stashResult = await invoke<StashPushMutationData>('stash_push', {
          repoPath: effectiveRepoPath,
          includeUntracked: true,
          message: preparedStashMessage ?? '',
        });
        clearWorktreeDraftForPathRef.current(effectiveRepoPath);
        checkoutOutcomes.push(outcomeFromStashPush(stashResult));
        stashedPrefix = 'Stashed local changes (including untracked), then ';
      }

      const checkedOutRef = await (target.branchName
        ? invoke<CheckedOutRef>('checkout_branch', {
            repoPath: effectiveRepoPath,
            branchName: target.branchName,
          })
        : invoke<CheckedOutRef>('checkout_ref', {
            repoPath: effectiveRepoPath,
            refName: target.commitSha,
          }));
      checkoutOutcomes.push(outcomeFromCheckout(checkedOutRef));
      await finishCheckoutMutation(checkoutOutcomes);
      const refLabel = target.branchName
        ? target.branchName
        : `${target.commitSha.slice(0, 7)} (detached)`;
      setCommitSwitchFeedback({
        kind: 'success',
        message: `${stashedPrefix}Checked out ${refLabel}`,
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to checkout commit:', message);
    }
  }

  async function stashWorktreeAtPath(worktreePath: string): Promise<StashPushMutationData | null> {
    const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: worktreePath });
    if (!ref.hasUncommittedChanges) return null;

    const preparedStashMessage = getPreparedStashMessageRef.current(worktreePath);
    const stashResult = await invoke<StashPushMutationData>('stash_push', {
      repoPath: worktreePath,
      includeUntracked: true,
      message: preparedStashMessage ?? '',
    });
    clearWorktreeDraftForPathRef.current(worktreePath);
    return stashResult;
  }

  async function handleStashLocalChanges(worktreePaths: string[]) {
    if (!repoPath || stashInProgress) return;
    const uniquePaths = Array.from(
      new Set(
        worktreePaths
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (uniquePaths.length === 0) {
      setCommitSwitchFeedback({
        kind: 'error',
        message: 'No local changes to stash.',
      });
      return;
    }

    setCommitSwitchFeedback(null);
    setStashInProgress(true);
    try {
      beginRepoMutation();
      const mutationOutcomes: RepoMutationOutcome[] = [];
      let stashedCount = 0;

      for (const worktreePath of uniquePaths) {
        const stashResult = await stashWorktreeAtPath(worktreePath);
        if (!stashResult) continue;
        mutationOutcomes.push(outcomeFromStashPush(stashResult));
        stashedCount += 1;
      }

      if (stashedCount === 0) {
        endRepoMutation();
        setCommitSwitchFeedback({
          kind: 'error',
          message: 'No local changes to stash.',
        });
        return;
      }

      await finalizeRepoMutation(repoPath, ...mutationOutcomes);
      setCommitSwitchFeedback({
        kind: 'success',
        message: stashedCount === 1
          ? 'Stashed local changes (including untracked files).'
          : `Stashed ${stashedCount} worktrees (including untracked files).`,
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to stash:', message);
    } finally {
      setStashInProgress(false);
    }
  }

  async function commitWorktreeAtPath(
    worktreePath: string,
    trimmed: string,
    generatedBranchName: string | null = null,
  ): Promise<CommitMutationData | null> {
    const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: worktreePath });
    if (!ref.hasUncommittedChanges) return null;

    const commitResult = await invoke<CommitMutationData>('commit_working_tree', {
      repoPath: worktreePath,
      message: trimmed,
      generatedBranchName,
    });
    noteSoftUpdateDebug('commit result', {
      path: normalizePath(worktreePath),
      branch: commitResult.branchName,
      head: commitResult.fullSha.slice(0, 7),
      parent: commitResult.parentSha?.slice(0, 7) ?? 'none',
    });
    clearWorktreeDraftForPathRef.current(worktreePath);
    return commitResult;
  }

  async function handleCommitLocalChanges(message: string, worktreePaths: string[]): Promise<boolean> {
    if (!repoPath || commitInProgress) return false;
    const trimmed = message.trim();
    if (!trimmed) {
      setCommitSwitchFeedback({
        kind: 'error',
        message: 'Enter a commit message.',
      });
      return false;
    }
    const uniquePaths = Array.from(
      new Set(
        worktreePaths
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (uniquePaths.length === 0) {
      setCommitSwitchFeedback({
        kind: 'error',
        message: 'Select a worktree with uncommitted changes.',
      });
      return false;
    }

    setCommitSwitchFeedback(null);
    setCommitInProgress(true);
    try {
      const branchNamesByPath = new Map<string, string>();
      for (const worktreePath of uniquePaths) {
        const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: worktreePath });
        if (ref.branchName) continue;
        const branchName = await waitForPreparedBranchNameRef.current(worktreePath);
        if (!branchName) {
          setCommitSwitchFeedback({
            kind: 'error',
            message: 'Branch name is still generating. Try again in a moment.',
          });
          return false;
        }
        branchNamesByPath.set(worktreePath, branchName);
      }

      beginRepoMutation();
      const mutationOutcomes: RepoMutationOutcome[] = [];
      let committedCount = 0;

      for (const worktreePath of uniquePaths) {
        const commitResult = await commitWorktreeAtPath(
          worktreePath,
          trimmed,
          branchNamesByPath.get(worktreePath) ?? null,
        );
        if (!commitResult) continue;
        mutationOutcomes.push(outcomeFromCommitData(commitResult));
        committedCount += 1;
      }

      if (committedCount === 0) {
        endRepoMutation();
        setCommitSwitchFeedback({
          kind: 'error',
          message: 'No local changes to commit.',
        });
        return false;
      }

      await finalizeRepoMutation(repoPath, ...mutationOutcomes);
      setCommitSwitchFeedback({
        kind: 'success',
        message: committedCount === 1
          ? 'Committed local changes.'
          : `Committed ${committedCount} worktrees.`,
      });
      return true;
    } catch (e) {
      endRepoMutation();
      const errText = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message: errText,
      });
      console.error('Failed to commit:', errText);
      return false;
    } finally {
      setCommitInProgress(false);
    }
  }

  async function handleAutoCommitLocalChanges(worktreePaths: string[]): Promise<boolean> {
    if (!repoPath || commitInProgress) return false;
    const uniquePaths = Array.from(
      new Set(
        worktreePaths
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (uniquePaths.length === 0) {
      setCommitSwitchFeedback({
        kind: 'error',
        message: 'No local changes to commit.',
      });
      return false;
    }

    setCommitSwitchFeedback(null);
    setCommitInProgress(true);
    try {
      const messagesByPath = new Map<string, string>();
      const branchNamesByPath = new Map<string, string>();
      for (const worktreePath of uniquePaths) {
        const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: worktreePath });
        if (!ref.hasUncommittedChanges) continue;

        const message = await waitForPreparedCommitMessageRef.current(worktreePath);
        if (!message) {
          setCommitSwitchFeedback({
            kind: 'error',
            message: 'Commit message is still generating. Try again in a moment.',
          });
          return false;
        }
        messagesByPath.set(worktreePath, message);
        if (!ref.branchName) {
          const branchName = await waitForPreparedBranchNameRef.current(worktreePath);
          if (!branchName) {
            setCommitSwitchFeedback({
              kind: 'error',
              message: 'Branch name is still generating. Try again in a moment.',
            });
            return false;
          }
          branchNamesByPath.set(worktreePath, branchName);
        }
      }

      if (messagesByPath.size === 0) {
        setCommitSwitchFeedback({
          kind: 'error',
          message: 'No local changes to commit.',
        });
        return false;
      }

      beginRepoMutation();
      const mutationOutcomes: RepoMutationOutcome[] = [];
      let committedCount = 0;

      for (const worktreePath of uniquePaths) {
        const message = messagesByPath.get(worktreePath);
        if (!message) continue;

        const commitResult = await commitWorktreeAtPath(
          worktreePath,
          message,
          branchNamesByPath.get(worktreePath) ?? null,
        );
        if (!commitResult) continue;
        mutationOutcomes.push(outcomeFromCommitData(commitResult));
        committedCount += 1;
      }

      await finalizeRepoMutation(repoPath, ...mutationOutcomes);
      setCommitSwitchFeedback({
        kind: 'success',
        message: committedCount === 1
          ? 'Committed local changes.'
          : `Committed ${committedCount} worktrees.`,
      });
      return true;
    } catch (e) {
      endRepoMutation();
      const errText = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message: errText,
      });
      console.error('Failed to auto-commit:', errText);
      return false;
    } finally {
      setCommitInProgress(false);
    }
  }

  async function handleStageAllChanges(): Promise<boolean> {
    if (!repoPath || stageInProgress) return false;
    setCommitSwitchFeedback(null);
    setStageInProgress(true);
    try {
      const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath });
      if (!ref.hasUncommittedChanges) {
        setCommitSwitchFeedback({
          kind: 'error',
          message: 'No local changes to stage.',
        });
        return false;
      }
      beginRepoMutation();
      const nextRef = await invoke<CheckedOutRef>('stage_working_tree', { repoPath });
      await finalizeRepoMutation(repoPath, outcomeFromCheckout(nextRef));
      setCommitSwitchFeedback({
        kind: 'success',
        message: 'Staged all changes.',
      });
      return true;
    } catch (e) {
      endRepoMutation();
      const errText = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message: errText,
      });
      console.error('Failed to stage:', errText);
      return false;
    } finally {
      setStageInProgress(false);
    }
  }

  async function handleCreateBranchFromNode(nodeId: string, branchName: string, worktreePath?: string | null) {
    if (!repoPath || createBranchFromNodeInProgress) return;
    setCreateBranchFromNodeInProgress(true);
    setCommitSwitchFeedback(null);
    try {
      beginRepoMutation();
      
      const checkedOutRef = await invoke<CheckedOutRef>('overhaul_create_branch', {
        repoPath,
        branchName,
        targetNodeId: nodeId,
        worktreePath: worktreePath || null,
      });

      if (worktreePath) {
        // Retrieve updated worktree list
        const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath }).catch(
          () => [] as WorktreeInfo[],
        );
        setWorktrees(updatedWorktrees);
        await finalizeRepoMutation(repoPath, outcomeFromWorktreeSync(updatedWorktrees), { kind: 'fullRefresh', layoutTopologyChanged: true });
        setCommitSwitchFeedback({
          kind: 'success',
          message: `Created branch "${branchName}" in new worktree at ${worktreePath}`,
        });
      } else {
        await finalizeRepoMutation(repoPath, outcomeFromCheckout(checkedOutRef), { kind: 'fullRefresh', layoutTopologyChanged: true });
        setCommitSwitchFeedback({
          kind: 'success',
          message: `Moved to new branch "${branchName}"`,
        });
      }
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({ kind: 'error', message });
      console.error('Failed to create branch from node:', message);
    } finally {
      setCreateBranchFromNodeInProgress(false);
    }
  }

  async function handleCreateGeneratedBranch(worktreePath: string, branchName: string) {
    if (!repoPath || createBranchFromNodeInProgress) return;
    setCreateBranchFromNodeInProgress(true);
    setCommitSwitchFeedback(null);
    try {
      beginRepoMutation();
      const checkedOutRef = await invoke<CheckedOutRef>('create_generated_branch', {
        repoPath: worktreePath,
        branchName,
      });
      const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath });
      setWorktrees(updatedWorktrees);
      const outcomes = [outcomeFromWorktreeSync(updatedWorktrees)];
      if (sameRepoPath(worktreePath, repoPath)) {
        outcomes.push(outcomeFromCheckout(checkedOutRef));
      }
      await finalizeRepoMutation(
        repoPath,
        ...outcomes,
        { kind: 'fullRefresh', layoutTopologyChanged: true },
      );
      setCommitSwitchFeedback({
        kind: 'success',
        message: `Moved to new branch "${checkedOutRef.branchName ?? branchName}"`,
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({ kind: 'error', message });
      console.error('Failed to create generated branch:', message);
    } finally {
      setCreateBranchFromNodeInProgress(false);
    }
  }

  async function handleCreateRootBranch(branchName: string, worktreePath?: string | null) {
    if (!repoPath || createBranchFromNodeInProgress) return;
    setCreateBranchFromNodeInProgress(true);
    setCommitSwitchFeedback(null);
    try {
      beginRepoMutation();
      
      const checkedOutRef = await invoke<CheckedOutRef>('overhaul_create_branch', {
        repoPath,
        branchName,
        targetNodeId: '',
        worktreePath: worktreePath || null,
      });

      if (worktreePath) {
        // Retrieve updated worktree list
        const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath }).catch(
          () => [] as WorktreeInfo[],
        );
        setWorktrees(updatedWorktrees);
        await finalizeRepoMutation(repoPath, outcomeFromWorktreeSync(updatedWorktrees), { kind: 'fullRefresh', layoutTopologyChanged: true });
        setCommitSwitchFeedback({
          kind: 'success',
          message: `Created root branch "${branchName}" in new worktree at ${worktreePath}`,
        });
      } else {
        await finalizeRepoMutation(repoPath, outcomeFromCheckout(checkedOutRef), { kind: 'fullRefresh', layoutTopologyChanged: true });
        setCommitSwitchFeedback({
          kind: 'success',
          message: `Created new root branch "${branchName}"`,
        });
      }
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({ kind: 'error', message });
      console.error('Failed to create root branch:', message);
    } finally {
      setCreateBranchFromNodeInProgress(false);
    }
  }

  async function handleMoveNodeBackToBranch(targetBranchName: string) {
    if (!repoPath) return;
    setCommitSwitchFeedback(null);
    try {
      beginRepoMutation();
      const checkedOutRef = await invoke<CheckedOutRef>('checkout_branch', {
        repoPath,
        branchName: targetBranchName,
      });
      await finalizeRepoMutation(repoPath, outcomeFromCheckout(checkedOutRef));
      setCommitSwitchFeedback({
        kind: 'success',
        message: `Moved back to "${targetBranchName}"`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({ kind: 'error', message });
      console.error('Failed to move node back:', message);
    }
  }

  async function handleMergeRefsIntoBranch(sourceRefs: string[], targetBranch: string) {
    if (!repoPath) return;
    const uniqueSourceRefs = Array.from(new Set(sourceRefs.filter((ref) => !!ref && ref !== targetBranch)));
    if (uniqueSourceRefs.length === 0) return;
    setCommitSwitchFeedback(null);
    setMergeInProgress(true);
    try {
      beginRepoMutation();
      for (const sourceRef of uniqueSourceRefs) {
        await invoke<CheckedOutRef>('merge_ref_into_branch', {
          repoPath,
          sourceRef,
          targetBranch,
        });
      }
      await finalizeRepoMutation(repoPath, { kind: 'fullRefresh', layoutTopologyChanged: true });
      setCommitSwitchFeedback({
        kind: 'success',
        message: uniqueSourceRefs.length === 1
          ? `Merged ${uniqueSourceRefs[0].slice(0, 7)} into ${targetBranch}`
          : `Merged ${uniqueSourceRefs.length} commits into ${targetBranch}`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to merge refs into branch:', message);
    } finally {
      setMergeInProgress(false);
    }
  }

  async function handlePushAllBranches() {
    if (!repoPath || pushInProgress) return;
    setCommitSwitchFeedback(null);
    setPushInProgress(true);
    try {
      beginRepoMutation();
      let pushed: Array<{ branchName: string }> = [];
      let usedPull = false;
      try {
        pushed = await invoke<Array<{ branchName: string }>>('push_all_unpushed_branches', {
          repoPath,
        });
      } catch (pushError) {
        const pushMessage = pushError instanceof Error ? pushError.message : String(pushError);
        const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(pushMessage);
        if (!isNonFastForward) throw pushError;
        const branchName = checkedOutRef?.branchName;
        if (!branchName) throw pushError;
        const useRebase = window.confirm(
          'Push all hit non-fast-forward.\n\nOK: pull --rebase then retry\nCancel: pull --no-rebase then retry',
        );
        await invoke('pull_branch_with_strategy', { repoPath, branchName, rebase: useRebase });
        usedPull = true;
        pushed = await invoke<Array<{ branchName: string }>>('push_all_unpushed_branches', {
          repoPath,
        });
      }
      if (usedPull) {
        await finalizeRepoMutation(repoPath, { kind: 'fullRefresh', layoutTopologyChanged: true });
      } else {
        await finalizeRepoMutation(
          repoPath,
          outcomeFromPush(pushed.map((entry) => entry.branchName)),
        );
      }
      setCommitSwitchFeedback({
        kind: 'success',
        message: pushed.length > 0
          ? pushed.length === 1
            ? `Pushed ${pushed[0].branchName}`
            : `Pushed ${pushed.length} branches`
          : 'Everything local is already pushed.',
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to push all branches:', message);
    } finally {
      setPushInProgress(false);
    }
  }

  async function handlePushCurrentBranch(targetPath?: string) {
    const activePath = targetPath || repoPath;
    if (!activePath || pushInProgress) return;
    setCommitSwitchFeedback(null);
    setPushInProgress(true);
    try {
      beginRepoMutation();
      const pushed = await invoke<{ branchName: string }>('push_current_branch', {
        repoPath: activePath,
      });
      await finalizeRepoMutation(activePath, outcomeFromPush([pushed.branchName]));
      setCommitSwitchFeedback({
        kind: 'success',
        message: `Pushed ${pushed.branchName}`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(message);
      if (isNonFastForward) {
        const useRebase = window.confirm(
          'Push was rejected (non-fast-forward).\n\nOK: pull --rebase then retry push\nCancel: pull --no-rebase then retry push',
        );
        try {
          const ref = await invoke<CheckedOutRef>('get_checked_out_ref', { repoPath: activePath });
          const branchName = ref.branchName;
          if (!branchName) throw new Error('Cannot resolve current branch for pull.');
          await invoke('pull_branch_with_strategy', { repoPath: activePath, branchName, rebase: useRebase });
          const pushed = await invoke<{ branchName: string }>('push_current_branch', { repoPath: activePath });
          await finalizeRepoMutation(activePath, { kind: 'fullRefresh', layoutTopologyChanged: true });
          setCommitSwitchFeedback({
            kind: 'success',
            message: `Pulled (${useRebase ? 'rebase' : 'merge'}) and pushed ${pushed.branchName}`,
          });
          return;
        } catch (retryError) {
          endRepoMutation();
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          setCommitSwitchFeedback({ kind: 'error', message: retryMessage });
          console.error('Failed to resolve non-fast-forward:', retryMessage);
          return;
        }
      }
      endRepoMutation();
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to push current branch:', message);
    } finally {
      setPushInProgress(false);
    }
  }

  async function handlePushCommitTargets(targets: PushTarget[]) {
    if (!repoPath || pushInProgress) return;
    const uniqueTargets = Array.from(
      new Map(
        targets
          .filter((target) => target.branchName && target.targetSha)
          .map((target) => [target.branchName, target])
      ).values()
    );
    if (uniqueTargets.length === 0) return;

    setCommitSwitchFeedback(null);
    setPushInProgress(true);
    try {
      beginRepoMutation();
      let usedPull = false;
      for (const target of uniqueTargets) {
        try {
          await invoke('push_branch', {
            repoPath,
            branchName: target.branchName,
            targetSha: target.targetSha,
          });
        } catch (pushError) {
          const pushMessage = pushError instanceof Error ? pushError.message : String(pushError);
          const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(pushMessage);
          if (!isNonFastForward) throw pushError;
          const useRebase = window.confirm(
            `Push rejected for ${target.branchName} (non-fast-forward).\n\nOK: pull --rebase then retry\nCancel: pull --no-rebase then retry`,
          );
          await invoke('pull_branch_with_strategy', { repoPath, branchName: target.branchName, rebase: useRebase });
          usedPull = true;
          await invoke('push_branch', {
            repoPath,
            branchName: target.branchName,
            targetSha: target.targetSha,
          });
        }
      }
      if (usedPull) {
        await finalizeRepoMutation(repoPath, { kind: 'fullRefresh', layoutTopologyChanged: true });
      } else {
        await finalizeRepoMutation(
          repoPath,
          outcomeFromPush(
            uniqueTargets.map((target) => target.branchName),
            uniqueTargets.map((target) => ({
              branchName: target.branchName,
              targetSha: target.targetSha,
            }))
          ),
        );
      }
      setCommitSwitchFeedback({
        kind: 'success',
        message: uniqueTargets.length === 1
          ? `Pushed ${uniqueTargets[0].branchName} through ${uniqueTargets[0].targetSha?.slice(0, 7)}`
          : `Pushed ${uniqueTargets.length} selected commit ranges`,
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to push selected commits:', message);
    } finally {
      setPushInProgress(false);
    }
  }

  async function handleSquashCommitRange(target: { branchName: string; commitShas: string[] }) {
    if (!repoPath || squashInProgress) return;
    const uniqueCommitShas = Array.from(new Set(target.commitShas.filter((sha) => sha.trim().length > 0)));
    if (!target.branchName || uniqueCommitShas.length < 2) return;
    const ok = window.confirm(
      `Squash ${uniqueCommitShas.length} commits on "${target.branchName}"?\n\nThis rewrites local history for that branch.`,
    );
    if (!ok) return;

    setCommitSwitchFeedback(null);
    setSquashInProgress(true);
    try {
      beginRepoMutation();
      const result = await invoke<{ branchName: string; squashedSha: string; commitCount: number }>('squash_commit_range', {
        repoPath,
        branchName: target.branchName,
        commitShas: uniqueCommitShas,
      });
      await finalizeRepoMutation(repoPath, { kind: 'fullRefresh', layoutTopologyChanged: true });
      setCommitSwitchFeedback({
        kind: 'success',
        message: `Squashed ${result.commitCount} commits on ${result.branchName} into ${result.squashedSha.slice(0, 7)}`,
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to squash selected commits:', message);
    } finally {
      setSquashInProgress(false);
    }
  }

  async function handleDeleteSelection(targets: {
    branchNames: string[];
    discardUncommittedChanges: boolean;
    discardUncommittedWorktreePaths?: string[];
    removeWorktrees?: Array<{ path: string; force: boolean }>;
    stashIndices?: number[];
  }) {
    if (!repoPath || deleteInProgress) return;
    const uniqueBranchNames = Array.from(new Set(targets.branchNames.filter((branchName) => branchName && branchName !== defaultBranch)));
    const discardPaths = Array.from(
      new Set(
        (targets.discardUncommittedWorktreePaths?.length
          ? targets.discardUncommittedWorktreePaths
          : targets.discardUncommittedChanges
            ? [repoPath]
            : []
        ).filter((path) => path.trim().length > 0),
      ),
    );
    const shouldDiscardUncommitted = discardPaths.length > 0;
    const stashIndices = targets.stashIndices ?? [];
    const uniqueStashDescending = Array.from(new Set(stashIndices)).sort((a, b) => b - a);
    const removeWorktrees = targets.removeWorktrees ?? [];
    const uniqueRemoveWorktrees = Array.from(
      new Map(removeWorktrees.map((entry) => [entry.path, entry] as const)).values(),
    );
    if (
      uniqueBranchNames.length === 0
      && !shouldDiscardUncommitted
      && uniqueStashDescending.length === 0
      && uniqueRemoveWorktrees.length === 0
    ) return;

    setCommitSwitchFeedback(null);
    setDeleteInProgress(true);
    try {
      beginRepoMutation();
      const mutationOutcomes: RepoMutationOutcome[] = [];

      for (const stashIndex of uniqueStashDescending) {
        await invoke('stash_drop', { repoPath, stashIndex });
      }
      if (uniqueStashDescending.length > 0) {
        mutationOutcomes.push(outcomeFromStashDrops(uniqueStashDescending));
      }

      let deleteResult: DeleteSelectionMutationData = {
        deletedBranches: [],
        discardedUncommittedChanges: false,
        checkedOutRef: null,
      };
      if (uniqueBranchNames.length > 0) {
        const result = await invoke<DeleteSelectionMutationData>('delete_selected_elements', {
          repoPath,
          branchNames: uniqueBranchNames,
          discardUncommittedChanges: false,
        });
        deleteResult = {
          deletedBranches: result.deletedBranches,
          discardedUncommittedChanges: result.discardedUncommittedChanges,
          checkedOutRef: result.checkedOutRef,
        };
      }
      for (const worktreePath of discardPaths) {
        const discardResult = await invoke<DeleteSelectionMutationData>('delete_selected_elements', {
          repoPath: worktreePath,
          branchNames: [],
          discardUncommittedChanges: true,
        });
        if (discardResult.discardedUncommittedChanges) {
          deleteResult = {
            ...deleteResult,
            discardedUncommittedChanges: true,
            checkedOutRef: discardResult.checkedOutRef ?? deleteResult.checkedOutRef,
          };
        }
      }

      for (const { path: worktreePath, force } of uniqueRemoveWorktrees) {
        await invoke('remove_worktree', { repoPath, worktreePath, force });
        mutationOutcomes.push(outcomeFromWorktreeRemove(worktreePath));
      }

      if (deleteResult.deletedBranches.length > 0 || deleteResult.discardedUncommittedChanges) {
        mutationOutcomes.push(outcomeFromDeleteSelection(deleteResult));
      }

      await finalizeRepoMutation(repoPath, ...mutationOutcomes);
      const feedbackParts: string[] = [];
      if (uniqueStashDescending.length > 0) {
        feedbackParts.push(
          uniqueStashDescending.length === 1
            ? `removed stash ${uniqueStashDescending[0]! + 1}`
            : `removed ${uniqueStashDescending.length} stashes`
        );
      }
      if (deleteResult.discardedUncommittedChanges) feedbackParts.push('discarded local uncommitted changes');
      if (deleteResult.deletedBranches.length > 0) {
        feedbackParts.push(
          deleteResult.deletedBranches.length === 1
            ? `deleted ${deleteResult.deletedBranches[0]}`
            : `deleted ${deleteResult.deletedBranches.length} branches`
        );
      }
      if (uniqueRemoveWorktrees.length > 0) {
        feedbackParts.push(
          uniqueRemoveWorktrees.length === 1
            ? 'removed 1 worktree'
            : `removed ${uniqueRemoveWorktrees.length} worktrees`
        );
      }
      setCommitSwitchFeedback({
        kind: 'success',
        message: feedbackParts.length > 0 ? feedbackParts.join(' and ') : 'Nothing to delete.',
      });
    } catch (e) {
      endRepoMutation();
      const message = e instanceof Error ? e.message : String(e);
      setCommitSwitchFeedback({
        kind: 'error',
        message,
      });
      console.error('Failed to delete selected elements:', message);
    } finally {
      setDeleteInProgress(false);
    }
  }

  void [
    mapLoading,
    worktrees,
    scrollRequest,
    focusedErrorBranch,
    mergeInProgress,
    pushInProgress,
    squashInProgress,
    deleteInProgress,
    branchPromptMeta,
    stashInProgress,
    commitInProgress,
    stageInProgress,
    createBranchFromNodeInProgress,
    handleMapCommitClick,
    handleStashLocalChanges,
    handleCommitLocalChanges,
    handleStageAllChanges,
    handleCreateBranchFromNode,
    handleCreateRootBranch,
    handleMoveNodeBackToBranch,
    handleMergeRefsIntoBranch,
    handlePushAllBranches,
    handlePushCurrentBranch,
    handlePushCommitTargets,
    handleDeleteSelection,
  ];

  const handleGridFocusChange = useCallback((sha: string | null) => {
    setGridFocusSha(sha);
    if (sha && repoPath && isWorkingTreeCommitId(sha)) {
      persistWorktreeFocusSha(repoPath, sha);
    }
  }, [repoPath]);

  const focusMapOnNode = useCallback((projectPath: string, sha: string) => {
    if (!sha) return;
    setGridFocusSha(sha);
    if (isWorkingTreeCommitId(sha)) {
      persistWorktreeFocusSha(projectPath, sha);
    }
    setGridSearchJumpToken((token) => token + 1);
  }, []);

  function handleSidebarSelectCommit(sha: string) {
    if (!repoPath) return;
    focusMapOnNode(repoPath, sha);
  }

  // Synthetic stash nodes (yellow) and per-worktree worktree nodes — same lane rules as before.
  const {
    enrichedBranches,
    enrichedBranchCommitPreviews,
    enrichedBranchUniqueAheadCounts,
    enrichedDirectCommits,
    enrichedUnpushedDirectCommits,
    visualCheckedOutRef,
  } = useMemo(() => {
    const sessionsForGraph = buildWorktreeSessions(sortedWorktrees, repoPath ?? undefined, checkedOutRef, activeProject?.worktreeOrder);
    const anyDirty = sessionsForGraph.some((session) => session.hasUncommittedChanges);
    const stashFolded = foldStashNodesIntoGraph(
      stashes,
      branches,
      directCommits,
      branchCommitPreviews,
      branchUniqueAheadCounts,
      defaultBranch,
      anyDirty,
    );
    let eb = stashFolded.branches;
    let edc = stashFolded.directCommits;
    let eupdc = unpushedDirectCommits;
    let ebp = stashFolded.branchCommitPreviews;
    let ebuac = stashFolded.branchUniqueAheadCounts;
    let effectiveCheckedOutRef = checkedOutRef;
    const hasRemoteTipInLocalGraph = remoteDefaultTipSha
      ? edc.some((commit) => commit.fullSha === remoteDefaultTipSha || commit.sha === remoteDefaultTipSha.slice(0, 7))
      : true;
    const resolvedRemoteParentSha =
      remoteDefaultTipParentSha
      ?? eb.find((branch) => branch.name === defaultBranch)?.headSha
      ?? (checkedOutRef?.branchName === defaultBranch ? checkedOutRef.headSha : null)
      ?? edc.find((commit) => commit.branch === defaultBranch)?.fullSha
      ?? null;
    if (remoteDefaultTipSha && resolvedRemoteParentSha && !hasRemoteTipInLocalGraph) {
      const parentDate =
        edc.find((commit) => commit.fullSha === resolvedRemoteParentSha || commit.sha === resolvedRemoteParentSha.slice(0, 7))?.date ??
        ebp[defaultBranch]?.find((commit) => commit.fullSha === resolvedRemoteParentSha || commit.sha === resolvedRemoteParentSha.slice(0, 7))?.date ??
        null;
      const remoteDate = parentDate
        ? new Date(new Date(parentDate).getTime() + 1000).toISOString()
        : new Date().toISOString();
      const previousDefaultHeadSha =
        resolvedRemoteParentSha ??
        eb.find((branch) => branch.name === defaultBranch)?.headSha ??
        (edc[0]?.fullSha ?? null);
      const remotePreviewNode: BranchCommitPreview = {
        fullSha: remoteDefaultTipSha,
        sha: remoteDefaultTipSha.slice(0, 7),
        parentSha: previousDefaultHeadSha,
        message: remoteDefaultTipMetadata?.subject?.trim() || `Remote commit on origin/${defaultBranch}`,
        author: remoteDefaultTipMetadata?.author?.trim() || 'Unknown',
        date: remoteDate,
        kind: 'commit',
        isRemote: true,
      };
      const remoteDirectCommit: DirectCommit = {
        fullSha: remoteDefaultTipSha,
        sha: remoteDefaultTipSha.slice(0, 7),
        parentSha: previousDefaultHeadSha,
        parentShas: previousDefaultHeadSha ? [previousDefaultHeadSha] : [],
        childShas: [],
        branch: defaultBranch,
        message: remotePreviewNode.message,
        author: remotePreviewNode.author,
        date: remoteDate,
        kind: 'commit',
        isRemote: true,
      };
      edc = [remoteDirectCommit, ...edc];
      ebp = {
        ...ebp,
        [defaultBranch]: [remotePreviewNode, ...(ebp[defaultBranch] ?? [])],
      };
      eb = eb.map((branch) => (
        branch.name === defaultBranch
          ? {
              ...branch,
              headSha: remoteDefaultTipSha,
              lastCommitDate: remoteDate,
            }
          : branch
      ));
    }

    const hasActiveRemoteOnlyDivergence =
      !!remoteDefaultTipSha &&
      !!resolvedRemoteParentSha &&
      !hasRemoteTipInLocalGraph;
    const shouldSplitLocalDivergenceLane =
      hasActiveRemoteOnlyDivergence &&
      checkedOutRef?.branchName === defaultBranch &&
      checkedOutRef.headSha !== remoteDefaultTipSha &&
      (checkedOutRef.hasUncommittedChanges || unpushedDirectCommits.length > 0);
    if (shouldSplitLocalDivergenceLane) {
      const localBranchName = `${defaultBranch} (local)`;
      const localUnpushedShas = new Set(unpushedDirectCommits.map((commit) => commit.fullSha));
      if (checkedOutRef?.headSha) localUnpushedShas.add(checkedOutRef.headSha);
      const localBranchDate =
        unpushedDirectCommits[0]?.date ??
        (checkedOutRef?.headSha ? edc.find((commit) => commit.fullSha === checkedOutRef.headSha)?.date : undefined) ??
        new Date().toISOString();

      if (!eb.some((branch) => branch.name === localBranchName)) {
        eb = [
          ...eb,
          {
            name: localBranchName,
            commitsAhead: Math.max(1, localUnpushedShas.size),
            commitsBehind: 0,
            lastCommitDate: localBranchDate,
            lastCommitAuthor: checkedOutRef?.branchName ?? 'You',
            status: 'fresh',
            remoteSyncStatus: 'unpushed',
            unpushedCommits: Math.max(1, localUnpushedShas.size),
            headSha: checkedOutRef?.headSha ?? (unpushedDirectCommits[0]?.fullSha ?? 'WORKING_TREE'),
            parentBranch: defaultBranch,
          },
        ];
      }

      edc = edc.map((commit) =>
        commit.branch === defaultBranch && localUnpushedShas.has(commit.fullSha)
          ? { ...commit, branch: localBranchName }
          : commit,
      );
      eupdc = eupdc.map((commit) =>
        commit.branch === defaultBranch && localUnpushedShas.has(commit.fullSha)
          ? { ...commit, branch: localBranchName }
          : commit,
      );

      const defaultPreviews = ebp[defaultBranch] ?? [];
      const localPreviews = defaultPreviews.filter((preview) => (
        (effectiveCheckedOutRef?.hasUncommittedChanges && isWorkingTreeCommitId(preview.fullSha))
        || localUnpushedShas.has(preview.fullSha)
      ));
      const retainedDefaultPreviews = defaultPreviews.filter((preview) => !localPreviews.includes(preview));
      if (localPreviews.length > 0) {
        ebp = {
          ...ebp,
          [defaultBranch]: retainedDefaultPreviews,
          [localBranchName]: [...localPreviews, ...(ebp[localBranchName] ?? [])],
        };
      }
      ebuac = {
        ...ebuac,
        [localBranchName]: Math.max(1, localUnpushedShas.size),
      };
      if (effectiveCheckedOutRef?.branchName === defaultBranch) {
        effectiveCheckedOutRef = {
          ...effectiveCheckedOutRef,
          branchName: localBranchName,
        };
      }
    }

    const remoteLaneCommitShas = new Set(edc.map((commit) => commit.fullSha));
    for (const branch of eb) {
      if (branch.remoteSyncStatus !== 'on-github') continue;
      const lanePreviews = (ebp[branch.name] ?? []).filter((preview) => preview.kind !== 'branch-created');
      for (const preview of lanePreviews) {
        if (remoteLaneCommitShas.has(preview.fullSha)) continue;
        edc = [
          ...edc,
          {
            fullSha: preview.fullSha,
            sha: preview.sha,
            parentSha: preview.parentSha ?? null,
            parentShas: preview.parentShas ?? (preview.parentSha ? [preview.parentSha] : []),
            childShas: preview.childShas ?? [],
            branch: branch.name,
            message: preview.message,
            author: preview.author,
            date: preview.date,
            kind: 'commit' as const,
            isRemote: preview.isRemote ?? true,
          },
        ];
        remoteLaneCommitShas.add(preview.fullSha);
      }
      if (lanePreviews.length === 0 && branch.headSha && !remoteLaneCommitShas.has(branch.headSha)) {
        const syntheticPreview: BranchCommitPreview = {
          fullSha: branch.headSha,
          sha: branch.headSha.slice(0, 7),
          parentSha: branch.divergedFromSha ?? branch.createdFromSha ?? null,
          message: 'Remote branch tip',
          author: branch.lastCommitAuthor || 'Unknown',
          date: branch.lastCommitDate,
          kind: 'commit',
          isRemote: true,
        };
        ebp = {
          ...ebp,
          [branch.name]: [...(ebp[branch.name] ?? []), syntheticPreview],
        };
        edc = [
          ...edc,
          {
            fullSha: branch.headSha,
            sha: branch.headSha.slice(0, 7),
            parentSha: syntheticPreview.parentSha,
            parentShas: syntheticPreview.parentSha ? [syntheticPreview.parentSha] : [],
            childShas: [],
            branch: branch.name,
            message: syntheticPreview.message,
            author: syntheticPreview.author,
            date: syntheticPreview.date,
            kind: 'commit' as const,
            isRemote: true,
          },
        ];
        remoteLaneCommitShas.add(branch.headSha);
      }
      ebuac = {
        ...ebuac,
        [branch.name]: Math.max(
          ebuac[branch.name] ?? 0,
          lanePreviews.length || (branch.headSha ? 1 : 0),
          Math.max(1, branch.commitsAhead),
        ),
      };
    }

    const sessionsForInject = buildWorktreeSessions(sortedWorktrees, repoPath ?? undefined, effectiveCheckedOutRef, activeProject?.worktreeOrder);
    const injected = injectWorktreeUncommittedPreviews({
      sessions: sessionsForInject,
      branches: eb,
      branchCommitPreviews: ebp,
      branchUniqueAheadCounts: ebuac,
      directCommits: edc,
      defaultBranch,
    });
    return {
      enrichedBranches: injected.branches,
      enrichedDirectCommits: edc,
      enrichedUnpushedDirectCommits: eupdc,
      enrichedBranchCommitPreviews: injected.branchCommitPreviews,
      enrichedBranchUniqueAheadCounts: injected.branchUniqueAheadCounts,
      visualCheckedOutRef: effectiveCheckedOutRef,
    };
  }, [branches, branchCommitPreviews, branchUniqueAheadCounts, checkedOutRef, defaultBranch, directCommits, remoteDefaultTipMetadata, remoteDefaultTipParentSha, remoteDefaultTipSha, repoPath, stashes, unpushedDirectCommits, sortedWorktrees]);

  /** Must match `visualCheckedOutRef` (lane split) so layout pin + inject agree after incremental patches. */
  const worktreeSessions = useMemo(
    () => buildWorktreeSessions(sortedWorktrees, repoPath ?? undefined, visualCheckedOutRef ?? checkedOutRef, activeProject?.worktreeOrder),
    [sortedWorktrees, repoPath, visualCheckedOutRef, checkedOutRef],
  );

  const migrateCommittedWorktreeNodePosition = useCallback((commit: CommitMutationData) => {
    const normalizedRepoPath = repoPath ? normalizePath(repoPath) : '';
    const normalizedWorktreePath = normalizePath(commit.worktreePath ?? '');
    if (!normalizedRepoPath || !normalizedWorktreePath) return;
    const session = worktreeSessions.find((candidate) => sameRepoPath(candidate.path, normalizedWorktreePath));
    if (!session) return;

    const laneBranchNames = laneBranchNamesForPositionOverrides({
      defaultBranch,
      commitBranchName: commit.branchName,
      checkedOutBranchName: checkedOutRef?.branchName,
      extraBranchNames: branches.map((branch) => branch.name),
    });

    let migratedOverrides: NodePositionOverrides | null = null;
    setNodePositionOverridesByRepo((previous) => {
      const current = previous[normalizedRepoPath] ?? {};
      const sourceOverride =
        laneBranchNames
          .map((branchName) =>
            getNodePositionOverride(current, {
              id: session.workingTreeId,
              visualId: `${branchName}:${session.workingTreeId}`,
              kind: 'uncommitted',
            }),
          )
          .find((override) => override != null)
        ?? getNodePositionOverride(current, {
          id: session.workingTreeId,
          visualId: session.workingTreeId,
          kind: 'uncommitted',
        });
      if (!sourceOverride) return previous;

      const nextForRepo = { ...current };
      for (const branchName of laneBranchNames) {
        assignNodePositionOverride(nextForRepo, {
          id: commit.fullSha,
          visualId: `${branchName}:${commit.fullSha}`,
          kind: 'commit',
          parentSha: commit.parentSha,
        }, { ...sourceOverride, isMigratedWorktree: true });
      }
      migratedOverrides = nextForRepo;
      return {
        ...previous,
        [normalizedRepoPath]: nextForRepo,
      };
    });

    if (migratedOverrides) {
      userDirtyNodePositionsRef.current.add(normalizedRepoPath);
      persistRepoNodePositions(normalizedRepoPath, migratedOverrides);
    }
  }, [branches, checkedOutRef?.branchName, defaultBranch, persistRepoNodePositions, repoPath, worktreeSessions]);

  const {
    draftsByWorkingTreeId: worktreeDraftByWorkingTreeId,
    getPreparedCommitMessage,
    getPreparedStashMessage,
    waitForPreparedCommitMessage,
    waitForPreparedBranchName,
    seedDraftForPath,
    clearDraftForPath,
  } = useWorktreeDraftMessages({
    worktreeSessions,
    isPaused: () => repoMutationInFlightRef.current,
    enabled: Boolean(repoPath),
    onWorktreeCleanStateDetected: () => {
      runRepoRefreshRef.current?.('clean-detected');
    },
  });

  getPreparedCommitMessageRef.current = getPreparedCommitMessage;
  waitForPreparedCommitMessageRef.current = waitForPreparedCommitMessage;
  waitForPreparedBranchNameRef.current = waitForPreparedBranchName;
  getPreparedStashMessageRef.current = getPreparedStashMessage;
  seedWorktreeDraftForPathRef.current = seedDraftForPath;
  clearWorktreeDraftForPathRef.current = clearDraftForPath;

  const focusCameraOnActiveWorktree = useCallback(() => {
    if (!repoPath) return;
    const focusSha = worktreeSessions.length > 0
      ? resolveActiveWorktreeFocusSha(worktreeSessions, repoPath)
      : visualCheckedOutRef?.headSha ?? null;
    if (!focusSha) return;
    const syncKey = `${repoPath}|${mapGridOrientation}|${mapSwitchEpoch}|${focusSha}`;
    if (autoFocusSyncKeyRef.current === syncKey) return;
    autoFocusSyncKeyRef.current = syncKey;
    if (isWorkingTreeCommitId(focusSha)) {
      persistWorktreeFocusSha(repoPath, focusSha);
    }
    const isFirstLoad = isFirstLoadSessionRef.current;
    if (isFirstLoad) {
      isFirstLoadSessionRef.current = false;
      try {
        window.localStorage.removeItem(mapGridCameraStorageKey(`${repoPath}::${mapGridOrientation}`));
      } catch {
        // ignore storage failures
      }
      setGridFocusSha(focusSha);
      setGridSearchJumpToken((token) => token + 1);
      return;
    }
    if (!readHasSavedMapGridCamera(repoPath, mapGridOrientation)) {
      setGridFocusSha(focusSha);
      setGridSearchJumpToken((token) => token + 1);
    }
  }, [
    mapGridOrientation,
    mapSwitchEpoch,
    repoPath,
    visualCheckedOutRef?.headSha,
    worktreeSessions,
  ]);
  focusCameraOnActiveWorktreeRef.current = focusCameraOnActiveWorktree;

  useEffect(() => {
    const readyForAutoFocus =
      !mapLoading &&
      !loading &&
      mapReadyForDisplay &&
      (
        remoteDefaultTipSha == null ||
        (isRemoteTipHydrated && remoteDefaultTipParentSha != null)
      );
    if (!readyForAutoFocus || !repoPath) return;
    focusCameraOnActiveWorktree();
  }, [
    focusCameraOnActiveWorktree,
    isRemoteTipHydrated,
    loading,
    mapReadyForDisplay,
    mapLoading,
    remoteDefaultTipParentSha,
    remoteDefaultTipSha,
    repoPath,
    branches,
    directCommits,
    unpushedDirectCommits,
  ]);

  useEffect(() => {
    autoFocusSyncKeyRef.current = null;
    setGridFocusSha(null);
  }, [repoPath, mapSwitchEpoch]);
  const branchesForLayout = useMemo(
    () => applyBranchParents(enrichedBranches, branchParentByName, defaultBranch),
    [enrichedBranches, branchParentByName, defaultBranch],
  );
  const enrichedBranchParentByName = useMemo(() => {
    const map: Record<string, string | null> = { [defaultBranch]: null };
    for (const branch of branchesForLayout) {
      if (branch.name === defaultBranch) continue;
      map[branch.name] = branch.parentBranch ?? null;
    }
    return map;
  }, [branchesForLayout, defaultBranch]);
  const graphLayoutSignature = useMemo(
    () =>
      buildGraphLayoutFingerprint({
        layoutEpoch,
        defaultBranch,
        checkedOutBranch: visualCheckedOutRef?.branchName ?? '',
        checkedOutHead: visualCheckedOutRef?.headSha ?? '',
        worktreeSessionSignature: formatWorktreeSessionLayoutSignature(worktreeSessions),
        branchRowsSignature: branchesForLayout
          .map((branch) => `${branch.name}:${branch.headSha}:${branch.commitsAhead}:${branch.commitsBehind}:${branch.parentBranch ?? ''}`)
          .join('|'),
        directCommitFingerprint: hashCommitShaList(enrichedDirectCommits),
        unpushedCommitFingerprint: hashCommitShaList(enrichedUnpushedDirectCommits),
        mergeNodesSignature: mergeNodes
          .map((node) => `${node.fullSha}:${node.targetBranch}:${node.targetCommitSha}`)
          .join('|'),
      }),
    [
      layoutEpoch,
      defaultBranch,
      visualCheckedOutRef?.branchName,
      visualCheckedOutRef?.headSha,
      worktreeSessions,
      branchesForLayout,
      enrichedDirectCommits,
      enrichedUnpushedDirectCommits,
      mergeNodes,
    ],
  );
  const layoutRevision = useMemo(
    () => ({
      repoPath: repoPath ?? '',
      graphLayoutSignature,
      branchesForLayout,
      mergeNodes,
      enrichedDirectCommits,
      enrichedUnpushedDirectCommits,
      unpushedCommitShasByBranch,
      defaultBranch,
      enrichedBranchCommitPreviews,
      enrichedBranchParentByName,
      enrichedBranchUniqueAheadCounts,
      manuallyOpenedGridClumps,
      manuallyClosedGridClumps,
      gridFocusSha,
      nodePositionOverrides: repoPath ? (nodePositionOverridesByRepo[normalizePath(repoPath)] ?? {}) : {},
      visualCheckedOutRef,
      worktreeSessions,
      mapGridOrientation,
    }),
    [
      repoPath,
      graphLayoutSignature,
      branchesForLayout,
      mergeNodes,
      enrichedDirectCommits,
      enrichedUnpushedDirectCommits,
      unpushedCommitShasByBranch,
      defaultBranch,
      enrichedBranchCommitPreviews,
      enrichedBranchParentByName,
      enrichedBranchUniqueAheadCounts,
      manuallyOpenedGridClumps,
      manuallyClosedGridClumps,
      gridFocusSha,
      nodePositionOverridesByRepo,
      visualCheckedOutRef,
      worktreeSessions,
      mapGridOrientation,
    ],
  );
  const deferredLayoutRevision = useDeferredValue(layoutRevision);
  const layoutRevisionForView = useMemo(
    () => {
      if (mapLoading || deferredLayoutRevision.repoPath !== (repoPath ?? '')) {
        return layoutRevision;
      }
      if (deferredLayoutRevision.graphLayoutSignature !== layoutRevision.graphLayoutSignature) {
        return layoutRevision;
      }
      if (
        deferredLayoutRevision.manuallyOpenedGridClumps !== layoutRevision.manuallyOpenedGridClumps ||
        deferredLayoutRevision.manuallyClosedGridClumps !== layoutRevision.manuallyClosedGridClumps ||
        deferredLayoutRevision.mapGridOrientation !== layoutRevision.mapGridOrientation ||
        deferredLayoutRevision.gridFocusSha !== layoutRevision.gridFocusSha ||
        deferredLayoutRevision.nodePositionOverrides !== layoutRevision.nodePositionOverrides
      ) {
        return layoutRevision;
      }
      return deferredLayoutRevision;
    },
    [deferredLayoutRevision, layoutRevision, mapLoading, repoPath],
  );
  const sharedGridLayoutCacheKey = useMemo(() => {
    if (!repoPath) return null;
    return makeLayoutCacheKey(
      repoPath,
      layoutRevisionForView.mapGridOrientation,
      layoutRevisionForView.manuallyOpenedGridClumps,
      layoutRevisionForView.manuallyClosedGridClumps,
      layoutRevisionForView.graphLayoutSignature,
      layoutRevisionForView.nodePositionOverrides,
    );
  }, [repoPath, layoutRevisionForView]);
  useEffect(() => {
    if (!repoPath || !sharedGridLayoutCacheKey) {
      setHydratedLayoutModel(null);
      setHydratedLayoutKey(null);
      return;
    }
    const normalizedRepoPath = normalizePath(repoPath);
    if (normalizedRepoPath && isPostCommitProtectionActive(normalizedRepoPath)) {
      setHydratedLayoutModel(null);
      setHydratedLayoutKey(null);
      return;
    }
    const hasWorktreeNodes = worktreeSessions.length > 0;
    const inMemory = layoutModelCacheRef.current.get(sharedGridLayoutCacheKey);
    if (inMemory) {
      if (layoutModelHasWorkingTree(inMemory) === hasWorktreeNodes) {
        setHydratedLayoutModel(inMemory);
        setHydratedLayoutKey(sharedGridLayoutCacheKey);
        persistedLayoutKeysRef.current.add(sharedGridLayoutCacheKey);
        return;
      }
      layoutModelCacheRef.current.delete(sharedGridLayoutCacheKey);
    }
    let disposed = false;
    setHydratedLayoutModel(null);
    setHydratedLayoutKey(null);
    void invoke<string | null>('get_repo_layout_snapshot', {
      repoPath,
      layoutKey: sharedGridLayoutCacheKey,
    })
      .then((payloadJson) => {
        if (disposed || !payloadJson) return;
        const parsed = JSON.parse(payloadJson);
        const hydrated = hydrateBranchGridLayoutModel(parsed);
        if (layoutModelHasWorkingTree(hydrated) !== hasWorktreeNodes) {
          return;
        }
        layoutModelCacheRef.current.set(sharedGridLayoutCacheKey, hydrated);
        persistedLayoutKeysRef.current.add(sharedGridLayoutCacheKey);
        setHydratedLayoutModel(hydrated);
        setHydratedLayoutKey(sharedGridLayoutCacheKey);
      })
      .catch(() => {
        if (disposed) return;
        setHydratedLayoutModel(null);
        setHydratedLayoutKey(null);
      });
    return () => {
      disposed = true;
    };
  }, [repoPath, sharedGridLayoutCacheKey, worktreeSessions]);
  const layoutGridRevision = useMemo(
    () => ({
      repoPath: layoutRevisionForView.repoPath,
      graphLayoutSignature: layoutRevisionForView.graphLayoutSignature,
      branchesForLayout: layoutRevisionForView.branchesForLayout,
      mergeNodes: layoutRevisionForView.mergeNodes,
      enrichedDirectCommits: layoutRevisionForView.enrichedDirectCommits,
      enrichedUnpushedDirectCommits: layoutRevisionForView.enrichedUnpushedDirectCommits,
      unpushedCommitShasByBranch: layoutRevisionForView.unpushedCommitShasByBranch,
      defaultBranch: layoutRevisionForView.defaultBranch,
      enrichedBranchCommitPreviews: layoutRevisionForView.enrichedBranchCommitPreviews,
      enrichedBranchParentByName: layoutRevisionForView.enrichedBranchParentByName,
      enrichedBranchUniqueAheadCounts: layoutRevisionForView.enrichedBranchUniqueAheadCounts,
      manuallyOpenedGridClumps: layoutRevisionForView.manuallyOpenedGridClumps,
      manuallyClosedGridClumps: layoutRevisionForView.manuallyClosedGridClumps,
      gridFocusSha: layoutRevisionForView.gridFocusSha,
      visualCheckedOutRef: layoutRevisionForView.visualCheckedOutRef,
      worktreeSessions: layoutRevisionForView.worktreeSessions,
      mapGridOrientation: layoutRevisionForView.mapGridOrientation,
      nodePositionOverrides: layoutRevisionForView.nodePositionOverrides,
    }),
    [layoutRevisionForView],
  );
  const handleBranchGridLayoutStatus = useCallback((status: BranchGridLayoutStatus) => {
    setMapLayoutStatus(status);
    const activePath = currentRepoPathRef.current;
    if (!activePath) return;
    const key = projectLoadKey(activePath);
    if (status.state === 'computing' && isRepoSwitchingRef.current) {
      setProjectLoadStates((previous) => ({
        ...previous,
        [key]: { status: 'loading', phase: 'Building map', progress: 95 },
      }));
      return;
    }
    if (status.state === 'error') {
      setMapLoading(false);
      setMapReadyForDisplay(false);
      setMapPresentationState('error');
      isRepoSwitchingRef.current = false;
      setProjectLoadStates((previous) => ({
        ...previous,
        [key]: {
          status: 'error',
          phase: 'Map failed',
          progress: 100,
          error: status.error,
        },
      }));
    }
  }, []);
  const sharedGridLayoutModel = useBranchGridLayoutFromRevision({
    layoutRevisionForView: layoutGridRevision,
    sharedGridLayoutCacheKey,
    hydratedLayoutModel,
    hydratedLayoutKey,
    mapLoading,
    layoutModelCacheRef,
    onStatusChange: handleBranchGridLayoutStatus,
  });
  const gridLayoutModelForView = sharedGridLayoutModel;
  useEffect(() => {
    lastResolvedLayoutModelRef.current = gridLayoutModelForView;
  }, [gridLayoutModelForView]);

  const softUpdateDebugRows = useMemo(() => {
    if (!isGridDebugOpen) return [];
    const normalizedRepoPath = repoPath ? normalizePath(repoPath) : '';
    const overrides = normalizedRepoPath ? (nodePositionOverridesByRepo[normalizedRepoPath] ?? {}) : {};
    const overrideKeys = Object.keys(overrides);
    const rows: string[] = [
      ...softUpdateDebugEvents,
      '',
      `repo=${normalizedRepoPath || 'none'}`,
      `checkedOut=${visualCheckedOutRef ? `${visualCheckedOutRef.branchName ?? 'detached'}@${visualCheckedOutRef.headSha.slice(0, 7)} parent=${visualCheckedOutRef.parentSha?.slice(0, 7) ?? 'none'} dirty=${visualCheckedOutRef.hasUncommittedChanges}` : 'none'}`,
      `layoutSignature=${graphLayoutSignature.slice(0, 96)}`,
      `nodeOverrides=${overrideKeys.length ? overrideKeys.join(', ') : 'none'}`,
    ];

    for (const session of worktreeSessions) {
      const rendered = gridLayoutModelForView.renderNodes.find((node) => node.commit.id === session.workingTreeId);
      const matchingPreviews = Object.entries(enrichedBranchCommitPreviews)
        .flatMap(([branchName, previews]) =>
          previews
            .filter((preview) => preview.fullSha === session.workingTreeId)
            .map((preview) => `${branchName}:parent=${preview.parentSha?.slice(0, 7) ?? 'none'} date=${preview.date}`),
        );
      const sessionOverrideKeys = overrideKeys.filter((key) => isWorktreePositionOverrideKeyFor(key, session.workingTreeId));
      rows.push(
        '',
        `worktree ${session.workingTreeId}`,
        `  path=${session.path}`,
        `  branch=${session.branchName ?? 'detached'} head=${session.headSha.slice(0, 7)} parent=${session.parentSha?.slice(0, 7) ?? 'none'} dirty=${session.hasUncommittedChanges} current=${session.isCurrent}`,
        `  rendered=${rendered ? `branch=${rendered.commit.branchName} row=${rendered.row} column=${rendered.column} x=${Math.round(rendered.x)} y=${Math.round(rendered.y)} parent=${rendered.commit.parentSha?.slice(0, 7) ?? 'none'}` : 'missing'}`,
        `  preview=${matchingPreviews.length ? matchingPreviews.join(' | ') : 'none'}`,
        `  overrideKeys=${sessionOverrideKeys.length ? sessionOverrideKeys.join(', ') : 'none'}`,
      );
    }
    return rows;
  }, [
    enrichedBranchCommitPreviews,
    graphLayoutSignature,
    gridLayoutModelForView,
    isGridDebugOpen,
    nodePositionOverridesByRepo,
    repoPath,
    softUpdateDebugEvents,
    visualCheckedOutRef,
    worktreeSessions,
  ]);
  useEffect(() => {
    if (!repoPath || !sharedGridLayoutCacheKey) return;
    const hasGraphSourceData =
      layoutRevisionForView.branchesForLayout.length > 0 ||
      layoutRevisionForView.enrichedDirectCommits.length > 0 ||
      layoutRevisionForView.enrichedUnpushedDirectCommits.length > 0;
    if (
      hasGraphSourceData &&
      (sharedGridLayoutModel.allCommits.length === 0 || sharedGridLayoutModel.renderNodes.length === 0)
    ) return;
    const normalizedRepoPath = normalizePath(repoPath);
    if (normalizedRepoPath && isPostCommitProtectionActive(normalizedRepoPath)) return;
    layoutModelCacheRef.current.set(sharedGridLayoutCacheKey, sharedGridLayoutModel);
    if (persistedLayoutKeysRef.current.has(sharedGridLayoutCacheKey)) return;
    let idleId: number | null = null;
    let fallbackId: number | null = null;
    const timer = setTimeout(() => {
      const persistLayoutSnapshot = () => {
        try {
          const payloadJson = JSON.stringify(serializeBranchGridLayoutModel(sharedGridLayoutModel));
          const previousPayload = persistedLayoutPayloadHashRef.current.get(sharedGridLayoutCacheKey);
          if (previousPayload === payloadJson) {
            persistedLayoutKeysRef.current.add(sharedGridLayoutCacheKey);
            return;
          }
          persistedLayoutPayloadHashRef.current.set(sharedGridLayoutCacheKey, payloadJson);
          persistedLayoutKeysRef.current.add(sharedGridLayoutCacheKey);
          void invoke('store_repo_layout_snapshot', {
            repoPath,
            layoutKey: sharedGridLayoutCacheKey,
            payloadJson,
          }).catch(() => {
            persistedLayoutKeysRef.current.delete(sharedGridLayoutCacheKey);
            persistedLayoutPayloadHashRef.current.delete(sharedGridLayoutCacheKey);
          });
        } catch {
          persistedLayoutKeysRef.current.delete(sharedGridLayoutCacheKey);
          persistedLayoutPayloadHashRef.current.delete(sharedGridLayoutCacheKey);
        }
      };
      if ('requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(persistLayoutSnapshot, { timeout: 2500 });
      } else {
        fallbackId = setTimeout(persistLayoutSnapshot, 0) as any;
      }
    }, 1000) as any;
    return () => {
      clearTimeout(timer);
      if (idleId != null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId);
      if (fallbackId != null) clearTimeout(fallbackId);
    };
  }, [repoPath, sharedGridLayoutCacheKey, sharedGridLayoutModel, layoutRevisionForView]);

  useEffect(() => {
    try {
      const rawWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      if (rawWidth) {
        const parsed = Number(rawWidth);
        if (Number.isFinite(parsed)) {
          setSidebarWidthPx(Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, parsed)));
        }
      }
      const rawCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (rawCollapsed != null) setIsSidebarCollapsed(rawCollapsed === 'true');
      const rawTerminalPlacement = window.localStorage.getItem(TERMINAL_PANEL_PLACEMENT_STORAGE_KEY);
      if (rawTerminalPlacement === 'right' || rawTerminalPlacement === 'bottom') {
        setTerminalPanelPlacement(rawTerminalPlacement);
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidthPx;
  }, [sidebarWidthPx]);

  useEffect(() => {
    const shell = sidebarShellRef.current;
    if (!shell) return;
    shell.style.width = isSidebarCollapsed ? '0px' : `${sidebarWidthPx}px`;
  }, [sidebarWidthPx, isSidebarCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
    } catch {
      // ignore storage failures
    }
  }, [isSidebarCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TERMINAL_PANEL_PLACEMENT_STORAGE_KEY, terminalPanelPlacement);
    } catch {
      // ignore storage failures
    }
  }, [terminalPanelPlacement]);

  const updateSidebarWidthFromPointer = (clientX: number) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    const nextWidth = drag.startWidth + (clientX - drag.startX);
    drag.pendingWidth = Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, nextWidth));
    const shell = sidebarShellRef.current;
    if (shell) shell.style.width = `${drag.pendingWidth}px`;
  };

  const finishSidebarDrag = (_reason: string, pointerId?: number) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    if (pointerId != null && drag.pointerId !== pointerId) return;
    sidebarDragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setSidebarWidthPx(drag.pendingWidth);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(drag.pendingWidth));
    } catch {
      // ignore storage failures
    }
  };

  const handleSidebarPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarDragRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
      pendingWidth: sidebarWidthRef.current,
      pointerId: event.pointerId,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSidebarPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateSidebarWidthFromPointer(event.clientX);
  };

  const handleSidebarPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore if capture already released
    }
    finishSidebarDrag('pointerup', event.pointerId);
  };

  const handleSidebarPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore if capture already released
    }
    finishSidebarDrag('pointercancel', event.pointerId);
  };

  const handleMapReadyForDisplay = useCallback((epoch: number) => {
    if (epoch !== mapSwitchEpochRef.current) return;
    finishMapSwitch(epoch, 'ready');
    const activePath = currentRepoPathRef.current;
    if (!activePath) return;
    const key = projectLoadKey(activePath);
    setProjectLoadStates((previous) => ({
      ...previous,
      [key]: { status: 'ready', phase: 'Ready', progress: 100 },
    }));
  }, []);

  const runPreviewForTarget = useCallback(async (
    target: PreviewTarget,
    nodeId: string,
    config: ProjectPreviewConfig,
    options?: { focusTerminal?: boolean },
  ) => {
    if (!repoPath) return;
    setPreviewInProgress(true);
    const targetId = target.kind === 'commit' ? target.sha : target.workingTreeId;
    if (target.kind === 'worktree') {
      setPreviewedWorktreeNodeIds((current) => current.includes(target.workingTreeId) ? current : [...current, target.workingTreeId]);
    } else {
      setPreviewedNodeId(targetId || nodeId);
    }
    // Find running commit preview session and capture its current output length BEFORE checkout starts
    let initialLength = 0;
    if (target.kind === 'commit') {
      const commitPreviews = terminalSessions.filter((session) =>
        sameRepoPath(session.projectPath, repoPath)
        && session.kind === 'preview'
        && session.targetKind === 'commit',
      );
      const runningPreview = commitPreviews.find((session) => session.status === 'running') ?? null;
      if (runningPreview) {
        const initialResult = await readTerminalSession(runningPreview.id).catch(() => null);
        initialLength = initialResult ? initialResult.output.length : 0;
      }
    }

    try {
      const prepared = target.kind === 'worktree'
        ? {
            previewPath: target.worktreePath,
            dependencyFilesChanged: false,
          }
        : await preparePreviewTarget(repoPath, target);
      const installNeeded = await previewDependenciesNeedInstall(
        prepared.previewPath,
        prepared.dependencyFilesChanged,
      );
      const command = installNeeded && config.installCommand.trim()
        ? `${config.installCommand.trim()} && ${config.runCommand.trim()}`
        : config.runCommand.trim();
      const targetId = target.kind === 'commit' ? target.sha : target.workingTreeId;

      if (target.kind === 'commit') {
        const commitPreviews = terminalSessions.filter((session) =>
          sameRepoPath(session.projectPath, repoPath)
          && session.kind === 'preview'
          && session.targetKind === 'commit',
        );
        const runningPreview = commitPreviews.find((session) => session.status === 'running') ?? null;
        const stalePreviewIds = commitPreviews
          .filter((session) => session.id !== runningPreview?.id)
          .map((session) => session.id);

        for (const staleId of stalePreviewIds) {
          await terminateTerminalSession(staleId).catch(() => undefined);
        }

        if (runningPreview) {
          let nextSession = runningPreview;
          const targetChanged = runningPreview.targetId !== targetId;
          let restarted = false;
          if (targetChanged) {
            if (runningPreview.command !== command) {
              openedPreviewUrlsRef.current.delete(runningPreview.id);
              nextSession = await setTerminalSessionTarget(runningPreview.id, targetId, 'commit');
              nextSession = await restartTerminalSession(runningPreview.id, command);
              restarted = true;
            } else {
              nextSession = await setTerminalSessionTarget(runningPreview.id, targetId, 'commit');
            }
          }
          nextSession = {
            ...nextSession,
            worktreePath: prepared.previewPath,
            command,
            targetId,
            targetKind: 'commit',
          };
          setTerminalSessions((current) => [
            ...current.filter((session) => session.id !== nextSession.id && !stalePreviewIds.includes(session.id)),
            nextSession,
          ]);
          if (options?.focusTerminal !== false) {
            setActiveTerminalId(nextSession.id);
          }
          setPreviewedNodeId(target.sha || nodeId);
          if (targetChanged && !restarted && nextSession.status === 'running') {
            const sessionId = nextSession.id;
            const sessionForActivation = nextSession;

            // Clear any existing poll for this session
            const existingInterval = rebuildPollIntervalsRef.current.get(sessionId);
            if (existingInterval) {
              clearInterval(existingInterval);
              rebuildPollIntervalsRef.current.delete(sessionId);
            }

            const startPolling = async () => {
              try {
                const startTime = Date.now();
                const timeoutMs = 2500; // 2.5 seconds maximum wait

                const pollInterval = setInterval(async () => {
                  const elapsed = Date.now() - startTime;
                  if (elapsed >= timeoutMs) {
                    clearInterval(pollInterval);
                    rebuildPollIntervalsRef.current.delete(sessionId);
                    void activatePreviewTarget(sessionForActivation, true).catch(() => undefined);
                    return;
                  }

                  try {
                    const currentResult = await readTerminalSession(sessionId);
                    const currentOutput = currentResult.output;
                    const newOutput = currentOutput.length >= initialLength
                      ? currentOutput.slice(initialLength)
                      : currentOutput;

                    // Strip ANSI escape sequences
                    const cleanOutput = newOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').toLowerCase();

                    const hasCompleted = [
                      'built in',
                      'ready in',
                      'compiled successfully',
                      'compiled',
                      'compilation finished',
                      'compiled with',
                      'hmr update',
                      'page reload',
                      'rebuilt',
                      'hot update',
                      'ready'
                    ].some(pattern => cleanOutput.includes(pattern));

                    if (hasCompleted) {
                      clearInterval(pollInterval);
                      rebuildPollIntervalsRef.current.delete(sessionId);
                      void activatePreviewTarget(sessionForActivation, true).catch(() => undefined);
                    }
                  } catch (e) {
                    clearInterval(pollInterval);
                    rebuildPollIntervalsRef.current.delete(sessionId);
                    void activatePreviewTarget(sessionForActivation, true).catch(() => undefined);
                  }
                }, 150);

                rebuildPollIntervalsRef.current.set(sessionId, pollInterval);
              } catch {
                void activatePreviewTarget(sessionForActivation, true).catch(() => undefined);
              }
            };

            void startPolling();
          }
          return;
        }
      }

      const result = await createTerminalSession({
        projectPath: repoPath,
        worktreePath: prepared.previewPath,
        kind: 'preview',
        label: 'Preview',
        command,
        cols: 100,
        rows: 30,
        targetId,
        targetKind: target.kind,
        previewUrl: null,
        previewAppName: null,
      });
      setTerminalSessions((current) => {
        const withoutDuplicates = target.kind === 'commit'
          ? current.filter((session) => !(
            sameRepoPath(session.projectPath, repoPath)
            && session.kind === 'preview'
            && session.targetKind === 'commit'
            && session.id !== result.id
          ))
          : current;
        return [...withoutDuplicates.filter((session) => session.id !== result.id), result];
      });
      if (options?.focusTerminal !== false) {
        setActiveTerminalId(result.id);
      }
      if (target.kind === 'worktree') {
        setPreviewedWorktreeNodeIds((current) => current.includes(target.workingTreeId) ? current : [...current, target.workingTreeId]);
      } else {
        setPreviewedNodeId(target.sha || nodeId);
      }
    } catch (error) {
      console.warn('Preview failed:', error);
      setPreviewedNodeId(null);
      setPreviewedWorktreeNodeIds((current) => target.kind === 'worktree'
        ? current.filter((id) => id !== target.workingTreeId)
        : current);
    } finally {
      setPreviewInProgress(false);
    }
  }, [repoPath, terminalSessions]);

  const handlePreviewNode = useCallback(async (
    target: PreviewTarget,
    nodeId: string,
    options?: { focusTerminal?: boolean },
  ) => {
    if (!repoPath) return;
    if (previewInProgress) return;
    const config = activeProject?.previewConfig;
    if (config?.runCommand.trim()) {
      await runPreviewForTarget(target, nodeId, config, options);
      return;
    }
    const defaults = await detectProjectPreviewDefaults(repoPath).catch(() => ({
      installCommand: 'npm install',
      runCommand: 'npm run dev',
    }));
    setPendingPreviewTarget(target);
    setPendingPreviewNodeId(nodeId);
    setPreviewedNodeId(nodeId);
    setPreviewDraftConfig({
      installCommand: defaults.installCommand,
      runCommand: defaults.runCommand,
      lastConfirmedAt: Date.now(),
    });
    setPreviewSetupOpen(true);
  }, [activeProject?.previewConfig, repoPath, runPreviewForTarget, previewInProgress]);

  const handleConfirmPreviewSetup = useCallback(async () => {
    if (!repoPath || !pendingPreviewTarget || !previewDraftConfig) return;
    const config = {
      ...previewDraftConfig,
      lastConfirmedAt: Date.now(),
    };
    updateProjectPreviewConfig(repoPath, config);
    setPreviewSetupOpen(false);
    await runPreviewForTarget(
      pendingPreviewTarget,
      pendingPreviewNodeId ?? (pendingPreviewTarget.kind === 'commit' ? pendingPreviewTarget.sha : pendingPreviewTarget.workingTreeId),
      config,
    );
    setPendingPreviewTarget(null);
    setPendingPreviewNodeId(null);
  }, [pendingPreviewNodeId, pendingPreviewTarget, previewDraftConfig, repoPath, runPreviewForTarget]);

  const syncActivePreviewTarget = useCallback(async (path: string) => {
    const targets = terminalSessions.filter((session) => sameRepoPath(session.projectPath, path) && session.kind === 'preview' && session.status === 'running');
    if (!sameRepoPath(repoPath, path)) return;
    const commitTarget = targets.find((target) => target.targetKind === 'commit') ?? null;
    const worktreeTargets = targets
      .filter((target) => target.targetKind === 'worktree')
      .map((target) => target.targetId ?? '')
      .sort();
    setPreviewedNodeId((current) => (current === (commitTarget?.targetId ?? null) ? current : (commitTarget?.targetId ?? null)));
    setPreviewedWorktreeNodeIds((current) => stringArraysEqual(current, worktreeTargets) ? current : worktreeTargets);
  }, [repoPath, terminalSessions]);

  useEffect(() => {
    if (!repoPath) {
      setPreviewedNodeId(null);
      setPreviewedWorktreeNodeIds([]);
      return;
    }
    void syncActivePreviewTarget(repoPath);
  }, [repoPath, syncActivePreviewTarget]);

  useEffect(() => {
    let disposed = false;
    let refreshInFlight = false;
    const refresh = async () => {
      if (refreshInFlight || isMapInteractingRef.current || repoMutationInFlightRef.current) return;
      refreshInFlight = true;
      try {
        const sessions = await listTerminalSessions();
        if (!disposed) {
          setTerminalSessions((current) => terminalSessionsEqual(current, sessions) ? current : sessions);
        }
      } catch {
        // A missed status poll must not disturb running terminal or preview sessions.
      } finally {
        refreshInFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 500);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const interval of rebuildPollIntervalsRef.current.values()) {
        clearInterval(interval);
      }
      rebuildPollIntervalsRef.current.clear();
    };
  }, []);

  const activeTerminal = terminalSessions.find((session) => session.id === activeTerminalId) ?? null;
  const openedPreviewUrlsRef = useRef(new Map<string, string>());

  useEffect(() => {
    for (const session of terminalSessions) {
      if (session.kind !== 'preview' || !session.previewUrl || session.status !== 'running') continue;
      if (isNativePreviewCommand(session.command)) continue;
      if (openedPreviewUrlsRef.current.get(session.id) === session.previewUrl) continue;
      openedPreviewUrlsRef.current.set(session.id, session.previewUrl);
      void activatePreviewTarget(session).catch(() => undefined);
    }
  }, [terminalSessions]);

  useEffect(() => {
    if (!activeTerminalId) return;
    const session = terminalSessions.find((s) => s.id === activeTerminalId);
    if (session && session.kind === 'shell' && session.worktreePath) {
      const normalizedPath = normalizePath(session.worktreePath).toLowerCase();
      lastActiveTerminalIdByWorktreePathRef.current.set(normalizedPath, session.id);
    }
  }, [activeTerminalId, terminalSessions]);

  const handleNodeDoubleClick = useCallback((node: Node) => {
    if (previewInProgress) return;
    const commitId = node.commit.id;
    const isWT = isWorkingTreeCommitId(commitId) || node.commit.kind === 'uncommitted';
    const isRegularCommit =
      !isWT &&
      node.commit.kind !== 'stash' &&
      !commitId.startsWith('STASH:') &&
      node.commit.kind !== 'branch-created' &&
      !commitId.startsWith('BRANCH_HEAD:');

    const wtSessions = buildWorktreeSessions(sortedWorktrees, repoPath ?? undefined, checkedOutRef, activeProject?.worktreeOrder);
    
    let targetWorktreePath: string | null = null;
    let targetSession: typeof wtSessions[0] | null = null;
    if (isWT) {
      const session = wtSessions.find((entry) => entry.workingTreeId === commitId);
      if (session) {
        targetWorktreePath = session.path;
        targetSession = session;
      }
    } else {
      const session = wtSessions.find((entry) => shaMatches(entry.headSha, commitId));
      if (session) {
        targetWorktreePath = session.path;
        targetSession = session;
      }
    }

    // Find preview session matching this node
    const previewSession = terminalSessions.find((session) => {
      if (session.kind !== 'preview') return false;
      if (!repoPath || !sameRepoPath(session.projectPath, repoPath)) return false;
      if (isWT) {
        return (
          session.targetKind === 'worktree' &&
          (session.targetId === commitId || (targetWorktreePath && sameRepoPath(session.worktreePath, targetWorktreePath)))
        );
      } else {
        return session.targetKind === 'commit' && session.targetId === commitId;
      }
    });

    if (isRegularCommit) {
      setActiveTerminalId(null);
      if (previewSession && previewSession.status === 'running') {
        void activatePreviewTarget(previewSession, true).catch(() => undefined);
      } else {
        const target: PreviewTarget = { kind: 'commit', sha: commitId };
        void handlePreviewNode(target, commitId, { focusTerminal: false });
      }
      return;
    }

    let focusedTerminalId: string | null = null;
    if (targetWorktreePath) {
      const normalizedPath = normalizePath(targetWorktreePath).toLowerCase();
      const lastUsedId = lastActiveTerminalIdByWorktreePathRef.current.get(normalizedPath);
      const worktreeShellSessions = terminalSessions.filter((session) =>
        session.kind === 'shell' &&
        sameRepoPath(session.worktreePath, targetWorktreePath)
      );
      if (worktreeShellSessions.length > 0) {
        const stillExists = worktreeShellSessions.find((s) => s.id === lastUsedId);
        focusedTerminalId = stillExists ? stillExists.id : worktreeShellSessions[0].id;
      }
    }

    if (previewSession && previewSession.status === 'running') {
      void activatePreviewTarget(previewSession, true).catch(() => undefined);
    } else if (targetSession) {
      const target: PreviewTarget = {
        kind: 'worktree',
        worktreePath: targetSession.path,
        headSha: targetSession.headSha || commitId,
        workingTreeId: targetSession.workingTreeId,
      };
      void handlePreviewNode(target, commitId, { focusTerminal: !focusedTerminalId });
    }

    if (focusedTerminalId) {
      setActiveTerminalId(focusedTerminalId);
    } else if (previewSession) {
      setActiveTerminalId(previewSession.id);
    }
  }, [repoPath, terminalSessions, sortedWorktrees, checkedOutRef, handlePreviewNode, previewInProgress]);

  const useBottomTerminal = activeTerminal != null && terminalPanelPlacement === 'bottom';
  const terminalCountByWorkingTreeId = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!repoPath) return counts;
    for (const worktreeSession of buildWorktreeSessions(sortedWorktrees, repoPath, checkedOutRef, activeProject?.worktreeOrder)) {
      const count = terminalSessions.filter((session) =>
        session.kind === 'shell'
        && session.status === 'running'
        && sameRepoPath(session.worktreePath, worktreeSession.path),
      ).length;
      if (count > 0) {
        counts[worktreeSession.workingTreeId] = count;
      }
    }
    return counts;
  }, [checkedOutRef, repoPath, terminalSessions, sortedWorktrees]);

  const handleCreateTerminal = useCallback(async (projectPath: string, worktreePath: string) => {
    const number = terminalSessions.filter((session) => sameRepoPath(session.worktreePath, worktreePath) && session.kind === 'shell').length + 1;
    const session = await createTerminalSession({
      projectPath,
      worktreePath,
      kind: 'shell',
      label: `Terminal ${number}`,
      command: '',
      cols: 100,
      rows: 30,
      targetId: null,
      targetKind: null,
      previewUrl: null,
      previewAppName: null,
    });
    setTerminalSessions((current) => [...current, session]);
    setActiveTerminalId(session.id);
    const focusId = resolveTerminalSessionFocusId(session);
    if (focusId) {
      focusMapOnNode(projectPath, focusId);
    }
  }, [focusMapOnNode, terminalSessions]);

  const handleTerminateTerminal = useCallback(async (id: string) => {
    await terminateTerminalSession(id).catch(() => undefined);
    setTerminalSessions((current) => current.filter((session) => session.id !== id));
    setActiveTerminalId((current) => current === id ? null : current);
  }, []);

  const handleTerminalSessionChange = useCallback((session: TerminalSession) => {
    setTerminalSessions((current) => {
      const next = current.map((candidate) => candidate.id === session.id ? session : candidate);
      return terminalSessionsEqual(current, next) ? current : next;
    });
  }, []);

  const blockMapDisplay = !mapReadyForDisplay || mapPresentationState !== 'ready';
  const blockMapInteraction = mapLoading;

  const handleCreateWorktree = useCallback((projectPath: string, branchOrCommitInput?: string) => {
    setWorktreePromptProjectPath(projectPath);
    setWorktreePromptOpen(true);

    const existingNames = new Set<string>();
    for (const b of branches) {
      existingNames.add(b.name.toLowerCase());
    }
    for (const w of sortedWorktrees) {
      const name = w.path.split(/[/\\]/).pop();
      if (name) {
        existingNames.add(name.toLowerCase());
      }
    }

    // Resolve synthetic current-worktree targets, but preserve explicit commit SHAs.
    let resolvedTarget = branchOrCommitInput;
    if (resolvedTarget === 'HEAD' || resolvedTarget === 'WORKING_TREE' || (resolvedTarget && resolvedTarget.startsWith('WORKING_TREE:'))) {
      if (checkedOutRef?.branchName) {
        resolvedTarget = checkedOutRef.branchName;
      }
    }

    if (resolvedTarget === undefined) {
      setWorktreePromptBranchOrCommit('');
      setWorktreePromptBranchOrCommitEditable(true);
    } else {
      setWorktreePromptBranchOrCommit(resolvedTarget);
      setWorktreePromptBranchOrCommitEditable(false);
    }

    const { defaultFolderName, createBranch, createBranchDisabled } = determineWorktreePromptDefaults(
      resolvedTarget,
      sortedWorktrees,
      branches,
    );

    setWorktreePromptFolderName(defaultFolderName);
    setWorktreePromptCreateBranch(createBranch);
    setWorktreePromptCreateBranchDisabled(createBranchDisabled);
  }, [branches, sortedWorktrees, checkedOutRef]);

  const confirmCreateWorktreePrompt = useCallback(async () => {
    const projectPath = worktreePromptProjectPath;
    const branchOrCommit = worktreePromptBranchOrCommit.trim();
    const folderName = worktreePromptFolderName.trim();
    if (!folderName) return;

    setWorktreePromptOpen(false);

    const homeDir = await invoke<string>('get_home_dir');
    const repoName = projectPath.split(/[/\\]/).pop() || 'repo';
    const repoHash = worktreeStableKey(projectPath);
    const repoFolderName = `${repoName}-${repoHash}`;
    const branchFolderName = folderName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const worktreePath = `${homeDir}/.cobble/worktrees/${repoFolderName}/${branchFolderName}`;

    const project = projectCards.find((p) => sameRepoPath(p.path, projectPath));
    const branch = project?.branches.find((b) => b.name === branchOrCommit);
    const headSha = branch?.headSha || project?.checkedOutRef?.headSha || '0000000000000000000000000000000000000000';

    const tempWorktree: WorktreeInfo = {
      path: worktreePath,
      pathExists: true,
      headSha,
      branchName: worktreePromptCreateBranch ? branchFolderName : (branchOrCommit || null),
      parentSha: null,
      isCurrent: false,
      isPrunable: false,
      hasUncommittedChanges: false,
    };

    beginRepoMutation();

    if (sameRepoPath(projectPath, repoPath)) {
      setWorktrees((prev) => [...prev, tempWorktree]);
    } else {
      setProjectSnapshots((prev) => {
        const snapshot = prev[projectPath];
        if (!snapshot) return prev;
        return {
          ...prev,
          [projectPath]: {
            ...snapshot,
            worktrees: [...(snapshot.worktrees || []), tempWorktree],
          },
        };
      });
    }

    try {
      await invoke('add_worktree', {
        repoPath: projectPath,
        worktreePath,
        branchOrCommit: branchOrCommit || null,
        newBranchName: worktreePromptCreateBranch ? branchFolderName : null,
      });

      const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath: projectPath }).catch(
        () => [] as WorktreeInfo[],
      );
      const movedStashIndex = /^stash@\{(\d+)\}$/.exec(branchOrCommit)?.[1];
      const stashDropOutcome = movedStashIndex != null
        ? outcomeFromStashDrops([parseInt(movedStashIndex, 10)])
        : null;

      if (sameRepoPath(projectPath, repoPath)) {
        setWorktrees(updatedWorktrees);
        await finalizeRepoMutation(
          projectPath,
          outcomeFromWorktreeSync(updatedWorktrees),
          ...(stashDropOutcome ? [stashDropOutcome] : []),
        );
      } else {
        const updatedStashes = movedStashIndex != null
          ? await invoke<GitStashEntry[]>('list_stashes', { repoPath: projectPath }).catch(() => null)
          : null;
        setProjectSnapshots((prev) => {
          const snapshot = prev[projectPath];
          if (!snapshot) return prev;
          return {
            ...prev,
            [projectPath]: {
              ...snapshot,
              worktrees: updatedWorktrees,
              stashes: updatedStashes ?? snapshot.stashes,
            },
          };
        });
        endRepoMutation();
      }
    } catch (e) {
      endRepoMutation();
      if (sameRepoPath(projectPath, repoPath)) {
        setWorktrees((prev) => prev.filter((wt) => wt.path !== worktreePath));
      } else {
        setProjectSnapshots((prev) => {
          const snapshot = prev[projectPath];
          if (!snapshot) return prev;
          return {
            ...prev,
            [projectPath]: {
              ...snapshot,
              worktrees: (snapshot.worktrees || []).filter((wt) => wt.path !== worktreePath),
            },
          };
        });
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error('Failed to create worktree:', message);
    }
  }, [projectCards, repoPath, worktreePromptProjectPath, worktreePromptBranchOrCommit, worktreePromptFolderName, worktreePromptCreateBranch]);

  const handleDeleteWorktree = useCallback(async (projectPath: string, worktreePath: string) => {
    let wtInfo: WorktreeInfo | undefined;
    let targetDefaultBranch = 'main';
    if (sameRepoPath(projectPath, repoPath)) {
      wtInfo = worktrees.find((wt) => wt.path === worktreePath);
      targetDefaultBranch = defaultBranch || 'main';
    } else {
      const snapshot = projectSnapshots[projectPath];
      if (snapshot) {
        wtInfo = (snapshot.worktrees || []).find((wt) => wt.path === worktreePath);
        targetDefaultBranch = snapshot.defaultBranch || 'main';
      }
    }

    const branchName = wtInfo?.branchName;
    const canDeleteBranch = Boolean(branchName && branchName !== targetDefaultBranch);

    let confirmMsg = `Are you sure you want to delete the worktree at ${worktreePath}?`;
    if (canDeleteBranch) {
      confirmMsg = `Are you sure you want to delete the worktree at ${worktreePath}? Its local branch "${branchName}" will also be deleted if it has no unique commits.`;
    }

    const confirm = window.confirm(confirmMsg);
    if (!confirm) return;

    beginRepoMutation();

    if (sameRepoPath(projectPath, repoPath)) {
      setWorktrees((prev) => prev.filter((wt) => wt.path !== worktreePath));
    } else {
      setProjectSnapshots((prev) => {
        const snapshot = prev[projectPath];
        if (!snapshot) return prev;
        return {
          ...prev,
          [projectPath]: {
            ...snapshot,
            worktrees: (snapshot.worktrees || []).filter((wt) => wt.path !== worktreePath),
          },
        };
      });
    }

    try {
      const removeResult = await invoke<RemoveWorktreeResult>('remove_worktree_and_empty_branch', {
        repoPath: projectPath,
        worktreePath,
        force: true,
      });
      const branchDeleteOutcome = removeResult.deletedBranch
        ? outcomeFromDeleteSelection({
          deletedBranches: [removeResult.deletedBranch],
          discardedUncommittedChanges: false,
          checkedOutRef: null,
          removedWorktreePaths: [worktreePath],
        })
        : null;

      const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath: projectPath }).catch(
        () => [] as WorktreeInfo[],
      );

      if (sameRepoPath(projectPath, repoPath)) {
        setWorktrees(updatedWorktrees);
        await finalizeRepoMutation(
          projectPath,
          ...(branchDeleteOutcome ? [branchDeleteOutcome] : []),
          outcomeFromWorktreeSync(updatedWorktrees),
        );
      } else {
        setProjectSnapshots((prev) => {
          const snapshot = prev[projectPath];
          if (!snapshot) return prev;
          return {
            ...prev,
            [projectPath]: {
              ...snapshot,
              worktrees: updatedWorktrees,
            },
          };
        });
        endRepoMutation();
        if (branchDeleteOutcome) {
          void refreshProjectSnapshotFromGit(projectPath, { force: true });
        }
      }
    } catch (e) {
      endRepoMutation();
      const updatedWorktrees = await invoke<WorktreeInfo[]>('list_worktrees', { repoPath: projectPath }).catch(
        () => [] as WorktreeInfo[],
      );
      if (sameRepoPath(projectPath, repoPath)) {
        setWorktrees(updatedWorktrees);
      } else {
        setProjectSnapshots((prev) => {
          const snapshot = prev[projectPath];
          if (!snapshot) return prev;
          return {
            ...prev,
            [projectPath]: {
              ...snapshot,
              worktrees: updatedWorktrees,
            },
          };
        });
        if (canDeleteBranch) {
          void refreshProjectSnapshotFromGit(projectPath, { force: true });
        }
      }
      const errText = e instanceof Error ? e.message : String(e);
      setError(errText);
      console.error('Failed to delete worktree:', errText);
    }
  }, [repoPath, worktrees, projectSnapshots, defaultBranch, refreshProjectSnapshotFromGit]);

  if (!projectsHydrated) {
    return <div className="h-screen min-h-0 overflow-hidden bg-background text-foreground" />;
  }

  if (projects.length === 0) {
    return (
      <div
        className="window-drag-region relative h-screen min-h-0 overflow-hidden bg-background text-foreground"
        onPointerEnter={() => setIsEmptyAddProjectHovered(true)}
        onPointerLeave={() => setIsEmptyAddProjectHovered(false)}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (
            event.button !== 0 ||
            target?.closest('.window-no-drag, input, textarea, select, button, [contenteditable="true"]')
          ) {
            return;
          }

          const startX = event.clientX;
          const startY = event.clientY;
          const DRAG_THRESHOLD_PX = 4;
          let dragging = false;

          const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('blur', onWindowBlur);
          };

          const onWindowBlur = () => {
            setIsEmptyAddProjectHovered(false);
            cleanup();
          };

          const onMove = (e: PointerEvent) => {
            if (dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
              dragging = true;
              cleanup();
              void getCurrentWindow().startDragging();
            }
          };

          const onUp = () => {
            cleanup();
            if (!dragging) {
              setIsEmptyAddProjectHovered(false);
              handleAddProject();
            }
          };

          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('blur', onWindowBlur);
        }}
      >
        <div className="absolute inset-0 flex">
          <MapGridLoadingTiles shimmer={false} rippleActive={isEmptyAddProjectHovered} />
        </div>
        {!pendingInitialProjectPath ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex h-7 items-center rounded-lg pr-3 text-sm text-foreground">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center">
                <CobblePlusIcon />
              </span>
              <span>Add project</span>
            </div>
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
          {error ? (
            <p className="window-no-drag pointer-events-auto max-w-[min(28rem,calc(100%-3rem))] rounded-xl bg-[var(--destructive-bg)] px-3 py-2 text-center text-xs text-red-600">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="relative z-30 flex h-full min-h-0 flex-col">
        <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
          <div
            ref={sidebarShellRef}
            className="relative z-[60] flex h-full min-h-0 flex-none overflow-visible border-r border-border"
            style={{ width: isSidebarCollapsed ? 64 : sidebarWidthPx }}
          >
            <button
              type="button"
              className="window-no-drag absolute right-2.5 left-22 top-2.25 z-[9999] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted"
              aria-label={isSidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
              onClick={() => setIsSidebarCollapsed((value) => !value)}
            >
              {isSidebarCollapsed ? (
                <PanelLeftOpen strokeWidth={1.5} className="h-4 w-4 shrink-0" />
              ) : (
                <PanelLeftClose strokeWidth={1.5} className="h-4 w-4 shrink-0" />
              )}
            </button>
            <DenseBranchSidebar
              className={cn(
                'min-h-0 shrink-0 overflow-hidden pt-14 transition-[width,opacity] duration-300 ease-in-out',
                'opacity-100',
              )}
              style={{ width: '100%' }}
              collapsed={isSidebarCollapsed}
              projects={projectCards}
              activeProjectPath={repoPath}
              onSelectProject={loadRepo}
              onAddProject={handleAddProject}
              onRemoveProject={removeProject}
              onReorderProjects={reorderProjects}
              onRevealProjectInFinder={revealProjectInFinder}
              onResetProjectNodePositions={resetProjectNodePositions}
              projectLoading={!repoPath && loading}
              projectLoadStates={projectLoadStates}
              projectError={error}
              terminalSessions={terminalSessions}
              activeTerminalId={activeTerminalId}
              onCreateTerminal={handleCreateTerminal}
              onSelectTerminal={async (session) => {
                setActiveTerminalId(session.id);
                if (session.kind === 'preview') {
                  void activatePreviewTarget(session).catch((error) => {
                    console.warn('Failed to activate preview:', error);
                  });
                  return;
                }
                if (!sameRepoPath(repoPath, session.projectPath)) {
                  await loadRepo(session.projectPath);
                }
                const focusId = resolveTerminalSessionFocusId(session);
                if (focusId) {
                  focusMapOnNode(session.projectPath, focusId);
                }
              }}
              onTerminateTerminal={handleTerminateTerminal}
              onSelectWorktree={async (projectPath, workingTreeId) => {
                if (!repoPath || !sameRepoPath(repoPath, projectPath)) await loadRepo(projectPath);
                handleSidebarSelectCommit(workingTreeId);
              }}
              onReorderWorktrees={reorderWorktrees}
              onReorderTerminals={reorderTerminals}
              onCreateWorktree={handleCreateWorktree}
              onDeleteWorktree={handleDeleteWorktree}
              onPreviewWorktree={async (projectPath, worktree) => {
                if (!repoPath || !sameRepoPath(repoPath, projectPath)) await loadRepo(projectPath);
                const workingTreeId = workingTreeIdForPath(worktree.path, worktree.isCurrent);
                handlePreviewNode({
                  kind: 'worktree',
                  worktreePath: worktree.path,
                  headSha: worktree.headSha,
                  workingTreeId,
                }, workingTreeId);
              }}
              onShowContextMenu={showContextMenu}
              onCloseContextMenu={() => setContextMenu(null)}
            />
            {!isSidebarCollapsed ? (
              <div
                aria-hidden="true"
                onPointerDown={handleSidebarPointerDown}
                onPointerMove={handleSidebarPointerMove}
                onPointerUp={handleSidebarPointerUp}
                onPointerCancel={handleSidebarPointerCancel}
                className="absolute bottom-0 right-[-6px] top-0 z-50 w-3 cursor-col-resize bg-transparent"
              />
            ) : null}
          </div>

          <div
            className={cn(
              'relative flex min-h-0 min-w-0 flex-1 overflow-hidden',
              useBottomTerminal ? 'flex-col' : 'flex-row',
            )}
          >
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <div className="pointer-events-none absolute left-0 right-0 top-0 z-40 h-12" />
              <BranchGridMapView
                branches={branchesForLayout}
                mergeNodes={mergeNodes}
                directCommits={enrichedDirectCommits}
                unpushedDirectCommits={enrichedUnpushedDirectCommits}
                unpushedCommitShasByBranch={unpushedCommitShasByBranch}
                openPRs={openPRs}
                defaultBranch={defaultBranch}
                branchCommitPreviews={enrichedBranchCommitPreviews}
                branchParentByName={enrichedBranchParentByName}
                branchUniqueAheadCounts={enrichedBranchUniqueAheadCounts}
                gridSearchQuery={gridSearchQuery}
                gridSearchJumpToken={gridSearchJumpToken}
                gridSearchJumpDirection={gridSearchJumpDirection}
                gridFocusSha={gridFocusSha}
                isLoading={mapLoading}
                isSyncing={projectTreeLoading}
                blockMapDisplay={blockMapDisplay}
                blockMapInteraction={blockMapInteraction}
                mapReadyEpoch={mapSwitchEpoch}
                onMapReadyForDisplay={handleMapReadyForDisplay}
                onGridSearchResultCountChange={setGridSearchResultCount}
                onGridSearchResultIndexChange={setGridSearchResultIndex}
                onGridSearchFocusChange={handleGridFocusChange}
                checkedOutRef={visualCheckedOutRef}
                onCommitClick={handleMapCommitClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onMergeRefsIntoBranch={handleMergeRefsIntoBranch}
                mergeInProgress={mergeInProgress}
                onPushAllBranches={handlePushAllBranches}
                onPushCurrentBranch={handlePushCurrentBranch}
                onPushCommitTargets={handlePushCommitTargets}
                pushInProgress={pushInProgress}
                onSquashCommitRange={handleSquashCommitRange}
                squashInProgress={squashInProgress}
                onDeleteSelection={handleDeleteSelection}
                deleteInProgress={deleteInProgress}
                worktrees={sortedWorktrees}
                currentRepoPath={repoPath ?? undefined}
                onStashLocalChanges={handleStashLocalChanges}
                stashInProgress={stashInProgress}
                stashDisabled={false}
                onCommitLocalChanges={handleCommitLocalChanges}
                onAutoCommitLocalChanges={handleAutoCommitLocalChanges}
                commitInProgress={commitInProgress}
                commitDisabled={false}
                onStageAllChanges={handleStageAllChanges}
                stageInProgress={stageInProgress}
                onCreateBranchFromNode={handleCreateBranchFromNode}
                onCreateGeneratedBranch={handleCreateGeneratedBranch}
                onCreateRootBranch={handleCreateRootBranch}
                onCreateTerminal={handleCreateTerminal}
                onCreateWorktree={handleCreateWorktree}
                createBranchFromNodeInProgress={createBranchFromNodeInProgress}
                isMutationBusy={isMutationBusy}
                isDebugOpen={isGridDebugOpen}
                onDebugClose={() => setIsGridDebugOpen(false)}
                debugRows={softUpdateDebugRows}
                onInteractionChange={setIsMapInteracting}
                onPreviewNode={handlePreviewNode}
                previewInProgress={previewInProgress}
                previewedNodeId={previewedNodeId}
                previewedWorktreeNodeIds={previewedWorktreeNodeIds}
                terminalCountByWorkingTreeId={terminalCountByWorkingTreeId}
                manuallyOpenedClumps={manuallyOpenedGridClumps}
                manuallyClosedClumps={manuallyClosedGridClumps}
                setManuallyOpenedClumps={setManuallyOpenedGridClumps}
                setManuallyClosedClumps={setManuallyClosedGridClumps}
                layoutModel={gridLayoutModelForView}
                nodePositionOverrides={
                  repoPath ? (nodePositionOverridesByRepo[normalizePath(repoPath)] ?? {}) : {}
                }
                onNodePositionOverridesChange={handleNodePositionOverridesChange}
                orientation={mapGridOrientation}
                worktreeDraftByWorkingTreeId={worktreeDraftByWorkingTreeId}
                gridHudProps={gridHudProps}
                onShowContextMenu={showContextMenu}
              />
              {mapLoading && mapLayoutStatus.state === 'computing' ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[130] flex justify-center px-4">
                  <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-card/80 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                    <span>Building map for {mapLayoutStatus.nodeEstimate.toLocaleString()} items</span>
                    {repoPath ? (
                      <button
                        type="button"
                        onClick={() => void copyProjectDiagnostics(repoPath)}
                        className="rounded-lg px-2 py-1 text-foreground transition-colors hover:bg-muted"
                      >
                        Copy diagnostics
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {mapPresentationState === 'error' && repoPath ? (
                <div className="absolute inset-0 z-[140] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
                  <div className="w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-lg">
                    <p className="text-sm font-medium text-foreground">Map could not be built</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {mapLayoutStatus.error ?? 'The repository data is available. The map worker stopped before it produced a layout.'}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {mapLayoutStatus.nodeEstimate.toLocaleString()} items were sent to the map worker.
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void copyProjectDiagnostics(repoPath)}
                        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        Copy diagnostics
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          beginMapSwitch();
                          isRepoSwitchingRef.current = true;
                          setMapLoading(true);
                          setLayoutEpoch((epoch) => epoch + 1);
                        }}
                        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        Retry map
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {diagnosticsCopyFeedback ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[160] flex justify-center">
                  <span className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-sm">
                    {diagnosticsCopyFeedback}
                  </span>
                </div>
              ) : null}
              {previewSetupOpen && previewDraftConfig ? (
                <div className="absolute inset-0 z-[90] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
                  <div className="w-full max-w-md rounded-2xl border border-border bg-background p-4 shadow-lg">
                    <p className="text-sm font-medium text-foreground">Preview commands</p>
                    <p className="mt-1 text-xs text-muted-foreground">Confirm the commands used to build and run this project preview.</p>
                    <label className="mt-3 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Install
                    </label>
                    <input
                      value={previewDraftConfig.installCommand}
                      onChange={(event) => setPreviewDraftConfig({ ...previewDraftConfig, installCommand: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                    <label className="mt-3 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Run
                    </label>
                    <input
                      value={previewDraftConfig.runCommand}
                      onChange={(event) => setPreviewDraftConfig({ ...previewDraftConfig, runCommand: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewSetupOpen(false);
                          setPendingPreviewTarget(null);
                          setPendingPreviewNodeId(null);
                          setPreviewedNodeId(null);
                        }}
                        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleConfirmPreviewSetup()}
                        disabled={!previewDraftConfig.runCommand.trim() || previewInProgress}
                        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {previewInProgress ? 'Starting...' : 'Save and preview'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <TerminalPanel
              session={activeTerminal}
              placement={terminalPanelPlacement}
              onPlacementChange={setTerminalPanelPlacement}
              onClose={() => setActiveTerminalId(null)}
              onTerminate={(id) => void handleTerminateTerminal(id)}
              onSessionChange={handleTerminalSessionChange}
            />
          </div>
        </div>
      </div>
      {contextMenu ? (
        <div
          ref={menuRef}
          className="context-menu-panel fixed z-[100] w-max min-w-[120px] rounded-md border border-border bg-background p-1"
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'project' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void revealProjectInFinder(contextMenu.projectPath);
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Open in Finder
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  try {
                    await navigator.clipboard.writeText(contextMenu.projectPath);
                  } catch (err) {
                    console.error('Failed to copy path:', err);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy file path
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  try {
                    const escaped = `'${contextMenu.projectPath.replace(/'/g, "'\\''")}'`;
                    await navigator.clipboard.writeText(`cd ${escaped}`);
                  } catch (err) {
                    console.error('Failed to copy cd command:', err);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy cd command
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void handleCreateWorktree(contextMenu.projectPath);
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                New worktree
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void copyProjectDiagnostics(contextMenu.projectPath);
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy diagnostics
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  resetProjectNodePositions(contextMenu.projectPath);
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Reset layout
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  removeProject(contextMenu.projectPath);
                }}
                className="w-full px-2 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-[var(--destructive-bg-hover)]"
              >
                Remove
              </button>
            </>
          )}
          {contextMenu.type === 'worktree' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    void revealProjectInFinder(contextMenu.worktreePath);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Open in Finder
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    try {
                      await navigator.clipboard.writeText(contextMenu.worktreePath);
                    } catch (err) {
                      console.error('Failed to copy path:', err);
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy file path
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    try {
                      const escaped = `'${contextMenu.worktreePath.replace(/'/g, "'\\''")}'`;
                      await navigator.clipboard.writeText(`cd ${escaped}`);
                    } catch (err) {
                      console.error('Failed to copy cd command:', err);
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy cd command
              </button>
              {contextMenu.worktree?.branchName && (
                <button
                  type="button"
                  onClick={async () => {
                    setContextMenu(null);
                    if (contextMenu.worktree?.branchName) {
                      try {
                        await navigator.clipboard.writeText(contextMenu.worktree.branchName);
                      } catch (err) {
                        console.error('Failed to copy worktree label:', err);
                      }
                    }
                  }}
                  className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  Copy worktree label
                </button>
              )}
              {contextMenu.commitText && (
                <button
                  type="button"
                  onClick={async () => {
                    setContextMenu(null);
                    if (contextMenu.commitText) {
                      try {
                        await navigator.clipboard.writeText(contextMenu.commitText);
                      } catch (err) {
                        console.error('Failed to copy message:', err);
                      }
                    }
                  }}
                  className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  Copy message
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    void handleCreateTerminal(contextMenu.projectPath, contextMenu.worktreePath);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                New terminal
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.worktree) {
                    if (!repoPath || !sameRepoPath(repoPath, contextMenu.projectPath)) await loadRepo(contextMenu.projectPath);
                    const workingTreeId = workingTreeIdForPath(contextMenu.worktree.path, contextMenu.worktree.isCurrent);
                    handlePreviewNode({
                      kind: 'worktree',
                      worktreePath: contextMenu.worktree.path,
                      headSha: contextMenu.worktree.headSha,
                      workingTreeId,
                    }, workingTreeId);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    void handleDeleteWorktree(contextMenu.projectPath, contextMenu.worktreePath);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-[var(--destructive-bg-hover)]"
              >
                Delete
              </button>
            </>
          )}
          {contextMenu.type === 'worktree-plus' && (
            <>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.worktree) {
                    if (!repoPath || !sameRepoPath(repoPath, contextMenu.projectPath)) await loadRepo(contextMenu.projectPath);
                    const workingTreeId = workingTreeIdForPath(contextMenu.worktree.path, contextMenu.worktree.isCurrent);
                    handlePreviewNode({
                      kind: 'worktree',
                      worktreePath: contextMenu.worktree.path,
                      headSha: contextMenu.worktree.headSha,
                      workingTreeId,
                    }, workingTreeId);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (contextMenu.worktreePath) {
                    void handleCreateTerminal(contextMenu.projectPath, contextMenu.worktreePath);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Terminal
              </button>
            </>
          )}
          {contextMenu.type === 'commit' && (
            <>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitLabel) {
                    try {
                      await navigator.clipboard.writeText(contextMenu.commitLabel);
                    } catch (err) {
                      console.error('Failed to copy label:', err);
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy commit label
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitText) {
                    try {
                      await navigator.clipboard.writeText(contextMenu.commitText);
                    } catch (err) {
                      console.error('Failed to copy message:', err);
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy commit message
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitSha) {
                    void handlePreviewNode({
                      kind: 'commit',
                      sha: contextMenu.commitSha,
                    }, contextMenu.commitSha);
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitSha && repoPath) {
                    void handleMapCommitClick({
                      commitSha: contextMenu.commitSha,
                      branchName: contextMenu.branchName,
                      worktreePath: repoPath,
                    });
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Checkout
              </button>
            </>
          )}
          {contextMenu.type === 'stash' && (
            <>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitText) {
                    try {
                      await navigator.clipboard.writeText(contextMenu.commitText);
                    } catch (err) {
                      console.error('Failed to copy stash message:', err);
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Copy stash message
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitSha && repoPath) {
                    void handleMapCommitClick({
                      commitSha: contextMenu.commitSha,
                      worktreePath: repoPath,
                    });
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Checkout
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.commitSha) {
                    const stashMatch = /^STASH:(\d+)$/.exec(contextMenu.commitSha);
                    if (stashMatch) {
                      const stashIndex = parseInt(stashMatch[1], 10);
                      void handleDeleteSelection({
                        branchNames: [],
                        discardUncommittedChanges: false,
                        stashIndices: [stashIndex],
                      });
                    }
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-[var(--destructive-bg-hover)]"
              >
                Delete
              </button>
            </>
          )}
          {contextMenu.type === 'empty-branch' && (
            <>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.branchName && repoPath) {
                    const commitSha = contextMenu.commitSha || '';
                    void handleMapCommitClick({
                      commitSha,
                      branchName: contextMenu.branchName,
                      worktreePath: repoPath,
                    });
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                Checkout
              </button>
              <button
                type="button"
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.branchName) {
                    void handleDeleteSelection({
                      branchNames: [contextMenu.branchName],
                      discardUncommittedChanges: false,
                    });
                  }
                }}
                className="w-full px-2 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-[var(--destructive-bg-hover)]"
              >
                Delete
              </button>
            </>
          )}
        </div>
      ) : null}

      {worktreePromptOpen && (
        <div className="absolute inset-0 z-[9999] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => setWorktreePromptOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-4" onClick={(event) => event.stopPropagation()}>
            <p className="text-sm font-medium text-foreground">Create new worktree</p>
            
            {worktreePromptBranchOrCommitEditable ? (
              <div className="mt-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                  Branch or Commit (leave empty for HEAD)
                </p>
                <input
                  value={worktreePromptBranchOrCommit}
                  onChange={(event) => {
                    const val = event.target.value;
                    setWorktreePromptBranchOrCommit(val);
                    setWorktreePromptFolderName(val.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'HEAD');
                  }}
                  placeholder="main"
                  className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none select-text"
                />
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                  Target Branch/Commit
                </p>
                <p className="mt-1 text-xs text-foreground font-semibold">
                  {worktreePromptBranchOrCommit || 'HEAD'}
                </p>
              </div>
            )}

            <div className="mt-4">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                Worktree Folder Name
              </p>
              <input
                value={worktreePromptFolderName}
                onChange={(event) => setWorktreePromptFolderName(event.target.value)}
                placeholder="my-worktree-folder"
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none select-text"
              />
            </div>

            <div className="mt-4 flex items-center gap-2">
              <input
                type="checkbox"
                id="create-branch-checkbox"
                checked={worktreePromptCreateBranch}
                disabled={worktreePromptCreateBranchDisabled}
                onChange={(event) => setWorktreePromptCreateBranch(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-border bg-background text-primary focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
              />
              <label
                htmlFor="create-branch-checkbox"
                className={`text-xs font-medium cursor-pointer ${
                  worktreePromptCreateBranchDisabled
                    ? 'text-muted-foreground cursor-not-allowed'
                    : 'text-foreground'
                }`}
              >
                Create a new branch (shares folder name)
              </label>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setWorktreePromptOpen(false)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmCreateWorktreePrompt()}
                disabled={!worktreePromptFolderName.trim()}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
