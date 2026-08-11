import { describe, expect, it } from 'vitest';
import type { Branch, DirectCommit } from '../../types';
import type { BranchGridLayoutInput } from './branchGridLayoutModel';
import {
  buildProgressiveBranchGridLayoutStages,
  estimateBranchGridLayoutItems,
  progressiveBranchGridLayoutLimits,
  sliceBranchGridLayoutInput,
} from './progressiveBranchGridLayout';

const branch = (name: string, index: number): Branch => ({
  name,
  commitsAhead: index,
  commitsBehind: 0,
  lastCommitDate: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  lastCommitAuthor: 'Test',
  status: 'fresh',
  remoteSyncStatus: 'local-only',
  unpushedCommits: 0,
  headSha: `sha-${index}`,
});

const commit = (index: number, branchName: string): DirectCommit => ({
  fullSha: `sha-${index}`,
  sha: `sha-${index}`,
  parentSha: index > 0 ? `sha-${index - 1}` : null,
  parentShas: index > 0 ? [`sha-${index - 1}`] : [],
  branch: branchName,
  message: `Commit ${index}`,
  author: 'Test',
  date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
});

const inputWithSize = (branchCount: number, commitCount: number): BranchGridLayoutInput => {
  const branches = Array.from({ length: branchCount }, (_, index) => branch(index === 0 ? 'main' : `branch-${index}`, index));
  const directCommits = Array.from(
    { length: commitCount },
    (_, index) => commit(index, index === 0 ? 'main' : `branch-${(index % Math.max(1, branchCount - 1)) + 1}`),
  );
  return {
    branches,
    mergeNodes: [],
    directCommits,
    unpushedDirectCommits: [],
    unpushedCommitShasByBranch: {},
    defaultBranch: 'main',
    branchCommitPreviews: {},
    branchParentByName: {},
    branchUniqueAheadCounts: {},
    manuallyOpenedClumps: new Set(),
    manuallyClosedClumps: new Set(),
    isDebugOpen: false,
    gridSearchQuery: '',
    gridFocusSha: null,
    checkedOutRef: null,
    worktreeSessions: [],
    orientation: 'vertical',
    nodePositionOverrides: {},
    graphLayoutSignature: 'test',
  };
};

describe('progressive branch grid layout', () => {
  it('uses monotonic bounded stages and ends with the exact full input', () => {
    const input = inputWithSize(1_000, 19_000);
    const stages = buildProgressiveBranchGridLayoutStages(input);

    expect(stages.map((stage) => stage.processedItems)).toEqual([
      500,
      1_500,
      3_500,
      7_000,
      12_000,
      20_000,
    ]);
    expect(stages.at(-1)?.input).toBe(input);
    expect(stages.at(-1)?.complete).toBe(true);
    expect(stages.slice(0, -1).every((stage) => !stage.complete)).toBe(true);
  });

  it('keeps the default, checked-out, and worktree branches in the first stage', () => {
    const input = inputWithSize(800, 2_000);
    input.checkedOutRef = {
      branchName: 'branch-700',
      headSha: 'sha-700',
      parentSha: 'sha-699',
      hasUncommittedChanges: false,
    };
    input.worktreeSessions = [{
      path: '/tmp/worktree',
      pathExists: true,
      branchName: 'branch-650',
      headSha: 'sha-650',
      parentSha: 'sha-649',
      hasUncommittedChanges: false,
      isCurrent: false,
      accentToken: 'worktree-rose',
      workingTreeId: 'WORKING_TREE:test',
    }];

    const partial = sliceBranchGridLayoutInput(input, 500);
    const names = new Set(partial.branches.map((candidate) => candidate.name));
    const shas = new Set(partial.directCommits.map((candidate) => candidate.fullSha));

    expect(names).toContain('main');
    expect(names).toContain('branch-700');
    expect(names).toContain('branch-650');
    expect(shas).toContain('sha-700');
    expect(shas).toContain('sha-650');
    expect(estimateBranchGridLayoutItems(partial)).toBeLessThanOrEqual(500);
  });

  it('does not add progressive stages for a small map', () => {
    const input = inputWithSize(10, 100);
    const stages = buildProgressiveBranchGridLayoutStages(input);

    expect(progressiveBranchGridLayoutLimits(110)).toEqual([110]);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.input).toBe(input);
    expect(stages[0]?.complete).toBe(true);
  });

  it('keeps earlier branch and commit selections while the map expands', () => {
    const input = inputWithSize(2_000, 8_000);
    const small = sliceBranchGridLayoutInput(input, 500);
    const large = sliceBranchGridLayoutInput(input, 1_500);
    const largeBranchNames = new Set(large.branches.map((candidate) => candidate.name));
    const largeCommitShas = new Set(large.directCommits.map((candidate) => candidate.fullSha));

    expect(small.branches.every((candidate) => largeBranchNames.has(candidate.name))).toBe(true);
    expect(small.directCommits.every((candidate) => largeCommitShas.has(candidate.fullSha))).toBe(true);
  });
});
