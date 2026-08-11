import {
  isWorkingTreeCommitId,
  isWorktreeLaneBranchName,
  worktreeSessionCoversEmptyBranch,
  type WorktreeSession,
} from '../../lib/worktreeSessions';
import type { Branch } from '../../types';
import type { BranchCommitPreview } from '../../types';
import type { CheckedOutRef } from '../../types';
import type { DirectCommit } from '../../types';
import type { MergeNode } from '../../types';
import {
  branchBaseCommit,
  CARD_HEIGHT,
  CARD_BODY_TOP_OFFSET,
  CARD_HEADER_HEIGHT,
  CARD_WIDTH,
  type CommitItem,
  type Connector,
  type Node,
  type VisualCommit,
  LEFT_PADDING,
  TOP_PADDING,
  COLUMN_WIDTH,
  type NodePositionOverrides,
  nodeForCommitSha,
  orderByLineage,
  renderableBranchPreviews,
  ROW_GAP,
  ROW_HEIGHT,
  sortByDateThenSha,
  sortedConcreteBranchPreviews,
  toCommit,
} from './LayoutGrid';
import type { Lane } from './LayoutGrid';
import { computeMergeConnectorAnchors, computeParentChildConnectorAnchors } from './branchGridConnectorAnchors';
import { getMapGridConnectorPolyline } from './gridPathUtils';
import { deriveAllClumpsFromOwners, syncClumpCoordinatesToRenderNodes } from './clumpLayout';
import { getNodePositionOverride, migrateNodePositionOverridesForCommits } from './nodePositionOverrides';
import { applyNodePositionOverrides } from './applyNodePositionOverrides';

/** Sync with MapGrid GRID_RENDER_ZOOM — row pitch is authored in this render space. */
export const GRID_LAYOUT_RENDER_ZOOM = 2.25;

const ROW_SPAN_BUCKET_SIZE = 32;

type RowSpanEntry<T> = {
  value: T;
  minRow: number;
  maxRow: number;
};

type RowSpanIndex<T> = Map<number, RowSpanEntry<T>[]>;

const buildRowSpanIndex = <T,>(
  values: T[],
  rows: (value: T) => { from: number; to: number },
): RowSpanIndex<T> => {
  const index: RowSpanIndex<T> = new Map();
  for (const value of values) {
    const span = rows(value);
    const minRow = Math.min(span.from, span.to);
    const maxRow = Math.max(span.from, span.to);
    const firstBucket = Math.floor(minRow / ROW_SPAN_BUCKET_SIZE);
    const lastBucket = Math.floor(maxRow / ROW_SPAN_BUCKET_SIZE);
    const entry = { value, minRow, maxRow };
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const entries = index.get(bucket) ?? [];
      entries.push(entry);
      index.set(bucket, entries);
    }
  }
  return index;
};

const queryRowSpanIndex = <T,>(index: RowSpanIndex<T>, row: number): T[] => {
  const bucket = Math.floor(row / ROW_SPAN_BUCKET_SIZE);
  return (index.get(bucket) ?? [])
    .filter((entry) => entry.minRow <= row && entry.maxRow >= row)
    .map((entry) => entry.value);
};

export type GridCluster = {
  branchName: string;
  key: string;
  /** Commits in this clump, oldest to newest. */
  commitIds: string[];
  leadId: string;
  count: number;
  /** Parents of the first/earliest commit in the clump. */
  parentShas: string[];
  /** Children of the last/latest commit in the clump. */
  childShas: string[];
};

export type ConnectorDecisionRow = {
  id: string;
  kind: 'branch' | 'ancestry' | 'merge';
  parent: string;
  child: string;
  rendered: boolean;
  reason: string;
};

export type MergeDestination = {
  sourceCommitSha: string;
  sourceBranchName: string;
  mergeCommitSha: string;
  targetCommitSha: string;
  targetBranchName: string;
};

export type BaseLayoutModel = {
  branchByName: Map<string, Branch>;
  laneByName: Map<string, Lane>;
  mainCommits: CommitItem[];
  branchCommitsByLane: Map<string, CommitItem[]>;
  branchPreviewSets: Map<string, BranchCommitPreview[]>;
  allCommits: VisualCommit[];
  clustersByBranch: Map<string, GridCluster[]>;
  clusterKeyByCommitId: Map<string, string>;
  clusterKeyBySha: Map<string, string[]>;
  leadByClusterKey: Map<string, string>;
  firstByClusterKey: Map<string, string>;
  clusterCounts: Map<string, number>;
  checkedOutClusterKey: string | null;
  defaultCollapsedClumps: Set<string>;
  mergeDestinations: MergeDestination[];
  mergeTargetBranchesBySourceBranchAndCommitSha: Map<string, Map<string, Set<string>>>;
  
  // Solved base layout details
  baseNodes: Node[];
  rowByVisualId: Map<string, number>;
  columnByCommitVisualId: Map<string, number>;
  clumpOwnerColumnByClusterKey: Map<string, number>;
  
  // Graph relations & helper maps
  branchStartParentShaByName: Map<string, string>;
  branchBaseCommitByName: Map<string, CommitItem>;
  firstBranchCommitByName: Map<string, CommitItem>;
  branchReceivingCommitByName: Map<string, CommitItem>;
  resolveBranchStartParentName: (branch: Branch) => string;
  blueStartShaForBranch: (branch: Branch) => string | null;
  commitById: Map<string, VisualCommit>;
  gitParentsForCommit: (commit: VisualCommit) => VisualCommit[];
  
  // Inputs/Parameters
  orientation: 'vertical' | 'horizontal';
  nodePositionOverrides: NodePositionOverrides;
  defaultBranch: string;
  branches: Branch[];
  branchCommitPreviews: Record<string, BranchCommitPreview[]>;
  branchUniqueAheadCounts: Record<string, number>;
  worktreeSessions: WorktreeSession[];
  isDebugOpen: boolean;
};

export type BranchGridLayoutModel = {
  branchByName: Map<string, Branch>;
  laneByName: Map<string, Lane>;
  mainCommits: CommitItem[];
  branchCommitsByLane: Map<string, CommitItem[]>;
  branchPreviewSets: Map<string, BranchCommitPreview[]>;
  allCommits: VisualCommit[];
  clustersByBranch: Map<string, GridCluster[]>;
  clusterKeyByCommitId: Map<string, string>;
  clusterKeyBySha: Map<string, string[]>;
  leadByClusterKey: Map<string, string>;
  firstByClusterKey: Map<string, string>;
  clusterCounts: Map<string, number>;
  debugRows: string[];
  branchDebugRows: string[];
  nodes: Node[];
  normalizedSearchQuery: string;
  matchingNodes: Node[];
  matchingNodeIds: Set<string>;
  focusedNode: Node | null;
  checkedOutClusterKey: string | null;
  defaultCollapsedClumps: Set<string>;
  visibleCommitsList: VisualCommit[];
  renderNodes: Node[];
  visibleNodesBySha: Map<string, Node[]>;
  visibleNodeByClusterKey: Map<string, Node>;
  pointFormatter: (x: number, y: number) => string;
  contentWidth: number;
  contentHeight: number;
  connectors: Connector[];
  mergeConnectors: Connector[];
  connectorDecisions: ConnectorDecisionRow[];
  nodeWarnings: Map<string, string[]>;
  connectorParentShas: Set<string>;
  branchStartShas: Set<string>;
  branchOffNodeShas: Set<string>;
  crossBranchOutgoingShas: Set<string>;
  commitIdsWithRenderedAncestry: Set<string>;
  branchBaseCommitByName: Map<string, CommitItem>;
  firstBranchCommitByName: Map<string, CommitItem>;
  mergeDestinations: MergeDestination[];
  mergeTargetBranchesBySourceBranchAndCommitSha: Map<string, Map<string, Set<string>>>;
};

export type BranchGridLayoutInput = {
  branches: Branch[];
  mergeNodes: MergeNode[];
  directCommits: DirectCommit[];
  unpushedDirectCommits: DirectCommit[];
  unpushedCommitShasByBranch?: Record<string, string[]>;
  defaultBranch: string;
  branchCommitPreviews: Record<string, BranchCommitPreview[]>;
  branchParentByName?: Record<string, string | null>;
  branchUniqueAheadCounts: Record<string, number>;
  manuallyOpenedClumps: Set<string>;
  manuallyClosedClumps: Set<string>;
  isDebugOpen: boolean;
  gridSearchQuery: string;
  gridFocusSha: string | null;
  checkedOutRef: CheckedOutRef | null;
  worktreeSessions?: WorktreeSession[];
  orientation?: 'vertical' | 'horizontal';
  nodePositionOverrides?: NodePositionOverrides;
  graphLayoutSignature?: string;
};

const safeTimeMs = (value: string | null | undefined): number => {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
};

const shasMatch = (left: string | null | undefined, right: string | null | undefined): boolean => {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
};

function findCommitMetaInRepo(
  sha: string,
  directCommits: DirectCommit[],
  branchCommitPreviews: Record<string, BranchCommitPreview[]>,
): { parentSha: string | null; date: string; author: string } | null {
  const direct = directCommits.find(
    (commit) => shasMatch(commit.fullSha, sha) || shasMatch(commit.sha, sha),
  );
  if (direct) {
    return {
      parentSha: direct.parentSha ?? direct.parentShas?.[0] ?? null,
      date: direct.date,
      author: direct.author,
    };
  }
  const preview = Object.values(branchCommitPreviews)
    .flat()
    .find((commit) => shasMatch(commit.fullSha, sha) || shasMatch(commit.sha, sha));
  if (preview) {
    return {
      parentSha: preview.parentSha ?? preview.parentShas?.[0] ?? null,
      date: preview.date,
      author: preview.author,
    };
  }
  return null;
}

const isWorktreeGraphNode = (commit: { id: string; kind?: string | null }): boolean =>
  commit.kind === 'uncommitted' || isWorkingTreeCommitId(commit.id);
const isWorktreeConnectorSource = (commit: { id: string; kind?: string | null }): boolean =>
  isWorktreeGraphNode(commit);
const isStashGraphCommit = (commit: VisualCommit): boolean =>
  commit.kind === 'stash' || commit.id.startsWith('STASH:');

const isClusterClumpOpen = (
  clusterKey: string,
  manuallyOpenedClumps: Set<string>,
  defaultCollapsedClumps: Set<string>,
  manuallyClosedClumps: Set<string>,
): boolean =>
  manuallyOpenedClumps.has(clusterKey) ||
  (!defaultCollapsedClumps.has(clusterKey) && !manuallyClosedClumps.has(clusterKey));

const compactTimelineRows = (
  rowByVisualId: Map<string, number>,
  commits: VisualCommit[],
): void => {
  const usedRows = [...new Set(commits.map((commit) => rowByVisualId.get(commit.visualId) ?? 1))].sort(
    (left, right) => left - right,
  );
  const remap = new Map(usedRows.map((row, index) => [row, index + 1] as const));
  for (const commit of commits) {
    const row = rowByVisualId.get(commit.visualId) ?? 1;
    rowByVisualId.set(commit.visualId, remap.get(row) ?? row);
  }
};

const compactRenderNodeTimelineRows = (nodes: Node[]): number => {
  if (nodes.length === 0) return 0;
  const usedRows = [...new Set(nodes.map((node) => node.row))].sort((left, right) => left - right);
  const remap = new Map(usedRows.map((row, index) => [row, index + 1] as const));
  for (const node of nodes) {
    node.row = remap.get(node.row) ?? node.row;
  }
  return Math.max(...nodes.map((node) => node.row));
};

const syncRenderNodeTimelineCoordinates = (
  nodes: Node[],
  isHorizontal: boolean,
  maxResolvedRow: number,
  timelineRowLeadOffset: number,
  zoomAwareTimelinePitch: number,
  zoomAwareLanePitch: number,
  hasPositionOverride: (commit: VisualCommit) => boolean,
): void => {
  for (const node of nodes) {
    if (hasPositionOverride(node.commit)) continue;
    if (isHorizontal) {
      node.x = LEFT_PADDING + (timelineRowLeadOffset + node.row - 1) * zoomAwareTimelinePitch;
      node.y = TOP_PADDING + node.column * zoomAwareLanePitch;
      continue;
    }
    node.x = LEFT_PADDING + node.column * COLUMN_WIDTH;
    node.y = TOP_PADDING + (maxResolvedRow - node.row) * zoomAwareTimelinePitch;
  }
};

const compactVisibleLaneColumns = (
  nodes: Node[],
  columnByCommitVisualId: Map<string, number>,
  isHorizontal: boolean,
  zoomAwareLanePitch: number,
  reservedColumns: ReadonlySet<number> = new Set(),
): void => {
  if (nodes.length === 0) return;
  const sortedUsedColumns = [...new Set([...nodes.map((node) => node.column), ...reservedColumns])].sort(
    (left, right) => left - right,
  );
  const compactColumnByLayoutColumn = new Map(
    sortedUsedColumns.map((column, index) => [column, index] as const),
  );
  for (const node of nodes) {
    const compactColumn = compactColumnByLayoutColumn.get(node.column) ?? node.column;
    node.column = compactColumn;
    columnByCommitVisualId.set(node.commit.visualId, compactColumn);
    if (isHorizontal) {
      node.y = TOP_PADDING + compactColumn * zoomAwareLanePitch;
      continue;
    }
    node.x = LEFT_PADDING + compactColumn * COLUMN_WIDTH;
  }
};

const syncClumpOwnerColumnsFromLeadNodes = (
  renderNodes: Node[],
  clusterKeyByCommitId: Map<string, string>,
  clusterCounts: Map<string, number>,
  leadByClusterKey: Map<string, string>,
  clumpOwnerColumnByClusterKey: Map<string, number>,
): void => {
  for (const [clusterKey, count] of clusterCounts.entries()) {
    if (count <= 1) continue;
    const leadVisualId = leadByClusterKey.get(clusterKey);
    if (!leadVisualId) continue;
    const memberNodes = renderNodes.filter(
      (node) => clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    if (memberNodes.length === 0) continue;
    const leadNode = memberNodes.find((node) => node.commit.visualId === leadVisualId);
    if (leadNode != null) clumpOwnerColumnByClusterKey.set(clusterKey, leadNode.column);
  }
};

function isEmptyPlaceholderBranch(
  branch: Branch,
  branchUniqueAheadCounts: Record<string, number>,
): boolean {
  if (branch.remoteSyncStatus === 'on-github' && branch.headSha) {
    return false;
  }
  const uniqueAhead = Object.prototype.hasOwnProperty.call(branchUniqueAheadCounts, branch.name)
    ? branchUniqueAheadCounts[branch.name] ?? 0
    : null;
  if (uniqueAhead != null) return branch.commitsAhead <= 0 && uniqueAhead <= 0;
  return branch.commitsAhead <= 0;
}

function laneCommitsForBranch(
  branch: Branch,
  branchCommitPreviews: Record<string, BranchCommitPreview[]>,
  branchUniqueAheadCounts: Record<string, number>,
  directCommits: DirectCommit[],
): CommitItem[] {
  const branchPreviews = renderableBranchPreviews(branch.name, branchUniqueAheadCounts, branchCommitPreviews);
  let commits = sortByDateThenSha(branchPreviews.map((commit) => toCommit(branch.name, commit)));
  const hasExplicitUniqueCount = Object.prototype.hasOwnProperty.call(branchUniqueAheadCounts, branch.name);
  if (commits.length === 0 && !hasExplicitUniqueCount) {
    commits = sortByDateThenSha(
      sortedConcreteBranchPreviews(branch.name, branchCommitPreviews).map((commit) => toCommit(branch.name, commit)),
    );
  }
  if (commits.length === 0) {
    commits = sortByDateThenSha(
      directCommits
        .filter((commit) => commit.branch === branch.name)
        .map((commit) => toCommit(branch.name, commit)),
    );
  }
  return commits;
}

function exclusiveBranchCommitPreviews(
  branchCommitPreviews: Record<string, BranchCommitPreview[]>,
  directCommits: DirectCommit[],
): Record<string, BranchCommitPreview[]> {
  const ownerBySha = new Map<string, string>();
  for (const commit of directCommits) {
    ownerBySha.set(commit.fullSha, commit.branch);
    ownerBySha.set(commit.sha, commit.branch);
  }
  if (ownerBySha.size === 0) return branchCommitPreviews;

  let changed = false;
  const next: Record<string, BranchCommitPreview[]> = {};
  for (const [branchName, previews] of Object.entries(branchCommitPreviews)) {
    const filtered = previews.filter((preview) => {
      if (preview.kind && preview.kind !== 'commit') return true;
      const owner = ownerBySha.get(preview.fullSha) ?? ownerBySha.get(preview.sha) ?? null;
      return owner == null || owner === branchName;
    });
    if (filtered.length !== previews.length) changed = true;
    next[branchName] = filtered;
  }
  return changed ? next : branchCommitPreviews;
}

function buildEmptyBranchLaneCommit(
  branch: Branch,
  directCommits: DirectCommit[],
  branchCommitPreviews: Record<string, BranchCommitPreview[]>,
): CommitItem | null {
  const laneTipSha =
    branch.headSha ||
    branch.createdFromSha ||
    branch.divergedFromSha ||
    branch.presidesFromSha ||
    null;
  if (!laneTipSha) return null;

  const forkPointSha =
    branch.divergedFromSha ??
    branch.createdFromSha ??
    branch.presidesFromSha ??
    laneTipSha;

  const tipMeta = findCommitMetaInRepo(laneTipSha, directCommits, branchCommitPreviews);
  const forkMeta =
    forkPointSha !== laneTipSha
      ? findCommitMetaInRepo(forkPointSha, directCommits, branchCommitPreviews)
      : tipMeta;

  const parentSha = forkPointSha;

  const forkDateFromDirect = directCommits.find(
    (commit) => shasMatch(commit.fullSha, forkPointSha) || shasMatch(commit.sha, forkPointSha),
  )?.date;
  const forkDateFromPreview =
    !forkDateFromDirect
      ? Object.values(branchCommitPreviews)
          .flat()
          .find((commit) => shasMatch(commit.fullSha, forkPointSha) || shasMatch(commit.sha, forkPointSha))?.date
      : undefined;
  const anchorParentDate =
    forkDateFromDirect ?? forkDateFromPreview ?? forkMeta?.date ?? tipMeta?.date ?? null;
  const forkTimeMs = safeTimeMs(anchorParentDate ?? undefined);
  const tipTimeMs = safeTimeMs(
    tipMeta?.date ?? branch.lastCommitDate ?? branch.createdDate ?? branch.divergedFromDate,
  );
  const placeholderTimeMs = Number.isFinite(forkTimeMs)
    ? forkTimeMs
    : Number.isFinite(tipTimeMs)
      ? tipTimeMs
      : safeTimeMs(branch.createdDate ?? branch.divergedFromDate ?? branch.lastCommitDate);

  return {
    id: `BRANCH_HEAD:${branch.name}:${laneTipSha}`,
    branchName: branch.name,
    message: '',
    author: tipMeta?.author ?? branch.lastCommitAuthor,
    date:
      anchorParentDate ??
      (Number.isFinite(placeholderTimeMs)
        ? new Date(placeholderTimeMs).toISOString()
        : branch.lastCommitDate),
    parentSha,
    clusterKey: null,
    childShas: [],
    kind: 'branch-created',
  };
}

function branchHasConcreteVisibleCommit(
  visibleCommitByVisualId: Map<string, VisualCommit>,
  branchName: string,
): boolean {
  return Array.from(visibleCommitByVisualId.values()).some(
    (commit) =>
      commit.branchName === branchName &&
      commit.kind !== 'branch-created' &&
      !commit.id.startsWith('BRANCH_HEAD:'),
  );
}

const setVisibleBranchCommit = (
  visibleCommitByVisualId: Map<string, VisualCommit>,
  visualCommit: VisualCommit,
): void => {
  const visualId = visualCommit.visualId || `${visualCommit.branchName}:${visualCommit.id}`;
  visibleCommitByVisualId.set(visualId, { ...visualCommit, visualId });
};

function ensureBranchLaneRepresentation(
  branches: Branch[],
  defaultBranch: string,
  branchCommitsByLane: Map<string, CommitItem[]>,
  visibleCommitByVisualId: Map<string, VisualCommit>,
  directCommits: DirectCommit[],
  branchCommitPreviews: Record<string, BranchCommitPreview[]>,
  _branchUniqueAheadCounts: Record<string, number>,
  worktreeSessions: WorktreeSession[],
): void {
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    if (isWorktreeLaneBranchName(branch.name)) continue;
    if (worktreeSessionCoversEmptyBranch(worktreeSessions, branch)) continue;
    if (branchHasConcreteVisibleCommit(visibleCommitByVisualId, branch.name)) continue;
    const existingPlaceholder = Array.from(visibleCommitByVisualId.values()).find(
      (commit) =>
        commit.branchName === branch.name &&
        (commit.kind === 'branch-created' || commit.id.startsWith('BRANCH_HEAD:')),
    );
    if (existingPlaceholder) continue;
    const lanePlaceholder =
      branchCommitsByLane.get(branch.name)?.find((commit) => commit.kind === 'branch-created') ??
      buildEmptyBranchLaneCommit(branch, directCommits, branchCommitPreviews);
    if (!lanePlaceholder) continue;
    const visualId = `${branch.name}:${lanePlaceholder.id}`;
    visibleCommitByVisualId.set(visualId, {
      ...lanePlaceholder,
      branchName: branch.name,
      visualId,
    });
    if (!branchCommitsByLane.has(branch.name)) {
      branchCommitsByLane.set(branch.name, [lanePlaceholder]);
    }
  }
}

/**
 * stable Base layout solver.
 * Solves the row, columns, clearances, overrides, and relative layout
 * assuming all virtual clumps are collapsed.
 */
export function computeBaseLayout(input: BranchGridLayoutInput): BaseLayoutModel {
  const {
    branches,
    mergeNodes,
    directCommits,
    unpushedDirectCommits,
    unpushedCommitShasByBranch: _unpushedCommitShasByBranch = {},
    defaultBranch,
    branchCommitPreviews: rawBranchCommitPreviews,
    branchParentByName = {},
    branchUniqueAheadCounts,
    isDebugOpen,
    checkedOutRef,
    worktreeSessions = [],
    orientation = 'horizontal',
    nodePositionOverrides = {},
  } = input;
  const isHorizontal = orientation === 'horizontal';
  const branchCommitPreviews = exclusiveBranchCommitPreviews(rawBranchCommitPreviews, directCommits);

  const branchByName = new Map(branches.map((branch) => [branch.name, branch]));

  const mainCommits = orderByLineage([
    ...mergeNodes.map((node) => ({
      id: node.fullSha,
      branchName: defaultBranch,
      message: node.prTitle ?? node.sha,
      author: '',
      date: node.date,
      parentSha: node.parentShas?.[0] ?? null,
      parentShas: node.parentShas ?? [],
    })),
    ...(branchCommitPreviews[defaultBranch] ?? []).map((commit) => toCommit(defaultBranch, commit)),
    ...directCommits.map((commit) => toCommit(commit.branch || '', commit)),
    ...unpushedDirectCommits.map((commit) => toCommit(commit.branch || '', commit)),
  ]);

  const branchCommitsByLane = new Map<string, CommitItem[]>();
  const branchPreviewSets = new Map<string, BranchCommitPreview[]>();
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const branchPreviews = renderableBranchPreviews(branch.name, branchUniqueAheadCounts, branchCommitPreviews);
    branchPreviewSets.set(branch.name, branchPreviews);
    if (isWorktreeLaneBranchName(branch.name)) {
      const commits = laneCommitsForBranch(branch, branchCommitPreviews, branchUniqueAheadCounts, directCommits);
      if (commits.length > 0) {
        branchCommitsByLane.set(branch.name, commits);
      }
      continue;
    }
    if (isEmptyPlaceholderBranch(branch, branchUniqueAheadCounts)) {
      if (worktreeSessionCoversEmptyBranch(worktreeSessions, branch)) {
        const commits = laneCommitsForBranch(branch, branchCommitPreviews, branchUniqueAheadCounts, directCommits);
        if (commits.length > 0) {
          branchCommitsByLane.set(branch.name, commits);
        }
        continue;
      }
      const syntheticBranchNode = buildEmptyBranchLaneCommit(branch, directCommits, branchCommitPreviews);
      if (syntheticBranchNode) {
        branchCommitsByLane.set(branch.name, [syntheticBranchNode]);
      }
      continue;
    }
    const commits = laneCommitsForBranch(branch, branchCommitPreviews, branchUniqueAheadCounts, directCommits);
    if (commits.length > 0) {
      branchCommitsByLane.set(branch.name, commits);
      continue;
    }
    if (worktreeSessionCoversEmptyBranch(worktreeSessions, branch)) {
      continue;
    }
    const syntheticBranchNode = buildEmptyBranchLaneCommit(branch, directCommits, branchCommitPreviews);
    if (!syntheticBranchNode) continue;
    branchCommitsByLane.set(branch.name, [syntheticBranchNode]);
  }

  const mainCommitShas = new Set<string>(mainCommits.map((commit) => commit.id));
  const oldestMainCommit = [...mainCommits].sort((a, b) => safeTimeMs(a.date) - safeTimeMs(b.date) || a.id.localeCompare(b.id))[0] ?? null;
  const branchCommitShasByName = new Map<string, Set<string>>(
    Array.from(branchCommitsByLane.entries()).map(([branchName, commits]) => [
      branchName,
      new Set(commits.map((commit) => commit.id)),
    ] as const)
  );
  const branchBaseCommitByName = new Map<string, CommitItem>();
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const baseCommit = branchBaseCommit(branch.name, branchCommitPreviews, branchUniqueAheadCounts);
    if (baseCommit) {
      branchBaseCommitByName.set(branch.name, baseCommit);
      continue;
    }
    const syntheticBaseCommit = branchCommitsByLane.get(branch.name)?.[0];
    if (syntheticBaseCommit) {
      branchBaseCommitByName.set(branch.name, syntheticBaseCommit);
    }
  }
  const branchReceivingCommitByName = new Map<string, CommitItem>();
  for (const [branchName, commits] of branchCommitsByLane.entries()) {
    const firstConcreteCommit = commits.find((commit) => commit.kind !== 'branch-created');
    if (firstConcreteCommit) branchReceivingCommitByName.set(branchName, firstConcreteCommit);
  }
  const firstBranchCommitByName = new Map<string, CommitItem>();
  for (const [branchName, commits] of branchCommitsByLane.entries()) {
    const concreteCommits = commits.filter((commit) => commit.kind !== 'branch-created');
    const commitsToInspect = concreteCommits.length > 0 ? concreteCommits : commits;
    const firstCommit = commitsToInspect[0] ?? null;
    if (firstCommit) firstBranchCommitByName.set(branchName, firstCommit);
  }
  const branchStartParentShaByName = new Map<string, string>();
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const firstBranchCommit = firstBranchCommitByName.get(branch.name) ?? null;
    const baseParentSha = branchBaseCommitByName.get(branch.name)?.parentSha ?? null;
    const metadataForkSha =
      branch.presidesFromSha ?? branch.divergedFromSha ?? branch.createdFromSha ?? branch.headSha ?? null;
    const firstParentSha = firstBranchCommit?.parentSha ?? null;
    const branchStartParentSha = firstParentSha ?? baseParentSha ?? metadataForkSha;
    if (branchStartParentSha) branchStartParentShaByName.set(branch.name, branchStartParentSha);
  }

  const resolveBranchStartParentName = (branch: Branch): string => {
    const declaredParent = branchParentByName[branch.name] ?? null;
    const hasConcreteParent =
      declaredParent &&
      declaredParent !== defaultBranch &&
      declaredParent !== branch.name &&
      branchByName.has(declaredParent);
    if (!hasConcreteParent) return declaredParent ?? '';

    const forkSha =
      branchStartParentShaByName.get(branch.name)
      ?? branch.presidesFromSha
      ?? branch.divergedFromSha
      ?? branch.createdFromSha;
    if (forkSha) {
      const declaredParentCommitShas = branchCommitShasByName.get(declaredParent) ?? new Set<string>();
      if (declaredParentCommitShas.has(forkSha)) return declaredParent;
    }

    const forkAnchor = branchBaseCommitByName.get(branch.name)?.parentSha ?? null;
    if (forkAnchor) {
      const declaredParentCommitShas = branchCommitShasByName.get(declaredParent) ?? new Set<string>();
      if (declaredParentCommitShas.has(forkAnchor)) return declaredParent;
    }

    return declaredParent;
  };

  const resolveBranchStartSha = (branch: Branch): string | null => {
    const childBaseCommit = branchBaseCommitByName.get(branch.name);
    const forkSha =
      branchStartParentShaByName.get(branch.name)
      ?? childBaseCommit?.parentSha
      ?? branch.presidesFromSha
      ?? branch.divergedFromSha
      ?? branch.createdFromSha
      ?? null;
    if (!branch.parentBranch && !forkSha) return null;
    if (!forkSha) return null;
    const parentName = resolveBranchStartParentName(branch);
    if (parentName === defaultBranch) {
      if (mainCommitShas.has(forkSha)) return forkSha;
      const childParentSha = childBaseCommit?.parentSha ?? null;
      if (childParentSha && mainCommitShas.has(childParentSha)) return childParentSha;
      return oldestMainCommit?.id ?? childParentSha ?? forkSha;
    }
    if (mainCommitShas.has(forkSha)) return forkSha;
    return forkSha;
  };
  const blueStartShaForBranch = (branch: Branch): string | null => resolveBranchStartSha(branch);

  const visibleCommitByVisualId = new Map<string, VisualCommit>();
  for (const commit of [...directCommits, ...unpushedDirectCommits]) {
    const visualCommit: VisualCommit = {
      ...toCommit(commit.branch || '', commit),
      visualId: `${commit.branch || ''}:${commit.fullSha}`,
    };
    visibleCommitByVisualId.set(visualCommit.visualId, visualCommit);
  }
  const insertVisibleCommitIfMissing = (commit: VisualCommit) => {
    setVisibleBranchCommit(visibleCommitByVisualId, commit);
  };

  const branchCommitShaSets = new Map<string, Set<string>>(
    Array.from(branchCommitsByLane.entries()).map(([branchName, commits]) => [
      branchName,
      new Set(commits.map((commit) => commit.id)),
    ] as const)
  );
  const branchCommitShaUnion = new Set<string>();
  for (const shaSet of branchCommitShaSets.values()) {
    for (const sha of shaSet) branchCommitShaUnion.add(sha);
  }
  for (const commit of mainCommits) {
    if (commit.branchName !== defaultBranch && branchCommitShaUnion.has(commit.id)) continue;
    insertVisibleCommitIfMissing({ ...commit, visualId: `${commit.branchName}:${commit.id}` });
  }
  const ingestBranchLaneCommits = (branchName: string, commits: CommitItem[]) => {
    for (const commit of commits) {
      const visualCommit: VisualCommit = { ...commit, branchName, visualId: `${branchName}:${commit.id}` };
      setVisibleBranchCommit(visibleCommitByVisualId, visualCommit);
    }
  };
  for (const [branchName, commits] of branchCommitsByLane.entries()) {
    ingestBranchLaneCommits(branchName, commits);
  }
  for (const node of mergeNodes) {
    const sha = node.fullSha;
    if (!sha) continue;
    const ps = node.parentShas ?? [];
    if (ps.length <= 1) continue;
    for (const [visualId, existing] of visibleCommitByVisualId.entries()) {
      if (!shasMatch(existing.id, sha)) continue;
      visibleCommitByVisualId.set(visualId, {
        ...existing,
        parentSha: ps[0] ?? existing.parentSha ?? null,
        parentShas: ps,
      });
    }
  }
  ensureBranchLaneRepresentation(
    branches,
    defaultBranch,
    branchCommitsByLane,
    visibleCommitByVisualId,
    directCommits,
    branchCommitPreviews,
    branchUniqueAheadCounts,
    worktreeSessions,
  );
  const visibleCommits: VisualCommit[] = Array.from(visibleCommitByVisualId.values());

  const allCommits = [...visibleCommits].sort((a, b) => safeTimeMs(a.date) - safeTimeMs(b.date) || a.id.localeCompare(b.id));
  const commitShasByBranchName = new Map<string, Set<string>>();
  for (const commit of allCommits) {
    const existing = commitShasByBranchName.get(commit.branchName) ?? new Set<string>();
    existing.add(commit.id);
    commitShasByBranchName.set(commit.branchName, existing);
  }
  const branchHasCommitSha = (branchName: string, sha: string): boolean => {
    const knownShas = commitShasByBranchName.get(branchName);
    if (!knownShas || knownShas.size === 0) return false;
    for (const knownSha of knownShas) {
      if (shasMatch(knownSha, sha)) return true;
    }
    return false;
  };
  const resolveSourceBranchName = (sourceSha: string, targetBranchName: string): string => {
    const directMatches = Array.from(commitShasByBranchName.entries())
      .filter(([branchName]) => branchName !== targetBranchName)
      .filter(([, commitShas]) => Array.from(commitShas).some((knownSha) => shasMatch(knownSha, sourceSha)))
      .map(([branchName]) => branchName);
    if (directMatches.length > 0) return directMatches.sort()[0]!;
    return sourceSha.slice(0, 7);
  };
  const mergeDestinations: MergeDestination[] = [];
  const mergeTargetBranchesBySourceBranchAndCommitSha = new Map<string, Map<string, Set<string>>>();
  const mergeParentShasByMergeSha = new Map<string, Set<string>>();
  for (const mergeNode of mergeNodes) {
    const mergeSha = mergeNode.fullSha;
    const targetBranchName = mergeNode.targetBranch;
    const targetCommitSha = mergeNode.targetCommitSha;
    if (!mergeSha || !targetBranchName || !targetCommitSha) continue;
    if (!branchHasCommitSha(targetBranchName, targetCommitSha)) continue;
    const mergedParentShas = (mergeNode.parentShas ?? []).slice(1).filter(
      (parentSha): parentSha is string => !!parentSha && !shasMatch(parentSha, mergeSha),
    );
    if (mergedParentShas.length === 0) continue;
    const existing = mergeParentShasByMergeSha.get(mergeSha) ?? new Set<string>();
    for (const parentSha of mergedParentShas) {
      existing.add(parentSha);
      const sourceBranchName = resolveSourceBranchName(parentSha, targetBranchName);
      mergeDestinations.push({
        sourceCommitSha: parentSha,
        sourceBranchName,
        mergeCommitSha: mergeSha,
        targetCommitSha,
        targetBranchName,
      });
      const byCommitSha = mergeTargetBranchesBySourceBranchAndCommitSha.get(sourceBranchName) ?? new Map<string, Set<string>>();
      const targetBranches = byCommitSha.get(parentSha) ?? new Set<string>();
      targetBranches.add(targetBranchName);
      byCommitSha.set(parentSha, targetBranches);
      mergeTargetBranchesBySourceBranchAndCommitSha.set(sourceBranchName, byCommitSha);
    }
    mergeParentShasByMergeSha.set(mergeSha, existing);
  }
  const branchStartAncestorByBranch = new Map<string, string>();
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const branchStartSha = resolveBranchStartSha(branch);
    if (branchStartSha) branchStartAncestorByBranch.set(branch.name, branchStartSha);
  }
  const extraParentShasByCommitId = new Map<string, Set<string>>();
  for (const commit of allCommits) {
    const mergeParentShas = mergeParentShasByMergeSha.get(commit.id);
    if (mergeParentShas && mergeParentShas.size > 0) {
      const set = extraParentShasByCommitId.get(commit.id) ?? new Set<string>();
      for (const parentSha of mergeParentShas) set.add(parentSha);
      extraParentShasByCommitId.set(commit.id, set);
    }
    if (commit.branchName === defaultBranch) continue;
    const branchStartAncestorSha = branchStartAncestorByBranch.get(commit.branchName);
    if (!branchStartAncestorSha || branchStartAncestorSha === commit.id) continue;
    const set = extraParentShasByCommitId.get(commit.id) ?? new Set<string>();
    set.add(branchStartAncestorSha);
    extraParentShasByCommitId.set(commit.id, set);
  }
  const commitById = new Map<string, VisualCommit>();
  for (const commit of allCommits) {
    commitById.set(commit.id, commit);
  }
  const childShasByParentSha = new Map<string, Set<string>>();
  for (const commit of allCommits) {
    if (commit.parentSha) {
      const children = childShasByParentSha.get(commit.parentSha) ?? new Set<string>();
      children.add(commit.id);
      childShasByParentSha.set(commit.parentSha, children);
    }
    for (const extraParentSha of extraParentShasByCommitId.get(commit.id) ?? []) {
      if (!extraParentSha) continue;
      const children = childShasByParentSha.get(extraParentSha) ?? new Set<string>();
      children.add(commit.id);
      childShasByParentSha.set(extraParentSha, children);
    }
  }
  const childShasByCommitId = new Map<string, string[]>();
  for (const [parentSha, childShas] of childShasByParentSha.entries()) {
    childShasByCommitId.set(parentSha, Array.from(childShas));
  }
  const specialClusterChildKinds = new Set<NonNullable<VisualCommit['kind']>>([
    'branch-created',
    'stash',
    'uncommitted',
  ]);
  const boundaryShaByCommitId = new Set<string>();
  const findCommitBySha = (sha: string | null | undefined): VisualCommit | null => {
    if (!sha) return null;
    const exact = commitById.get(sha);
    if (exact) return exact;
    const resolved = allCommits.find(
      (commit) => shasMatch(commit.id, sha) || shasMatch(commit.visualId.split(':').slice(1).join(':'), sha),
    );
    return resolved ?? null;
  };

  for (const commit of allCommits) {
    if (commit.parentSha) {
      const parentCommit = findCommitBySha(commit.parentSha);
      const parentIsBoundary = !!parentCommit && boundaryShaByCommitId.has(parentCommit.visualId);
      if (parentCommit && (commit.kind === 'stash' || commit.kind === 'branch-created' || parentIsBoundary)) {
        boundaryShaByCommitId.add(parentCommit.visualId);
      }
    }
    const childShas = childShasByParentSha.get(commit.id) ?? new Set<string>();
    const realChildShas = Array.from(childShas).filter((sha) => {
      const child = commitById.get(sha);
      return !child || !isWorktreeGraphNode(child);
    });
    if (
      realChildShas.length > 1 ||
      Array.from(childShas)
        .map((sha) => commitById.get(sha))
        .some((child) => child != null && child.kind != null && specialClusterChildKinds.has(child.kind))
    ) {
      boundaryShaByCommitId.add(commit.visualId);
    }
  }
  const allCommitsWithClusters: VisualCommit[] = allCommits.map((commit) => ({
    ...commit,
    childShas: childShasByCommitId.get(commit.id) ?? commit.childShas ?? [],
  }));
  const effectiveCommitTime = (commit: VisualCommit): number => {
    if (isWorktreeGraphNode(commit) && commit.parentSha) {
      const parent = findCommitBySha(commit.parentSha);
      if (parent) {
        const parentTime = safeTimeMs(parent.date);
        if (Number.isFinite(parentTime)) return parentTime;
      }
    }
    if (
      commit.parentSha
      && (commit.kind === 'branch-created' || isStashGraphCommit(commit))
    ) {
      const parent = findCommitBySha(commit.parentSha);
      if (parent) {
        const parentTime = safeTimeMs(parent.date);
        if (Number.isFinite(parentTime)) return parentTime + 1;
      }
    }
    const time = safeTimeMs(commit.date);
    return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
  };
  const commitsByBranch = new Map<string, VisualCommit[]>();
  for (const commit of allCommitsWithClusters) {
    const list = commitsByBranch.get(commit.branchName) ?? [];
    list.push(commit);
    commitsByBranch.set(commit.branchName, list);
  }
  const clustersByBranch = new Map<string, GridCluster[]>();
  const clusterKeyByCommitId = new Map<string, string>();
  const clusterKeyBySha = new Map<string, string[]>();
  const leadByClusterKey = new Map<string, string>();
  const firstByClusterKey = new Map<string, string>();
  const clusterCounts = new Map<string, number>();
  const buildClustersForBranch = (branchName: string, commits: VisualCommit[]): GridCluster[] => {
    if (commits.length === 0) return [];
    const ordered = [...commits].sort((a, b) => {
      return effectiveCommitTime(a) - effectiveCommitTime(b) || a.id.localeCompare(b.id);
    });
    const entriesByKey = new Map<string, VisualCommit[]>();
    let currentKey: string | null = null;
    let segmentIndex = 0;
    const clusterBoundaryKind = (commit: VisualCommit): string => {
      if (commit.kind === 'uncommitted') return 'uncommitted';
      if (commit.kind === 'stash') return 'stash';
      if (commit.kind === 'branch-created') return 'branch-created';
      const sessionTip = worktreeSessions.find(
        (session) =>
          session.headSha &&
          shasMatch(commit.id, session.headSha) &&
          (!session.branchName || commit.branchName === session.branchName),
      );
      if (sessionTip) return 'checked-out-tip';
      const checkedOutBranch = checkedOutRef?.branchName ?? null;
      const checkedOutHead = checkedOutRef?.headSha ?? null;
      if (
        checkedOutBranch &&
        checkedOutHead &&
        commit.branchName === checkedOutBranch &&
        shasMatch(commit.id, checkedOutHead)
      ) {
        return 'checked-out-tip';
      }
      return 'commit';
    };
    let previousBoundaryKind: string | null = null;
    let previousAuthor: string | null = null;
    let previousCommit: VisualCommit | null = null;
    for (const commit of ordered) {
      const isHiddenSyntheticChild = commit.kind === 'branch-created' || commit.kind === 'stash';
      const isBoundary = boundaryShaByCommitId.has(commit.visualId);
      if (isHiddenSyntheticChild) {
        continue;
      }
      const mergeParentCount = mergeParentShasByMergeSha.get(commit.id)?.size ?? 0;
      const parentShasForMerge = commit.parentShas?.length
        ? commit.parentShas
        : commit.parentSha
          ? [commit.parentSha]
          : [];
      const isMergeCommit = parentShasForMerge.length > 1 || mergeParentCount > 0;
      if (isMergeCommit) {
        currentKey = null;
      }
      const boundaryKind = clusterBoundaryKind(commit);
      const connectsToPrevious = !previousCommit ||
        commit.parentSha === previousCommit.id ||
        (commit.parentShas && commit.parentShas.includes(previousCommit.id));

      const shouldReset = 
        !currentKey || 
        !connectsToPrevious ||
        (previousBoundaryKind != null && (
          previousBoundaryKind === 'uncommitted' || boundaryKind === 'uncommitted' ||
          previousBoundaryKind === 'stash' || boundaryKind === 'stash' ||
          previousBoundaryKind === 'branch-created' || boundaryKind === 'branch-created' ||
          previousBoundaryKind === 'checked-out-tip'
        )) ||
        (previousAuthor != null && commit.author !== previousAuthor);

      if (branchName === 'feature') {
        console.log(`[CLUSTERING] commit=${commit.visualId} author=${commit.author} prevAuthor=${previousAuthor} shouldReset=${shouldReset} isBoundary=${isBoundary}`);
      }

      if (shouldReset) {
        segmentIndex += 1;
        currentKey = `cluster:${branchName}:segment:${segmentIndex}`;
      }
      const keyStr = currentKey!;
      const list = entriesByKey.get(keyStr) ?? [];
      list.push(commit);
      entriesByKey.set(keyStr, list);
      if (isBoundary) {
        currentKey = null;
      }
      previousBoundaryKind = boundaryKind;
      previousAuthor = commit.author;
      previousCommit = commit;
    }
    const leadPriority = (commit: VisualCommit): number => {
      if (commit.kind === 'uncommitted') return 3;
      if (clusterBoundaryKind(commit) === 'checked-out-tip') return 2;
      return 1;
    };
    const clusters: GridCluster[] = [];
    for (const [key, chunk] of entriesByKey.entries()) {
      if (chunk.length === 0) continue;
      const lead = [...chunk].sort((a, b) => {
        return leadPriority(b) - leadPriority(a)
          || effectiveCommitTime(b) - effectiveCommitTime(a)
          || b.id.localeCompare(a.id);
      })[0]!;
      const leadId = lead.visualId;
      const first = [...chunk].sort(
        (left, right) =>
          effectiveCommitTime(left) - effectiveCommitTime(right) || left.id.localeCompare(right.id),
      )[0]!;
      const firstId = first.visualId;
      const orderedCommitIds = chunk.map((commit) => commit.visualId);
      const firstParentShas = first.parentShas?.length
        ? first.parentShas
        : first.parentSha
          ? [first.parentSha]
          : [];
      const last = [...chunk].sort(
        (left, right) =>
          effectiveCommitTime(right) - effectiveCommitTime(left) || right.id.localeCompare(left.id),
      )[0]!;
      const lastChildShas = childShasByCommitId.get(last.id) ?? last.childShas ?? [];
      const clusterVm = {
        branchName,
        key,
        commitIds: orderedCommitIds,
        leadId,
        count: chunk.length,
        parentShas: firstParentShas,
        childShas: lastChildShas,
      };
      clusters.push(clusterVm);
      const previousCount = clusterCounts.get(key) ?? 0;
      if (!leadByClusterKey.has(key)) {
        leadByClusterKey.set(key, leadId);
      } else {
        const currentLeadId = leadByClusterKey.get(key)!;
        const currentLead = commitById.get(currentLeadId.split(':').slice(1).join(':'));
        if (currentLead) {
          const nextLeadRow = safeTimeMs(lead.date);
          const currentLeadRow = safeTimeMs(currentLead.date);
          if (nextLeadRow > currentLeadRow) leadByClusterKey.set(key, leadId);
        }
      }
      if (!firstByClusterKey.has(key)) {
        firstByClusterKey.set(key, firstId);
      } else {
        const currentFirstId = firstByClusterKey.get(key)!;
        const currentFirst = commits.find((candidate) => candidate.visualId === currentFirstId);
        if (currentFirst && effectiveCommitTime(first) < effectiveCommitTime(currentFirst)) {
          firstByClusterKey.set(key, firstId);
        }
      }
      clusterCounts.set(key, Math.max(previousCount, chunk.length));
      for (const id of clusterVm.commitIds) {
        clusterKeyByCommitId.set(id, key);
        const sha = id.split(':').slice(1).join(':');
        const keys = clusterKeyBySha.get(sha) ?? [];
        if (!keys.includes(key)) keys.push(key);
        clusterKeyBySha.set(sha, keys);
      }
    }
    return clusters;
  };
  for (const [branchName, commits] of commitsByBranch.entries()) {
    clustersByBranch.set(branchName, buildClustersForBranch(branchName, commits));
  }
  const clusterByKey = new Map<string, GridCluster>();
  for (const clusters of clustersByBranch.values()) {
    for (const cluster of clusters) clusterByKey.set(cluster.key, cluster);
  }

  const checkedOutSha = checkedOutRef?.headSha ?? null;
  const checkedOutClusterKey = (() => {
    const checkedOutBranchName = checkedOutRef?.branchName ?? null;
    if (!checkedOutSha || !checkedOutBranchName) return null;
    const directKey = clusterKeyByCommitId.get(`${checkedOutBranchName}:${checkedOutSha}`);
    if (directKey) return directKey;
    for (const [visualId, clusterKey] of clusterKeyByCommitId.entries()) {
      const colon = visualId.indexOf(':');
      if (colon <= 0) continue;
      const branch = visualId.slice(0, colon);
      const shaPart = visualId.slice(colon + 1);
      if (branch !== checkedOutBranchName) continue;
      if (shasMatch(shaPart, checkedOutSha)) return clusterKey;
    }
    return null;
  })();
  const defaultCollapsedClumps = new Set<string>();
  for (const [clusterKey, count] of clusterCounts.entries()) {
    if (count > 1 && clusterKey !== checkedOutClusterKey) defaultCollapsedClumps.add(clusterKey);
  }

  const columnByCommitVisualId = new Map<string, number>();
  const rowByVisualId = new Map<string, number>();
  const clumpOwnerColumnByClusterKey = new Map<string, number>();

  const parentsMap = new Map<string, VisualCommit[]>();
  const childrenMap = new Map<string, VisualCommit[]>();

  const commitsByExactSha = new Map<string, VisualCommit[]>();
  const commitByBranchAndExactSha = new Map<string, VisualCommit>();
  const commitByVisualId = new Map<string, VisualCommit>();
  for (const commit of allCommitsWithClusters) {
    const exactMatches = commitsByExactSha.get(commit.id) ?? [];
    exactMatches.push(commit);
    commitsByExactSha.set(commit.id, exactMatches);
    commitByBranchAndExactSha.set(`${commit.branchName}\0${commit.id}`, commit);
    commitByVisualId.set(commit.visualId, commit);
  }

  const findCommitNode = (sha: string, preferredBranchName?: string): VisualCommit | null => {
    if (preferredBranchName) {
      const exact = commitByBranchAndExactSha.get(`${preferredBranchName}\0${sha}`);
      if (exact) return exact;
      const match = allCommitsWithClusters.find(
        (c) => c.branchName === preferredBranchName && (shasMatch(c.id, sha) || shasMatch(c.visualId, sha))
      );
      if (match) return match;
    }
    const exact = commitsByExactSha.get(sha)?.[0];
    if (exact) return exact;
    return allCommitsWithClusters.find((c) => shasMatch(c.id, sha) || shasMatch(c.visualId, sha)) || null;
  };

  for (const commit of allCommitsWithClusters) {
    const parents: VisualCommit[] = [];
    if (commit.parentSha) {
      const p = findCommitNode(commit.parentSha, commit.branchName);
      if (p && p.visualId !== commit.visualId) parents.push(p);
    }
    const extraParents = extraParentShasByCommitId.get(commit.id) ?? new Set<string>();
    for (const extraSha of extraParents) {
      if (extraSha && (!commit.parentSha || !shasMatch(commit.parentSha, extraSha))) {
        const p = findCommitNode(extraSha, commit.branchName);
        if (p && p.visualId !== commit.visualId && !parents.some((x) => x.visualId === p.visualId)) parents.push(p);
      }
    }
    parentsMap.set(commit.visualId, parents);

    for (const p of parents) {
      const list = childrenMap.get(p.visualId) ?? [];
      if (!list.some((x) => x.visualId === commit.visualId)) {
        list.push(commit);
      }
      childrenMap.set(p.visualId, list);
    }
  }

  const primaryParentMap = new Map<string, VisualCommit>();
  const primaryChildrenMap = new Map<string, VisualCommit[]>();

  for (const commit of allCommitsWithClusters) {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    const count = clusterKey ? clusterCounts.get(clusterKey) ?? 1 : 1;
    let parentSha: string | null = null;
    let preferredBranch: string | undefined = commit.branchName;
    if (clusterKey && count > 1) {
      const firstVisualId = firstByClusterKey.get(clusterKey);
      const firstCommit = firstVisualId ? commitByVisualId.get(firstVisualId) ?? null : null;
      parentSha = firstCommit?.parentSha ?? null;
      preferredBranch = firstCommit?.branchName;
    } else {
      parentSha = commit.parentSha ?? null;
    }

    if (parentSha) {
      const p = findCommitNode(parentSha, preferredBranch);
      if (p && p.visualId !== commit.visualId) {
        primaryParentMap.set(commit.visualId, p);
        const list = primaryChildrenMap.get(p.visualId) ?? [];
        list.push(commit);
        primaryChildrenMap.set(p.visualId, list);
      }
    }
  }

  const gitParentsForCommit = (commit: VisualCommit): VisualCommit[] => {
    const parents: VisualCommit[] = [];
    const addParent = (parent: VisualCommit | null) => {
      if (parent && !parents.some((candidate) => candidate.visualId === parent.visualId)) {
        parents.push(parent);
      }
    };

    const primarySha = commit.parentSha ?? commit.parentShas?.[0] ?? null;
    if (primarySha) addParent(findCommitNode(primarySha, commit.branchName));

    const mergedParentShas = mergeParentShasByMergeSha.get(commit.id);
    if (mergedParentShas) {
      for (const sha of mergedParentShas) {
        const sourceBranchName = resolveSourceBranchName(sha, commit.branchName);
        addParent(findCommitNode(sha, sourceBranchName));
      }
    }

    const listedParentShas = commit.parentShas?.length
      ? commit.parentShas
      : commit.parentSha
        ? [commit.parentSha]
        : [];
    for (const sha of listedParentShas.slice(1)) {
      if (!sha || shasMatch(sha, primarySha)) continue;
      const sourceBranchName = resolveSourceBranchName(sha, commit.branchName);
      addParent(findCommitNode(sha, sourceBranchName));
    }

    return parents;
  };

  const isGitMergeCommit = (commit: VisualCommit): boolean => gitParentsForCommit(commit).length > 1;

  const rowAfterAllGitParents = (commit: VisualCommit, fallbackRow: number): number => {
    let row = fallbackRow;
    for (const parent of gitParentsForCommit(commit)) {
      const parentRow = rowByVisualId.get(parent.visualId);
      if (parentRow != null) row = Math.max(row, parentRow + 1);
    }
    return row;
  };

  const rowAfterLayoutParents = (commit: VisualCommit, fallbackRow: number): number => {
    let row = fallbackRow;
    for (const parent of parentsMap.get(commit.visualId) ?? []) {
      const parentRow = rowByVisualId.get(parent.visualId);
      if (parentRow != null) row = Math.max(row, parentRow + 1);
    }
    return row;
  };

  const assignRows = (u: VisualCommit, uRow: number, visiting = new Set<string>()) => {
    if (visiting.has(u.visualId)) return;
    visiting.add(u.visualId);
    rowByVisualId.set(u.visualId, uRow);
    const children = primaryChildrenMap.get(u.visualId) ?? [];
    children.sort((a, b) => {
      return effectiveCommitTime(a) - effectiveCommitTime(b) || a.id.localeCompare(b.id);
    });
    if (children.length === 0) return;

    const rowSharingChildren: VisualCommit[] = [];
    const mergeChildren: VisualCommit[] = [];
    for (const child of children) {
      if (isGitMergeCommit(child)) mergeChildren.push(child);
      else rowSharingChildren.push(child);
    }

    if (rowSharingChildren.length > 0) {
      let sharedSiblingRow = uRow + 1;
      for (const child of rowSharingChildren) {
        if (visiting.has(child.visualId)) continue;
        sharedSiblingRow = rowAfterLayoutParents(child, sharedSiblingRow);
      }
      for (const child of rowSharingChildren) {
        assignRows(child, sharedSiblingRow, new Set(visiting));
      }
    }

    for (const child of mergeChildren) {
      assignRows(child, rowAfterAllGitParents(child, uRow + 1), new Set(visiting));
    }
  };

  const subtreeSizes = new Map<string, number>();
  const getSubtreeSize = (visualId: string, visiting = new Set<string>()): number => {
    if (subtreeSizes.has(visualId)) return subtreeSizes.get(visualId)!;
    if (visiting.has(visualId)) return 0;
    visiting.add(visualId);
    const children = primaryChildrenMap.get(visualId) ?? [];
    let size = 1;
    for (const child of children) {
      size += getSubtreeSize(child.visualId, new Set(visiting));
    }
    subtreeSizes.set(visualId, size);
    return size;
  };

  const reservedColsByRow = new Map<number, Set<number>>();
  const isBlockFree = (row: number, start: number, size: number): boolean => {
    for (let adjacentRow = row - 1; adjacentRow <= row + 1; adjacentRow += 1) {
      const reserved = reservedColsByRow.get(adjacentRow);
      if (!reserved) continue;
      for (let c = start; c < start + size; c++) {
        if (reserved.has(c)) return false;
      }
    }
    return true;
  };
  const reserveBlock = (row: number, start: number, size: number) => {
    const reserved = reservedColsByRow.get(row) ?? new Set<number>();
    for (let c = start; c < start + size; c++) {
      reserved.add(c);
    }
    reservedColsByRow.set(row, reserved);
  };

  const roots = allCommitsWithClusters.filter((c) => !primaryParentMap.has(c.visualId));
  roots.sort((a, b) => effectiveCommitTime(a) - effectiveCommitTime(b) || a.id.localeCompare(b.id));

  for (const root of roots) {
    const rootParents = isGitMergeCommit(root) ? gitParentsForCommit(root) : (parentsMap.get(root.visualId) ?? []);
    const parentRows = rootParents.map((parent) => rowByVisualId.get(parent.visualId) ?? -1);
    const rootRow = parentRows.length === 0 ? 0 : Math.max(0, ...parentRows.map((row) => row + 1));
    assignRows(root, rootRow);
  }

  const isInMultiCommitClump = (commit: VisualCommit): boolean => {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    return !!clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1;
  };

  const enforceMergeRowsAfterAllGitParents = (): void => {
    let changed = true;
    let passes = 0;
    const maxPasses = Math.max(1, allCommitsWithClusters.length * 2);
    while (changed && passes < maxPasses) {
      passes += 1;
      changed = false;
      for (const commit of allCommitsWithClusters) {
        if (!isGitMergeCommit(commit)) continue;
        if (isInMultiCommitClump(commit)) continue;
        const requiredRow = rowAfterAllGitParents(commit, rowByVisualId.get(commit.visualId) ?? 1);
        const currentRow = rowByVisualId.get(commit.visualId) ?? 1;
        if (requiredRow > currentRow) {
          rowByVisualId.set(commit.visualId, requiredRow);
          changed = true;
        }
      }
    }
  };
  enforceMergeRowsAfterAllGitParents();

  const clumpMembersByKey = new Map<string, VisualCommit[]>();
  for (const commit of allCommitsWithClusters) {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (!clusterKey || (clusterCounts.get(clusterKey) ?? 1) <= 1) continue;
    const members = clumpMembersByKey.get(clusterKey) ?? [];
    members.push(commit);
    clumpMembersByKey.set(clusterKey, members);
  }
  for (const [clusterKey, members] of clumpMembersByKey.entries()) {
    clumpMembersByKey.set(clusterKey, sortByDateThenSha(members));
  }
  const mergeSourceVisualIds = new Set<string>();
  for (const commit of allCommitsWithClusters) {
    if (
      mergeDestinations.some(
        (destination) =>
          shasMatch(destination.sourceCommitSha, commit.id)
          && !shasMatch(destination.targetCommitSha, commit.id),
      )
    ) {
      mergeSourceVisualIds.add(commit.visualId);
    }
  }
  const mergeClumpKeys = new Set<string>();
  for (const [clusterKey, members] of clumpMembersByKey.entries()) {
    if (members.some((member) => isGitMergeCommit(member) || mergeSourceVisualIds.has(member.visualId))) {
      mergeClumpKeys.add(clusterKey);
    }
  }
  const firstClumpMember = (clusterKey: string): VisualCommit | null => {
    const firstVisualId = firstByClusterKey.get(clusterKey);
    return (
      (firstVisualId ? commitByVisualId.get(firstVisualId) ?? null : null)
      ?? clumpMembersByKey.get(clusterKey)?.[0]
      ?? null
    );
  };

  const firstClumpSourceParents = (clusterKey: string): VisualCommit[] => {
    const firstMember = firstClumpMember(clusterKey);
    if (!firstMember) return [];
    const parents: VisualCommit[] = [];
    const addParent = (parent: VisualCommit | null) => {
      if (
        parent
        && clusterKeyByCommitId.get(parent.visualId) !== clusterKey
        && !parents.some((candidate) => candidate.visualId === parent.visualId)
      ) {
        parents.push(parent);
      }
    };
    for (const parent of parentsMap.get(firstMember.visualId) ?? []) addParent(parent);
    for (const parent of gitParentsForCommit(firstMember)) addParent(parent);
    return parents.filter((parent) => clusterKeyByCommitId.get(parent.visualId) !== clusterKey);
  };

  const clumpRow = (clusterKey: string): number => {
    const members = clumpMembersByKey.get(clusterKey) ?? [];
    return Math.max(0, ...members.map((member) => rowByVisualId.get(member.visualId) ?? 0));
  };

  const setClumpRow = (clusterKey: string, row: number): void => {
    for (const member of clumpMembersByKey.get(clusterKey) ?? []) {
      rowByVisualId.set(member.visualId, row);
    }
  };

  const parentRowForConstraint = (parent: VisualCommit): number | null => {
    const parentClusterKey = clusterKeyByCommitId.get(parent.visualId);
    if (parentClusterKey && (clusterCounts.get(parentClusterKey) ?? 1) > 1) {
      return clumpRow(parentClusterKey);
    }
    return rowByVisualId.get(parent.visualId) ?? null;
  };

  const enforceRowsAfterVirtualClumpParents = (): void => {
    let changed = true;
    let passes = 0;
    const maxPasses = Math.max(1, allCommitsWithClusters.length * 2);
    while (changed && passes < maxPasses) {
      passes += 1;
      changed = false;

      for (const clusterKey of clumpMembersByKey.keys()) {
        const firstMember = firstClumpMember(clusterKey);
        if (!firstMember) continue;

        let requiredRow = clumpRow(clusterKey);
        const parentCandidates = firstClumpSourceParents(clusterKey);
        for (const parent of parentCandidates) {
          const parentRow = parentRowForConstraint(parent);
          if (parentRow != null) requiredRow = Math.max(requiredRow, parentRow + 1);
        }

        if (requiredRow > clumpRow(clusterKey)) {
          setClumpRow(clusterKey, requiredRow);
          changed = true;
        }
      }

      for (const commit of allCommitsWithClusters) {
        const clusterKey = clusterKeyByCommitId.get(commit.visualId);
        if (clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1) continue;

        let requiredRow = rowByVisualId.get(commit.visualId) ?? 0;
        const parentCandidates = isGitMergeCommit(commit)
          ? gitParentsForCommit(commit)
          : parentsMap.get(commit.visualId) ?? [];
        for (const parent of parentCandidates) {
          const parentRow = parentRowForConstraint(parent);
          if (parentRow != null) requiredRow = Math.max(requiredRow, parentRow + 1);
        }

        const currentRow = rowByVisualId.get(commit.visualId) ?? 0;
        if (requiredRow > currentRow) {
          rowByVisualId.set(commit.visualId, requiredRow);
          changed = true;
        }
      }
    }
  };
  enforceRowsAfterVirtualClumpParents();

  const inDegree = new Map<string, number>();
  for (const commit of allCommitsWithClusters) {
    const parents = parentsMap.get(commit.visualId) ?? [];
    inDegree.set(commit.visualId, parents.length);
  }

  const layoutQueue = allCommitsWithClusters.filter((c) => (inDegree.get(c.visualId) ?? 0) === 0);
  const subtreeOrderByVisualId = new Map<string, number>();
  let subtreeOrder = 0;
  const assignSubtreeOrder = (commit: VisualCommit, visiting = new Set<string>()): void => {
    if (visiting.has(commit.visualId) || subtreeOrderByVisualId.has(commit.visualId)) return;
    visiting.add(commit.visualId);
    subtreeOrderByVisualId.set(commit.visualId, subtreeOrder);
    subtreeOrder += 1;
    const children = [...(primaryChildrenMap.get(commit.visualId) ?? [])].sort(
      (a, b) => effectiveCommitTime(a) - effectiveCommitTime(b) || a.id.localeCompare(b.id),
    );
    for (const child of children) assignSubtreeOrder(child, new Set(visiting));
  };
  for (const root of roots) assignSubtreeOrder(root);
  for (const commit of allCommitsWithClusters) assignSubtreeOrder(commit);

  const compareNodes = (a: VisualCommit, b: VisualCommit): number => {
    const subtreeOrderDelta =
      (subtreeOrderByVisualId.get(a.visualId) ?? Number.MAX_SAFE_INTEGER)
      - (subtreeOrderByVisualId.get(b.visualId) ?? Number.MAX_SAFE_INTEGER);
    if (subtreeOrderDelta !== 0) return subtreeOrderDelta;
    const keyA = clusterKeyByCommitId.get(a.visualId);
    const keyB = clusterKeyByCommitId.get(b.visualId);
    if (keyA && keyA === keyB) {
      const count = clusterCounts.get(keyA) ?? 1;
      if (count > 1) {
        const leadId = leadByClusterKey.get(keyA);
        if (a.visualId === leadId) return -1;
        if (b.visualId === leadId) return 1;
      }
    }
    return effectiveCommitTime(a) - effectiveCommitTime(b) || a.id.localeCompare(b.id);
  };

  let colCursor = 0;

  const layoutExternalParents = (commit: VisualCommit, visiting = new Set<string>()): VisualCommit[] => {
    if (visiting.has(commit.visualId)) return [];
    visiting.add(commit.visualId);
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    const external: VisualCommit[] = [];
    for (const parent of parentsMap.get(commit.visualId) ?? []) {
      if (clusterKey && clusterKeyByCommitId.get(parent.visualId) === clusterKey) {
        external.push(...layoutExternalParents(parent, new Set(visiting)));
        continue;
      }
      external.push(parent);
    }
    return external;
  };

  const layoutParentColumn = (parent: VisualCommit): number => {
    const clusterKey = clusterKeyByCommitId.get(parent.visualId);
    const count = clusterKey ? clusterCounts.get(clusterKey) ?? 1 : 1;
    if (clusterKey && count > 1) {
      const storedColumn = columnByCommitVisualId.get(parent.visualId);
      if (storedColumn != null) return storedColumn;
      const externalParents = (parentsMap.get(parent.visualId) ?? []).filter(
        (candidate) => clusterKeyByCommitId.get(candidate.visualId) !== clusterKey,
      );
      if (externalParents.length > 0) return layoutParentColumn(externalParents[0]!);
      const ownerColumn =
        clumpOwnerColumnByClusterKey.get(clusterKey)
        ?? columnByCommitVisualId.get(leadByClusterKey.get(clusterKey) ?? '')
        ?? -1;
      if (ownerColumn >= 0) return ownerColumn;
      return -1;
    }
    return columnByCommitVisualId.get(parent.visualId) ?? -1;
  };

  const getBranchColumn = (branchName: string): number => {
    for (const commit of allCommitsWithClusters) {
      if (commit.branchName === branchName) {
        const col = columnByCommitVisualId.get(commit.visualId);
        if (col != null) return col;
      }
    }
    return 0;
  };

  const resolveParentColumnForCommit = (commit: VisualCommit): number => {
    for (const parent of parentsMap.get(commit.visualId) ?? []) {
      const parentCol = layoutParentColumn(parent);
      if (parentCol >= 0) return parentCol;
    }
    const branch = branchByName.get(commit.branchName);
    if (branch) {
      const parentBranchName = resolveBranchStartParentName(branch);
      if (parentBranchName) {
        return getBranchColumn(parentBranchName);
      }
    }
    return getBranchColumn(defaultBranch);
  };

  const enqueueLayoutChildren = (u: VisualCommit): void => {
    for (const child of childrenMap.get(u.visualId) ?? []) {
      const remaining = (inDegree.get(child.visualId) ?? 1) - 1;
      inDegree.set(child.visualId, remaining);
      if (remaining === 0) layoutQueue.push(child);
    }
  };

  const placeLayoutNode = (u: VisualCommit): void => {
    const clusterKey = clusterKeyByCommitId.get(u.visualId);
    const count = clusterKey ? clusterCounts.get(clusterKey) ?? 1 : 1;
    const isClumpLead = !!clusterKey && count > 1 && leadByClusterKey.get(clusterKey) === u.visualId;
    const isClumpNonLead = !!clusterKey && count > 1 && !isClumpLead;

    if (isClumpNonLead) {
      enqueueLayoutChildren(u);
      return;
    }

    const parents = layoutExternalParents(u);
    const parentCols = parents.map((parent) => layoutParentColumn(parent));

    let minCol = 0;
    if (parents.length === 0) {
      if (u.kind === 'stash' || u.kind === 'branch-created') {
        minCol = resolveParentColumnForCommit(u) + 1;
      } else {
        minCol = colCursor;
      }
    } else {
      minCol = Math.max(...parentCols.map((column) => column + 1));
    }
    minCol = Math.max(minCol, subtreeOrderByVisualId.get(u.visualId) ?? minCol);

    const r = rowByVisualId.get(u.visualId) ?? 1;
    const reservationSize = isClumpLead ? 1 : getSubtreeSize(u.visualId);

    while (!isBlockFree(r, minCol, reservationSize)) {
      minCol += 1;
    }

    columnByCommitVisualId.set(u.visualId, minCol);
    if (isClumpLead) clumpOwnerColumnByClusterKey.set(clusterKey, minCol);

    reserveBlock(r, minCol, reservationSize);

    if (parents.length === 0) {
      if (u.kind === 'stash' || u.kind === 'branch-created') {
        colCursor = Math.max(colCursor, minCol + 1);
      } else {
        colCursor = Math.max(colCursor, minCol + reservationSize);
      }
    } else if (isClumpLead) {
      colCursor = Math.max(colCursor, minCol + 1);
    } else {
      colCursor = Math.max(colCursor, minCol + 1);
    }

    enqueueLayoutChildren(u);
  };

  while (layoutQueue.length > 0) {
    layoutQueue.sort(compareNodes);
    placeLayoutNode(layoutQueue.shift()!);
  }

  if (columnByCommitVisualId.size < allCommitsWithClusters.length) {
    const remaining = allCommitsWithClusters.filter((c) => !columnByCommitVisualId.has(c.visualId));
    remaining.sort(compareNodes);
    for (const u of remaining) placeLayoutNode(u);
  }

  for (const [clusterKey, count] of clusterCounts.entries()) {
    if (count > 1) {
      const leadVisualId = leadByClusterKey.get(clusterKey);
      if (leadVisualId) {
        const column = columnByCommitVisualId.get(leadVisualId);
        if (column != null && !clumpOwnerColumnByClusterKey.has(clusterKey)) {
          clumpOwnerColumnByClusterKey.set(clusterKey, column);
        }
      }
    }
  }

  const clusterColumnByKey = new Map<string, number>(clumpOwnerColumnByClusterKey);
  const lanes: Lane[] = Array.from(clusterColumnByKey.entries())
    .map(([key, column]) => ({
      name: key,
      column,
      parentName: null,
    }))
    .sort((a, b) => a.column - b.column || a.name.localeCompare(b.name));
  const laneByName = new Map(lanes.map((lane) => [lane.name, lane] as const));

  compactTimelineRows(rowByVisualId, allCommitsWithClusters);
  
  // Collapse all clumps initially for base layout
  deriveAllClumpsFromOwners({
    commits: allCommitsWithClusters,
    clusterKeyByCommitId,
    clusterCounts,
    leadByClusterKey,
    clumpOwnerColumnByClusterKey,
    rowByVisualId,
    columnByCommitVisualId,
    isClumpOpen: () => false,
  });

  // Stash and branch-created are synthetic leaves; uncommitted worktrees use placeLayoutNode like other commits.
  for (const commit of allCommitsWithClusters) {
    if (commit.kind !== 'stash' && commit.kind !== 'branch-created') {
      continue;
    }
    let row = rowByVisualId.get(commit.visualId) ?? 0;
    let column = columnByCommitVisualId.get(commit.visualId) ?? 0;
    let parentCol = -1;
    for (const parent of parentsMap.get(commit.visualId) ?? []) {
      const parentRow = parentRowForConstraint(parent);
      if (parentRow != null) row = Math.max(row, parentRow + 1);
      const col = layoutParentColumn(parent);
      if (col >= 0) parentCol = Math.max(parentCol, col);
    }
    if (parentCol < 0) {
      parentCol = resolveParentColumnForCommit(commit);
    }
    column = Math.max(column, parentCol + 1);
    rowByVisualId.set(commit.visualId, row);
    columnByCommitVisualId.set(commit.visualId, column);
  }
  const allRowByVisualId = rowByVisualId;
  const commitBySha = new Map<string, VisualCommit>();
  for (const commit of allCommitsWithClusters) {
    commitBySha.set(commit.id, commit);
  }

  const maxPreviewRow = Math.max(0, ...allCommitsWithClusters.map((commit) => rowByVisualId.get(commit.visualId) ?? 1));

  const baseLayoutCommits = allCommits.filter((commit) => {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (!clusterKey || (clusterCounts.get(clusterKey) ?? 1) <= 1) return true;
    return leadByClusterKey.get(clusterKey) === commit.visualId;
  });

  const timelineRowLeadOffset = 0;
  const zoomAwareRowGap = ROW_GAP / GRID_LAYOUT_RENDER_ZOOM;
  const zoomAwareLabelBand = 20 / GRID_LAYOUT_RENDER_ZOOM;
  const zoomAwareTimelinePitch = isHorizontal
    ? CARD_WIDTH + zoomAwareRowGap + zoomAwareLabelBand
    : ROW_HEIGHT + zoomAwareRowGap + zoomAwareLabelBand;
  const zoomAwareLanePitch = isHorizontal ? ROW_HEIGHT + zoomAwareRowGap + zoomAwareLabelBand : COLUMN_WIDTH;

  const renderNodesRaw: Node[] = baseLayoutCommits.map((commit) => {
    const row = allRowByVisualId.get(commit.visualId) ?? 1;
    const column = columnByCommitVisualId.get(commit.visualId) ?? 0;
    if (isHorizontal) {
      return {
        commit,
        row,
        column,
        x: LEFT_PADDING + (row - 1) * zoomAwareTimelinePitch,
        y: TOP_PADDING + column * zoomAwareLanePitch,
      };
    }
    return {
      commit,
      row,
      column,
      x: LEFT_PADDING + column * COLUMN_WIDTH,
      y: TOP_PADDING + (maxPreviewRow - row) * zoomAwareTimelinePitch,
    };
  });
  
  const renderNodes = [...renderNodesRaw]
    .sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      if (a.column !== b.column) return a.column - b.column;
      return a.commit.visualId.localeCompare(b.commit.visualId);
    })
    .map((node) => ({ ...node }));

  let maxResolvedRow = compactRenderNodeTimelineRows(renderNodes);
  const renderNodeByVisualId = new Map(renderNodes.map((node) => [node.commit.visualId, node] as const));
  const renderNodeByClusterKey = new Map<string, Node>();
  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (clusterKey) renderNodeByClusterKey.set(clusterKey, node);
  }
  const renderNodeForConstraintParent = (parent: VisualCommit): Node | null => {
    const directNode = renderNodeByVisualId.get(parent.visualId) ?? null;
    if (directNode) return directNode;
    const parentClusterKey = clusterKeyByCommitId.get(parent.visualId);
    if (!parentClusterKey || (clusterCounts.get(parentClusterKey) ?? 1) <= 1) return null;
    return renderNodeByClusterKey.get(parentClusterKey) ?? null;
  };
  const renderConstraintParentsForNode = (node: Node): VisualCommit[] => {
    const nodeClusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (nodeClusterKey && (clusterCounts.get(nodeClusterKey) ?? 1) > 1) {
      return firstClumpSourceParents(nodeClusterKey);
    }

    const parentCandidates: VisualCommit[] = [];
    const addParent = (parent: VisualCommit | null) => {
      if (parent && !parentCandidates.some((candidate) => candidate.visualId === parent.visualId)) {
        parentCandidates.push(parent);
      }
    };
    for (const parent of parentsMap.get(node.commit.visualId) ?? []) addParent(parent);
    for (const parent of gitParentsForCommit(node.commit)) addParent(parent);
    if (node.commit.parentSha && !parentCandidates.some((parent) => shasMatch(parent.id, node.commit.parentSha))) {
      addParent(findCommitNode(node.commit.parentSha, node.commit.branchName));
    }
    return parentCandidates;
  };
  const renderConstraintParentsByVisualId = new Map(
    renderNodes.map((node) => [node.commit.visualId, renderConstraintParentsForNode(node)] as const),
  );

  const renderConstraintParentNodesByVisualId = new Map<string, Node[]>();
  const renderConstraintChildrenByVisualId = new Map<string, Node[]>();
  for (const node of renderNodes) {
    const parentNodes = (renderConstraintParentsByVisualId.get(node.commit.visualId) ?? [])
      .map((parent) => renderNodeForConstraintParent(parent))
      .filter((parent): parent is Node => !!parent && parent.commit.visualId !== node.commit.visualId);
    renderConstraintParentNodesByVisualId.set(node.commit.visualId, parentNodes);
    for (const parent of parentNodes) {
      const children = renderConstraintChildrenByVisualId.get(parent.commit.visualId) ?? [];
      if (!children.some((child) => child.commit.visualId === node.commit.visualId)) children.push(node);
      renderConstraintChildrenByVisualId.set(parent.commit.visualId, children);
    }
  }

  const visibleDependencyOrder = (): Node[] => {
    const inDegree = new Map(
      renderNodes.map((node) => [
        node.commit.visualId,
        renderConstraintParentNodesByVisualId.get(node.commit.visualId)?.length ?? 0,
      ] as const),
    );
    const compareNodes = (left: Node, right: Node): number =>
      left.row - right.row
      || left.column - right.column
      || left.commit.visualId.localeCompare(right.commit.visualId);
    const queue = renderNodes.filter((node) => (inDegree.get(node.commit.visualId) ?? 0) === 0).sort(compareNodes);
    const ordered: Node[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index]!;
      if (seen.has(node.commit.visualId)) continue;
      seen.add(node.commit.visualId);
      ordered.push(node);
      const children = [...(renderConstraintChildrenByVisualId.get(node.commit.visualId) ?? [])].sort(compareNodes);
      for (const child of children) {
        const nextDegree = (inDegree.get(child.commit.visualId) ?? 1) - 1;
        inDegree.set(child.commit.visualId, nextDegree);
        if (nextDegree === 0) queue.push(child);
      }
    }
    ordered.push(...renderNodes.filter((node) => !seen.has(node.commit.visualId)).sort(compareNodes));
    return ordered;
  };

  const placeVisibleNodesInDependencyOrder = (): Set<string> => {
    const changedIds = new Set<string>();
    const occupiedByRow = new Map<number, Map<number, string | null>>();
    const occupiedRowCounts = new Map<number, number>();
    const occupiedColumnCounts = new Map<number, number>();
    const exclusiveRows = new Set<number>();
    const exclusiveColumns = new Set<number>();
    const isExclusiveNode = (node: Node): boolean => {
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      return (
        (!!clusterKey && mergeClumpKeys.has(clusterKey))
        || isGitMergeCommit(node.commit)
        || mergeSourceVisualIds.has(node.commit.visualId)
      );
    };
    for (const node of visibleDependencyOrder()) {
      const parents = renderConstraintParentNodesByVisualId.get(node.commit.visualId) ?? [];
      let row = parents.reduce((candidate, parent) => Math.max(candidate, parent.row + 1), node.row);
      let column = parents.reduce((candidate, parent) => Math.max(candidate, parent.column + 1), node.column);
      const exclusive = isExclusiveNode(node);
      if (exclusive) {
        while ((occupiedRowCounts.get(row) ?? 0) > 0 || exclusiveRows.has(row)) row += 1;
        while ((occupiedColumnCounts.get(column) ?? 0) > 0 || exclusiveColumns.has(column)) column += 1;
      } else {
        while (exclusiveRows.has(row)) row += 1;
        while (exclusiveColumns.has(column)) column += 1;
      }
      if (row !== node.row || column !== node.column) changedIds.add(node.commit.visualId);
      node.row = row;
      node.column = column;

      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId) ?? null;
      const collisionKey = clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1 ? clusterKey : null;
      const columnCollides = (candidateColumn: number): boolean => {
        if (exclusiveColumns.has(candidateColumn)) return true;
        if (exclusive && (occupiedColumnCounts.get(candidateColumn) ?? 0) > 0) return true;
        for (let adjacentRow = node.row - 1; adjacentRow <= node.row + 1; adjacentRow += 1) {
          const occupant = occupiedByRow.get(adjacentRow)?.get(candidateColumn);
          if (occupant !== undefined && (collisionKey === null || occupant !== collisionKey)) return true;
        }
        return false;
      };
      while (columnCollides(node.column)) {
        node.column += 1;
        changedIds.add(node.commit.visualId);
      }
      const occupiedColumns = occupiedByRow.get(node.row) ?? new Map<number, string | null>();
      occupiedColumns.set(node.column, collisionKey);
      occupiedByRow.set(node.row, occupiedColumns);
      occupiedRowCounts.set(node.row, (occupiedRowCounts.get(node.row) ?? 0) + 1);
      occupiedColumnCounts.set(node.column, (occupiedColumnCounts.get(node.column) ?? 0) + 1);
      if (exclusive) {
        exclusiveRows.add(node.row);
        exclusiveColumns.add(node.column);
      }
      columnByCommitVisualId.set(node.commit.visualId, node.column);
    }
    return changedIds;
  };

  const connectorClearancePaddingPx = 0;
  const nodeRectForConnectorClearance = (node: Node) => ({
    left: node.x - connectorClearancePaddingPx,
    right: node.x + CARD_WIDTH + connectorClearancePaddingPx,
    top: node.y - CARD_BODY_TOP_OFFSET - connectorClearancePaddingPx,
    bottom: node.y + CARD_HEIGHT + connectorClearancePaddingPx,
  });
  const segmentIntersectsNodeRect = (
    start: { x: number; y: number },
    end: { x: number; y: number },
    node: Node,
  ): boolean => {
    const rect = nodeRectForConnectorClearance(node);
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    if (Math.abs(start.x - end.x) < 0.5) {
      return start.x >= rect.left && start.x <= rect.right && maxY >= rect.top && minY <= rect.bottom;
    }
    if (Math.abs(start.y - end.y) < 0.5) {
      return start.y >= rect.top && start.y <= rect.bottom && maxX >= rect.left && minX <= rect.right;
    }
    return maxX >= rect.left && minX <= rect.right && maxY >= rect.top && minY <= rect.bottom;
  };
  const connectorPolylineIntersectsNode = (
    anchors: ReturnType<typeof computeParentChildConnectorAnchors>,
    blocker: Node,
  ): boolean => {
    const points = getMapGridConnectorPolyline(
      anchors.fromX,
      anchors.fromY,
      anchors.toX,
      anchors.toY,
      anchors.fromFace,
      anchors.toFace,
    );
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersectsNodeRect(points[index - 1]!, points[index]!, blocker)) return true;
    }
    return false;
  };
  const parentChildConnectorIntersectsNode = (
    useBranchFeedAnchors: boolean,
    parentNode: Node,
    childNode: Node,
    blocker: Node,
  ): boolean => {
    if (blocker.commit.visualId === parentNode.commit.visualId || blocker.commit.visualId === childNode.commit.visualId) {
      return false;
    }
    if (getNodePositionOverride(nodePositionOverrides, blocker.commit)) return false;
    const anchors = computeParentChildConnectorAnchors(
      isHorizontal,
      useBranchFeedAnchors,
      parentNode,
      childNode,
    );
    return connectorPolylineIntersectsNode(anchors, blocker);
  };
  const mergeConnectorIntersectsNode = (sourceNode: Node, mergeTarget: Node, blocker: Node): boolean => {
    if (blocker.commit.visualId === sourceNode.commit.visualId || blocker.commit.visualId === mergeTarget.commit.visualId) {
      return false;
    }
    if (getNodePositionOverride(nodePositionOverrides, blocker.commit)) return false;
    return connectorPolylineIntersectsNode(computeMergeConnectorAnchors(isHorizontal, sourceNode, mergeTarget), blocker);
  };
  const shiftNodeColumn = (node: Node, nextColumn: number): void => {
    if (nextColumn <= node.column) return;
    node.column = nextColumn;
    columnByCommitVisualId.set(node.commit.visualId, nextColumn);
  };
  const renderNodesByClusterKey = new Map<string, Node[]>();
  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey) continue;
    const clusterNodes = renderNodesByClusterKey.get(clusterKey) ?? [];
    clusterNodes.push(node);
    renderNodesByClusterKey.set(clusterKey, clusterNodes);
  }
  const shiftClearanceGroup = (node: Node, nextColumn: number): void => {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    const clusterIsVisibleGroup = !!clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1;
    const groupNodes = clusterIsVisibleGroup
      ? renderNodesByClusterKey.get(clusterKey) ?? [node]
      : [node];
    const delta = nextColumn - node.column;
    if (delta <= 0) return;
    const dependentNodes: Node[] = [];
    const dependentIds = new Set<string>();
    const pending = [...groupNodes];
    while (pending.length > 0) {
      const dependent = pending.pop()!;
      if (dependentIds.has(dependent.commit.visualId)) continue;
      dependentIds.add(dependent.commit.visualId);
      dependentNodes.push(dependent);
      pending.push(...(renderConstraintChildrenByVisualId.get(dependent.commit.visualId) ?? []));
    }
    for (const dependent of dependentNodes) {
      if (getNodePositionOverride(nodePositionOverrides, dependent.commit)) continue;
      shiftNodeColumn(dependent, dependent.column + delta);
    }
  };
  const renderedNodesByExactSha = new Map<string, Node[]>();
  const renderedNodeByBranchAndExactSha = new Map<string, Node>();
  for (const node of renderNodes) {
    const exactMatches = renderedNodesByExactSha.get(node.commit.id) ?? [];
    exactMatches.push(node);
    renderedNodesByExactSha.set(node.commit.id, exactMatches);
    renderedNodeByBranchAndExactSha.set(`${node.commit.branchName}\0${node.commit.id}`, node);
  }
  const renderedNodeForSha = (sha: string | null | undefined, preferredBranchName?: string): Node | null => {
    if (!sha) return null;
    const exactPreferred = preferredBranchName
      ? renderedNodeByBranchAndExactSha.get(`${preferredBranchName}\0${sha}`) ?? null
      : null;
    if (exactPreferred) return exactPreferred;
    const exact = renderedNodesByExactSha.get(sha)?.[0] ?? null;
    if (exact) return exact;
    const preferred = preferredBranchName
      ? renderNodes.find((node) => node.commit.branchName === preferredBranchName && shasMatch(node.commit.id, sha))
      : null;
    return preferred ?? renderNodes.find((node) => shasMatch(node.commit.id, sha)) ?? null;
  };
  const renderedConnectorPairs = (): Array<{
    id: string;
    sourceNode: Node;
    targetNode: Node;
    intersects: (sourceNode: Node, targetNode: Node, blocker: Node) => boolean;
  }> => {
    const pairs: Array<{
      id: string;
      sourceNode: Node;
      targetNode: Node;
      intersects: (sourceNode: Node, targetNode: Node, blocker: Node) => boolean;
    }> = [];
    const seen = new Set<string>();
    const pushPair = (
      id: string,
      sourceNode: Node | null,
      targetNode: Node | null,
      intersects: (sourceNode: Node, targetNode: Node, blocker: Node) => boolean,
    ) => {
      if (!sourceNode || !targetNode || sourceNode.commit.visualId === targetNode.commit.visualId) return;
      if (seen.has(id)) return;
      seen.add(id);
      pairs.push({ id, sourceNode, targetNode, intersects });
    };
    for (const branch of branches) {
      if (branch.name === defaultBranch) continue;
      const branchBaseCommit = branchBaseCommitByName.get(branch.name);
      if (!branchBaseCommit) continue;
      const receivingCommit = branchReceivingCommitByName.get(branch.name) ?? branchBaseCommit;
      const parentSha = receivingCommit.parentSha ?? branchStartParentShaByName.get(branch.name) ?? null;
      if (!parentSha) continue;
      const sourceNode = renderedNodeForSha(parentSha, resolveBranchStartParentName(branch));
      const targetNode = renderedNodeForSha(receivingCommit.id, branch.name);
      pushPair(
        `branch:${sourceNode?.commit.visualId ?? parentSha}->${targetNode?.commit.visualId ?? receivingCommit.id}`,
        sourceNode,
        targetNode,
        (source, target, blocker) => parentChildConnectorIntersectsNode(true, source, target, blocker),
      );
    }
    for (const childNode of renderNodes) {
      const parentNode =
        renderedNodeForSha(childNode.commit.parentSha, childNode.commit.branchName)
        ?? renderedNodeForSha(childNode.commit.parentSha);
      pushPair(
        `ancestry:${parentNode?.commit.visualId ?? childNode.commit.parentSha ?? 'missing'}->${childNode.commit.visualId}`,
        parentNode,
        childNode,
        (sourceNode, targetNode, blocker) =>
          parentChildConnectorIntersectsNode(false, sourceNode, targetNode, blocker),
      );
    }
    for (const destination of mergeDestinations) {
      const sourceNode = renderedNodeForSha(destination.sourceCommitSha, destination.sourceBranchName);
      const targetNode = renderedNodeForSha(destination.targetCommitSha, destination.targetBranchName);
      pushPair(
        `merge:${sourceNode?.commit.visualId ?? destination.sourceCommitSha}->${targetNode?.commit.visualId ?? destination.targetCommitSha}`,
        sourceNode,
        targetNode,
        mergeConnectorIntersectsNode,
      );
    }
    return pairs;
  };
  const connectorPairs = renderedConnectorPairs().sort((left, right) => {
    if (left.sourceNode.row !== right.sourceNode.row) return left.sourceNode.row - right.sourceNode.row;
    if (left.targetNode.row !== right.targetNode.row) return left.targetNode.row - right.targetNode.row;
    return left.id.localeCompare(right.id);
  });

  const enforceConnectorClearance = (nodesList: Node[]): Set<string> => {
    const changedIds = new Set<string>();
    const requiredColumnByVisualId = new Map<string, number>();
    
    // Temporarily compute coordinates for intersection checks
    for (const node of nodesList) {
      if (isHorizontal) {
        node.x = LEFT_PADDING + (timelineRowLeadOffset + node.row - 1) * zoomAwareTimelinePitch;
        node.y = TOP_PADDING + node.column * zoomAwareLanePitch;
      } else {
        node.x = LEFT_PADDING + node.column * COLUMN_WIDTH;
        node.y = TOP_PADDING + (maxPreviewRow - node.row) * zoomAwareTimelinePitch;
      }
    }

    const pairIndex = buildRowSpanIndex(connectorPairs, (pair) => ({
      from: pair.sourceNode.row,
      to: pair.targetNode.row,
    }));
    for (const blocker of nodesList) {
      for (const { sourceNode, targetNode, intersects } of queryRowSpanIndex(pairIndex, blocker.row)) {
        if (blocker.commit.visualId === sourceNode.commit.visualId) continue;
        if (blocker.commit.visualId === targetNode.commit.visualId) continue;
        const minColumn = Math.min(sourceNode.column, targetNode.column);
        const maxColumn = Math.max(sourceNode.column, targetNode.column);
        if (blocker.column < minColumn || blocker.column > maxColumn) continue;
        if (!intersects(sourceNode, targetNode, blocker)) continue;
        const nextColumn = Math.max(blocker.column + 1, sourceNode.column + 1, targetNode.column + 1);
        requiredColumnByVisualId.set(
          blocker.commit.visualId,
          Math.max(requiredColumnByVisualId.get(blocker.commit.visualId) ?? blocker.column, nextColumn),
        );
      }
    }

    const shiftedClusters = new Set<string>();
    const orderedNodes = [...nodesList].sort((a, b) => {
      if (a.column !== b.column) return a.column - b.column;
      if (a.row !== b.row) return a.row - b.row;
      return a.commit.visualId.localeCompare(b.commit.visualId);
    });
    for (const node of orderedNodes) {
      const nextColumn = requiredColumnByVisualId.get(node.commit.visualId);
      if (nextColumn == null || nextColumn <= node.column) continue;
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      if (clusterKey && shiftedClusters.has(clusterKey)) continue;
      shiftClearanceGroup(node, nextColumn);
      if (clusterKey) shiftedClusters.add(clusterKey);
      changedIds.add(node.commit.visualId);
    }
    return changedIds;
  };

  // Place in dependency order, then move complete dependent subtrees for connector clearance.
  let converged = false;
  let pass = 0;
  const maxPasses = 50;
  while (!converged && pass < maxPasses) {
    pass += 1;
    const placementChanged = placeVisibleNodesInDependencyOrder();
    const clearanceChanged = enforceConnectorClearance(renderNodes);

    if (placementChanged.size === 0 && clearanceChanged.size === 0) {
      converged = true;
    }
  }

  const normalizedNodePositionOverrides = migrateNodePositionOverridesForCommits(nodePositionOverrides, allCommitsWithClusters);
  maxResolvedRow = compactRenderNodeTimelineRows(renderNodes);
  compactVisibleLaneColumns(
    renderNodes,
    columnByCommitVisualId,
    isHorizontal,
    zoomAwareLanePitch,
    new Set<number>(),
  );
  syncClumpOwnerColumnsFromLeadNodes(
    renderNodes,
    clusterKeyByCommitId,
    clusterCounts,
    leadByClusterKey,
    clumpOwnerColumnByClusterKey,
  );

  maxResolvedRow = Math.max(0, ...renderNodes.map((node) => node.row));
  
  syncRenderNodeTimelineCoordinates(
    renderNodes,
    isHorizontal,
    maxResolvedRow,
    timelineRowLeadOffset,
    zoomAwareTimelinePitch,
    zoomAwareLanePitch,
    () => false,
  );
  
  syncClumpCoordinatesToRenderNodes(
    renderNodes,
    clusterKeyByCommitId,
    clusterCounts,
    columnByCommitVisualId,
    isHorizontal,
    maxResolvedRow,
    zoomAwareTimelinePitch,
    zoomAwareLanePitch,
  );

  // Sync final row and column coordinates back to the maps
  for (const node of renderNodes) {
    allRowByVisualId.set(node.commit.visualId, node.row);
    columnByCommitVisualId.set(node.commit.visualId, node.column);
  }

  // Also sync non-lead clump members to their lead's final coordinates
  for (const commit of allCommitsWithClusters) {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (clusterKey && (clusterCounts.get(clusterKey) ?? 1) > 1) {
      const leadVisualId = leadByClusterKey.get(clusterKey);
      if (leadVisualId && leadVisualId !== commit.visualId) {
        const leadNode = renderNodes.find((n) => n.commit.visualId === leadVisualId);
        if (leadNode) {
          allRowByVisualId.set(commit.visualId, leadNode.row);
          columnByCommitVisualId.set(commit.visualId, leadNode.column);
        }
      }
    }
  }

  return {
    branchByName,
    laneByName,
    mainCommits,
    branchCommitsByLane,
    branchPreviewSets,
    allCommits,
    clustersByBranch,
    clusterKeyByCommitId,
    clusterKeyBySha,
    leadByClusterKey,
    firstByClusterKey,
    clusterCounts,
    checkedOutClusterKey,
    defaultCollapsedClumps,
    mergeDestinations,
    mergeTargetBranchesBySourceBranchAndCommitSha,
    baseNodes: renderNodes,
    rowByVisualId: allRowByVisualId,
    columnByCommitVisualId,
    clumpOwnerColumnByClusterKey,
    branchStartParentShaByName,
    branchBaseCommitByName,
    firstBranchCommitByName,
    branchReceivingCommitByName,
    resolveBranchStartParentName,
    blueStartShaForBranch,
    commitById,
    gitParentsForCommit,
    orientation,
    nodePositionOverrides: normalizedNodePositionOverrides,
    defaultBranch,
    branches,
    branchCommitPreviews,
    branchUniqueAheadCounts,
    worktreeSessions,
    isDebugOpen,
  };
}

/**
 * Pure visibility projection function.
 * Filters nodes based on open/closed clumps, materializes open clump members,
 * shifts later columns, and rebuilds connectors and bounds.
 */
export function projectVisibility(
  baseModel: BaseLayoutModel,
  manuallyOpenedClumps: Set<string>,
  manuallyClosedClumps: Set<string>,
  gridSearchQuery: string,
  gridFocusSha: string | null,
): BranchGridLayoutModel {
  const {
    branchByName,
    laneByName,
    mainCommits,
    branchCommitsByLane,
    branchPreviewSets,
    allCommits,
    clustersByBranch,
    clusterKeyByCommitId,
    clusterKeyBySha,
    leadByClusterKey,
    firstByClusterKey,
    clusterCounts,
    checkedOutClusterKey,
    defaultCollapsedClumps,
    mergeDestinations,
    mergeTargetBranchesBySourceBranchAndCommitSha,
    baseNodes,
    rowByVisualId: allRowByVisualId,
    clumpOwnerColumnByClusterKey,
    branchStartParentShaByName,
    branchBaseCommitByName,
    firstBranchCommitByName,
    branchReceivingCommitByName,
    resolveBranchStartParentName,
    blueStartShaForBranch,
    commitById,
    gitParentsForCommit,
    orientation,
    nodePositionOverrides,
    defaultBranch,
    branches,
    branchCommitPreviews,
    branchUniqueAheadCounts,
    worktreeSessions,
    isDebugOpen,
  } = baseModel;

  const isHorizontal = orientation === 'horizontal';
  const zoomAwareRowGap = ROW_GAP / GRID_LAYOUT_RENDER_ZOOM;
  const zoomAwareLabelBand = 20 / GRID_LAYOUT_RENDER_ZOOM;
  const zoomAwareTimelinePitch = isHorizontal
    ? CARD_WIDTH + zoomAwareRowGap + zoomAwareLabelBand
    : ROW_HEIGHT + zoomAwareRowGap + zoomAwareLabelBand;
  const zoomAwareLanePitch = isHorizontal ? ROW_HEIGHT + zoomAwareRowGap + zoomAwareLabelBand : COLUMN_WIDTH;

  const searchOpenedClumps = new Set<string>();
  const addSearchOpenedClump = (clusterKey: string | undefined): void => {
    if (!clusterKey || (clusterCounts.get(clusterKey) ?? 1) <= 1) return;
    searchOpenedClumps.add(clusterKey);
  };
  if (gridFocusSha) {
    const directClusterKeys = clusterKeyBySha.get(gridFocusSha) ?? [];
    if (directClusterKeys.length > 0) {
      for (const clusterKey of directClusterKeys) addSearchOpenedClump(clusterKey);
    } else {
      for (const [sha, clusterKeys] of clusterKeyBySha.entries()) {
        if (!shasMatch(sha, gridFocusSha)) continue;
        for (const clusterKey of clusterKeys) addSearchOpenedClump(clusterKey);
      }
    }
  }

  const isClumpOpen = (clusterKey: string): boolean =>
    !manuallyClosedClumps.has(clusterKey) && (
      searchOpenedClumps.has(clusterKey) ||
      isClusterClumpOpen(clusterKey, manuallyOpenedClumps, defaultCollapsedClumps, manuallyClosedClumps)
    );

  // Filter visible commits
  const visibleCommitsList = allCommits.filter((commit) => {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (!clusterKey) return true;
    const leadId = leadByClusterKey.get(clusterKey);
    const count = clusterCounts.get(clusterKey) ?? 1;
    const isOpen = isClumpOpen(clusterKey);
    return count <= 1 || isOpen || leadId === commit.visualId;
  });

  const visibleCommitVisualIds = new Set(visibleCommitsList.map((commit) => commit.visualId));

  // Build projected nodes
  const renderNodes: Node[] = [];
  const projectedNodeByVisualId = new Map<string, Node>();
  const columnByCommitVisualId = new Map<string, number>();

  for (const baseNode of baseNodes) {
    if (visibleCommitVisualIds.has(baseNode.commit.visualId)) {
      const clonedNode = { ...baseNode };
      renderNodes.push(clonedNode);
      projectedNodeByVisualId.set(clonedNode.commit.visualId, clonedNode);
      columnByCommitVisualId.set(clonedNode.commit.visualId, clonedNode.column);
    }
  }

  for (const commit of visibleCommitsList) {
    if (projectedNodeByVisualId.has(commit.visualId)) continue;
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    const leadVisualId = clusterKey ? leadByClusterKey.get(clusterKey) : null;
    const ownerNode = leadVisualId ? projectedNodeByVisualId.get(leadVisualId) : null;
    if (!ownerNode) continue;
    const projectedNode = { ...ownerNode, commit };
    renderNodes.push(projectedNode);
    projectedNodeByVisualId.set(commit.visualId, projectedNode);
    columnByCommitVisualId.set(commit.visualId, projectedNode.column);
  }

  const projectedNodesByExactSha = new Map<string, Node[]>();
  const projectedNodeByBranchAndExactSha = new Map<string, Node>();
  for (const node of renderNodes) {
    const exactMatches = projectedNodesByExactSha.get(node.commit.id) ?? [];
    exactMatches.push(node);
    projectedNodesByExactSha.set(node.commit.id, exactMatches);
    projectedNodeByBranchAndExactSha.set(`${node.commit.branchName}\0${node.commit.id}`, node);
  }

  // Preserve clump owner columns and project open clumps (shifting columns)
  const projectedClumpOwnerColumn = new Map<string, number>(clumpOwnerColumnByClusterKey);
  syncClumpOwnerColumnsFromLeadNodes(
    renderNodes,
    clusterKeyByCommitId,
    clusterCounts,
    leadByClusterKey,
    projectedClumpOwnerColumn,
  );

  const openClumps = [...clusterCounts.entries()]
    .filter(([clusterKey, count]) => count > 1 && isClumpOpen(clusterKey))
    .map(([clusterKey, count]) => {
      const ownerColumn =
        projectedClumpOwnerColumn.get(clusterKey);
      return ownerColumn == null ? null : { clusterKey, count, ownerColumn };
    })
    .filter((value): value is { clusterKey: string; count: number; ownerColumn: number } => value != null)
    .sort((a, b) => a.ownerColumn - b.ownerColumn || a.clusterKey.localeCompare(b.clusterKey));

  const openClumpKeys = new Set(openClumps.map((clump) => clump.clusterKey));
  const occupiedStableCells = new Set(
    renderNodes
      .filter((node) => {
        const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
        return !clusterKey || !openClumpKeys.has(clusterKey);
      })
      .map((node) => `${node.row}:${node.column}`),
  );
  for (const clump of openClumps) {
    const memberNodes = renderNodes.filter(
      (node) => clusterKeyByCommitId.get(node.commit.visualId) === clump.clusterKey,
    );
    const ownerColumn = projectedClumpOwnerColumn.get(clump.clusterKey);
    if (ownerColumn == null) continue;

    // Keep existing lanes stable. The opened clump moves as one local block.
    const leadVisualId = leadByClusterKey.get(clump.clusterKey);
    const orderedMembers = [...memberNodes].sort((left, right) => {
      if (left.commit.visualId === leadVisualId) return 1;
      if (right.commit.visualId === leadVisualId) return -1;
      return (
        safeTimeMs(left.commit.date) - safeTimeMs(right.commit.date)
        || left.commit.id.localeCompare(right.commit.id)
        || left.commit.visualId.localeCompare(right.commit.visualId)
      );
    });
    const sharedRow = memberNodes[0]?.row ?? 0;
    const desiredBandStart = Math.max(0, ownerColumn - orderedMembers.length + 1);
    const bandIsOccupied = (startColumn: number) => orderedMembers.some(
      (_, index) => occupiedStableCells.has(`${sharedRow}:${startColumn + index}`),
    );
    let bandStartColumn = desiredBandStart;
    while (bandIsOccupied(bandStartColumn)) bandStartColumn += 1;
    orderedMembers.forEach((node, index) => {
      const nextColumn = bandStartColumn + index;
      node.column = nextColumn;
      columnByCommitVisualId.set(node.commit.visualId, nextColumn);
      occupiedStableCells.add(`${sharedRow}:${nextColumn}`);
    });
    const leadNode = leadVisualId
      ? orderedMembers.find((node) => node.commit.visualId === leadVisualId) ?? null
      : null;
    projectedClumpOwnerColumn.set(clump.clusterKey, leadNode?.column ?? bandStartColumn);
  }

  const latestOpenClumpNodeForSha = (
    sha: string | null | undefined,
    preferredBranchName?: string,
  ): Node | null => {
    if (!sha) return null;
    const directClusterKey = preferredBranchName
      ? clusterKeyByCommitId.get(`${preferredBranchName}:${sha}`)
      : null;
    const clusterKeys = [
      directClusterKey,
      ...(clusterKeyBySha.get(sha) ?? []),
    ].filter((key): key is string => !!key);
    for (const clusterKey of [...new Set(clusterKeys)]) {
      if ((clusterCounts.get(clusterKey) ?? 1) <= 1 || !isClumpOpen(clusterKey)) continue;
      const leadVisualId = leadByClusterKey.get(clusterKey);
      const leadNode = leadVisualId ? projectedNodeByVisualId.get(leadVisualId) ?? null : null;
      if (leadNode) return leadNode;
    }
    return null;
  };

  const actualWorktreeParentSha = (commit: VisualCommit): string | null => {
    if (!isWorktreeGraphNode(commit)) return commit.parentSha ?? commit.parentShas?.[0] ?? null;
    return (
      worktreeSessions.find((session) => session.workingTreeId === commit.id)?.headSha
      ?? commit.parentSha
      ?? commit.parentShas?.[0]
      ?? null
    );
  };
  const projectedNodeForSha = (sha: string, preferredBranchName: string): Node | null =>
    projectedNodeByBranchAndExactSha.get(`${preferredBranchName}\0${sha}`)
    ?? projectedNodesByExactSha.get(sha)?.[0]
    ?? renderNodes.find((node) => node.commit.branchName === preferredBranchName && shasMatch(node.commit.id, sha))
    ?? renderNodes.find((node) => shasMatch(node.commit.id, sha))
    ?? null;
  const projectedConnectorNodeForSha = (
    sha: string | null | undefined,
    preferredBranchName: string,
  ): Node | null => {
    if (!sha) return null;
    const directNode = projectedNodeForSha(sha, preferredBranchName);
    if (directNode) return directNode;
    const clumpNode = latestOpenClumpNodeForSha(sha, preferredBranchName);
    if (clumpNode) return clumpNode;
    const clusterKey =
      clusterKeyByCommitId.get(`${preferredBranchName}:${sha}`)
      ?? clusterKeyByCommitId.get(sha)
      ?? clusterKeyBySha.get(sha)?.[0]
      ?? null;
    if (!clusterKey) return null;
    return renderNodes.find((node) => clusterKeyByCommitId.get(node.commit.visualId) === clusterKey) ?? null;
  };
  type CanonicalEdge = { parent: Node; child: Node; sharesTimelineColumn: boolean };
  const canonicalEdges: CanonicalEdge[] = [];
  const canonicalEdgeKeys = new Set<string>();
  const canonicalChildrenByVisualId = new Map<string, Set<string>>();
  const canonicalPathExists = (fromVisualId: string, targetVisualId: string): boolean => {
    const pending = [fromVisualId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const visualId = pending.pop()!;
      if (visualId === targetVisualId) return true;
      if (seen.has(visualId)) continue;
      seen.add(visualId);
      for (const childVisualId of canonicalChildrenByVisualId.get(visualId) ?? []) {
        pending.push(childVisualId);
      }
    }
    return false;
  };
  const addCanonicalEdge = (parent: Node | null, child: Node | null): void => {
    if (!parent || !child || parent.commit.visualId === child.commit.visualId) return;
    if (parent.commit.id === child.commit.id) return;
    const key = `${parent.commit.visualId}->${child.commit.visualId}`;
    if (canonicalEdgeKeys.has(key)) return;
    if (canonicalPathExists(child.commit.visualId, parent.commit.visualId)) return;
    canonicalEdgeKeys.add(key);
    const parentClusterKey = clusterKeyByCommitId.get(parent.commit.visualId);
    const childClusterKey = clusterKeyByCommitId.get(child.commit.visualId);
    canonicalEdges.push({
      parent,
      child,
      sharesTimelineColumn:
        !!parentClusterKey
        && parentClusterKey === childClusterKey
        && isClumpOpen(parentClusterKey)
        && !isWorktreeGraphNode(parent.commit)
        && !isWorktreeGraphNode(child.commit)
        && parent.commit.kind !== 'stash'
        && child.commit.kind !== 'stash'
        && parent.commit.kind !== 'branch-created'
        && child.commit.kind !== 'branch-created',
    });
    const children = canonicalChildrenByVisualId.get(parent.commit.visualId) ?? new Set<string>();
    children.add(child.commit.visualId);
    canonicalChildrenByVisualId.set(parent.commit.visualId, children);
  };
  const collapsedClumpExternalParents = (clusterKey: string): VisualCommit[] => {
    const firstVisualId = firstByClusterKey.get(clusterKey);
    const firstMember = firstVisualId
      ? allCommits.find((commit) => commit.visualId === firstVisualId)
      : null;
    if (!firstMember) return [];
    const parents: VisualCommit[] = [];
    const addParent = (parent: VisualCommit | null) => {
      if (
        parent
        && clusterKeyByCommitId.get(parent.visualId) !== clusterKey
        && !parents.some((candidate) => candidate.visualId === parent.visualId)
      ) {
        parents.push(parent);
      }
    };
    for (const parent of gitParentsForCommit(firstMember)) addParent(parent);
    const parentSha = actualWorktreeParentSha(firstMember);
    if (parentSha) {
      const parentNode = projectedConnectorNodeForSha(parentSha, firstMember.branchName);
      addParent(parentNode?.commit ?? null);
    }
    return parents;
  };

  for (const child of renderNodes) {
    const childClusterKey = clusterKeyByCommitId.get(child.commit.visualId);
    const childIsCollapsedClump =
      !!childClusterKey
      && (clusterCounts.get(childClusterKey) ?? 1) > 1
      && !isClumpOpen(childClusterKey);
    const canonicalParents = childIsCollapsedClump
      ? collapsedClumpExternalParents(childClusterKey)
      : gitParentsForCommit(child.commit);
    for (const parent of canonicalParents) {
      addCanonicalEdge(
        projectedConnectorNodeForSha(parent.id, parent.branchName),
        child,
      );
    }
    const parentSha = childIsCollapsedClump ? null : actualWorktreeParentSha(child.commit);
    if (parentSha) addCanonicalEdge(projectedConnectorNodeForSha(parentSha, child.commit.branchName), child);
  }
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const branchBaseCommit = branchBaseCommitByName.get(branch.name);
    if (!branchBaseCommit) continue;
    const receivingCommit = branchReceivingCommitByName.get(branch.name) ?? branchBaseCommit;
    const parentSha = receivingCommit.parentSha ?? branchStartParentShaByName.get(branch.name) ?? null;
    if (!parentSha) continue;
    addCanonicalEdge(
      projectedConnectorNodeForSha(parentSha, resolveBranchStartParentName(branch)),
      projectedConnectorNodeForSha(receivingCommit.id, branch.name),
    );
  }
  for (const destination of mergeDestinations) {
    addCanonicalEdge(
      projectedConnectorNodeForSha(destination.sourceCommitSha, destination.sourceBranchName),
      projectedConnectorNodeForSha(destination.targetCommitSha, destination.targetBranchName),
    );
  }
  const visibleByBranch = new Map<string, Node[]>();
  for (const node of renderNodes) {
    const list = visibleByBranch.get(node.commit.branchName) ?? [];
    list.push(node);
    visibleByBranch.set(node.commit.branchName, list);
  }
  for (const child of renderNodes) {
    if (!isWorktreeGraphNode(child.commit)) continue;
    const parentSha = actualWorktreeParentSha(child.commit);
    if (parentSha && projectedConnectorNodeForSha(parentSha, child.commit.branchName)) continue;
    const visibleParent = [...(visibleByBranch.get(child.commit.branchName) ?? [])]
      .filter((candidate) => !isWorktreeGraphNode(candidate.commit) && candidate.commit.visualId !== child.commit.visualId)
      .sort(
        (left, right) =>
          safeTimeMs(right.commit.date) - safeTimeMs(left.commit.date)
          || right.commit.visualId.localeCompare(left.commit.visualId),
      )[0] ?? null;
    addCanonicalEdge(visibleParent, child);
  }

  const incomingByVisualId = new Map<string, CanonicalEdge[]>();
  const childrenByVisualId = new Map<string, Node[]>();
  for (const edge of canonicalEdges) {
    const incoming = incomingByVisualId.get(edge.child.commit.visualId) ?? [];
    incoming.push(edge);
    incomingByVisualId.set(edge.child.commit.visualId, incoming);
    const children = childrenByVisualId.get(edge.parent.commit.visualId) ?? [];
    if (!children.some((child) => child.commit.visualId === edge.child.commit.visualId)) children.push(edge.child);
    childrenByVisualId.set(edge.parent.commit.visualId, children);
  }
  const canonicalClusterTime = (node: Node): number => {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey || (clusterCounts.get(clusterKey) ?? 1) <= 1) return safeTimeMs(node.commit.date);
    const leadVisualId = leadByClusterKey.get(clusterKey);
    const leadCommit = leadVisualId
      ? allCommits.find((commit) => commit.visualId === leadVisualId)
      : null;
    return safeTimeMs(leadCommit?.date ?? node.commit.date);
  };
  const compareCanonicalNodes = (left: Node, right: Node): number => {
    const leftClusterKey = clusterKeyByCommitId.get(left.commit.visualId);
    const rightClusterKey = clusterKeyByCommitId.get(right.commit.visualId);
    if (leftClusterKey && leftClusterKey === rightClusterKey) {
      return (
        safeTimeMs(left.commit.date) - safeTimeMs(right.commit.date)
        || left.commit.visualId.localeCompare(right.commit.visualId)
      );
    }
    return (
      canonicalClusterTime(left) - canonicalClusterTime(right)
      || left.commit.visualId.localeCompare(right.commit.visualId)
    );
  };
  const canonicalOrder = [...renderNodes].sort(
    compareCanonicalNodes,
  );
  const canonicalSubtreeRankByVisualId = new Map<string, number>();
  let canonicalSubtreeRank = 0;
  const assignCanonicalSubtreeRanks = (root: Node): void => {
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (canonicalSubtreeRankByVisualId.has(node.commit.visualId)) continue;
      canonicalSubtreeRankByVisualId.set(node.commit.visualId, canonicalSubtreeRank);
      canonicalSubtreeRank += 1;
      const children = [...(childrenByVisualId.get(node.commit.visualId) ?? [])].sort(
        compareCanonicalNodes,
      );
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]!);
      }
    }
  };
  for (const node of canonicalOrder) {
    if ((incomingByVisualId.get(node.commit.visualId) ?? []).length === 0) {
      assignCanonicalSubtreeRanks(node);
    }
  }
  for (const node of canonicalOrder) assignCanonicalSubtreeRanks(node);
  const nodesByCanonicalSubtreeRank = [...renderNodes].sort(
    (left, right) =>
      (canonicalSubtreeRankByVisualId.get(left.commit.visualId) ?? Number.MAX_SAFE_INTEGER)
      - (canonicalSubtreeRankByVisualId.get(right.commit.visualId) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const [clusterKey, count] of clusterCounts) {
    if (count <= 1 || !isClumpOpen(clusterKey)) continue;
    const memberNodes = renderNodes.filter(
      (node) =>
        clusterKeyByCommitId.get(node.commit.visualId) === clusterKey
        && !isWorktreeGraphNode(node.commit)
        && node.commit.kind !== 'stash'
        && node.commit.kind !== 'branch-created',
    );
    if (memberNodes.length <= 1) continue;
    const sharedRow = Math.max(...memberNodes.map((node) => node.row));
    for (const node of memberNodes) node.row = sharedRow;
  }
  const pinnedOverrideNodeIds = applyNodePositionOverrides({
    renderNodes,
    allCommitsWithClusters: allCommits,
    clusterKeyByCommitId,
    leadByClusterKey,
    rowByVisualId: allRowByVisualId,
    overrides: nodePositionOverrides,
    isHorizontal,
    zoomAwareTimelinePitch,
    zoomAwareLanePitch,
    maxResolvedRow: Math.max(0, ...renderNodes.map((node) => node.row)),
  });
  const isPinnedOverrideNode = (node: Node): boolean => pinnedOverrideNodeIds.has(node.commit.visualId);

  for (const node of nodesByCanonicalSubtreeRank) {
    if (
      !isWorktreeGraphNode(node.commit)
      && !pinnedOverrideNodeIds.has(node.commit.visualId)
    ) {
      continue;
    }
    const incoming = incomingByVisualId.get(node.commit.visualId) ?? [];
    if (incoming.length === 0) continue;
    const requiredRow = Math.max(
      ...incoming.map((edge) => edge.parent.row + (edge.sharesTimelineColumn ? 0 : 1)),
    );
    const requiredColumn = Math.max(...incoming.map((edge) => edge.parent.column + 1));
    if (node.row < requiredRow) node.row = requiredRow;
    if (node.column < requiredColumn) node.column = requiredColumn;
  }
  const movableProjectionVisualIds = new Set([
    ...pinnedOverrideNodeIds,
    ...renderNodes
      .filter((node) => isWorktreeGraphNode(node.commit))
      .map((node) => node.commit.visualId),
  ]);
  const occupiedProjectionCells = new Set(
    renderNodes
      .filter((node) => !movableProjectionVisualIds.has(node.commit.visualId))
      .map((node) => `${node.row}:${node.column}`),
  );
  const movableProjectionNodes = renderNodes
    .filter((node) => movableProjectionVisualIds.has(node.commit.visualId))
    .sort((left, right) => {
      const leftPinned = isPinnedOverrideNode(left);
      const rightPinned = isPinnedOverrideNode(right);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (left.row !== right.row) return left.row - right.row;
      if (left.column !== right.column) return left.column - right.column;
      return left.commit.visualId.localeCompare(right.commit.visualId);
    });
  for (const node of movableProjectionNodes) {
    let column = node.column;
    while (occupiedProjectionCells.has(`${node.row}:${column}`)) column += 1;
    node.column = column;
    occupiedProjectionCells.add(`${node.row}:${column}`);
  }

  for (const node of renderNodes) {
    allRowByVisualId.set(node.commit.visualId, node.row);
    columnByCommitVisualId.set(node.commit.visualId, node.column);
  }

  // Re-sync final visual node coordinates
  let maxResolvedRow = Math.max(0, ...renderNodes.map((node) => node.row));
  const timelineRowLeadOffset = 0;
  
  for (const node of renderNodes) {
    if (isHorizontal) {
      node.x = LEFT_PADDING + (timelineRowLeadOffset + node.row - 1) * zoomAwareTimelinePitch;
      node.y = TOP_PADDING + node.column * zoomAwareLanePitch;
    } else {
      node.x = LEFT_PADDING + node.column * COLUMN_WIDTH;
      node.y = TOP_PADDING + (maxResolvedRow - node.row) * zoomAwareTimelinePitch;
    }
  }

  // Build mapping and search structures
  const visibleNodesBySha = new Map<string, Node[]>();
  for (const node of renderNodes) {
    const list = visibleNodesBySha.get(node.commit.id) ?? [];
    list.push(node);
    visibleNodesBySha.set(node.commit.id, list);
  }

  const visibleNodeByClusterKey = new Map<string, Node>();
  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey) continue;
    const current = visibleNodeByClusterKey.get(clusterKey);
    if (!current || (isHorizontal ? node.x > current.x : node.y < current.y)) {
      visibleNodeByClusterKey.set(clusterKey, node);
    }
  }

  // Apply search filtering and focus
  const maxPreviewRow = Math.max(0, ...allCommits.map((commit) => allRowByVisualId.get(commit.visualId) ?? 1));
  const nodes: Node[] = allCommits.map((commit) => {
    const row = allRowByVisualId.get(commit.visualId) ?? 1;
    const column = columnByCommitVisualId.get(commit.visualId) ?? 0;
    let x = 0;
    let y = 0;
    if (isHorizontal) {
      x = LEFT_PADDING + (row - 1) * zoomAwareTimelinePitch;
      y = TOP_PADDING + column * zoomAwareLanePitch;
    } else {
      x = LEFT_PADDING + column * COLUMN_WIDTH;
      y = TOP_PADDING + (maxPreviewRow - row) * zoomAwareTimelinePitch;
    }
    return { commit, row, column, x, y };
  });

  const normalizedSearchQuery = gridSearchQuery.trim().toLowerCase();
  const matchingNodes = normalizedSearchQuery
    ? nodes.filter((node) => {
        const sha = node.commit.id.toLowerCase();
        const shortSha = node.commit.id.slice(0, 7).toLowerCase();
        const message = node.commit.message.toLowerCase();
        const branchName = node.commit.branchName.toLowerCase();
        return sha.includes(normalizedSearchQuery) || shortSha.includes(normalizedSearchQuery) || message.includes(normalizedSearchQuery) || branchName.includes(normalizedSearchQuery);
      })
    : nodes;
  const focusedNode = gridFocusSha ? nodes.find((node) => node.commit.id === gridFocusSha) ?? null : null;
  const matchingNodeIds = new Set(matchingNodes.map((node) => node.commit.id));

  const pointFormatter = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const maxVisibleRow = Math.max(0, ...renderNodes.map((node) => node.row));
  const maxLaneColumn = Math.max(0, ...renderNodes.map((node) => node.column));
  const renderedMaxX = Math.max(0, ...renderNodes.map((node) => node.x + CARD_WIDTH));
  const renderedMaxY = Math.max(0, ...renderNodes.map((node) => node.y + CARD_BODY_TOP_OFFSET + CARD_HEIGHT));
  const contentWidth = Math.max(
    isHorizontal
      ? LEFT_PADDING * 2 + Math.max(0, maxVisibleRow - 1) * zoomAwareTimelinePitch + CARD_WIDTH + CARD_HEADER_HEIGHT + zoomAwareLabelBand
      : LEFT_PADDING * 2 + (maxLaneColumn + 1) * COLUMN_WIDTH,
    renderedMaxX + LEFT_PADDING,
  );
  const contentHeight = Math.max(
    isHorizontal
      ? TOP_PADDING * 2 + maxLaneColumn * zoomAwareLanePitch + CARD_HEIGHT + CARD_HEADER_HEIGHT + zoomAwareLabelBand
      : TOP_PADDING * 2 + Math.max(0, maxVisibleRow - 1) * zoomAwareTimelinePitch + CARD_HEIGHT + CARD_HEADER_HEIGHT + zoomAwareLabelBand,
    renderedMaxY + TOP_PADDING,
  );

  // -------------------------------------------------------------
  // Connector Construction
  // -------------------------------------------------------------
  const connectors: Connector[] = [];
  const branchZIndexByName = new Map<string, number>(
    branches.map((branch) => {
      const time = new Date(branch.createdDate ?? branch.divergedFromDate ?? branch.lastCommitDate).getTime();
      return [branch.name, Number.isFinite(time) ? time : 0] as const;
    }),
  );
  const branchConnectorZIndex = (branchName: string): number => branchZIndexByName.get(branchName) ?? 0;
  const connectorDecisions: ConnectorDecisionRow[] = [];
  const pushConnectorDecision = (row: ConnectorDecisionRow) => {
    if (!isDebugOpen) return;
    connectorDecisions.push(row);
  };

  const commitIdsWithRenderedAncestry = new Set<string>();
  const nodeWarnings = new Map<string, string[]>();
  const addNodeWarning = (sha: string, message: string) => {
    const list = nodeWarnings.get(sha) ?? [];
    if (!list.includes(message)) list.push(message);
    nodeWarnings.set(sha, list);
  };
  const connectorParentShas = new Set<string>();
  const branchStartShas = new Set<string>();
  const branchOffNodeShas = new Set<string>();
  const isClusterCollapsed = (clusterKey: string): boolean =>
    (clusterCounts.get(clusterKey) ?? 1) > 1 && !isClumpOpen(clusterKey);

  const nodeForConnectorTipSha = (sha: string | null | undefined, preferredBranchName?: string): Node | null => {
    if (!sha) return null;
    const visibleNode = nodeForCommitSha(visibleNodesBySha, sha, preferredBranchName);
    if (visibleNode) return visibleNode;
    const exactRenderedNode = renderNodes.find(
      (candidate) =>
        shasMatch(candidate.commit.id, sha) &&
        (!preferredBranchName || candidate.commit.branchName === preferredBranchName),
    );
    if (exactRenderedNode) return exactRenderedNode;
    const clusterKey =
      clusterKeyByCommitId.get(`${preferredBranchName ?? defaultBranch}:${sha}`) ??
      clusterKeyByCommitId.get(sha);
    if (!clusterKey) return null;
    const clusterNodes = renderNodes.filter(
      (candidate) => clusterKeyByCommitId.get(candidate.commit.visualId) === clusterKey,
    );
    const forkNodeInCluster = clusterNodes.find((candidate) => shasMatch(candidate.commit.id, sha));
    if (forkNodeInCluster) return forkNodeInCluster;
    if (isClusterCollapsed(clusterKey)) {
      return visibleNodeByClusterKey.get(clusterKey) ?? null;
    }
    const clusterLeadId = leadByClusterKey.get(clusterKey);
    if (clusterLeadId) {
      const leadNode = renderNodes.find((candidate) => candidate.commit.visualId === clusterLeadId);
      if (leadNode && shasMatch(leadNode.commit.id, sha)) return leadNode;
    }
    return null;
  };
  const connectorKeySet = new Set<string>();
  for (const branch of branches) {
    const branchStartSha = blueStartShaForBranch(branch);
    if (branchStartSha) branchStartShas.add(branchStartSha);
    const forkSha = branchStartParentShaByName.get(branch.name) ?? null;
    if (forkSha) branchOffNodeShas.add(forkSha);
  }
  const resolveConnectorNode = (commit: VisualCommit): Node | null => {
    const directNode = nodeForConnectorTipSha(commit.id, commit.branchName);
    if (directNode) return directNode;
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (!clusterKey) return null;
    const leadId = leadByClusterKey.get(clusterKey);
    if (!leadId) return null;
    return (
      renderNodes.find((candidate) => candidate.commit.visualId === leadId)
      ?? visibleNodeByClusterKey.get(clusterKey)
      ?? null
    );
  };

  const resolveChildNodeForSha = (sha: string | null | undefined, preferredBranchName?: string): Node | null => {
    if (!sha) return null;
    return nodeForCommitSha(visibleNodesBySha, sha, preferredBranchName);
  };

  const isConnectorBranching = (parentNode: Node, childNode: Node): boolean => {
    if (parentNode.column !== childNode.column) return true;
    if (!isHorizontal) return false;
    return parentNode.commit.branchName !== childNode.commit.branchName;
  };

  const resolveParentNode = (parentSha: string, preferredBranchName: string): Node | null => {
    return nodeForCommitSha(visibleNodesBySha, parentSha, preferredBranchName);
  };

  const resolveNodeForSha = (sha: string | null | undefined, preferredBranchName?: string): Node | null => {
    return resolveChildNodeForSha(sha, preferredBranchName);
  };

  const mergeConnectors: Connector[] = [];
  const mergeConnectorGeometryKeySet = new Set<string>();
  for (const destination of mergeDestinations) {
    const mergeTarget =
      nodeForConnectorTipSha(destination.targetCommitSha, destination.targetBranchName) ?? null;
    if (!mergeTarget) {
      pushConnectorDecision({
        id: `merge:${destination.mergeCommitSha}:${destination.sourceCommitSha}:target`,
        kind: 'merge',
        parent: destination.sourceCommitSha,
        child: destination.targetCommitSha,
        rendered: false,
        reason: 'missing merge target node',
      });
      continue;
    }
    const parentSha = destination.sourceCommitSha;
    const decisionId = `merge:${destination.mergeCommitSha}:${parentSha ?? 'unknown'}`;
    if (!parentSha || shasMatch(parentSha, destination.targetCommitSha)) {
      pushConnectorDecision({
        id: decisionId,
        kind: 'merge',
        parent: parentSha ?? 'unknown',
        child: destination.targetCommitSha,
        rendered: false,
        reason: !parentSha ? 'missing merged parent sha' : 'merged parent equals merge target sha',
      });
      continue;
    }
    const sourceNode =
      nodeForCommitSha(visibleNodesBySha, parentSha, destination.sourceBranchName)
      ?? nodeForCommitSha(visibleNodesBySha, parentSha)
      ?? null;
    if (!sourceNode) {
      pushConnectorDecision({
        id: decisionId,
        kind: 'merge',
        parent: parentSha,
        child: destination.targetCommitSha,
        rendered: false,
        reason: 'missing merge parent node',
      });
      continue;
    }
    if (isWorktreeConnectorSource(sourceNode.commit)) {
      pushConnectorDecision({
        id: decisionId,
        kind: 'merge',
        parent: sourceNode.commit.id,
        child: mergeTarget.commit.id,
        rendered: false,
        reason: 'worktree nodes have no outgoing connectors',
      });
      continue;
    }
    if (sourceNode.commit.id === mergeTarget.commit.id) {
      pushConnectorDecision({
        id: decisionId,
        kind: 'merge',
        parent: sourceNode.commit.id,
        child: mergeTarget.commit.id,
        rendered: false,
        reason: 'merge parent and target resolve to same node',
      });
      continue;
    }
    const anchors = computeMergeConnectorAnchors(isHorizontal, sourceNode, mergeTarget);
    const { fromX, fromY, fromFace, toX, toY, toFace } = anchors;
    const geometryKey = `${fromX.toFixed(2)}:${fromY.toFixed(2)}:${toX.toFixed(2)}:${toY.toFixed(2)}`;
    if (mergeConnectorGeometryKeySet.has(geometryKey)) {
      pushConnectorDecision({
        id: decisionId,
        kind: 'merge',
        parent: sourceNode.commit.id,
        child: mergeTarget.commit.id,
        rendered: false,
        reason: 'duplicate merge connector geometry',
      });
      continue;
    }
    mergeConnectorGeometryKeySet.add(geometryKey);
    mergeConnectors.push({
      id: decisionId,
      fromX,
      fromY,
      toX,
      toY,
      fromFace,
      toFace,
      zIndex: branchConnectorZIndex(sourceNode.commit.branchName),
      fromCommitVisualId: sourceNode.commit.visualId,
      toCommitVisualId: mergeTarget.commit.visualId,
      connectorEdgeKind: 'merge',
    });
    pushConnectorDecision({
      id: decisionId,
      kind: 'merge',
      parent: sourceNode.commit.id,
      child: mergeTarget.commit.id,
      rendered: true,
      reason: `merge connector rendered to ${destination.targetBranchName}`,
    });
  }

  const crossBranchOutgoingShas = new Set<string>();
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const branchBaseCommit = branchBaseCommitByName.get(branch.name);
    if (!branchBaseCommit) continue;
    const parentName = resolveBranchStartParentName(branch);
    const receivingCommit = branchReceivingCommitByName.get(branch.name) ?? branchBaseCommit;
    const immediateParentSha = receivingCommit.parentSha ?? branchStartParentShaByName.get(branch.name) ?? null;
    const preferredParentBranchName =
      immediateParentSha
        ? (commitById.get(immediateParentSha)?.branchName ?? parentName)
        : parentName;
    const parentNode = immediateParentSha
      ? (
        nodeForConnectorTipSha(immediateParentSha, preferredParentBranchName)
        ?? resolveParentNode(immediateParentSha, preferredParentBranchName)
      )
      : null;
    const childNode = resolveNodeForSha(receivingCommit.id, branch.name) ?? resolveConnectorNode(receivingCommit as VisualCommit);
    if (!parentNode || !childNode || parentNode.commit.id === childNode.commit.id) {
      const parentClusterKey = clusterKeyByCommitId.get(`${branch.name}:${branchBaseCommit.id}`);
      const childClusterKey = clusterKeyByCommitId.get(`${branch.name}:${receivingCommit.id}`);
      const parentClusterDefaultOpen = !!parentClusterKey && !defaultCollapsedClumps.has(parentClusterKey);
      const childClusterDefaultOpen = !!childClusterKey && !defaultCollapsedClumps.has(childClusterKey);
      const parentHiddenByClump = !!parentClusterKey
        && !manuallyOpenedClumps.has(parentClusterKey)
        && (parentClusterDefaultOpen ? manuallyClosedClumps.has(parentClusterKey) : true);
      const childHiddenByClump = !!childClusterKey
        && !manuallyOpenedClumps.has(childClusterKey)
        && (childClusterDefaultOpen ? manuallyClosedClumps.has(childClusterKey) : true);
      if (!parentNode && !parentHiddenByClump) {
        addNodeWarning(childNode?.commit.id ?? branchBaseCommit.id, 'Missing parent node');
      }
      if (!childNode && !childHiddenByClump) {
        addNodeWarning(branchBaseCommit.id, 'Missing child node');
      }
      pushConnectorDecision({
        id: `branch:${parentNode?.commit.id ?? 'null'}->${childNode?.commit.id ?? 'null'}`,
        kind: 'branch',
        parent: parentNode?.commit.id ?? 'null',
        child: childNode?.commit.id ?? 'null',
        rendered: false,
        reason: !parentNode ? 'missing parent node' : !childNode ? 'missing child node' : 'parent and child are the same node',
      });
      continue;
    }
    if (isWorktreeConnectorSource(parentNode.commit)) {
      pushConnectorDecision({
        id: `branch:${parentNode.commit.id}->${childNode.commit.id}`,
        kind: 'branch',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'worktree nodes have no outgoing connectors',
      });
      continue;
    }
    const redundantWithDirectAncestry =
      receivingCommit.kind !== 'branch-created'
      && !!receivingCommit.parentSha
      && shasMatch(receivingCommit.parentSha, parentNode.commit.id);
    if (redundantWithDirectAncestry) {
      pushConnectorDecision({
        id: `branch:${parentNode.commit.id}->${childNode.commit.id}`,
        kind: 'branch',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'redundant with direct ancestry connector',
      });
      continue;
    }
    const key = `branch:${parentNode.commit.id}->${childNode.commit.id}`;
    if (connectorKeySet.has(key)) {
      pushConnectorDecision({
        id: key,
        kind: 'branch',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'duplicate connector key',
      });
      continue;
    }
    connectorKeySet.add(key);
    connectorParentShas.add(parentNode.commit.id);
    const isBranching = isConnectorBranching(parentNode, childNode);
    if (parentNode.commit.branchName !== childNode.commit.branchName) {
      crossBranchOutgoingShas.add(parentNode.commit.id);
    }
    const anchors = computeParentChildConnectorAnchors(isHorizontal, true, parentNode, childNode);
    connectors.push({
      id: key,
      fromX: anchors.fromX,
      fromY: anchors.fromY,
      toX: anchors.toX,
      toY: anchors.toY,
      fromFace: anchors.fromFace,
      toFace: anchors.toFace,
      zIndex: branchConnectorZIndex(childNode.commit.branchName),
      fromCommitVisualId: parentNode.commit.visualId,
      toCommitVisualId: childNode.commit.visualId,
      useBranchFeedAnchors: true,
      connectorEdgeKind: 'branch',
    });
    pushConnectorDecision({
      id: key,
      kind: 'branch',
      parent: parentNode.commit.id,
      child: childNode.commit.id,
      rendered: true,
      reason: isBranching ? 'branch connector rendered' : isHorizontal ? 'horizontal connector rendered' : 'vertical connector rendered',
    });
  }

  for (const commit of allCommits) {
    const childNode = resolveConnectorNode(commit);
    if (!childNode) continue;
    const parentSha = actualWorktreeParentSha(commit);
    if (!parentSha) continue;
    let parentNode =
      (isWorktreeGraphNode(commit) ? latestOpenClumpNodeForSha(parentSha, commit.branchName) : null)
      ?? nodeForConnectorTipSha(parentSha, commit.branchName)
      ?? resolveParentNode(parentSha, commit.branchName);
    if (!parentNode && isWorktreeGraphNode(commit)) {
      parentNode = [...(visibleByBranch.get(commit.branchName) ?? [])]
        .filter((candidate) => !isWorktreeGraphNode(candidate.commit) && candidate.commit.visualId !== childNode.commit.visualId)
        .sort(
          (left, right) =>
            safeTimeMs(right.commit.date) - safeTimeMs(left.commit.date)
            || right.commit.visualId.localeCompare(left.commit.visualId),
        )[0] ?? null;
    }
    if (!parentNode) {
      const parentClusterKey =
        clusterKeyByCommitId.get(`${commit.branchName}:${parentSha}`) ?? clusterKeyByCommitId.get(parentSha);
      const parentClusterDefaultOpen = !!parentClusterKey && !defaultCollapsedClumps.has(parentClusterKey);
      const parentHiddenByClump = !!parentClusterKey
        && !manuallyOpenedClumps.has(parentClusterKey)
        && (parentClusterDefaultOpen ? manuallyClosedClumps.has(parentClusterKey) : true);
      if (!parentHiddenByClump) {
        addNodeWarning(commit.id, 'Missing parent node');
      }
      pushConnectorDecision({
        id: `${commit.visualId}->${parentSha}`,
        kind: 'ancestry',
        parent: parentSha,
        child: commit.id,
        rendered: false,
        reason: 'missing parent node',
      });
      continue;
    }
    if (childNode.commit.id === parentNode.commit.id) {
      addNodeWarning(childNode.commit.id, 'Parent and child resolve to the same node');
      pushConnectorDecision({
        id: `${parentNode.commit.id}->${childNode.commit.id}`,
        kind: 'ancestry',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'parent and child are the same node',
      });
      continue;
    }
    if (isWorktreeConnectorSource(parentNode.commit)) {
      pushConnectorDecision({
        id: `${parentNode.commit.id}->${childNode.commit.id}`,
        kind: 'ancestry',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'worktree nodes have no outgoing connectors',
      });
      continue;
    }
    const key = `${commit.branchName}:${parentNode.commit.visualId ?? parentNode.commit.id}->${childNode.commit.visualId}`;
    if (connectorKeySet.has(key)) {
      addNodeWarning(parentNode.commit.id, 'Duplicate connector key');
      addNodeWarning(childNode.commit.id, 'Duplicate connector key');
      pushConnectorDecision({
        id: key,
        kind: 'ancestry',
        parent: parentNode.commit.id,
        child: childNode.commit.id,
        rendered: false,
        reason: 'duplicate connector key',
      });
      continue;
    }
    connectorKeySet.add(key);
    connectorParentShas.add(parentNode.commit.id);
    const isBranching = isConnectorBranching(parentNode, childNode);
    const anchors = computeParentChildConnectorAnchors(isHorizontal, false, parentNode, childNode);
    connectors.push({
      id: key,
      fromX: anchors.fromX,
      fromY: anchors.fromY,
      toX: anchors.toX,
      toY: anchors.toY,
      fromFace: anchors.fromFace,
      toFace: anchors.toFace,
      zIndex: branchConnectorZIndex(childNode.commit.branchName),
      fromCommitVisualId: parentNode.commit.visualId,
      toCommitVisualId: childNode.commit.visualId,
      useBranchFeedAnchors: false,
      connectorEdgeKind: 'ancestry',
    });
    pushConnectorDecision({
      id: key,
      kind: 'ancestry',
      parent: parentNode.commit.id,
      child: childNode.commit.id,
      rendered: true,
      reason: isBranching ? 'ancestry connector rendered' : isHorizontal ? 'horizontal ancestry rendered' : 'vertical ancestry rendered',
    });
    commitIdsWithRenderedAncestry.add(parentNode.commit.id);
    commitIdsWithRenderedAncestry.add(childNode.commit.id);
  }

  // Debug outputs
  const resolveCommitLabel = (sha: string | null | undefined): string => {
    if (!sha) return 'none';
    const resolved = Array.from(commitById.values()).find(
      (commit) => shasMatch(commit.id, sha) || shasMatch(commit.id.slice(0, 7), sha) || shasMatch(sha, commit.id),
    );
    if (!resolved) return sha.slice(0, 7);
    return `${resolved.id.slice(0, 7)} ${resolved.branchName}`;
  };

  const debugRows = isDebugOpen
    ? [
        'Lane rows (expected):',
        ...[...laneByName.values()]
          .sort((a, b) => a.column - b.column || a.name.localeCompare(b.name))
          .map((lane) => `  row=${lane.column} branch=${lane.name} parent=${lane.parentName ?? 'none'}`),
        '',
        ...branches.flatMap((branch) => {
          const previews = branchCommitPreviews[branch.name] ?? [];
          const concretePreviews = [...(branchPreviewSets.get(branch.name) ?? [])].reverse();
          const renderedPreviewIds = new Set((branchCommitsByLane.get(branch.name) ?? []).map((commit) => commit.id));
          const childCommit = concretePreviews.find((commit) => !commit.parentSha || !concretePreviews.some((candidate) => shasMatch(candidate.fullSha, commit.parentSha ?? ''))) ?? concretePreviews[0] ?? null;
          const parentCommitSha = childCommit?.parentSha ?? branchStartParentShaByName.get(branch.name) ?? null;
          return [
            `Branch ${branch.name}`,
            `  ahead=${branchUniqueAheadCounts[branch.name] ?? 0} previews=${concretePreviews.length} rendered=${renderedPreviewIds.size}`,
            `  db parent commit=${resolveCommitLabel(parentCommitSha)}`,
            `  db child commit=${childCommit ? `${childCommit.fullSha.slice(0, 7)} ${branch.name}` : 'none'}`,
            ...concretePreviews.map((commit) => {
              const status = renderedPreviewIds.has(commit.fullSha) ? 'visible' : 'hidden';
              const reason = renderedPreviewIds.has(commit.fullSha) ? 'kept by render set' : 'dropped by render set';
              return `  ${status} ${commit.fullSha.slice(0, 7)} ${commit.message} [${reason}]`;
            }),
            previews.length === 0 ? '  no preview data' : null,
          ].filter((line): line is string => line != null);
        }),
      ]
    : [];

  const branchDebugRows = isDebugOpen
    ? Array.from(branchCommitsByLane.entries()).map(([branchName, commits]) => {
        return [
          `Branch debug ${branchName}`,
          ...commits.map((commit) => `  ${commit.id.slice(0, 7)} ${commit.message}`),
        ].join('\n');
      })
    : [];

  return {
    branchByName,
    laneByName,
    mainCommits,
    branchCommitsByLane,
    branchPreviewSets,
    allCommits,
    clustersByBranch,
    clusterKeyByCommitId,
    clusterKeyBySha,
    leadByClusterKey,
    firstByClusterKey,
    clusterCounts,
    debugRows,
    branchDebugRows,
    nodes,
    normalizedSearchQuery,
    matchingNodes,
    matchingNodeIds,
    focusedNode,
    checkedOutClusterKey,
    defaultCollapsedClumps,
    visibleCommitsList,
    renderNodes,
    visibleNodesBySha,
    visibleNodeByClusterKey,
    pointFormatter,
    contentWidth,
    contentHeight,
    connectors,
    mergeConnectors,
    connectorDecisions,
    nodeWarnings,
    connectorParentShas,
    branchStartShas,
    branchOffNodeShas,
    crossBranchOutgoingShas,
    commitIdsWithRenderedAncestry,
    branchBaseCommitByName,
    firstBranchCommitByName,
    mergeDestinations,
    mergeTargetBranchesBySourceBranchAndCommitSha,
  };
}

// Struct-level cache keyed by graph fingerprint and requested grid positions.
const baseLayoutCache = new Map<string, BaseLayoutModel>();
const MAX_CACHE_SIZE = 5;

const getBaseLayoutCacheKey = (input: BranchGridLayoutInput): string => {
  const overridesKey = input.nodePositionOverrides ? JSON.stringify(input.nodePositionOverrides) : '';
  const graphKey = input.graphLayoutSignature ?? '';
  const fallbackKey = generateFallbackGraphSignature(input);
  return `${graphKey}::${fallbackKey}::horizontal::${overridesKey}`;
};

const generateFallbackGraphSignature = (input: BranchGridLayoutInput): string => {
  const branchSig = input.branches.map(b => `${b.name}:${b.headSha}`).join('|');
  const commitSig = input.directCommits.map(c => `${c.fullSha}:${c.author}:${c.date}`).join('|');
  const unpushedSig = (input.unpushedDirectCommits ?? []).map(c => `${c.fullSha}:${c.author}:${c.date}`).join('|');
  const previewSig = Object.entries(input.branchCommitPreviews)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([branchName, previews]) =>
      `${branchName}:${previews.map((preview) => `${preview.fullSha}:${preview.parentSha ?? ''}:${preview.kind ?? ''}:${preview.date}`).join(',')}`,
    )
    .join('|');
  const checkoutSig = `${input.checkedOutRef?.branchName ?? ''}:${input.checkedOutRef?.headSha ?? ''}:${input.checkedOutRef?.hasUncommittedChanges ? 'dirty' : 'clean'}`;
  const worktreeSig = (input.worktreeSessions ?? [])
    .map((session) => `${session.workingTreeId}:${session.branchName ?? ''}:${session.headSha}:${session.parentSha ?? ''}:${session.isCurrent ? 'current' : 'linked'}:${session.hasUncommittedChanges ? 'dirty' : 'clean'}`)
    .join('|');
  return `${branchSig}::${commitSig}::${unpushedSig}::${previewSig}::${checkoutSig}::${worktreeSig}`;
};

const setCachedBaseLayout = (key: string, model: BaseLayoutModel) => {
  if (baseLayoutCache.size >= MAX_CACHE_SIZE) {
    const firstKey = baseLayoutCache.keys().next().value;
    if (firstKey !== undefined) {
      baseLayoutCache.delete(firstKey);
    }
  }
  baseLayoutCache.set(key, model);
};

export function computeBranchGridLayout(input: BranchGridLayoutInput): BranchGridLayoutModel {
  const cacheKey = getBaseLayoutCacheKey(input);
  let baseModel = baseLayoutCache.get(cacheKey);
  if (!baseModel) {
    baseModel = computeBaseLayout(input);
    setCachedBaseLayout(cacheKey, baseModel);
  }
  return projectVisibility(
    baseModel,
    input.manuallyOpenedClumps,
    input.manuallyClosedClumps,
    input.gridSearchQuery,
    input.gridFocusSha,
  );
}
