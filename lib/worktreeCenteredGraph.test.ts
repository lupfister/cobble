import { describe, expect, it } from 'vitest';
import type { Branch, DirectCommit } from '../types';
import { buildWorktreeCenteredGraph } from './worktreeCenteredGraph';

const commit = (fullSha: string, parentSha: string | null, branch: string): DirectCommit => ({
  fullSha,
  sha: fullSha,
  parentSha,
  parentShas: parentSha ? [parentSha] : [],
  childShas: [],
  branch,
  message: fullSha,
  author: 'Luca',
  date: '2026-08-24T00:00:00.000Z',
  kind: 'commit',
});

const branch = (name: string, headSha: string, extra: Partial<Branch> = {}): Branch => ({
  name,
  headSha,
  commitsAhead: 1,
  commitsBehind: 0,
  lastCommitDate: '2026-08-24T00:00:00.000Z',
  lastCommitAuthor: 'Luca',
  status: 'fresh',
  remoteSyncStatus: 'local-only',
  unpushedCommits: 0,
  ...extra,
});

describe('buildWorktreeCenteredGraph', () => {
  it('keeps heads and a non-head fork point, then reconnects the compressed lineage', () => {
    const commits = [
      commit('D', 'C', 'main'),
      commit('C', 'B', 'main'),
      commit('B', 'A', 'main'),
      commit('A', null, 'main'),
      commit('F', 'E', 'feature'),
      commit('E', 'B', 'feature'),
    ];
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'D'),
        branch('feature', 'F', { parentBranch: 'main', divergedFromSha: 'B' }),
      ],
      worktreeBranchNames: ['feature'],
      directCommits: commits,
      unpushedDirectCommits: [],
      branchCommitPreviews: { main: [], feature: [] },
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: { main: 4, feature: 2 },
    });

    expect(result.directCommits.map((item) => item.fullSha)).toEqual(['D', 'B', 'F']);
    expect(result.directCommits.find((item) => item.fullSha === 'D')?.parentSha).toBe('B');
    expect(result.directCommits.find((item) => item.fullSha === 'F')?.parentSha).toBe('B');
  });

  it('uses only heads when a branch begins at its parent head', () => {
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'D'),
        branch('feature', 'F', { parentBranch: 'main', divergedFromSha: 'D' }),
      ],
      worktreeBranchNames: ['feature'],
      directCommits: [commit('D', 'C', 'main'), commit('C', null, 'main'), commit('F', 'D', 'feature')],
      unpushedDirectCommits: [],
      branchCommitPreviews: {},
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.directCommits.map((item) => item.fullSha)).toEqual(['D', 'F']);
  });

  it('always retains working-tree and stash states', () => {
    const workingTree = { ...commit('working-tree:feature', 'F', 'feature'), kind: 'uncommitted' as const };
    const stash = { ...commit('stash:0', 'F', 'feature'), kind: 'stash' as const };
    const result = buildWorktreeCenteredGraph({
      branches: [branch('main', 'D'), branch('feature', 'F', { parentBranch: 'main' })],
      worktreeBranchNames: ['feature'],
      directCommits: [commit('D', null, 'main'), commit('F', 'D', 'feature'), workingTree, stash],
      unpushedDirectCommits: [],
      branchCommitPreviews: {},
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.directCommits.map((item) => item.fullSha)).toContain('working-tree:feature');
    expect(result.directCommits.map((item) => item.fullSha)).toContain('stash:0');
  });

  it('keeps the real branch head beneath a dirty worktree synthetic head', () => {
    const dirtyWorktree = {
      ...commit('working-tree:feature', 'FEATURE_HEAD', 'feature'),
      kind: 'uncommitted' as const,
    };
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'MAIN_HEAD'),
        branch('feature', 'working-tree:feature', {
          parentBranch: 'main',
          divergedFromSha: 'MAIN_HEAD',
        }),
      ],
      worktreeBranchNames: ['feature'],
      directCommits: [
        commit('MAIN_HEAD', null, 'main'),
        commit('FEATURE_HEAD', 'MAIN_HEAD', 'feature'),
      ],
      unpushedDirectCommits: [],
      branchCommitPreviews: { feature: [dirtyWorktree] },
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.directCommits.map((item) => item.fullSha)).toEqual(['MAIN_HEAD', 'FEATURE_HEAD']);
    expect(result.branchCommitPreviews.feature?.[0]?.parentSha).toBe('FEATURE_HEAD');
  });

  it('excludes branches that have no worktree and are not part of worktree provenance', () => {
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'D'),
        branch('feature', 'F', { parentBranch: 'main', divergedFromSha: 'D' }),
        branch('unused', 'U', { parentBranch: 'main', divergedFromSha: 'D' }),
      ],
      worktreeBranchNames: ['feature'],
      directCommits: [commit('D', null, 'main'), commit('F', 'D', 'feature'), commit('U', 'D', 'unused')],
      unpushedDirectCommits: [],
      branchCommitPreviews: {},
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.branches.map((item) => item.name)).toEqual(['main', 'feature']);
    expect(result.directCommits.map((item) => item.fullSha)).toEqual(['D', 'F']);
  });

  it('keeps an intermediate branch when it explains a worktree branch provenance chain', () => {
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'D'),
        branch('feature', 'F', { parentBranch: 'main', divergedFromSha: 'D' }),
        branch('experiment', 'X', { parentBranch: 'feature', divergedFromSha: 'F' }),
      ],
      worktreeBranchNames: ['experiment'],
      directCommits: [commit('D', null, 'main'), commit('F', 'D', 'feature'), commit('X', 'F', 'experiment')],
      unpushedDirectCommits: [],
      branchCommitPreviews: {},
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.branches.map((item) => item.name)).toEqual(['main', 'feature', 'experiment']);
  });

  it('always shows the latest main head beside older worktree provenance', () => {
    const result = buildWorktreeCenteredGraph({
      branches: [
        branch('main', 'LATEST_MAIN'),
        branch('feature', 'FEATURE_HEAD', { parentBranch: 'main', divergedFromSha: 'OLD_MAIN' }),
      ],
      worktreeBranchNames: ['feature'],
      directCommits: [
        commit('LATEST_MAIN', 'NEWER_MAIN', 'main'),
        commit('NEWER_MAIN', 'OLD_MAIN', 'main'),
        commit('OLD_MAIN', null, 'main'),
        commit('FEATURE_HEAD', 'OLD_MAIN', 'feature'),
      ],
      unpushedDirectCommits: [],
      branchCommitPreviews: {},
      mergeNodes: [],
      defaultBranch: 'main',
      branchUniqueAheadCounts: {},
    });

    expect(result.directCommits.map((item) => item.fullSha)).toEqual([
      'LATEST_MAIN',
      'OLD_MAIN',
      'FEATURE_HEAD',
    ]);
    expect(result.directCommits.find((item) => item.fullSha === 'LATEST_MAIN')?.parentSha).toBe('OLD_MAIN');
  });
});
