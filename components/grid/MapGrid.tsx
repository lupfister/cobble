import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from 'react';
import { invoke } from '../../src/timedInvoke';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { BranchCommitPreview } from '../../types';
import {
  CARD_HEIGHT,
  CARD_BODY_TOP_OFFSET,
  CARD_WIDTH,
  LEFT_PADDING,
  ROW_GAP,
  ROW_HEIGHT,
  TOP_PADDING,
  type BranchGridViewProps,
  type ConnectorFace,
  type Connector,
  type NodePositionOverrides,
  type Node,
} from './LayoutGrid';
import { GitMerge } from 'lucide-react';
import type { PreviewTarget } from '../../lib/git';
import { GRID_LAYOUT_RENDER_ZOOM } from './branchGridLayoutModel';
import type { BranchGridLayoutModel } from './branchGridLayoutModel';
import { deriveGridSearchMatch } from './gridSearchMatch';
import { connectorsWithEffectivePositions } from './mapGridLiveConnectors';
import {
  assignNodePositionOverride,
  assignNodePositionPreview,
  canonicalizeNodePositionOverridesForCommits,
  getNodePositionOverride,
  isPixelNodePositionOverride,
} from './nodePositionOverrides';
import CommitControls from './CommitControls';
import { mergePanStableVisibleNodeIds, pickNearestVisibleVisualIds } from './MapGridCardVirtualizer';
import MapGridCanvas from './MapGridCanvas';
import MapGridLoadingTiles from './MapGridLoadingTiles';
import MapGridDebugPanel from './MapGridDebugPanel';
import {
  pulseMapGridBackgroundActivity,
  setMapGridBackgroundActivity,
} from './mapGridBackgroundActivity';
import MapGridDialogs from './MapGridDialogs';
import MapSearchBar from './MapSearchBar';
import { useMapGridCamera } from './useMapGridCamera';
import { useMapGridSelection } from './useMapGridSelection';
import {
  buildWorktreeAccentByCommitId,
  buildWorktreeSessions,
  isWorkingTreeCommitId,
  selectedRemovableWorktreeSessions,
  dirtyWorktreeSessions,
  selectedUncommittedSessions,
  worktreeStableKey,
  type WorktreeSession,
} from '../../lib/worktreeSessions';
import type { WorktreeInfo } from '../../types';
import { resolveWorktreeDraftDisplayLabel, type WorktreeDraftDisplay } from '../../src/worktreeDraftMessages';
import { parseMapCheckoutTarget, type MapCheckoutTarget } from './mapCheckoutTarget';
import { parseDeletableEmptyBranchFromCommitId } from './mapDeleteTarget';
import {
  GRID_COMMIT_CORNER_RADIUS_BASE_PX,
  GRID_RENDER_ZOOM,
  MAP_GRID_CULL_VIEWPORT_INSET_SCREEN_PX,
  MAP_GRID_MAX_NODES_REMOVED_PER_FRAME,
  MAP_GRID_PAN_MAX_VISIBLE_EVICT_PER_TICK,
  mapGridMaxVisibleNodeRetain,
  mapGridPanAdmissionBudget,
  buildCommitCullSpatialIndex,
  collectVisibleCommitIdsFromSpatialIndex,
  computeViewportCullBounds,
  isOtherWorktree,
  normalizeRepoPathForCompare,
  looseCableConnectorIntersectsViewportBounds,
  visibleCommitIdSetEquals,
  worktreeSessionDisplayName,
  worktreeShortLabel,
  shasMatch,
  isCommitUnpushedOnBranch,
} from './mapGridUtils';
import type { ViewportContentBounds } from './mapGridUtils';

function countStaleVisibleNodes(prev: Set<string>, target: Set<string>): number {
  let n = 0;
  for (const id of prev) {
    if (!target.has(id)) n++;
  }
  return n;
}

function pruneVisibleNodesTowardTarget(prev: Set<string>, target: Set<string>, maxRemove: number): Set<string> {
  const next = new Set(prev);
  let removed = 0;
  for (const id of prev) {
    if (target.has(id)) continue;
    next.delete(id);
    removed++;
    if (removed >= maxRemove) break;
  }
  for (const id of target) next.add(id);
  return next;
}

const serializeDebugNode = (node: Node | null | undefined) => {
  if (!node) return null;
  return {
    id: node.commit.id,
    visualId: node.commit.visualId,
    branchName: node.commit.branchName,
    kind: node.commit.kind ?? null,
    message: node.commit.message,
    date: node.commit.date,
    parentSha: node.commit.parentSha ?? null,
    parentShas: node.commit.parentShas ?? [],
    row: node.row,
    column: node.column,
    x: node.x,
    y: node.y,
  };
};

const serializeDebugConnector = (connector: Connector, nodeByVisualId: Map<string, Node>) => {
  const parent = connector.fromCommitVisualId ? nodeByVisualId.get(connector.fromCommitVisualId) : null;
  const child = connector.toCommitVisualId ? nodeByVisualId.get(connector.toCommitVisualId) : null;
  return {
    id: connector.id,
    edgeKind: connector.connectorEdgeKind ?? null,
    fromCommitVisualId: connector.fromCommitVisualId ?? null,
    toCommitVisualId: connector.toCommitVisualId ?? null,
    from: parent ? serializeDebugNode(parent) : null,
    to: child ? serializeDebugNode(child) : null,
    rowDelta: parent && child ? child.row - parent.row : null,
    columnDelta: parent && child ? child.column - parent.column : null,
    fromX: connector.fromX,
    fromY: connector.fromY,
    toX: connector.toX,
    toY: connector.toY,
  };
};

function MapGridLoadingState() {
  return <MapGridLoadingTiles />;
}

function MapGridBlockingOverlay() {
  return (
    <div
      role="status"
      aria-label="Preparing map"
      className="pointer-events-auto absolute inset-0 z-[120] bg-background/80"
    />
  );
}

function nodePositionOverridesEqual(left: NodePositionOverrides, right: NodePositionOverrides) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const leftPoint = left[key];
    const rightPoint = right[key];
    if (!rightPoint) return false;
    if (JSON.stringify(leftPoint) !== JSON.stringify(rightPoint)) return false;
  }
  return true;
}

const NODE_POSITIONS_STORAGE_KEY_PREFIX = 'cobble:node-positions:';
const SEARCH_FOCUS_PAN_CLEAR_THRESHOLD_PX = 48;
const EMPTY_SOLVED_POSITION_OVERRIDES: NodePositionOverrides = {};

function normalizeRepoPathForNodePositions(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/, '');
}

function nodePositionsStorageKey(repoPath: string): string {
  return `${NODE_POSITIONS_STORAGE_KEY_PREFIX}${encodeURIComponent(normalizeRepoPathForNodePositions(repoPath))}`;
}

type Props = BranchGridViewProps & {
  isSyncing?: boolean;
  isDebugOpen?: boolean;
  onDebugClose?: () => void;
  debugRows?: string[];
  gridHudProps?: {
    githubAuthStatus: { ghAvailable: boolean; authenticated: boolean } | null;
    githubAuthLoading: boolean;
    onGitHubAuthSetup: () => void;
    gridSearchQuery: string;
    setGridSearchQuery: (value: string) => void;
    gridSearchResultCount: number | null;
    gridSearchResultIndex: number | null;
    setGridSearchJumpDirection: (direction: 1 | -1) => void;
    setGridSearchJumpToken: (token: number | ((token: number) => number)) => void;
    setIsGridDebugOpen: (open: boolean | ((open: boolean) => boolean)) => void;
    githubAuthMessage: string | null;
    commitSwitchFeedback: { kind: 'success' | 'error'; message: string } | null;
    isCommitSwitchFeedbackVisible: boolean;
  };
  blockMapInteraction?: boolean;
  blockMapDisplay?: boolean;
  mapReadyEpoch?: number;
  onMapReadyForDisplay?: (epoch: number) => void;
  nodePositionOverrides?: NodePositionOverrides;
  onNodePositionOverridesChange?: (overrides: NodePositionOverrides) => void;
  worktreeDraftByWorkingTreeId?: ReadonlyMap<string, WorktreeDraftDisplay>;
  terminalCountByWorkingTreeId?: Readonly<Record<string, number>>;
  onShowContextMenu?: (
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus' | 'commit' | 'stash' | 'empty-branch',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo,
    commitSha?: string,
    commitLabel?: string,
    commitText?: string,
    branchName?: string
  ) => void;
};

export default function BranchGridMap({
  branches,
  mergeNodes: _mergeNodes = [],
  directCommits = [],
  unpushedDirectCommits = [],
  unpushedCommitShasByBranch = {},
  openPRs = [],
  defaultBranch,
  onCommitClick,
  onShowContextMenu,
  onLoadMore,
  view,
  staleBranches = [],
  isLoading = false,
  isSyncing = false,
  scrollRequest,
  focusedErrorBranch,
  mapTopInsetPx = 0,
  onMergeRefsIntoBranch,
  mergeInProgress = false,
  onPushAllBranches,
  onPushCurrentBranch,
  onPushCommitTargets,
  pushInProgress = false,
  onSquashCommitRange,
  squashInProgress = false,
  onDeleteSelection,
  deleteInProgress = false,
  worktrees = [],
  currentRepoPath,
  onStashLocalChanges,
  stashInProgress = false,
  stashDisabled = false,
  onCommitLocalChanges,
  onAutoCommitLocalChanges,
  commitInProgress = false,
  commitDisabled = false,
  onStageAllChanges,
  stageInProgress = false,
  onCreateBranchFromNode,
  onCreateGeneratedBranch,
  onCreateRootBranch,
  onCreateTerminal,
  onCreateWorktree,
  createBranchFromNodeInProgress = false,
  isDebugOpen = false,
  onDebugClose,
  debugRows: softUpdateDebugRows = [],
  orientation = 'horizontal',
  branchCommitPreviews = {},
  branchParentByName: _branchParentByName = {},
  branchUniqueAheadCounts = {},
  gridSearchQuery = '',
  gridSearchJumpToken = 0,
  gridSearchJumpDirection = 1,
  gridFocusSha = null,
  checkedOutRef = null,
  onGridSearchResultCountChange,
  onGridSearchResultIndexChange,
  onGridSearchFocusChange,
  onInteractionChange,
  onPreviewNode,
  previewInProgress = false,
  previewedNodeId = null,
  previewedWorktreeNodeIds = [],
  manuallyOpenedClumps: controlledManuallyOpenedClumps,
  manuallyClosedClumps: controlledManuallyClosedClumps,
  setManuallyOpenedClumps: controlledSetManuallyOpenedClumps,
  setManuallyClosedClumps: controlledSetManuallyClosedClumps,
  layoutModel: providedLayoutModel,
  gridHudProps,
  blockMapInteraction = false,
  blockMapDisplay = false,
  mapReadyEpoch = 0,
  onMapReadyForDisplay,
  nodePositionOverrides: controlledNodePositionOverrides,
  onNodePositionOverridesChange,
  worktreeDraftByWorkingTreeId,
  terminalCountByWorkingTreeId = {},
  onNodeDoubleClick,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hudHeaderRef = useRef<HTMLElement | null>(null);
  /** `p-2.5` wrapper: used to map pointer position to the transform layer origin (padding edge). */
  const mapPadHostRef = useRef<HTMLDivElement | null>(null);
  const lastSearchResultCountRef = useRef<number | null | undefined>(undefined);
  const lastSearchResultIndexRef = useRef<number | null | undefined>(undefined);
  const lastSearchFocusShaRef = useRef<string | null | undefined>(undefined);
  const lastHandledSearchJumpKeyRef = useRef<string>('');
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogWorktreePaths, setCommitDialogWorktreePaths] = useState<string[]>([]);
  const [commitMessageDraft, setCommitMessageDraft] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [checkoutPickerOpen, setCheckoutPickerOpen] = useState(false);
  const [checkoutPickerTarget, setCheckoutPickerTarget] = useState<MapCheckoutTarget | null>(null);
  const [checkoutPickerSelectedPath, setCheckoutPickerSelectedPath] = useState<string | null>(null);
  const [newBranchDialogOpen, setNewBranchDialogOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createNewWorktree, setCreateNewWorktree] = useState<boolean>(() => {
    const stored = localStorage.getItem('cobble:new-branch-create-worktree');
    return stored === null ? true : stored === 'true';
  });
  const handleCreateNewWorktreeChange = useCallback((value: boolean) => {
    setCreateNewWorktree(value);
    localStorage.setItem('cobble:new-branch-create-worktree', String(value));
  }, []);
  const [newWorktreeName, setNewWorktreeName] = useState('');
  const [isWorktreeNameManuallyEdited, setIsWorktreeNameManuallyEdited] = useState(false);
  const handleNewBranchNameChange = useCallback((value: string) => {
    setNewBranchName(value);
    if (!isWorktreeNameManuallyEdited) {
      setNewWorktreeName(value.replace(/[^a-zA-Z0-9._-]/g, '_'));
    }
  }, [isWorktreeNameManuallyEdited]);
  const handleNewWorktreeNameChange = useCallback((value: string) => {
    setNewWorktreeName(value);
    setIsWorktreeNameManuallyEdited(true);
  }, []);
  const [localManuallyOpenedClumps, setLocalManuallyOpenedClumps] = useState<Set<string>>(() => new Set());
  const [localManuallyClosedClumps, setLocalManuallyClosedClumps] = useState<Set<string>>(() => new Set());
  const [localNodePositionOverrides, setLocalNodePositionOverrides] = useState<NodePositionOverrides>({});
  const [optimisticNodePositionOverrides, setOptimisticNodePositionOverrides] = useState<NodePositionOverrides | null>(null);
  const nodePositionOverrides =
    optimisticNodePositionOverrides ?? controlledNodePositionOverrides ?? localNodePositionOverrides;
  const setNodePositionOverrides = useCallback(
    (nextOverrides: NodePositionOverrides) => {
      setLocalNodePositionOverrides(nextOverrides);
      if (controlledNodePositionOverrides != null) setOptimisticNodePositionOverrides(nextOverrides);
      onNodePositionOverridesChange?.(nextOverrides);
    },
    [controlledNodePositionOverrides, onNodePositionOverridesChange],
  );
  const [dragPreviewByNodeId, setDragPreviewByNodeId] = useState<NodePositionOverrides>({});
  const [, setActiveDragNodeIds] = useState<Set<string>>(() => new Set());
  const suppressNextCommitClickRef = useRef(false);
  const dragNodeRef = useRef<{
    nodeId: string;
    pointerId?: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    sourceLane: number;
    baseOverrides: NodePositionOverrides;
    baseNodes: Node[];
    groupNodes: Array<{ nodeId: string; commit: Node['commit']; baseX: number; baseY: number }>;
    moved: boolean;
    pendingX: number;
    pendingY: number;
  } | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const manuallyOpenedClumps = controlledManuallyOpenedClumps ?? localManuallyOpenedClumps;
  const manuallyClosedClumps = controlledManuallyClosedClumps ?? localManuallyClosedClumps;
  const setManuallyOpenedClumps = controlledSetManuallyOpenedClumps ?? setLocalManuallyOpenedClumps;
  const setManuallyClosedClumps = controlledSetManuallyClosedClumps ?? setLocalManuallyClosedClumps;
  const [visibleNodeIds, setVisibleNodeIds] = useState<Set<string>>(() => new Set());
  const panAdmissionPendingRef = useRef<Set<string>>(new Set());
  const settlePrunePendingRef = useRef(false);
  const settlePruneTargetRef = useRef<Set<string> | null>(null);
  const settlePruneRafRef = useRef<number | null>(null);
  const visibleRenderNodesRef = useRef<Node[]>([]);
  const lastInteractionEmittedRef = useRef(false);
  const isMarqueeSelectingRef = useRef(false);
  const onRenderedCameraAppliedRef = useRef<() => void>(() => {});
  const onPanActiveChangeRef = useRef<(active: boolean) => void>(() => {});
  const [viewportClientSize, setViewportClientSize] = useState<{ width: number; height: number } | null>(null);
  const [isCompactHud, setIsCompactHud] = useState(false);
  const [hideSearchBar, setHideSearchBar] = useState(false);
  const autoRecoverRef = useRef<{ key: string; attempts: number } | null>(null);
  const searchFocusPanDistanceRef = useRef(0);
  const isSearchPanDismissedRef = useRef(false);
  const hasCullRunRef = useRef(false);
  const visibleBoundsRef = useRef<ViewportContentBounds | null>(null);
  const connectorCullScopeRef = useRef(`${currentRepoPath ?? ''}::${mapReadyEpoch}`);
  const connectorCullScopeKey = `${currentRepoPath ?? ''}::${mapReadyEpoch}`;
  if (connectorCullScopeRef.current !== connectorCullScopeKey) {
    connectorCullScopeRef.current = connectorCullScopeKey;
    visibleBoundsRef.current = null;
  }
  const mergeSliderScopeId = useId();

  const handleUserCameraPan = useCallback((deltaX: number, deltaY: number) => {
    if (isSearchPanDismissedRef.current) return;
    if (!gridFocusSha || !gridSearchQuery.trim()) {
      searchFocusPanDistanceRef.current = 0;
      return;
    }

    searchFocusPanDistanceRef.current += Math.hypot(deltaX, deltaY);
    if (searchFocusPanDistanceRef.current < SEARCH_FOCUS_PAN_CLEAR_THRESHOLD_PX) return;

    searchFocusPanDistanceRef.current = 0;
    isSearchPanDismissedRef.current = true;
    lastSearchFocusShaRef.current = null;
    lastHandledViewportFocusRequestRef.current = null;
    gridHudProps?.setGridSearchQuery('');
    onGridSearchFocusChange?.(null);
  }, [gridFocusSha, gridHudProps, gridSearchQuery, onGridSearchFocusChange]);

  const {
    isCameraMovingRef,
    cameraStateRef,
    panEpoch,
    renderedZoom,
    cameraRenderTick,
    renderedCameraRef,
    interactionIdleTimeoutRef,
    getTransformLayerOriginScreen,
    flushCameraReactTick,
    syncCamera,
    handleWheel,
    registerCameraTarget,
  } = useMapGridCamera({
    mapPadHostRef,
    isEnabled: !blockMapInteraction,
    cameraStorageScopeKey: `${currentRepoPath ?? '__no-repo__'}::${orientation}`,
    onUserCameraPan: handleUserCameraPan,
    onRenderedCameraApplied: () => onRenderedCameraAppliedRef.current(),
    onPanActiveChange: (active) => onPanActiveChangeRef.current(active),
  });

  const lastReadyEpochReportedRef = useRef<number>(0);
  const lastHandledViewportFocusRequestRef = useRef<string | null>(null);

  useEffect(() => {
    lastHandledViewportFocusRequestRef.current = null;
    autoRecoverRef.current = null;
    hasCullRunRef.current = false;
    searchFocusPanDistanceRef.current = 0;
    isSearchPanDismissedRef.current = false;
  }, [mapReadyEpoch, currentRepoPath]);

  useEffect(() => {
    searchFocusPanDistanceRef.current = 0;
  }, [gridFocusSha]);

  useEffect(() => {
    searchFocusPanDistanceRef.current = 0;
    isSearchPanDismissedRef.current = false;
  }, [gridSearchQuery, gridSearchJumpToken]);

  useEffect(() => {
    if (!optimisticNodePositionOverrides || !controlledNodePositionOverrides) return;
    if (!nodePositionOverridesEqual(optimisticNodePositionOverrides, controlledNodePositionOverrides)) return;
    setOptimisticNodePositionOverrides(null);
  }, [controlledNodePositionOverrides, optimisticNodePositionOverrides]);

  const worktreeSessions = useMemo(
    () => buildWorktreeSessions(worktrees, currentRepoPath, checkedOutRef ?? null),
    [worktrees, currentRepoPath, checkedOutRef],
  );
  const worktreeAccentByCommitId = useMemo(
    () => buildWorktreeAccentByCommitId(worktreeSessions),
    [worktreeSessions],
  );

  const checkoutPickerWorktrees = useMemo((): Array<{
    path: string;
    label: string;
    detail: string;
    session: WorktreeSession;
  }> => {
    const normalizedCurrent = currentRepoPath ? normalizeRepoPathForCompare(currentRepoPath) : null;
    const dirtyPaths = new Set(
      dirtyWorktreeSessions(worktreeSessions).map((s) => normalizeRepoPathForCompare(s.path).toLowerCase())
    );
    return worktrees
      .filter((worktree) => worktree.pathExists !== false)
      .filter((worktree) => {
        const norm = normalizeRepoPathForCompare(worktree.path).toLowerCase();
        return !dirtyPaths.has(norm);
      })
      .map((worktree) => {
        const normalizedPath = normalizeRepoPathForCompare(worktree.path);
        const session = worktreeSessions.find((entry) => entry.path === worktree.path)
          ?? worktreeSessions.find(
            (entry) => normalizeRepoPathForCompare(entry.path).toLowerCase() === normalizedPath.toLowerCase(),
          );
        if (!session) return null;
        const isCurrentWindow = normalizedCurrent
          ? normalizedPath === normalizedCurrent || normalizedPath.toLowerCase() === normalizedCurrent.toLowerCase()
          : !isOtherWorktree(worktree, currentRepoPath);
        const branchLabel = worktree.branchName ?? 'detached';
        const headLabel = worktree.headSha.slice(0, 7);
        return {
          path: worktree.path,
          label: isCurrentWindow ? 'This window' : worktreeShortLabel(worktree.path),
          detail: `${branchLabel} • ${headLabel}`,
          session,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
      .sort((left, right) => {
        if (left.session.isCurrent !== right.session.isCurrent) {
          return left.session.isCurrent ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
  }, [worktrees, worktreeSessions, currentRepoPath]);

  const resolvedLayoutModel: BranchGridLayoutModel = providedLayoutModel ?? {
    branchByName: new Map(),
    laneByName: new Map(),
    mainCommits: [],
    branchCommitsByLane: new Map(),
    branchPreviewSets: new Map(),
    allCommits: [],
    clustersByBranch: new Map(),
    clusterKeyByCommitId: new Map(),
    clusterKeyBySha: new Map(),
    leadByClusterKey: new Map(),
    firstByClusterKey: new Map(),
    clusterCounts: new Map(),
    debugRows: [],
    branchDebugRows: [],
    nodes: [],
    normalizedSearchQuery: '',
    matchingNodes: [],
    matchingNodeIds: new Set(),
    focusedNode: null,
    checkedOutClusterKey: null,
    defaultCollapsedClumps: new Set(),
    visibleCommitsList: [],
    renderNodes: [],
    visibleNodesBySha: new Map(),
    visibleNodeByClusterKey: new Map(),
    pointFormatter: () => '',
    contentWidth: 0,
    contentHeight: 0,
    connectors: [],
    mergeConnectors: [],
    connectorDecisions: [],
    nodeWarnings: new Map(),
    connectorParentShas: new Set(),
    branchStartShas: new Set(),
    branchOffNodeShas: new Set(),
    crossBranchOutgoingShas: new Set(),
    commitIdsWithRenderedAncestry: new Set(),
    branchBaseCommitByName: new Map(),
    firstBranchCommitByName: new Map(),
    mergeDestinations: [],
    mergeTargetBranchesBySourceBranchAndCommitSha: new Map(),
  };

  const {
    allCommits,
    clusterKeyByCommitId,
    leadByClusterKey,
    firstByClusterKey,
    clusterCounts,
    focusedNode,
    defaultCollapsedClumps,
    nodes: layoutNodes,
    renderNodes,
    visibleNodesBySha,
    contentWidth,
    contentHeight,
    connectors,
    mergeConnectors,
    connectorDecisions,
  } = resolvedLayoutModel;

  const worktreeSearchLabelsByCommitId = useMemo(() => {
    if (!worktreeDraftByWorkingTreeId || worktreeDraftByWorkingTreeId.size === 0) return undefined;
    const labels = new Map<string, string>();
    for (const [commitId, draft] of worktreeDraftByWorkingTreeId) {
      labels.set(commitId, resolveWorktreeDraftDisplayLabel(draft));
    }
    return labels;
  }, [worktreeDraftByWorkingTreeId]);

  const gridSearchMatch = useMemo(
    () => deriveGridSearchMatch(resolvedLayoutModel.nodes, gridSearchQuery, worktreeSearchLabelsByCommitId),
    [gridSearchQuery, resolvedLayoutModel.nodes, worktreeSearchLabelsByCommitId],
  );
  const { matchingNodes, matchingNodeIds, normalizedSearchQuery } = gridSearchMatch;

  const isHorizontalLayout = orientation === 'horizontal';
  const connectorsForView = useMemo(
    () => connectorsWithEffectivePositions(connectors, renderNodes, dragPreviewByNodeId, EMPTY_SOLVED_POSITION_OVERRIDES, isHorizontalLayout),
    [connectors, renderNodes, dragPreviewByNodeId, isHorizontalLayout],
  );
  const mergeConnectorsForView = useMemo(
    () => connectorsWithEffectivePositions(mergeConnectors, renderNodes, dragPreviewByNodeId, EMPTY_SOLVED_POSITION_OVERRIDES, isHorizontalLayout),
    [mergeConnectors, renderNodes, dragPreviewByNodeId, isHorizontalLayout],
  );

  const isGridSearchActive = Boolean(normalizedSearchQuery);

  const displayZoom = renderedZoom / GRID_RENDER_ZOOM;
  const snapMetrics = useMemo(() => {
    const zoomAwareRowGap = ROW_GAP / GRID_LAYOUT_RENDER_ZOOM;
    const zoomAwareLabelBand = 20 / GRID_LAYOUT_RENDER_ZOOM;
    return {
      timelinePitch: CARD_WIDTH + zoomAwareRowGap + zoomAwareLabelBand,
      lanePitch: ROW_HEIGHT + zoomAwareRowGap + zoomAwareLabelBand,
    };
  }, []);
  const laneFromY = useCallback(
    (y: number) => Math.max(0, Math.round((y - TOP_PADDING) / snapMetrics.lanePitch)),
    [snapMetrics.lanePitch],
  );
  const snapNodePosition = useCallback(
    (x: number, y: number) => {
      return {
        x: LEFT_PADDING + Math.max(0, Math.round((x - LEFT_PADDING) / snapMetrics.timelinePitch)) * snapMetrics.timelinePitch,
        y: TOP_PADDING + laneFromY(y) * snapMetrics.lanePitch,
      };
    },
    [laneFromY, snapMetrics.timelinePitch],
  );
  const avoidNodeCollisions = useCallback(
    (
      dragState: NonNullable<typeof dragNodeRef.current>,
      candidatePositions: NodePositionOverrides,
    ) => {
      const draggedNodeIds = new Set(dragState.groupNodes.map((groupNode) => groupNode.nodeId));
      const occupied = dragState.baseNodes
        .filter((node) => !draggedNodeIds.has(node.commit.visualId))
        .map((node) => {
          const override = getNodePositionOverride(dragState.baseOverrides, node.commit);
          return isPixelNodePositionOverride(override) ? override : { x: node.x, y: node.y };
        });
      const nodeBoxHeight = CARD_BODY_TOP_OFFSET + CARD_HEIGHT + 4;
      const overlaps = (
        left: { x: number; y: number },
        right: { x: number; y: number },
      ) =>
        left.x < right.x + CARD_WIDTH &&
        left.x + CARD_WIDTH > right.x &&
        left.y < right.y + nodeBoxHeight &&
        left.y + nodeBoxHeight > right.y;
      const candidateForGroup = (offset: number) =>
        dragState.groupNodes.map((groupNode) => {
          const point = getNodePositionOverride(candidatePositions, groupNode.commit);
          return {
            x: (isPixelNodePositionOverride(point) ? point.x : groupNode.baseX) + offset,
            y: isPixelNodePositionOverride(point) ? point.y : groupNode.baseY,
          };
        });

      let offset = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const groupCandidates = candidateForGroup(offset);
        const hitsOccupied = groupCandidates.some((candidate) =>
          occupied.some((occupiedNode) => overlaps(candidate, occupiedNode)),
        );
        const hitsGroup = groupCandidates.some((candidate, index) =>
          groupCandidates.some((other, otherIndex) => otherIndex > index && overlaps(candidate, other)),
        );
        if (!hitsOccupied && !hitsGroup) break;
        offset += snapMetrics.timelinePitch;
      }
      if (offset === 0) return candidatePositions;
      const next = { ...candidatePositions };
      for (const groupNode of dragState.groupNodes) {
        const point = getNodePositionOverride(next, groupNode.commit);
        if (!isPixelNodePositionOverride(point)) continue;
        assignNodePositionOverride(next, groupNode.commit, { x: point.x + offset, y: point.y });
      }
      return next;
    },
    [snapMetrics.timelinePitch],
  );

  const nodeByVisualId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const node of renderNodes) {
      m.set(node.commit.visualId, node);
    }
    return m;
  }, [renderNodes]);

  const nodeByCommitId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const node of renderNodes) {
      m.set(node.commit.id, node);
    }
    return m;
  }, [renderNodes]);

  const commitCullSpatialIndex = useMemo(
    () => buildCommitCullSpatialIndex(renderNodes),
    [renderNodes],
  );



  const visibleRenderNodes = useMemo(() => {
    return renderNodes.filter((node) => {
      const commitId = node.commit.id;
      const visualId = node.commit.visualId;
      if (isGridSearchActive && matchingNodeIds.has(commitId)) return true;
      if (focusedNode?.commit.id === commitId) return true;
      if (visibleNodeIds.size === 0) return false;
      if (!visibleNodeIds.has(visualId)) return false;
      return true;
    });
  }, [renderNodes, isGridSearchActive, matchingNodeIds, focusedNode, visibleNodeIds]);

  visibleRenderNodesRef.current = visibleRenderNodes;

  const renderedOpenClumps = useMemo(() => {
    const renderedCountByClusterKey = new Map<string, number>();
    for (const node of renderNodes) {
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      if (!clusterKey || (clusterCounts.get(clusterKey) ?? 1) <= 1) continue;
      renderedCountByClusterKey.set(clusterKey, (renderedCountByClusterKey.get(clusterKey) ?? 0) + 1);
    }
    const next = new Set<string>();
    for (const [clusterKey, count] of renderedCountByClusterKey.entries()) {
      if (count > 1) next.add(clusterKey);
    }
    return next;
  }, [clusterCounts, clusterKeyByCommitId, renderNodes]);

  const lineStrokeWidth = 1.25 / displayZoom;
  const commitCornerRadiusPx = GRID_COMMIT_CORNER_RADIUS_BASE_PX / displayZoom;

  const branchByName = useMemo(() => new Map(branches.map((branch) => [branch.name, branch])), [branches]);
  const freshCopyBranchNames = useMemo(
    () => new Set(branches.filter((branch) => branch.commitsAhead === 0 && !branch.name.startsWith('*')).map((branch) => branch.name)),
    [branches],
  );
  const commitShaToBranchNames = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const node of renderNodes) {
      const set = map.get(node.commit.id) ?? new Set<string>();
      set.add(node.commit.branchName);
      map.set(node.commit.id, set);
    }
    for (const commit of directCommits) {
      const set = map.get(commit.fullSha) ?? new Set<string>();
      if (commit.branch) set.add(commit.branch);
      map.set(commit.fullSha, set);
    }
    return map;
  }, [renderNodes, directCommits, defaultBranch]);
  const unpushedCommitShasSetByBranch = useMemo(
    () =>
      new Map(
        Object.entries(unpushedCommitShasByBranch).map(([branchName, shas]) => [branchName, new Set(shas)] as const),
      ),
    [unpushedCommitShasByBranch],
  );
  const remoteCommitShas = useMemo(() => {
    const localCommitShas = new Set<string>(directCommits.map((commit) => commit.fullSha));
    const remoteShas = new Set<string>();
    const addSha = (sha: string) => {
      if (!sha) return;
      remoteShas.add(sha);
      remoteShas.add(sha.slice(0, 7));
    };
    for (const branch of branches) {
      if (branch.commitsBehind <= 0 && branch.remoteSyncStatus !== 'on-github') continue;
      const previews = branchCommitPreviews[branch.name] ?? [];
      for (const preview of previews) {
        if (preview.kind === 'branch-created' || preview.kind === 'uncommitted' || preview.kind === 'stash') continue;
        if (preview.isRemote || !localCommitShas.has(preview.fullSha)) addSha(preview.fullSha);
      }
      if (branch.headSha && !localCommitShas.has(branch.headSha)) addSha(branch.headSha);
    }
    for (const commit of directCommits) {
      if (commit.isRemote) addSha(commit.fullSha);
    }
    return remoteShas;
  }, [branches, branchCommitPreviews, directCommits]);
  const handlePointerReleaseNoMarquee = useCallback(() => {
    void interactionIdleTimeoutRef.current;
    if (isCameraMovingRef.current || isMarqueeSelectingRef.current) {
      flushCameraReactTick();
    }
  }, [flushCameraReactTick, isCameraMovingRef, isMarqueeSelectingRef, interactionIdleTimeoutRef]);
  const {
    isMarqueeSelecting,
    marqueeRect,
    selectedCommitShas,
    setSelectedCommitShas,
    mergeTargetCommitSha,
    setMergeTargetCommitSha,
    startMarqueeDrag,
  } = useMapGridSelection({
    scrollContainerRef,
    renderedCameraRef,
    getTransformLayerOriginScreen,
    visibleRenderNodes,
    onPointerReleaseNoMarquee: handlePointerReleaseNoMarquee,
  });
  isMarqueeSelectingRef.current = isMarqueeSelecting;
  const selectableCommitShaSet = useMemo(() => new Set(renderNodes.map((node) => node.commit.id)), [renderNodes]);
  const selectedVisibleCommitShas = useMemo(
    () => selectedCommitShas.filter((sha) => selectableCommitShaSet.has(sha)),
    [selectedCommitShas, selectableCommitShaSet],
  );
  const selectedVisibleCommitShasRef = useRef(selectedVisibleCommitShas);
  selectedVisibleCommitShasRef.current = selectedVisibleCommitShas;

  const selectedPreviewNode = useMemo(() => {
    if (selectedVisibleCommitShas.length !== 1) return null;
    const selectedSha = selectedVisibleCommitShas[0];
    return nodeByCommitId.get(selectedSha) ?? null;
  }, [nodeByCommitId, selectedVisibleCommitShas]);

  const layoutDebugJson = useMemo(() => {
    if (!isDebugOpen) return undefined;
    const nodeByVisualId = new Map(renderNodes.map((node) => [node.commit.visualId, node] as const));
    const selectedIds = new Set(selectedVisibleCommitShas);
    const worktreeIds = new Set(worktreeSessions.map((session) => session.workingTreeId));
    const interestingNodeIds = new Set<string>([...selectedIds, ...worktreeIds]);
    const interestingNodes = renderNodes.filter((node) => (
      interestingNodeIds.has(node.commit.id)
      || isWorkingTreeCommitId(node.commit.id)
      || node.commit.kind === 'uncommitted'
    ));
    const interestingVisualIds = new Set(interestingNodes.map((node) => node.commit.visualId));
    const allConnectorsForDebug = [...connectorsForView, ...mergeConnectorsForView];
    const relatedConnectors = allConnectorsForDebug.filter((connector) => (
      (connector.fromCommitVisualId && interestingVisualIds.has(connector.fromCommitVisualId))
      || (connector.toCommitVisualId && interestingVisualIds.has(connector.toCommitVisualId))
    ));
    const violatedConnectors = allConnectorsForDebug.filter((connector) => {
      if (!connector.fromCommitVisualId || !connector.toCommitVisualId) return false;
      const parent = nodeByVisualId.get(connector.fromCommitVisualId);
      const child = nodeByVisualId.get(connector.toCommitVisualId);
      return Boolean(parent && child && (child.row <= parent.row || child.column <= parent.column));
    });
    const overrideEntries = Object.entries(nodePositionOverrides)
      .filter(([key]) => (
        [...interestingNodeIds].some((id) => key.includes(id)) ||
        [...interestingVisualIds].some((visualId) => key.includes(visualId))
      ));

    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      repoPath: currentRepoPath ?? null,
      orientation,
      selectedCommitShas: selectedVisibleCommitShas,
      checkedOutRef,
      worktreeSessions,
      selectedNode: serializeDebugNode(selectedPreviewNode),
      interestingNodes: interestingNodes.map(serializeDebugNode),
      relatedConnectors: relatedConnectors.map((connector) => serializeDebugConnector(connector, nodeByVisualId)),
      violatedConnectors: violatedConnectors.map((connector) => serializeDebugConnector(connector, nodeByVisualId)),
      nodePositionOverrides: Object.fromEntries(overrideEntries),
      visibleBounds: visibleBoundsRef.current,
      layoutCounts: {
        allCommits: allCommits.length,
        layoutNodes: layoutNodes.length,
        renderNodes: renderNodes.length,
        connectors: connectorsForView.length,
        mergeConnectors: mergeConnectorsForView.length,
      },
      warnings: Object.fromEntries(resolvedLayoutModel.nodeWarnings),
    }, null, 2);
  }, [
    allCommits.length,
    checkedOutRef,
    connectorsForView,
    currentRepoPath,
    isDebugOpen,
    layoutNodes.length,
    mergeConnectorsForView,
    nodePositionOverrides,
    orientation,
    renderNodes,
    resolvedLayoutModel.nodeWarnings,
    selectedPreviewNode,
    selectedVisibleCommitShas,
    worktreeSessions,
  ]);

  const isSelectedWorktree = selectedPreviewNode != null && (
    isWorkingTreeCommitId(selectedPreviewNode.commit.id) ||
    selectedPreviewNode.commit.kind === 'uncommitted'
  );
  const newBranchCreateMode = selectedVisibleCommitShas.length === 1 ? 'from-selected-node' : 'new-root';
  const selectedNodeContextText = useMemo(() => {
    if (selectedVisibleCommitShas.length !== 1 || !selectedPreviewNode) return null;
    const commit = selectedPreviewNode.commit;
    if (isWorkingTreeCommitId(commit.id) || commit.kind === 'uncommitted') {
      return 'Stems from HEAD, carrying over uncommitted changes.';
    }
    if (commit.id.startsWith('STASH:') || commit.kind === 'stash') {
      return 'Stems from stash base commit. Stash will be applied and dropped.';
    }
    const shortSha = commit.id.slice(0, 7);
    const msg = commit.message.length > 50 ? `${commit.message.substring(0, 50)}...` : commit.message;
    return `Stems from commit ${shortSha} ("${msg}").`;
  }, [selectedVisibleCommitShas, selectedPreviewNode]);

  const selectedPreviewTarget = useMemo((): { target: PreviewTarget; nodeId: string } | null => {
    if (!selectedPreviewNode) return null;
    const commitId = selectedPreviewNode.commit.id;
    if (commitId.startsWith('STASH:') || commitId.startsWith('BRANCH_HEAD:')) return null;
    if (selectedPreviewNode.commit.kind === 'stash' || selectedPreviewNode.commit.kind === 'branch-created') return null;
    if (isWorkingTreeCommitId(commitId) || selectedPreviewNode.commit.kind === 'uncommitted') {
      const session = worktreeSessions.find((entry) => entry.workingTreeId === commitId);
      if (!session) return null;
      return {
        nodeId: commitId,
        target: {
          kind: 'worktree',
          worktreePath: session.path,
          headSha: session.headSha,
          workingTreeId: session.workingTreeId,
        },
      };
    }
    if (!commitId) return null;
    return {
      nodeId: commitId,
      target: { kind: 'commit', sha: commitId },
    };
  }, [selectedPreviewNode, worktreeSessions]);

  const checkedOutBranchName = checkedOutRef?.branchName ?? null;
  const checkedOutHeadSha = checkedOutRef?.headSha ?? null;

  const branchCandidatesForCommit = useCallback(
    (sha: string): string[] => Array.from(commitShaToBranchNames.get(sha) ?? []),
    [commitShaToBranchNames],
  );

  const selectedCommitTargetOption = useMemo(() => {
    const isMergeableTargetBranch = (name: string) => !/^stash\b/i.test(name.trim());
    const byBranch = new Map<string, { targetSha: string; targetBranch: string; sourceRefs: string[] }>();
    for (const targetSha of selectedVisibleCommitShas) {
      const candidates = branchCandidatesForCommit(targetSha).filter(isMergeableTargetBranch);
      if (candidates.length === 0) continue;
      const targetBranch = candidates.find((name) => name !== defaultBranch) ?? candidates[0];
      const sourceRefs = selectedVisibleCommitShas
        .filter((sha) => sha !== targetSha)
        .filter((sha) => {
          const sourceCandidates = new Set(branchCandidatesForCommit(sha).filter(isMergeableTargetBranch));
          return !sourceCandidates.has(targetBranch);
        });
      byBranch.set(targetBranch, { targetSha, targetBranch, sourceRefs });
    }
    const options = Array.from(byBranch.values());
    const explicit = mergeTargetCommitSha
      ? options.find((option) => option.targetSha === mergeTargetCommitSha || option.targetBranch === (branchCandidatesForCommit(mergeTargetCommitSha)[0] ?? ''))
      : null;
    const selected = explicit ?? options[options.length - 1] ?? null;
    return {
      options,
      selected,
      targetBranch: selected?.targetBranch ?? null,
      sources: selected?.sourceRefs ?? [],
    };
  }, [selectedVisibleCommitShas, branchCandidatesForCommit, defaultBranch, mergeTargetCommitSha]);

  const hasNonMergeableSelection = useMemo(() => {
    const isMergeableTargetBranch = (name: string) => !/^stash\b/i.test(name.trim());
    return selectedVisibleCommitShas.some((sha) => {
      const candidates = branchCandidatesForCommit(sha);
      return candidates.length > 0 && candidates.filter(isMergeableTargetBranch).length === 0;
    });
  }, [selectedVisibleCommitShas, branchCandidatesForCommit]);

  const shouldShowMergeMenu =
    selectedVisibleCommitShas.length > 1 &&
    selectedCommitTargetOption.options.length > 0 &&
    !!selectedCommitTargetOption.targetBranch &&
    selectedCommitTargetOption.sources.length > 0 &&
    !hasNonMergeableSelection &&
    !!onMergeRefsIntoBranch;
  const [mergeSliderAnimate, setMergeSliderAnimate] = useState(false);
  useEffect(() => {
    if (shouldShowMergeMenu) setMergeSliderAnimate(false);
  }, [shouldShowMergeMenu, selectedVisibleCommitShas]);

  const pushableBranchByName = useMemo(() => {
    const entries = [
      ...((unpushedDirectCommits.length > 0 || checkedOutBranchName === defaultBranch)
        ? [{
            name: defaultBranch,
            headSha: checkedOutBranchName === defaultBranch ? (checkedOutHeadSha ?? '') : '',
            unpushedCommits: unpushedDirectCommits.length,
            remoteSyncStatus: 'unpushed' as const,
          }]
        : []),
      ...branches.map((branch) => {
        const set = unpushedCommitShasSetByBranch.get(branch.name);
        const unpushedCommitsCount = set && set.size > 0 ? set.size : branch.unpushedCommits;
        return {
          ...branch,
          unpushedCommits: unpushedCommitsCount,
        };
      }),
    ]
      .filter(
        (branch) =>
          !branch.name.startsWith('*') &&
          branch.unpushedCommits > 0 &&
          branch.remoteSyncStatus !== 'on-github',
      )
      .map((branch) => [branch.name, branch] as const);
    return new Map(entries);
  }, [branches, checkedOutBranchName, checkedOutHeadSha, defaultBranch, unpushedDirectCommits.length, unpushedCommitShasSetByBranch]);

  const selectedPushTargets = useMemo(() => {
    // Check if the selected node represents a stash or worktree placeholder (not pushable)
    const selectedNode = selectedVisibleCommitShas.length === 1 ? nodeByCommitId.get(selectedVisibleCommitShas[0]) : null;
    const isSelectedStash = selectedNode != null && (
      selectedNode.commit.id.startsWith('STASH:') ||
      selectedNode.commit.kind === 'stash'
    );
    const isSelectedWorktree = selectedNode != null && (
      isWorkingTreeCommitId(selectedNode.commit.id) ||
      selectedNode.commit.kind === 'uncommitted'
    );
    const isSelectedPlaceholder = selectedNode != null && (
      selectedNode.commit.kind === 'branch-created' ||
      selectedNode.commit.id.startsWith('BRANCH_HEAD:')
    );

    if (isSelectedStash || isSelectedWorktree || isSelectedPlaceholder) {
      return [];
    }

    const getPushableBranch = (sha: string): { name: string; unpushedCommits: number } | null => {
      let candidates = branchCandidatesForCommit(sha);
      if (candidates.length === 0 && selectedNode?.commit.branchName) {
        candidates = [selectedNode.commit.branchName];
      }

      const pushableCandidates = candidates
        .map((name) => {
          if (name === defaultBranch) {
            const isDirectUnpushed = unpushedDirectCommits.some((c) => shasMatch(c.fullSha, sha));
            const hasUnpushedShas = unpushedCommitShasSetByBranch.get(defaultBranch)?.has(sha);
            if (isDirectUnpushed || hasUnpushedShas) {
              const count = unpushedCommitShasSetByBranch.get(defaultBranch)?.size || unpushedDirectCommits.length || 1;
              return { name, unpushedCommits: count };
            }
            return null;
          }

          const branchObj = pushableBranchByName.get(name) || branches.find((b) => b.name === name);
          const unpushedSet = unpushedCommitShasSetByBranch.get(name);
          const isCommitUnpushed = unpushedSet?.has(sha) || isCommitUnpushedOnBranch(sha, name, unpushedCommitShasSetByBranch);

          if (isCommitUnpushed) {
            const count = unpushedSet?.size || branchObj?.unpushedCommits || 1;
            return { name, unpushedCommits: count };
          }

          if (branchObj && branchObj.remoteSyncStatus === 'local-only') {
            return { name, unpushedCommits: branchObj.unpushedCommits || 1 };
          }

          return null;
        })
        .filter((item): item is { name: string; unpushedCommits: number } => item !== null);

      if (pushableCandidates.length === 0) return null;

      if (checkedOutBranchName) {
        const checkedOut = pushableCandidates.find((c) => c.name === checkedOutBranchName);
        if (checkedOut) return checkedOut;
      }

      const nonDefault = pushableCandidates.find((c) => c.name !== defaultBranch);
      if (nonDefault) return nonDefault;

      return pushableCandidates[0];
    };

    const commitPreviewListForBranch = (branchName: string): BranchCommitPreview[] => {
      if (branchName === defaultBranch) {
        return unpushedDirectCommits.map((commit) => ({
          fullSha: commit.fullSha,
          sha: commit.sha,
          parentSha: commit.parentSha ?? null,
          message: commit.message,
          author: commit.author,
          date: commit.date,
          kind: commit.kind ?? 'commit',
        }));
      }
      return branchCommitPreviews[branchName] ?? [];
    };

    const map = new Map<string, { branchName: string; targetSha: string; targetIndex: number; commitCount: number }>();
    for (const sha of selectedVisibleCommitShas) {
      const pushableBranch = getPushableBranch(sha);
      if (!pushableBranch) continue;

      const branchName = pushableBranch.name;
      const unpushedCommitsCount = pushableBranch.unpushedCommits;
      const previews = commitPreviewListForBranch(branchName);

      const targetIndex = previews.findIndex((commit) => shasMatch(commit.fullSha, sha));
      if (targetIndex !== -1) {
        const commitCount = previews.length - targetIndex;
        const existing = map.get(branchName);
        if (!existing || targetIndex < existing.targetIndex) {
          map.set(branchName, {
            branchName,
            targetSha: sha,
            targetIndex,
            commitCount,
          });
        }
      } else {
        const existing = map.get(branchName);
        if (!existing) {
          map.set(branchName, {
            branchName,
            targetSha: sha,
            targetIndex: 0,
            commitCount: unpushedCommitsCount || 1,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [
    selectedVisibleCommitShas,
    nodeByCommitId,
    branchCandidatesForCommit,
    unpushedDirectCommits,
    unpushedCommitShasSetByBranch,
    pushableBranchByName,
    branches,
    checkedOutBranchName,
    defaultBranch,
    branchCommitPreviews,
    selectedPreviewNode,
  ]);

  const selectedSquashTarget = useMemo((): { branchName: string; commitShas: string[] } | null => {
    if (!onSquashCommitRange) return null;

    if (selectedVisibleCommitShas.length >= 2) {
      const selectedNodes = selectedVisibleCommitShas
        .map((sha) => nodeByCommitId.get(sha))
        .filter((node): node is Node => node != null);
      if (selectedNodes.length !== selectedVisibleCommitShas.length) return null;
      if (selectedNodes.some((node) => (
        node.commit.kind === 'branch-created' ||
        node.commit.kind === 'uncommitted' ||
        node.commit.kind === 'stash' ||
        node.commit.id.startsWith('BRANCH_HEAD:') ||
        node.commit.id.startsWith('STASH:') ||
        isWorkingTreeCommitId(node.commit.id) ||
        node.commit.isRemote
      ))) return null;
      const branchName = selectedNodes[0]?.commit.branchName;
      if (!branchName || selectedNodes.some((node) => node.commit.branchName !== branchName)) return null;
      const branchPreviews = branchName === defaultBranch
        ? directCommits.map((commit) => ({
            fullSha: commit.fullSha,
            parentSha: commit.parentSha ?? null,
          }))
        : (branchCommitPreviews[branchName] ?? [])
            .filter((commit) => commit.kind !== 'branch-created' && commit.kind !== 'uncommitted' && commit.kind !== 'stash')
            .map((commit) => ({
              fullSha: commit.fullSha,
              parentSha: commit.parentSha ?? null,
            }));
      const selectedSet = new Set(selectedVisibleCommitShas);
      const selectedPreviews = branchPreviews.filter((commit) => selectedSet.has(commit.fullSha));
      if (selectedPreviews.length !== selectedVisibleCommitShas.length) return null;
      const indexes = selectedPreviews
        .map((commit) => branchPreviews.findIndex((candidate) => candidate.fullSha === commit.fullSha))
        .sort((a, b) => a - b);
      if (indexes.some((index) => index < 0)) return null;
      for (let index = 1; index < indexes.length; index += 1) {
        if (indexes[index] !== indexes[index - 1]! + 1) return null;
      }
      const ordered = indexes.map((index) => branchPreviews[index]!.fullSha);
      return { branchName, commitShas: ordered };
    }

    if (selectedVisibleCommitShas.length === 1) {
      const selectedSha = selectedVisibleCommitShas[0];
      const selectedNode = nodeByCommitId.get(selectedSha);
      if (!selectedNode) return null;

      let realSha = selectedNode.commit.id;
      let isBranchHead = false;
      if (realSha.startsWith('BRANCH_HEAD:')) {
        isBranchHead = true;
        const parts = realSha.split(':');
        realSha = parts[parts.length - 1];
      }

      if (
        selectedNode.commit.kind === 'branch-created' ||
        selectedNode.commit.kind === 'uncommitted' ||
        selectedNode.commit.kind === 'stash' ||
        (!isBranchHead && selectedNode.commit.id.startsWith('BRANCH_HEAD:')) ||
        selectedNode.commit.id.startsWith('STASH:') ||
        isWorkingTreeCommitId(selectedNode.commit.id) ||
        selectedNode.commit.isRemote
      ) return null;

      const branchName = selectedNode.commit.branchName;
      if (!branchName) return null;

      const clusterKeys = resolvedLayoutModel.clusterKeyBySha.get(realSha) ?? [];
      const clusterKey = clusterKeys[0];
      if (!clusterKey) return null;

      const count = resolvedLayoutModel.clusterCounts.get(clusterKey) ?? 1;
      if (count < 2) return null;

      const clumpCommits = resolvedLayoutModel.allCommits.filter((commit) => {
        const keys = resolvedLayoutModel.clusterKeyBySha.get(commit.id) ?? [];
        return keys.includes(clusterKey);
      });

      const validCommits = clumpCommits.filter((commit) => 
        commit.kind !== 'branch-created' && 
        commit.kind !== 'uncommitted' && 
        commit.kind !== 'stash'
      );

      if (validCommits.length < 2) return null;

      const safeTime = (dStr: string) => {
        const t = new Date(dStr).getTime();
        return Number.isFinite(t) ? t : 0;
      };

      const ordered = [...validCommits]
        .sort((a, b) => safeTime(a.date) - safeTime(b.date))
        .map((commit) => commit.id);

      return { branchName, commitShas: ordered };
    }

    return null;
  }, [
    onSquashCommitRange,
    selectedVisibleCommitShas,
    nodeByCommitId,
    defaultBranch,
    directCommits,
    branchCommitPreviews,
    resolvedLayoutModel,
  ]);

  const selectedStashIndices = useMemo(
    () =>
      Array.from(
        new Set(
          selectedVisibleCommitShas
            .map((sha) => /^STASH:(\d+)$/.exec(sha))
            .filter((match): match is RegExpExecArray => !!match)
            .map((match) => parseInt(match[1], 10)),
        ),
      ).sort((a, b) => a - b),
    [selectedVisibleCommitShas],
  );
  const worktreeInfoByNormalizedPath = useMemo(() => {
    const map = new Map<string, WorktreeInfo>();
    for (const worktree of worktrees) {
      map.set(normalizeRepoPathForCompare(worktree.path).toLowerCase(), worktree);
    }
    return map;
  }, [worktrees]);
  const dirtyWorktrees = useMemo(
    () => dirtyWorktreeSessions(worktreeSessions),
    [worktreeSessions],
  );
  const dirtyWorktreePaths = useMemo(
    () => dirtyWorktrees.map((session) => session.path),
    [dirtyWorktrees],
  );
  const uncommittedSessionsToDiscard = useMemo(
    () => selectedUncommittedSessions(worktreeSessions, selectedVisibleCommitShas),
    [worktreeSessions, selectedVisibleCommitShas],
  );
  const selectedDirtyWorktreePaths = useMemo(
    () => uncommittedSessionsToDiscard.map((session) => session.path),
    [uncommittedSessionsToDiscard],
  );
  const removableWorktreeSessions = useMemo(
    () => selectedRemovableWorktreeSessions(worktreeSessions, selectedVisibleCommitShas),
    [worktreeSessions, selectedVisibleCommitShas],
  );
  const removeWorktreeTargets = useMemo(
    () =>
      removableWorktreeSessions
        .filter((session) => session.pathExists)
        .map((session) => {
          const info = worktreeInfoByNormalizedPath.get(
            normalizeRepoPathForCompare(session.path).toLowerCase(),
          );
          return { path: session.path, force: info?.isPrunable ?? false };
        }),
    [removableWorktreeSessions, worktreeInfoByNormalizedPath],
  );
  const hasSelectedUncommittedChanges = uncommittedSessionsToDiscard.length > 0;
  const selectedDeletableBranchNames = useMemo(() => {
    const names: string[] = [];
    for (const commitId of selectedVisibleCommitShas) {
      const branchName = parseDeletableEmptyBranchFromCommitId(
        commitId,
        defaultBranch,
        branchByName,
        branchUniqueAheadCounts,
        branchCommitPreviews,
      );
      if (branchName) names.push(branchName);
    }
    return Array.from(new Set(names));
  }, [
    selectedVisibleCommitShas,
    defaultBranch,
    branchByName,
    branchUniqueAheadCounts,
    branchCommitPreviews,
  ]);
  const deletableSelectionCount =
    uncommittedSessionsToDiscard.length
    + removeWorktreeTargets.length
    + selectedStashIndices.length
    + selectedDeletableBranchNames.length;
  const deleteSelectionItems = [
    ...selectedDeletableBranchNames.map((branchName) => `Branch ${branchName}`),
    ...uncommittedSessionsToDiscard.map((session) => (
      session.isCurrent
        ? 'Discard changes'
        : `Discard changes · ${worktreeSessionDisplayName(session)}`
    )),
    ...removeWorktreeTargets.map(({ path }) => {
      const session = removableWorktreeSessions.find((entry) => entry.path === path);
      return session
        ? `Remove worktree · ${worktreeSessionDisplayName(session)}`
        : `Remove worktree · ${worktreeShortLabel(path)}`;
    }),
    ...selectedStashIndices.map((idx) => `Stash ${idx + 1}`),
  ];
  const pushableRemoteBranchCount = pushableBranchByName.size;

  const handleHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.window-no-drag, input, textarea, select, button, [contenteditable="true"]')) {
      return;
    }
    if (event.detail >= 2) {
      void getCurrentWindow().toggleMaximize();
      return;
    }
    void getCurrentWindow().startDragging();
  }, []);

  useEffect(() => {
    const next = normalizedSearchQuery ? matchingNodes.length : null;
    if (lastSearchResultCountRef.current === next) return;
    lastSearchResultCountRef.current = next;
    onGridSearchResultCountChange?.(next);
  }, [matchingNodes.length, normalizedSearchQuery, onGridSearchResultCountChange]);

  const searchMatchedBranchHeadSha = useMemo(() => {
    if (!normalizedSearchQuery) return null;
    const query = normalizedSearchQuery;
    const branchNames = branches.map((branch) => branch.name);
    const exactBranchName = branchNames.find((branchName) => branchName.toLowerCase() === query);
    const startsWithBranchName =
      exactBranchName ?? branchNames.find((branchName) => branchName.toLowerCase().startsWith(query));
    const includesBranchName =
      startsWithBranchName ?? branchNames.find((branchName) => branchName.toLowerCase().includes(query));
    const matchedBranchName = includesBranchName;
    if (!matchedBranchName) return null;

    const matchedBranch = branches.find((branch) => branch.name === matchedBranchName) ?? null;
    if (matchedBranch?.headSha) return matchedBranch.headSha;

    const previews = branchCommitPreviews[matchedBranchName] ?? [];
    if (previews.length > 0) return previews[0]?.fullSha ?? null;

    if (matchedBranchName === defaultBranch) {
      return directCommits[0]?.fullSha ?? null;
    }
    return null;
  }, [normalizedSearchQuery, branches, branchCommitPreviews, defaultBranch, directCommits]);

  const searchJumpFocusSha = useMemo(() => {
    if (!normalizedSearchQuery || gridSearchJumpToken <= 0) return null;
    const currentIndex = gridFocusSha
      ? matchingNodes.findIndex((node) => node.commit.id === gridFocusSha)
      : -1;
    const nextIndex = matchingNodes.length > 0
      ? (currentIndex < 0
          ? 0
          : (currentIndex + gridSearchJumpDirection + matchingNodes.length) % matchingNodes.length)
      : -1;
    return matchingNodes[nextIndex]?.commit.id ?? searchMatchedBranchHeadSha ?? null;
  }, [
    normalizedSearchQuery,
    gridSearchJumpToken,
    gridSearchJumpDirection,
    matchingNodes,
    gridFocusSha,
    searchMatchedBranchHeadSha,
  ]);

  const viewportFocusSha = isGridSearchActive && gridSearchJumpToken > 0
    ? (searchJumpFocusSha ?? gridFocusSha)
    : gridFocusSha;

  useEffect(() => {
    const next =
      normalizedSearchQuery && viewportFocusSha
        ? (() => {
            const index = matchingNodes.findIndex((node) => node.commit.id === viewportFocusSha);
            return index >= 0 ? index : null;
          })()
        : null;
    if (lastSearchResultIndexRef.current === next) return;
    lastSearchResultIndexRef.current = next;
    onGridSearchResultIndexChange?.(next);
  }, [viewportFocusSha, matchingNodes, normalizedSearchQuery, onGridSearchResultIndexChange]);

  const resolveFocusRenderNode = useCallback((sha: string | null): Node | null => {
    if (!sha) return null;
    const renderCandidates = renderNodes.filter((node) => node.commit.id === sha);
    if (renderCandidates.length > 0) {
      if (renderCandidates.length === 1 || !focusedNode) return renderCandidates[0];
      return renderCandidates.reduce((best, candidate) => {
        const bestDistance = (best.x - focusedNode.x) ** 2 + (best.y - focusedNode.y) ** 2;
        const candidateDistance = (candidate.x - focusedNode.x) ** 2 + (candidate.y - focusedNode.y) ** 2;
        return candidateDistance < bestDistance ? candidate : best;
      });
    }
    const layoutNode = layoutNodes.find((node) => node.commit.id === sha);
    if (layoutNode) {
      const clusterKey = clusterKeyByCommitId.get(layoutNode.commit.visualId);
      if (clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1) return null;
      return layoutNode;
    }
    return matchingNodes.find((node) => node.commit.id === sha) ?? null;
  }, [renderNodes, focusedNode, layoutNodes, clusterKeyByCommitId, clusterCounts, matchingNodes]);

  const viewportFocusRenderNode = useMemo(
    () => resolveFocusRenderNode(viewportFocusSha),
    [resolveFocusRenderNode, viewportFocusSha],
  );

  const resolveNodeCardCenter = useCallback((node: Node): { x: number; y: number } => {
    const override = getNodePositionOverride(nodePositionOverrides, node.commit);
    const cardLeft = override?.x ?? node.x;
    const cardTop = override?.y ?? node.y;
    return {
      x: cardLeft + CARD_WIDTH / 2,
      y: cardTop + CARD_BODY_TOP_OFFSET + CARD_HEIGHT / 2,
    };
  }, [nodePositionOverrides]);

  useEffect(() => {
    if (!normalizedSearchQuery) {
      lastHandledSearchJumpKeyRef.current = `${gridSearchJumpToken}:`;
      if (lastSearchFocusShaRef.current === null) return;
      lastSearchFocusShaRef.current = null;
      onGridSearchFocusChange?.(null);
      return;
    }

    if (gridSearchJumpToken > 0) {
      const searchJumpKey = `${gridSearchJumpToken}:${normalizedSearchQuery}`;
      if (lastHandledSearchJumpKeyRef.current === searchJumpKey) return;
      lastHandledSearchJumpKeyRef.current = searchJumpKey;
    }

    const nextFocusSha = gridSearchJumpToken > 0
      ? searchJumpFocusSha
      : (matchingNodes[0]?.commit.id ?? searchMatchedBranchHeadSha ?? null);
    if (lastSearchFocusShaRef.current === nextFocusSha) return;
    lastSearchFocusShaRef.current = nextFocusSha;
    onGridSearchFocusChange?.(nextFocusSha);
  }, [
    normalizedSearchQuery,
    onGridSearchFocusChange,
    searchJumpFocusSha,
    searchMatchedBranchHeadSha,
    matchingNodes,
    gridSearchJumpToken,
  ]);

  useLayoutEffect(() => {
    if (!viewportFocusSha) return;
    const focusRequestKey = `${viewportFocusSha}:${gridSearchJumpToken}:${normalizedSearchQuery}`;
    if (lastHandledViewportFocusRequestRef.current === focusRequestKey) return;
    const viewport = scrollContainerRef.current;
    const focusNode = viewportFocusRenderNode;
    if (!viewport || !focusNode) return;
    const origin = getTransformLayerOriginScreen();
    if (!origin) return;
    const viewportRect = viewport.getBoundingClientRect();
    const targetZoom = renderedCameraRef.current.zoom;
    const scale = targetZoom / GRID_RENDER_ZOOM;
    const { x: nodeCenterX, y: nodeCenterY } = resolveNodeCardCenter(focusNode);
    const targetScreenX = viewportRect.left + viewportRect.width / 2;
    const targetScreenY = viewportRect.top + viewportRect.height / 2;
    syncCamera(
      targetScreenX - origin.x - nodeCenterX * scale,
      targetScreenY - origin.y - nodeCenterY * scale,
      targetZoom,
      { animate: true },
    );
    lastHandledViewportFocusRequestRef.current = focusRequestKey;
  }, [
    viewportFocusSha,
    viewportFocusRenderNode,
    normalizedSearchQuery,
    gridSearchJumpToken,
    resolveNodeCardCenter,
    getTransformLayerOriginScreen,
    syncCamera,
    renderedCameraRef,
    mapReadyEpoch,
    renderNodes.length,
    blockMapInteraction,
  ]);

  // Updated on every camera transform write so connector culling matches the viewport during pan.
  const nodeByVisualIdRef = useRef<Map<string, Node>>(new Map());
  nodeByVisualIdRef.current = nodeByVisualId;
  const cullViewportCenterRef = useRef({ x: 0, y: 0 });

  const syncVisibleBoundsFromCamera = useCallback(() => {
    const viewport = scrollContainerRef.current;
    if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
    const bounds = computeViewportCullBounds(
      viewport.clientWidth,
      viewport.clientHeight,
      renderedCameraRef.current,
    );
    if (bounds) visibleBoundsRef.current = bounds;
  }, [renderedCameraRef]);

  onRenderedCameraAppliedRef.current = syncVisibleBoundsFromCamera;

  useLayoutEffect(() => {
    syncVisibleBoundsFromCamera();
    flushCameraReactTick({ urgent: true });
  }, [connectorCullScopeKey, syncVisibleBoundsFromCamera, flushCameraReactTick]);

  const emitInteractionState = useCallback((next: boolean, reason: 'pan/zoom' | 'marquee' | 'idle') => {
    if (lastInteractionEmittedRef.current === next) return;
    lastInteractionEmittedRef.current = next;
    console.debug('[map-interaction] state changed', { active: next, reason });
    setMapGridBackgroundActivity(
      'map-interaction',
      'Map interaction',
      next,
      reason,
    );
    onInteractionChange?.(next);
  }, [onInteractionChange]);

  const handlePanActiveChange = useCallback(
    (active: boolean) => {
      if (active) {
        panAdmissionPendingRef.current.clear();
      }
      const next = active || isMarqueeSelectingRef.current;
      emitInteractionState(next, next ? (active ? 'pan/zoom' : 'marquee') : 'idle');
    },
    [emitInteractionState],
  );

  onPanActiveChangeRef.current = handlePanActiveChange;

  useEffect(() => {
    const next = isCameraMovingRef.current || isMarqueeSelectingRef.current;
    emitInteractionState(next, next ? (isCameraMovingRef.current ? 'pan/zoom' : 'marquee') : 'idle');
  }, [isMarqueeSelecting, emitInteractionState]);

  const cullConnectorPath = useCallback(
    (connector: { id: string; fromX: number; fromY: number; toX: number; toY: number; fromFace?: ConnectorFace; toFace?: ConnectorFace }): boolean => {
      const vb = visibleBoundsRef.current;
      if (!vb) return true;
      const { fromX, fromY, toX, toY } = connector;
      const pad = 160;
      if (
        Math.max(fromX, toX) < vb.left - pad ||
        Math.min(fromX, toX) > vb.right + pad ||
        Math.max(fromY, toY) < vb.top - pad ||
        Math.min(fromY, toY) > vb.bottom + pad
      ) {
        return false;
      }
      return looseCableConnectorIntersectsViewportBounds(fromX, fromY, toX, toY, vb, connector.fromFace, connector.toFace);
    },
    // stable forever — reads visibleBoundsRef at call time
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const applyVisibleNodeCull = useCallback(() => {
    hasCullRunRef.current = true;
    const viewport = scrollContainerRef.current;
    if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;

    const bounds = computeViewportCullBounds(
      viewport.clientWidth,
      viewport.clientHeight,
      renderedCameraRef.current,
    );
    if (!bounds) return;
    visibleBoundsRef.current = bounds;

    const displayZoomForCull = renderedCameraRef.current.zoom / GRID_RENDER_ZOOM;
    const labelTopForCull = -(20 / displayZoomForCull);

    const nextVisible = collectVisibleCommitIdsFromSpatialIndex(
      commitCullSpatialIndex,
      bounds,
      nodeByVisualId,
      labelTopForCull,
    );
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    cullViewportCenterRef.current = { x: centerX, y: centerY };
    const visibleRetainCap = mapGridMaxVisibleNodeRetain(displayZoomForCull);
    const cappedVisible = pickNearestVisibleVisualIds(
      nextVisible,
      visibleRetainCap,
      nodeByVisualId,
      centerX,
      centerY,
    );
    for (const node of renderNodes) {
      const alwaysRetain =
        node.commit.id.startsWith('BRANCH_HEAD:')
        || isWorkingTreeCommitId(node.commit.id)
        || node.commit.kind === 'uncommitted';
      if (!alwaysRetain) continue;
      if (nextVisible.has(node.commit.visualId)) {
        cappedVisible.add(node.commit.visualId);
      }
    }

    if (isCameraMovingRef.current) {
      settlePrunePendingRef.current = false;
      settlePruneTargetRef.current = null;
      setMapGridBackgroundActivity('settle-prune', 'Visible-settle prune', false);
      if (settlePruneRafRef.current != null) {
        window.cancelAnimationFrame(settlePruneRafRef.current);
        settlePruneRafRef.current = null;
      }

      pulseMapGridBackgroundActivity(
        'spatial-cull',
        'Spatial cull tick',
        `${cappedVisible.size} visible`,
      );
      const admissionBudget = mapGridPanAdmissionBudget(displayZoomForCull);
      startTransition(() => {
        setVisibleNodeIds((prev) => {
          if (cappedVisible.size === 0 && prev.size > 0) return prev;
          const next = mergePanStableVisibleNodeIds(
            prev,
            nextVisible,
            cappedVisible,
            admissionBudget,
            visibleRetainCap,
            MAP_GRID_PAN_MAX_VISIBLE_EVICT_PER_TICK,
            nodeByVisualId,
            centerX,
            centerY,
          );
          return visibleCommitIdSetEquals(prev, next) ? prev : next;
        });
      });
      return;
    }

    if (cameraStateRef.current === 'PANNING') return;

    startTransition(() => {
      setVisibleNodeIds((prev) => {
        if (cameraStateRef.current === 'PANNING') return prev;
        if (cappedVisible.size === 0 && prev.size > 0) return prev;
        const pending = panAdmissionPendingRef.current;
        panAdmissionPendingRef.current.clear();

        let base = prev;
        if (base && pending.size > 0) {
          base = new Set(base);
          for (const id of pending) {
            if (cappedVisible.has(id)) base.add(id);
          }
        }

        if (visibleCommitIdSetEquals(base, cappedVisible)) {
          settlePrunePendingRef.current = false;
          settlePruneTargetRef.current = null;
          return base;
        }
        if (!base) {
          settlePrunePendingRef.current = false;
          settlePruneTargetRef.current = null;
          return cappedVisible;
        }

        const stale = countStaleVisibleNodes(base, cappedVisible);
        if (stale <= MAP_GRID_MAX_NODES_REMOVED_PER_FRAME) {
          settlePrunePendingRef.current = false;
          settlePruneTargetRef.current = null;
          return cappedVisible;
        }

        settlePrunePendingRef.current = true;
        settlePruneTargetRef.current = cappedVisible;
        setMapGridBackgroundActivity('settle-prune', 'Visible-settle prune', true, 'pruning toward viewport');
        return pruneVisibleNodesTowardTarget(base, cappedVisible, MAP_GRID_MAX_NODES_REMOVED_PER_FRAME);
      });
    });
  }, [commitCullSpatialIndex, isCameraMovingRef, nodeByVisualId, renderedCameraRef, renderNodes]);

  const spatialCullRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (spatialCullRafRef.current != null) {
      window.cancelAnimationFrame(spatialCullRafRef.current);
    }
    spatialCullRafRef.current = window.requestAnimationFrame(() => {
      spatialCullRafRef.current = null;
      applyVisibleNodeCull();
    });
    return () => {
      if (spatialCullRafRef.current != null) {
        window.cancelAnimationFrame(spatialCullRafRef.current);
        spatialCullRafRef.current = null;
      }
    };
  }, [
    applyVisibleNodeCull,
    gridSearchJumpToken,
    gridFocusSha,
    cameraRenderTick,
    panEpoch,
    viewportClientSize,
  ]);

  useLayoutEffect(() => {
    hasCullRunRef.current = false;
    if (spatialCullRafRef.current != null) {
      window.cancelAnimationFrame(spatialCullRafRef.current);
      spatialCullRafRef.current = null;
    }
    applyVisibleNodeCull();
  }, [renderNodes, applyVisibleNodeCull]);

  useEffect(() => {
    if (isCameraMovingRef.current) return;
    if (cameraStateRef.current === 'PANNING') return;

    if (!settlePrunePendingRef.current || settlePruneTargetRef.current == null) {
      setMapGridBackgroundActivity('settle-prune', 'Visible-settle prune', false);
      return;
    }
    if (settlePruneRafRef.current != null) return;

    settlePruneRafRef.current = window.requestAnimationFrame(() => {
      settlePruneRafRef.current = null;
      if (cameraStateRef.current === 'PANNING') return;
      const target = settlePruneTargetRef.current;
      if (!target || !settlePrunePendingRef.current) return;

      setVisibleNodeIds((prev) => {
        if (!prev || visibleCommitIdSetEquals(prev, target)) {
          settlePrunePendingRef.current = false;
          settlePruneTargetRef.current = null;
          return prev ?? target;
        }
        const next = pruneVisibleNodesTowardTarget(prev, target, MAP_GRID_MAX_NODES_REMOVED_PER_FRAME);
        if (visibleCommitIdSetEquals(next, target)) {
          settlePrunePendingRef.current = false;
          settlePruneTargetRef.current = null;
        }
        return visibleCommitIdSetEquals(prev, next) ? prev : next;
      });
    });

    return () => {
      if (settlePruneRafRef.current != null) {
        window.cancelAnimationFrame(settlePruneRafRef.current);
        settlePruneRafRef.current = null;
      }
    };
  }, [panEpoch, visibleNodeIds]);

  useLayoutEffect(() => {
    const viewport = scrollContainerRef.current;
    if (!viewport) return;
    const handleResize = () => {
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      if (w <= 0 || h <= 0) return;
      setViewportClientSize((prev) => (prev?.width === w && prev?.height === h ? prev : { width: w, height: h }));
    };
    handleResize();
    const ro = new ResizeObserver(handleResize);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [allCommits.length]);

  const renderedNodeCount = isDebugOpen ? visibleRenderNodes.length : 0;
  const renderedMergeConnectorCount = isDebugOpen ? mergeConnectorsForView.filter((connector) => cullConnectorPath(connector)).length : 0;
  const renderedConnectorCount = isDebugOpen ? connectorsForView.filter((connector) => cullConnectorPath(connector)).length : 0;

  useLayoutEffect(() => {
    if (isLoading) return;
    if (blockMapInteraction) return;
    if (Object.keys(nodePositionOverrides).length > 0) return;
    if (renderNodes.length === 0) return;
    if (visibleNodeIds.size > 0) {
      autoRecoverRef.current = null;
      return;
    }
    if (!hasCullRunRef.current) return;
    // Viewport culling can briefly report zero visible nodes while panning; recentering
    // during an active pan gesture reads as a teleport.
    if (isCameraMovingRef.current) return;

    const viewport = scrollContainerRef.current;
    if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
    const origin = getTransformLayerOriginScreen();
    if (!origin) return;

    const recoveryKey = `${mapReadyEpoch}:${renderNodes.length}:${contentWidth}:${contentHeight}`;
    const previousRecovery = autoRecoverRef.current;
    const attempts = previousRecovery?.key === recoveryKey ? previousRecovery.attempts + 1 : 1;
    autoRecoverRef.current = { key: recoveryKey, attempts };

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of renderNodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y + CARD_BODY_TOP_OFFSET);
      maxX = Math.max(maxX, node.x + CARD_WIDTH);
      maxY = Math.max(maxY, node.y + CARD_BODY_TOP_OFFSET + CARD_HEIGHT);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const viewportRect = viewport.getBoundingClientRect();
    const targetZoom = renderedCameraRef.current.zoom;
    if (attempts >= 2) {
      const candidateIds = new Set(renderNodes.map((node) => node.commit.visualId));
      setVisibleNodeIds(pickNearestVisibleVisualIds(
        candidateIds,
        mapGridMaxVisibleNodeRetain(targetZoom / GRID_RENDER_ZOOM),
        nodeByVisualId,
        centerX,
        centerY,
        nodePositionOverrides,
      ));
      return;
    }
    const scale = targetZoom / GRID_RENDER_ZOOM;
    const targetScreenX = viewportRect.left + viewportRect.width / 2;
    const targetScreenY = viewportRect.top + viewportRect.height / 2;
    syncCamera(
      targetScreenX - origin.x - centerX * scale,
      targetScreenY - origin.y - centerY * scale,
      targetZoom,
      { persist: false },
    );
  }, [
    isLoading,
    blockMapInteraction,
    nodePositionOverrides,
    renderNodes,
    visibleNodeIds,
    mapReadyEpoch,
    contentWidth,
    contentHeight,
    nodeByVisualId,
    getTransformLayerOriginScreen,
    renderedCameraRef,
    syncCamera,
  ]);

  const handleCommitCardClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (suppressNextCommitClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      const commitSha = node.commit.id;
      if (event.shiftKey) {
        setSelectedCommitShas((prev) =>
          prev.includes(commitSha)
            ? prev.filter((sha) => sha !== commitSha)
            : [...prev, commitSha],
        );
        setMergeTargetCommitSha(commitSha);
      } else {
        setSelectedCommitShas((prev) => (prev.includes(commitSha) ? [] : [commitSha]));
        setMergeTargetCommitSha((current) => (current === commitSha ? null : commitSha));
      }



      const isDoubleClick = event.detail >= 2;
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      const shouldCheckout = isCmdOrCtrl;

      if (isDoubleClick) {
        onNodeDoubleClick?.(node);
      }

      if (!shouldCheckout) return;

      const checkoutTarget = parseMapCheckoutTarget(node);
      if (!checkoutTarget || !onCommitClick) return;

      if (checkoutPickerWorktrees.length <= 1) {
        const onlyPath = checkoutPickerWorktrees[0]?.path ?? currentRepoPath;
        if (!onlyPath) return;
        void onCommitClick({
          ...checkoutTarget,
          worktreePath: onlyPath,
        });
        return;
      }

      const defaultPath =
        checkoutPickerWorktrees.find((entry) => entry.session.isCurrent)?.path
        ?? checkoutPickerWorktrees[0]?.path
        ?? null;
      setCheckoutPickerTarget(checkoutTarget);
      setCheckoutPickerSelectedPath(defaultPath);
      setCheckoutPickerOpen(true);
    },
    [checkoutPickerWorktrees, currentRepoPath, onCommitClick, onNodeDoubleClick],
  );

  const confirmCheckoutWorktree = useCallback(() => {
    if (!checkoutPickerTarget || !checkoutPickerSelectedPath || !onCommitClick) return;
    setCheckoutPickerOpen(false);
    void onCommitClick({
      ...checkoutPickerTarget,
      worktreePath: checkoutPickerSelectedPath,
    });
    setCheckoutPickerTarget(null);
    setCheckoutPickerSelectedPath(null);
  }, [checkoutPickerSelectedPath, checkoutPickerTarget, onCommitClick]);

  const handleCommitControlsCheckout = useCallback(
    async (target: { commitSha: string; branchName?: string; worktreePath: string }) => {
      if (!onCommitClick) return;

      if (checkoutPickerWorktrees.length <= 1) {
        const onlyPath = checkoutPickerWorktrees[0]?.path ?? currentRepoPath;
        if (!onlyPath) return;
        await onCommitClick({
          ...target,
          worktreePath: onlyPath,
        });
        return;
      }

      const defaultPath =
        checkoutPickerWorktrees.find((entry) => entry.session.isCurrent)?.path
        ?? checkoutPickerWorktrees[0]?.path
        ?? null;
      const targetFromNode = selectedPreviewNode ? parseMapCheckoutTarget(selectedPreviewNode) : null;
      setCheckoutPickerTarget({
        commitSha: target.commitSha,
        branchName: target.branchName,
        summary: targetFromNode?.summary ?? '',
      });
      setCheckoutPickerSelectedPath(defaultPath);
      setCheckoutPickerOpen(true);
    },
    [checkoutPickerWorktrees, currentRepoPath, onCommitClick, selectedPreviewNode],
  );

  const clampDragOverridesToTopology = useCallback(
    (
      dragState: NonNullable<typeof dragNodeRef.current>,
      candidatePositions: NodePositionOverrides,
    ): NodePositionOverrides => {
      const draggedIds = new Set(dragState.groupNodes.map((groupNode) => groupNode.nodeId));
      const allConnectors = [...connectors, ...mergeConnectors];
      const next = { ...candidatePositions };
      for (const groupNode of dragState.groupNodes) {
        const point = getNodePositionOverride(next, groupNode.commit);
        if (!isPixelNodePositionOverride(point)) continue;
        let minX = 0;
        let minY = 0;
        let maxX = Number.POSITIVE_INFINITY;
        let maxY = Number.POSITIVE_INFINITY;
        for (const connector of allConnectors) {
          if (
            connector.toCommitVisualId === groupNode.nodeId
            && connector.fromCommitVisualId
            && !draggedIds.has(connector.fromCommitVisualId)
          ) {
            const parent = nodeByVisualId.get(connector.fromCommitVisualId);
            if (parent) {
              minX = Math.max(minX, parent.x + snapMetrics.timelinePitch);
              minY = Math.max(minY, parent.y + snapMetrics.lanePitch);
            }
          }
          if (
            connector.fromCommitVisualId === groupNode.nodeId
            && connector.toCommitVisualId
            && !draggedIds.has(connector.toCommitVisualId)
          ) {
            const child = nodeByVisualId.get(connector.toCommitVisualId);
            if (child) {
              maxX = Math.min(maxX, child.x - snapMetrics.timelinePitch);
              maxY = Math.min(maxY, child.y - snapMetrics.lanePitch);
            }
          }
        }
        assignNodePositionOverride(next, groupNode.commit, {
          x: Math.min(maxX, Math.max(minX, point.x)),
          y: Math.min(maxY, Math.max(minY, point.y)),
        });
      }
      return next;
    },
    [connectors, mergeConnectors, nodeByVisualId, snapMetrics.lanePitch, snapMetrics.timelinePitch],
  );

  const buildSnappedDragOverrides = useCallback(
    (dragState: NonNullable<typeof dragNodeRef.current>) => {
      const snapped = snapNodePosition(dragState.pendingX, dragState.pendingY);
      const deltaX = dragState.pendingX - dragState.baseX;
      const deltaY = dragState.pendingY - dragState.baseY;
      const snapDeltaX = snapped.x - dragState.pendingX;
      const snapDeltaY = snapped.y - dragState.pendingY;
      const next: NodePositionOverrides = canonicalizeNodePositionOverridesForCommits(
        dragState.baseOverrides,
        dragState.baseNodes.map((node) => node.commit),
      );
      for (const groupNode of dragState.groupNodes) {
        assignNodePositionOverride(next, groupNode.commit, {
          x: groupNode.baseX + deltaX + snapDeltaX,
          y: groupNode.baseY + deltaY + snapDeltaY,
        });
      }
      const snappedPixels = clampDragOverridesToTopology(dragState, avoidNodeCollisions(dragState, next));
      const logical = canonicalizeNodePositionOverridesForCommits(
        dragState.baseOverrides,
        dragState.baseNodes.map((node) => node.commit),
      );
      for (const groupNode of dragState.groupNodes) {
        const point = getNodePositionOverride(snappedPixels, groupNode.commit);
        if (!isPixelNodePositionOverride(point)) continue;
        assignNodePositionOverride(logical, groupNode.commit, {
          row: Math.max(1, Math.round((point.x - LEFT_PADDING) / snapMetrics.timelinePitch) + 1),
          column: laneFromY(point.y),
        });
      }
      return logical;
    },
    [avoidNodeCollisions, clampDragOverridesToTopology, laneFromY, snapMetrics.timelinePitch, snapNodePosition],
  );

  const buildLiveDragPreviewOverrides = useCallback(
    (dragState: NonNullable<typeof dragNodeRef.current>) => {
      const deltaX = dragState.pendingX - dragState.baseX;
      const deltaY = dragState.pendingY - dragState.baseY;
      const next: NodePositionOverrides = {};
      for (const groupNode of dragState.groupNodes) {
        assignNodePositionPreview(next, groupNode.commit, {
          x: groupNode.baseX + deltaX,
          y: groupNode.baseY + deltaY,
        });
      }
      return clampDragOverridesToTopology(dragState, next);
    },
    [clampDragOverridesToTopology],
  );

  const flushDragPosition = useCallback(() => {
    dragRafRef.current = null;
    const dragState = dragNodeRef.current;
    if (!dragState) return;
    setDragPreviewByNodeId(buildLiveDragPreviewOverrides(dragState));
  }, [buildLiveDragPreviewOverrides]);

  const updateDragPosition = useCallback(
    (clientX: number, clientY: number) => {
      const dragState = dragNodeRef.current;
      if (!dragState) return;
      const dragScale = renderedCameraRef.current.zoom / GRID_RENDER_ZOOM;
      const inverseScale = dragScale > 0 ? 1 / dragScale : 1;
      const deltaX = (clientX - dragState.startX) * inverseScale;
      const deltaY = (clientY - dragState.startY) * inverseScale;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) dragState.moved = true;
      if (dragState.moved) suppressNextCommitClickRef.current = true;
      dragState.pendingX = dragState.baseX + deltaX;
      dragState.pendingY = dragState.baseY + deltaY;
      if (dragRafRef.current != null) return;
      dragRafRef.current = window.requestAnimationFrame(flushDragPosition);
    },
    [flushDragPosition, renderedCameraRef],
  );

  const persistNodePositionsDirectly = useCallback((nextOverrides: NodePositionOverrides) => {
    if (!currentRepoPath) return;
    const normalizedPath = normalizeRepoPathForNodePositions(currentRepoPath);
    const payloadJson = JSON.stringify(nextOverrides);
    try {
      window.localStorage.setItem(nodePositionsStorageKey(normalizedPath), payloadJson);
    } catch {
      // App-level persistence still attempts the Tauri write.
    }
    void invoke('store_repo_node_positions', {
      repoPath: normalizedPath,
      payloadJson,
    }).catch((error) => {
      console.error('Failed to directly save node positions:', error);
    });
  }, [currentRepoPath]);

  const endDrag = useCallback(() => {
    if (dragRafRef.current != null) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
      flushDragPosition();
    }
    const dragState = dragNodeRef.current;
    if (dragState?.moved) {
      const nextOverrides = buildSnappedDragOverrides(dragState);
      setNodePositionOverrides(nextOverrides);
      persistNodePositionsDirectly(nextOverrides);
    }
    dragNodeRef.current = null;
    setActiveDragNodeIds(new Set());
    setDragPreviewByNodeId({});
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('-webkit-user-select');
    window.setTimeout(() => {
      suppressNextCommitClickRef.current = false;
    }, 0);
  }, [buildSnappedDragOverrides, flushDragPosition, persistNodePositionsDirectly]);

  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, node: Node) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select')) return;
      event.stopPropagation();
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('-webkit-user-select', 'none');
      suppressNextCommitClickRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      const currentOverride = getNodePositionOverride(nodePositionOverrides, node.commit);
      const baseX = isPixelNodePositionOverride(currentOverride) ? currentOverride.x : node.x;
      const baseY = isPixelNodePositionOverride(currentOverride) ? currentOverride.y : node.y;
      const selectedCommitShaSet = new Set(selectedVisibleCommitShasRef.current);
      const shouldDragSelection = selectedCommitShaSet.size > 1 && selectedCommitShaSet.has(node.commit.id);
      const groupNodes = (shouldDragSelection
        ? renderNodes.filter((renderNode) => selectedCommitShaSet.has(renderNode.commit.id))
        : [node]
      ).map((groupNode) => {
        const groupOverride = getNodePositionOverride(nodePositionOverrides, groupNode.commit);
        return {
          nodeId: groupNode.commit.visualId,
          commit: groupNode.commit,
          baseX: isPixelNodePositionOverride(groupOverride) ? groupOverride.x : groupNode.x,
          baseY: isPixelNodePositionOverride(groupOverride) ? groupOverride.y : groupNode.y,
        };
      });
      setActiveDragNodeIds(new Set(groupNodes.map((groupNode) => groupNode.nodeId)));
      dragNodeRef.current = {
        nodeId: node.commit.visualId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX,
        baseY,
        sourceLane: laneFromY(baseY),
        baseOverrides: nodePositionOverrides,
        baseNodes: renderNodes,
        groupNodes,
        moved: false,
        pendingX: baseX,
        pendingY: baseY,
      };
    },
    [laneFromY, nodePositionOverrides, renderNodes],
  );

  const handleNodePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragNodeRef.current;
      if (!dragState) return;
      if (dragState.pointerId != null && dragState.pointerId !== event.pointerId) return;
      updateDragPosition(event.clientX, event.clientY);
    },
    [updateDragPosition],
  );

  const handleNodePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragNodeRef.current;
      if (!dragState) return;
      if (dragState.pointerId != null && dragState.pointerId !== event.pointerId) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore if pointer capture was already released.
      }
      endDrag();
    },
    [endDrag],
  );

  useEffect(() => {
    const handleWindowPointerMove = (event: PointerEvent) => {
      const dragState = dragNodeRef.current;
      if (!dragState) return;
      if (dragState.pointerId != null && dragState.pointerId !== event.pointerId) return;
      updateDragPosition(event.clientX, event.clientY);
    };
    const handleWindowPointerEnd = (event: PointerEvent) => {
      const dragState = dragNodeRef.current;
      if (!dragState) return;
      if (dragState.pointerId != null && dragState.pointerId !== event.pointerId) return;
      endDrag();
    };
    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerEnd);
    window.addEventListener('pointercancel', handleWindowPointerEnd);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerEnd);
      window.removeEventListener('pointercancel', handleWindowPointerEnd);
    };
  }, [endDrag, updateDragPosition]);

  const commitDialogSummary = useMemo(() => {
    if (commitDialogWorktreePaths.length === 0) {
      return 'Select a worktree with uncommitted changes.';
    }
    if (commitDialogWorktreePaths.length === 1) {
      const session = uncommittedSessionsToDiscard.find(
        (entry) => entry.path === commitDialogWorktreePaths[0],
      );
      if (session) {
        return `Stage all changes, then commit in ${worktreeSessionDisplayName(session)}.`;
      }
      return 'Stage all changes, then commit in the selected worktree.';
    }
    return `Stage all changes, then commit in ${commitDialogWorktreePaths.length} selected worktrees.`;
  }, [commitDialogWorktreePaths, uncommittedSessionsToDiscard]);

  const handleOpenWriteCommit = useCallback(() => {
    const paths = selectedDirtyWorktreePaths;
    if (paths.length === 0) return;
    setCommitDialogWorktreePaths(paths);
    const firstSession = uncommittedSessionsToDiscard[0];
    const draftMessage = firstSession
      ? worktreeDraftByWorkingTreeId?.get(firstSession.workingTreeId)?.message.trim()
      : '';
    setCommitMessageDraft(draftMessage ?? '');
    setCommitDialogOpen(true);
  }, [
    selectedDirtyWorktreePaths,
    uncommittedSessionsToDiscard,
    worktreeDraftByWorkingTreeId,
  ]);

  const handleCloseCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogWorktreePaths([]);
    setCommitMessageDraft('');
  }, []);

  const confirmCommit = useCallback(async () => {
    if (!onCommitLocalChanges || commitDialogWorktreePaths.length === 0) return;
    const ok = await onCommitLocalChanges(commitMessageDraft, commitDialogWorktreePaths);
    if (ok) {
      handleCloseCommitDialog();
    }
  }, [onCommitLocalChanges, commitMessageDraft, commitDialogWorktreePaths, handleCloseCommitDialog]);

  const confirmDeleteSelection = useCallback(async () => {
    if (!onDeleteSelection) return;
    await onDeleteSelection({
      branchNames: selectedDeletableBranchNames,
      discardUncommittedChanges: hasSelectedUncommittedChanges,
      discardUncommittedWorktreePaths: uncommittedSessionsToDiscard.map((session) => session.path),
      removeWorktrees: removeWorktreeTargets,
      stashIndices: selectedStashIndices,
    });
    setDeleteConfirmOpen(false);
    setSelectedCommitShas([]);
    setMergeTargetCommitSha(null);
  }, [
    onDeleteSelection,
    hasSelectedUncommittedChanges,
    selectedStashIndices,
    uncommittedSessionsToDiscard,
    removeWorktreeTargets,
    selectedDeletableBranchNames,
  ]);

  const confirmCreateBranchFromSelection = useCallback(async () => {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;

    let worktreePath: string | null = null;
    if (createNewWorktree && !isSelectedWorktree) {
      const folderName = newWorktreeName.trim();
      if (!folderName) return;

      const homeDir = await invoke<string>('get_home_dir');
      const repoName = currentRepoPath?.split(/[/\\]/).pop() || 'repo';
      const repoHash = worktreeStableKey(currentRepoPath || '');
      const repoFolderName = `${repoName}-${repoHash}`;
      const branchFolderName = folderName.replace(/[^a-zA-Z0-9._-]/g, '_');
      worktreePath = `${homeDir}/.cobble/worktrees/${repoFolderName}/${branchFolderName}`;
    }

    if (newBranchCreateMode === 'new-root') {
      if (!onCreateRootBranch) return;
      await onCreateRootBranch(trimmed, worktreePath);
    } else {
      if (!onCreateBranchFromNode) return;
      const target = selectedVisibleCommitShas.length === 1
        ? selectedVisibleCommitShas[0]
        : checkedOutRef?.headSha ?? null;
      if (!target) return;
      await onCreateBranchFromNode(target, trimmed, worktreePath);
    }
    setNewBranchDialogOpen(false);
    setNewBranchName('');
    setNewWorktreeName('');
    setIsWorktreeNameManuallyEdited(false);
    setSelectedCommitShas([]);
    setMergeTargetCommitSha(null);
  }, [
    newBranchName,
    newWorktreeName,
    createNewWorktree,
    currentRepoPath,
    newBranchCreateMode,
    onCreateRootBranch,
    onCreateBranchFromNode,
    selectedVisibleCommitShas,
    checkedOutRef?.headSha,
    setSelectedCommitShas,
    setMergeTargetCommitSha,
    isSelectedWorktree,
  ]);

  const mapHudVisible =
    Boolean(gridHudProps)
    && !isLoading
    && !(allCommits.length === 0 && blockMapInteraction);

  useLayoutEffect(() => {
    if (!mapHudVisible) return;
    const element = hudHeaderRef.current;
    if (!element) return;
    const compactThresholdPx = 640;
    const searchHideThresholdPx = 440;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      setIsCompactHud(width < compactThresholdPx);
      setHideSearchBar(width < searchHideThresholdPx);
    };
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    return () => observer.disconnect();
  }, [mapHudVisible]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!onDeleteSelection) return;
      if (deleteConfirmOpen) return;
      if (deletableSelectionCount === 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      setDeleteConfirmOpen(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteConfirmOpen, deletableSelectionCount, onDeleteSelection]);

  void [openPRs, onLoadMore, view, staleBranches, isLoading, scrollRequest, focusedErrorBranch, mapTopInsetPx, visibleNodesBySha, freshCopyBranchNames];

  useLayoutEffect(() => {
    if (renderNodes.length === 0) return;
    if (lastReadyEpochReportedRef.current === mapReadyEpoch) return;
    const rafId = window.requestAnimationFrame(() => {
      if (lastReadyEpochReportedRef.current === mapReadyEpoch) return;
      lastReadyEpochReportedRef.current = mapReadyEpoch;
      onMapReadyForDisplay?.(mapReadyEpoch);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [mapReadyEpoch, onMapReadyForDisplay, renderNodes.length]);

  const handleStageAllChanges = useMemo(() => {
    if (!onStageAllChanges) return undefined;
    return () => void onStageAllChanges();
  }, [onStageAllChanges]);

  const handlePreviewSelectedNode = useMemo(() => {
    if (!selectedPreviewTarget || !onPreviewNode) return undefined;
    return () => onPreviewNode(selectedPreviewTarget.target, selectedPreviewTarget.nodeId);
  }, [selectedPreviewTarget, onPreviewNode]);

  const hasUsableMap = renderNodes.length > 0;
  const showLoadingTiles = !hasUsableMap && (isLoading || blockMapInteraction);

  if (showLoadingTiles) {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <MapGridLoadingState />
      </div>
    );
  }

  return (
    <div className="mapgrid-viewport relative flex h-full min-h-0 flex-col overflow-hidden bg-background select-none">
      <MapGridDebugPanel
        isOpen={isDebugOpen}
        onClose={() => onDebugClose?.()}
        visibleBounds={visibleBoundsRef.current}
        renderedNodeCount={renderedNodeCount}
        totalNodeCount={renderNodes.length}
        renderedMergeConnectorCount={renderedMergeConnectorCount}
        totalMergeConnectorCount={mergeConnectorsForView.length}
        renderedConnectorCount={renderedConnectorCount}
        totalConnectorCount={connectorsForView.length}
        mapGridCullViewportInsetScreenPx={MAP_GRID_CULL_VIEWPORT_INSET_SCREEN_PX}
        debugRows={resolvedLayoutModel.debugRows}
        branchDebugRows={resolvedLayoutModel.branchDebugRows}
        softUpdateRows={softUpdateDebugRows}
        layoutDebugJson={layoutDebugJson}
        connectorDecisions={connectorDecisions}
      />
      {gridHudProps ? (
        <header
          ref={hudHeaderRef}
          data-tauri-drag-region
          onPointerDown={handleHeaderPointerDown}
          className="window-drag-region pointer-events-none absolute inset-x-0 top-0 z-[70] flex w-full select-none"
        >
          <div className="pointer-events-auto ml-auto flex w-full max-w-[calc(100vw-116px)] min-w-0 items-start justify-between gap-3 p-2.25 select-none">
              <div className="flex min-w-0 flex-nowrap items-center justify-start gap-3 overflow-visible">
                <CommitControls
                  compactLabels={isCompactHud}
                  selectedVisibleCommitShas={selectedVisibleCommitShas}
                  commitInProgress={commitInProgress}
                  commitDisabled={commitDisabled}
                  stageInProgress={stageInProgress}
                  stashInProgress={stashInProgress}
                  stashDisabled={stashDisabled}
                  pushInProgress={pushInProgress}
                  createBranchFromNodeInProgress={createBranchFromNodeInProgress}
                  onCommitLocalChanges={onCommitLocalChanges}
                  onAutoCommitLocalChanges={onAutoCommitLocalChanges}
                  onStageAllChanges={handleStageAllChanges}
                  onStashLocalChanges={onStashLocalChanges}
                  onPushAllBranches={onPushAllBranches}
                  onPushCurrentBranch={onPushCurrentBranch}
                  onPushCommitTargets={onPushCommitTargets}
                  onSquashCommitRange={onSquashCommitRange}
                  onPreviewSelectedNode={handlePreviewSelectedNode}
                  previewInProgress={previewInProgress}
                  onMergeRefsIntoBranch={onMergeRefsIntoBranch}
                  selectedPushTargets={selectedPushTargets}
                  selectedSquashTarget={selectedSquashTarget}
                  squashInProgress={squashInProgress}
                  pushableRemoteBranchCount={pushableRemoteBranchCount}
                  selectedCommitTargetOption={selectedCommitTargetOption}
                  mergeInProgress={mergeInProgress}
                  mergeTargetCommitSha={mergeTargetCommitSha}
                  setMergeTargetCommitSha={setMergeTargetCommitSha}
                  onWriteCommit={handleOpenWriteCommit}
                  setNewBranchDialogOpen={setNewBranchDialogOpen}
                  onCreateGeneratedBranch={onCreateGeneratedBranch}
                  worktreeDraftByWorkingTreeId={worktreeDraftByWorkingTreeId}
                  dirtyWorktreePaths={dirtyWorktreePaths}
                  selectedDirtyWorktreePaths={selectedDirtyWorktreePaths}
                  selectedPreviewNode={selectedPreviewNode}
                  worktreeSessions={worktreeSessions}
                  currentRepoPath={currentRepoPath}
                  onCommitClick={handleCommitControlsCheckout}
                  onCreateTerminal={onCreateTerminal}
                  onCreateWorktree={onCreateWorktree}
                  hideMergeControls
                />
              </div>
            <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
              <div className="window-no-drag pointer-events-auto flex items-center gap-2">
                {!hideSearchBar ? (
                  <MapSearchBar
                    query={gridHudProps.gridSearchQuery}
                    onQueryChange={gridHudProps.setGridSearchQuery}
                    resultCount={gridHudProps.gridSearchResultCount}
                    resultIndex={gridHudProps.gridSearchResultIndex}
                    onJump={(direction) => {
                      gridHudProps.setGridSearchJumpDirection(direction);
                      gridHudProps.setGridSearchJumpToken((token) => token + 1);
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
          <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-1.5">
            {gridHudProps.githubAuthStatus?.ghAvailable && !gridHudProps.githubAuthStatus.authenticated ? (
              <button
                onClick={gridHudProps.onGitHubAuthSetup}
                disabled={gridHudProps.githubAuthLoading}
                className="window-no-drag pointer-events-auto inline-flex h-7 items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {gridHudProps.githubAuthLoading ? 'Connecting GitHub...' : 'Connect GitHub'}
              </button>
            ) : null}
            {gridHudProps.githubAuthStatus && !gridHudProps.githubAuthStatus.ghAvailable ? (
              <div className="window-no-drag pointer-events-auto inline-flex h-7 items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 text-[11px] font-medium text-foreground">
                <p className="shrink-0 text-[10px] font-medium text-foreground">GitHub</p>
                <p className="max-w-36 truncate text-[11px] text-foreground/90">
                  Install `gh` for private PR data
                </p>
              </div>
            ) : null}
            {gridHudProps.githubAuthMessage ? (
              <div className="window-no-drag pointer-events-auto inline-flex h-7 items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 text-[11px] text-foreground">
                <p className="shrink-0 text-[10px] font-medium text-foreground">GitHub</p>
                <p className="max-w-36 truncate text-[11px] text-foreground/90" title={gridHudProps.githubAuthMessage}>
                  {gridHudProps.githubAuthMessage}
                </p>
              </div>
            ) : null}
            {gridHudProps.commitSwitchFeedback ? (
              <div
                className={`window-no-drag pointer-events-auto inline-flex h-7 items-center gap-2 rounded-md px-2 text-[11px] transition-opacity duration-200 ${
                  gridHudProps.isCommitSwitchFeedbackVisible ? 'opacity-100' : 'opacity-0'
                } ${
                  gridHudProps.commitSwitchFeedback.kind === 'error'
                    ? 'bg-[var(--destructive-bg)] text-red-600'
                    : 'bg-[var(--info-bg)] text-blue-600'
                }`}
                title={gridHudProps.commitSwitchFeedback.message}
              >
                <p className="shrink-0 text-[10px] font-medium opacity-70">
                  {gridHudProps.commitSwitchFeedback.kind === 'error' ? 'Alert' : 'Update'}
                </p>
                <p className="truncate text-[11px]">
                  {gridHudProps.commitSwitchFeedback.message}
                </p>
              </div>
            ) : null}
          </div>
        </header>
      ) : null}
      {shouldShowMergeMenu ? (
        <div className="pointer-events-none absolute bottom-2.25 left-1/2 z-[80] -translate-x-1/2">
          <div className="pointer-events-auto inline-flex w-fit flex-nowrap items-center gap-2.25">
            <div className="inline-flex h-7 items-center rounded-md border border-border bg-background/95 pl-[2px] pr-[4px]">
              <span className="px-2 text-[11px] font-medium text-foreground">Merge to...</span>
              <div className="relative inline-flex h-5 items-center rounded-[2px] bg-muted/30 p-0.5">
                <div className="absolute inset-0.5 overflow-hidden rounded-[1px]">
                  <div
                    className={`h-full rounded-[1px] bg-border ${mergeSliderAnimate ? 'transition-all duration-200 ease-in-out' : ''}`}
                    style={{
                      width: `var(--${mergeSliderScopeId}-active-width, 0px)`,
                      transform: `translateX(var(--${mergeSliderScopeId}-active-offset, 0px))`,
                    }}
                  />
                </div>
                {selectedCommitTargetOption.options.map((option) => {
                  const isActive = option.targetBranch === selectedCommitTargetOption.targetBranch;
                  return (
                    <button
                      key={`merge-${option.targetBranch}`}
                      type="button"
                      onClick={() => {
                        if (option.targetSha !== mergeTargetCommitSha) setMergeSliderAnimate(true);
                        setMergeTargetCommitSha(option.targetSha);
                      }}
                      ref={(node) => {
                        if (!node) return;
                        const parent = node.parentElement;
                        if (!parent) return;
                        if (!isActive) return;
                        const nodeRect = node.getBoundingClientRect();
                        const parentRect = parent.getBoundingClientRect();
                        parent.style.setProperty(`--${mergeSliderScopeId}-active-width`, `${nodeRect.width}px`);
                        parent.style.setProperty(`--${mergeSliderScopeId}-active-offset`, `${nodeRect.left - parentRect.left}px`);
                      }}
                      className={`relative z-10 h-4.5 px-2 text-[11px] font-medium transition-colors ${
                        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {option.targetBranch}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                void onMergeRefsIntoBranch(selectedCommitTargetOption.sources, selectedCommitTargetOption.targetBranch!)
              }
              disabled={selectedCommitTargetOption.sources.length === 0 || mergeInProgress}
              className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <GitMerge strokeWidth={1} className="mr-1.5 h-4 w-4 shrink-0" />
              {mergeInProgress ? 'Merging...' : 'Confirm'}
            </button>
          </div>
        </div>
      ) : null}
      <MapGridCanvas
          scrollContainerRef={scrollContainerRef}
          mapPadHostRef={mapPadHostRef}
          registerCameraTarget={registerCameraTarget}
          renderedCameraRef={renderedCameraRef}
          isMarqueeSelecting={isMarqueeSelecting}
          contentWidth={contentWidth}
          contentHeight={contentHeight}
          isCameraMovingRef={isCameraMovingRef}
          panEpoch={panEpoch}
          cameraRenderTick={cameraRenderTick}
          viewportClientSize={viewportClientSize}
          onWheel={handleWheel}
          onMouseDown={startMarqueeDrag}
          onNodePointerDown={handleNodePointerDown}
          onNodePointerMove={handleNodePointerMove}
          onNodePointerUp={handleNodePointerUp}
          displayZoom={displayZoom}
          selectedVisibleCommitShas={selectedVisibleCommitShas}
          normalizedSearchQuery={normalizedSearchQuery}
          matchingNodeIds={matchingNodeIds}
          focusedCommitId={viewportFocusSha}
          visibleRenderNodes={visibleRenderNodes}
          layoutNodes={renderNodes}
          manuallyOpenedClumps={manuallyOpenedClumps}
          renderedOpenClumps={renderedOpenClumps}
          manuallyClosedClumps={manuallyClosedClumps}
          defaultCollapsedClumps={defaultCollapsedClumps}
          leadByClusterKey={leadByClusterKey}
          firstByClusterKey={firstByClusterKey}
          clusterKeyByCommitId={clusterKeyByCommitId}
          clusterCounts={clusterCounts}
          commitCornerRadiusPx={commitCornerRadiusPx}
          lineStrokeWidth={lineStrokeWidth}
          connectors={connectorsForView}
          mergeConnectors={mergeConnectorsForView}
          cullConnectorPath={cullConnectorPath}
          flushCameraReactTick={flushCameraReactTick}
          syncCamera={syncCamera}
          setManuallyOpenedClumps={setManuallyOpenedClumps}
          setManuallyClosedClumps={setManuallyClosedClumps}
          onCommitCardClick={handleCommitCardClick}
          unpushedCommitShasSetByBranch={unpushedCommitShasSetByBranch}
          remoteCommitShas={remoteCommitShas}
          worktreeAccentByCommitId={worktreeAccentByCommitId}
          worktreeSessions={worktreeSessions}
          worktreeDraftByWorkingTreeId={worktreeDraftByWorkingTreeId}
          terminalCountByWorkingTreeId={terminalCountByWorkingTreeId}
          worktrees={worktrees}
          currentRepoPath={currentRepoPath}
          onShowContextMenu={onShowContextMenu}
          previewedNodeId={previewedNodeId}
          previewedWorktreeNodeIds={previewedWorktreeNodeIds}
          orientation={orientation}
          dragPreviewByNodeId={dragPreviewByNodeId}
          nodePositionOverrides={EMPTY_SOLVED_POSITION_OVERRIDES}
          connectorPathCacheScopeBase={`${currentRepoPath ?? '__no-repo__'}::${orientation}`}
          commitInProgress={commitInProgress}
        />
      {blockMapDisplay ? <MapGridBlockingOverlay /> : null}
      {isSyncing && hasUsableMap && !blockMapDisplay ? (
        <div
          role="status"
          aria-label="Syncing repository"
          className="pointer-events-none absolute right-3 top-3 z-[70] rounded-lg border border-border/50 bg-card/80 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm backdrop-blur-sm"
        >
          Syncing
        </div>
      ) : null}

      {marqueeRect && isMarqueeSelecting ? (
        <div
          className="pointer-events-none absolute z-[60] border"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
            borderColor: 'var(--select)',
            borderWidth: '1.5px',
            backgroundColor: 'transparent',
            borderRadius: 0,
          }}
        />
      ) : null}

      <MapGridDialogs
        commitDialogOpen={commitDialogOpen}
        commitDialogSummary={commitDialogSummary}
        commitMessageDraft={commitMessageDraft}
        onCommitMessageDraftChange={setCommitMessageDraft}
        onCommitDialogClose={handleCloseCommitDialog}
        onCommitConfirm={() => void confirmCommit()}
        commitInProgress={commitInProgress}
        deleteConfirmOpen={deleteConfirmOpen}
        deleteSelectionItems={deleteSelectionItems}
        onDeleteConfirmClose={() => setDeleteConfirmOpen(false)}
        onDeleteConfirm={() => void confirmDeleteSelection()}
        deleteInProgress={deleteInProgress}
        deletableSelectionCount={deletableSelectionCount}
        newBranchDialogOpen={newBranchDialogOpen}
        newBranchName={newBranchName}
        onNewBranchNameChange={handleNewBranchNameChange}
        onNewBranchDialogClose={() => {
          setNewBranchDialogOpen(false);
          setNewBranchName('');
          setNewWorktreeName('');
          setIsWorktreeNameManuallyEdited(false);
        }}
        onNewBranchConfirm={() => void confirmCreateBranchFromSelection()}
        createBranchFromNodeInProgress={createBranchFromNodeInProgress}
        createNewWorktree={createNewWorktree}
        onCreateNewWorktreeChange={handleCreateNewWorktreeChange}
        newWorktreeName={newWorktreeName}
        onNewWorktreeNameChange={handleNewWorktreeNameChange}
        selectedNodeContextText={selectedNodeContextText}
        isWorktreeSelected={isSelectedWorktree}
        checkoutPickerOpen={checkoutPickerOpen}
        checkoutPickerSummary={checkoutPickerTarget?.summary ?? ''}
        checkoutPickerWorktrees={checkoutPickerWorktrees}
        checkoutPickerSelectedPath={checkoutPickerSelectedPath}
        onCheckoutPickerSelectPath={setCheckoutPickerSelectedPath}
        onCheckoutPickerClose={() => {
          setCheckoutPickerOpen(false);
          setCheckoutPickerTarget(null);
          setCheckoutPickerSelectedPath(null);
        }}
        onCheckoutPickerConfirm={() => void confirmCheckoutWorktree()}
      />
    </div>
  );
}
