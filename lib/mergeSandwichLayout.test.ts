import { describe, expect, it } from 'vitest';
import type { Branch } from '../types';
import { computeBranchGridLayout } from '../components/grid/branchGridLayoutModel';

/**
 * Reproduces the sandwich bug: main/452ea41 merge between main/e11ecda and worktree-agents/5d65b8a.
 * Merge metadata often lists only parentSha on the main commit; the merged branch tip must still
 * constrain layout via mergeNodes / mergeDestinations.
 */
describe('merge sandwich row layout', () => {
  const defaultBranch = 'main';
  const rootSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const mainParentSha = 'e11ecda1111111111111111111111111111111111';
  const worktreeMiddleSha = '71ceed3777777777777777777777777777777777';
  const mergedSha = '5d65b8a5555555555555555555555555555555555';
  const mergeSha = '452ea414444444444444444444444444444444444';
  const stashId = 'Stash 2';

  const makeBranch = (name: string, headSha: string, commitsAhead: number): Branch => ({
    name,
    commitsAhead,
    commitsBehind: 0,
    lastCommitDate: '2024-06-15T12:00:00Z',
    lastCommitAuthor: 'test',
    status: 'fresh',
    remoteSyncStatus: 'local-only',
    unpushedCommits: 0,
    headSha,
    parentBranch: defaultBranch,
    divergedFromSha: mainParentSha,
  });

  const buildLayout = (mergeParentShasOnDirectCommit: string[]) =>
    computeBranchGridLayout({
      branches: [
        makeBranch(defaultBranch, mergeSha, 3),
        makeBranch('worktree-agents', mergedSha, 2),
        {
          ...makeBranch('Stash 2', stashId, 1),
          parentBranch: defaultBranch,
        },
      ],
      mergeNodes: [
        {
          sha: mergeSha.slice(0, 7),
          fullSha: mergeSha,
          prNumber: null,
          prTitle: null,
          date: '2024-06-15T12:00:00Z',
          parentShas: [mainParentSha, mergedSha],
          targetBranch: defaultBranch,
          targetCommitSha: mainParentSha,
        },
      ],
      directCommits: [
        {
          fullSha: rootSha,
          sha: rootSha.slice(0, 7),
          branch: defaultBranch,
          message: 'root',
          author: 'test',
          date: '2024-05-01T12:00:00Z',
          parentSha: null,
          parentShas: [],
        },
        {
          fullSha: mainParentSha,
          sha: mainParentSha.slice(0, 7),
          branch: defaultBranch,
          message: 'Improve branch parent resolution',
          author: 'test',
          date: '2024-06-01T12:00:00Z',
          parentSha: rootSha,
          parentShas: [rootSha],
        },
        {
          fullSha: worktreeMiddleSha,
          sha: worktreeMiddleSha.slice(0, 7),
          branch: 'worktree-agents',
          message: 'Fix empty-branch placeholder',
          author: 'test',
          date: '2024-06-05T12:00:00Z',
          parentSha: mainParentSha,
          parentShas: [mainParentSha],
        },
        {
          fullSha: mergedSha,
          sha: mergedSha.slice(0, 7),
          branch: 'worktree-agents',
          message: 'Remove water-ripple worktree',
          author: 'test',
          date: '2024-06-10T12:00:00Z',
          parentSha: worktreeMiddleSha,
          parentShas: [worktreeMiddleSha],
        },
        {
          fullSha: mergeSha,
          sha: mergeSha.slice(0, 7),
          branch: defaultBranch,
          message: "Merge commit '5d65b8a8021'",
          author: 'test',
          date: '2024-06-15T12:00:00Z',
          parentSha: mergeParentShasOnDirectCommit[0] ?? mainParentSha,
          parentShas: mergeParentShasOnDirectCommit,
        },
        {
          fullSha: mergedSha,
          sha: mergedSha.slice(0, 7),
          branch: defaultBranch,
          message: 'Remove water-ripple worktree (main copy)',
          author: 'test',
          date: '2024-06-10T12:00:00Z',
          parentSha: mainParentSha,
          parentShas: [mainParentSha],
        },
      ],
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [],
        'worktree-agents': [],
        'Stash 2': [
          {
            fullSha: stashId,
            sha: stashId,
            parentSha: mainParentSha,
            message: 'Refactor tile pattern layout',
            author: 'You',
            date: '2024-06-03T12:00:00Z',
            kind: 'stash',
          },
        ],
      },
      branchParentByName: { main: null, 'worktree-agents': defaultBranch, 'Stash 2': defaultBranch },
      branchUniqueAheadCounts: { main: 3, 'worktree-agents': 2, 'Stash 2': 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

  const assertMergeAfterBothParents = (layout: ReturnType<typeof computeBranchGridLayout>) => {
    const mergeNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === mergeSha,
    );
    const mainParentNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === mainParentSha,
    );
    const worktreeParentNode = layout.renderNodes.find(
      (node) => node.commit.branchName === 'worktree-agents' && node.commit.id === mergedSha,
    );
    expect(mergeNode).toBeDefined();
    expect(mainParentNode).toBeDefined();
    expect(worktreeParentNode).toBeDefined();

    const latestParentRow = Math.max(mainParentNode!.row, worktreeParentNode!.row);
    expect(mergeNode!.row).toBeGreaterThan(latestParentRow);
    expect(mergeNode!.row).toBeGreaterThan(mainParentNode!.row);
    expect(mergeNode!.row).toBeGreaterThan(worktreeParentNode!.row);

    const latestParentColumn = Math.max(mainParentNode!.column, worktreeParentNode!.column);
    expect(mergeNode!.column).toBeGreaterThan(latestParentColumn);
    expect(
      layout.renderNodes.filter(
        (node) => node.column === mergeNode!.column && node.commit.visualId !== mergeNode!.commit.visualId,
      ),
    ).toHaveLength(0);
    expect(
      layout.renderNodes.filter(
        (node) =>
          node.column === worktreeParentNode!.column
          && node.commit.visualId !== worktreeParentNode!.commit.visualId,
      ),
    ).toHaveLength(0);
    expect(mergeNode!.row).toBeGreaterThan(latestParentRow);

    const usedColumns = [...new Set(layout.renderNodes.map((node) => node.column))].sort((a, b) => a - b);
    expect(usedColumns).toEqual(usedColumns.map((_, index) => index));

    const worktreeMiddleNode = layout.renderNodes.find(
      (node) => node.commit.branchName === 'worktree-agents' && node.commit.id === worktreeMiddleSha,
    );
    if (worktreeMiddleNode) {
      expect(mergeNode!.row).not.toBe(worktreeMiddleNode.row);
    }
  };

  it('places merge after both parents when direct commit lists full parentShas', () => {
    assertMergeAfterBothParents(buildLayout([mainParentSha, mergedSha]));
  });

  it('places merge after both parents when direct commit only has first parentSha (mergeNodes supply the rest)', () => {
    assertMergeAfterBothParents(buildLayout([mainParentSha]));
  });
});
