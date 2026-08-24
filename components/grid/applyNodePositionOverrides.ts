import type { Node, NodePositionOverrides, VisualCommit } from './LayoutGrid';
import { getNodePositionOverride } from './nodePositionOverrides';

export type ApplyNodePositionOverridesInput = {
  renderNodes: Node[];
  allCommitsWithClusters: VisualCommit[];
  clusterKeyByCommitId: Map<string, string>;
  leadByClusterKey: Map<string, string>;
  rowByVisualId: Map<string, number>;
  overrides: NodePositionOverrides;
  isHorizontal: boolean;
  zoomAwareTimelinePitch: number;
  timelineRowLeadOffset?: number;
  zoomAwareLanePitch?: number;
  maxResolvedRow?: number;
};

type ClusterDragAnchor = {
  node: Node;
  originalRow: number;
  originalColumn: number;
};

const layoutIndicesForLogicalOverride = (
  override: NodePositionOverrides[string],
): { row: number; column: number } | null => {
  if (!Number.isFinite(override?.row) || !Number.isFinite(override?.column)) return null;
  return {
    row: Math.max(1, Math.round(override.row!)),
    column: Math.max(0, Math.round(override.column!)),
  };
};

/**
 * Applies persisted drag positions. Collapsed clumps inherit the override from the member
 * on the highest timeline row (newest in layout order); non-lead members offset from the lead.
 * Returns the visual ids whose position came from a direct or inherited override.
 */
export const applyNodePositionOverrides = ({
  renderNodes,
  allCommitsWithClusters,
  clusterKeyByCommitId,
  leadByClusterKey,
  rowByVisualId,
  overrides,
  isHorizontal: _isHorizontal,
}: ApplyNodePositionOverridesInput): Set<string> => {
  const pinnedNodeVisualIds = new Set<string>();
  const bestOverrideByClusterKey = new Map<string, { override: NodePositionOverrides[string]; row: number }>();
  const renderedCountByClusterKey = new Map<string, number>();
  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey) continue;
    renderedCountByClusterKey.set(clusterKey, (renderedCountByClusterKey.get(clusterKey) ?? 0) + 1);
  }

  const clusterCounts = new Map<string, number>();
  for (const commit of allCommitsWithClusters) {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (clusterKey) {
      clusterCounts.set(clusterKey, (clusterCounts.get(clusterKey) ?? 0) + 1);
    }
  }

  const isClusterCollapsed = (clusterKey: string): boolean => {
    const count = clusterCounts.get(clusterKey) ?? 0;
    const rendered = renderedCountByClusterKey.get(clusterKey) ?? 0;
    return count > 1 && rendered === 1;
  };

  for (const commit of allCommitsWithClusters) {
    const clusterKey = clusterKeyByCommitId.get(commit.visualId);
    if (!clusterKey) continue;
    const override = getNodePositionOverride(overrides, commit);
    if (!override) continue;
    if (override.isMigratedWorktree && isClusterCollapsed(clusterKey)) {
      continue;
    }
    const row = rowByVisualId.get(commit.visualId) ?? 0;
    const current = bestOverrideByClusterKey.get(clusterKey);
    if (!current || row > current.row) {
      bestOverrideByClusterKey.set(clusterKey, { override, row });
    }
  }

  const clusterDragAnchorByKey = new Map<string, ClusterDragAnchor>();
  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey) continue;
    if (leadByClusterKey.get(clusterKey) !== node.commit.visualId) continue;
    let directOverride = getNodePositionOverride(overrides, node.commit);
    if (directOverride?.isMigratedWorktree && isClusterCollapsed(clusterKey)) {
      directOverride = undefined;
    }
    if (directOverride) {
      const indices = layoutIndicesForLogicalOverride(directOverride);
      if (!indices) continue;
      const originalRow = node.row;
      const originalColumn = node.column;
      node.row = indices.row;
      node.column = indices.column;
      clusterDragAnchorByKey.set(clusterKey, { node, originalRow, originalColumn });
      pinnedNodeVisualIds.add(node.commit.visualId);
      continue;
    }
    const inherited = bestOverrideByClusterKey.get(clusterKey);
    if ((renderedCountByClusterKey.get(clusterKey) ?? 0) > 1) continue;
    if (!inherited) continue;
    const indices = layoutIndicesForLogicalOverride(inherited.override);
    if (!indices) continue;
    const originalRow = node.row;
    const originalColumn = node.column;
    node.row = indices.row;
    node.column = indices.column;
    clusterDragAnchorByKey.set(clusterKey, { node, originalRow, originalColumn });
    pinnedNodeVisualIds.add(node.commit.visualId);
  }

  for (const node of renderNodes) {
    const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
    let override = getNodePositionOverride(overrides, node.commit);
    if (override?.isMigratedWorktree && clusterKey && isClusterCollapsed(clusterKey)) {
      override = undefined;
    }
    if (override) {
      const indices = layoutIndicesForLogicalOverride(override);
      if (!indices) continue;
      node.row = indices.row;
      node.column = indices.column;
      pinnedNodeVisualIds.add(node.commit.visualId);
      continue;
    }
    const anchor = clusterKey ? clusterDragAnchorByKey.get(clusterKey) : null;
    if (!anchor) continue;
    if (anchor.node.commit.visualId === node.commit.visualId) continue;
    node.row += anchor.node.row - anchor.originalRow;
    node.column += anchor.node.column - anchor.originalColumn;
  }

  return pinnedNodeVisualIds;
};
