import { describe, expect, it } from 'vitest';
import type { BranchGridLayoutModel } from './branchGridLayoutModel';
import { layoutModelMatchesManualClumpState } from './useBranchGridLayoutFromRevision';

const CLUSTER_KEY = 'cluster:feature:segment:1';

function modelWithRenderedMembers(renderedMemberCount: number): BranchGridLayoutModel {
  const visualIds = ['feature:a', 'feature:b', 'feature:c'];
  return {
    clusterCounts: new Map([[CLUSTER_KEY, visualIds.length]]),
    clusterKeyByCommitId: new Map(visualIds.map((visualId) => [visualId, CLUSTER_KEY])),
    renderNodes: visualIds.slice(0, renderedMemberCount).map((visualId) => ({
      commit: { visualId },
    })),
  } as BranchGridLayoutModel;
}

describe('layoutModelMatchesManualClumpState', () => {
  it('rejects an open cached model for a manually closed clump', () => {
    expect(layoutModelMatchesManualClumpState(
      modelWithRenderedMembers(3),
      new Set(),
      new Set([CLUSTER_KEY]),
    )).toBe(false);
  });

  it('accepts a collapsed cached model for a manually closed clump', () => {
    expect(layoutModelMatchesManualClumpState(
      modelWithRenderedMembers(1),
      new Set(),
      new Set([CLUSTER_KEY]),
    )).toBe(true);
  });

  it('rejects a collapsed cached model for a manually opened clump', () => {
    expect(layoutModelMatchesManualClumpState(
      modelWithRenderedMembers(1),
      new Set([CLUSTER_KEY]),
      new Set(),
    )).toBe(false);
  });
});
