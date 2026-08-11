import { describe, expect, it } from 'vitest';
import type { Branch, DirectCommit, BranchCommitPreview } from '../../types';
import { ROW_GAP, ROW_HEIGHT, TOP_PADDING, type NodePositionOverrides } from './LayoutGrid';
import { computeBranchGridLayout, GRID_LAYOUT_RENDER_ZOOM } from './branchGridLayoutModel';
import { assignNodePositionOverride, getStableNodePositionKey } from './nodePositionOverrides';

const mainSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tipSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const makeBranch = (name: string, headSha: string, commitsAhead: number, parentBranch?: string): Branch => ({
  name,
  commitsAhead,
  commitsBehind: 0,
  lastCommitDate: '2024-06-01T12:00:00Z',
  lastCommitAuthor: 'test',
  status: 'fresh',
  remoteSyncStatus: 'local-only',
  unpushedCommits: 0,
  headSha,
  parentBranch: parentBranch ?? 'main',
  divergedFromSha: mainSha,
});

describe('computeBranchGridLayout empty branch placeholders', () => {
  it('does not render inherited stale previews on a newer branch', () => {
    const mainSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const branchASha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        parentSha: null,
        parentShas: [],
        childShas: [branchASha],
        clusterKey: null,
        branch: 'main',
        message: 'Base',
        author: 'Test',
        date: '2024-01-01T00:00:00Z',
      },
      {
        fullSha: branchASha,
        sha: branchASha.slice(0, 7),
        parentSha: mainSha,
        parentShas: [mainSha],
        childShas: [],
        clusterKey: null,
        branch: 'branch-a',
        message: 'Branch A work',
        author: 'Test',
        date: '2024-01-02T00:00:00Z',
      },
    ];
    const branches: Branch[] = [
      makeBranch('branch-a', branchASha, 1, 'main'),
      makeBranch('branch-b', branchASha, 0, 'branch-a'),
    ];
    branches[0]!.divergedFromSha = mainSha;
    branches[1]!.divergedFromSha = branchASha;

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch: 'main',
      branchCommitPreviews: {
        main: [],
        'branch-a': [{
          ...directCommits[1]!,
          kind: 'commit',
        }],
        'branch-b': [{
          ...directCommits[1]!,
          kind: 'commit',
        }],
      },
      branchParentByName: { 'branch-a': 'main', 'branch-b': 'branch-a' },
      branchUniqueAheadCounts: { main: 1, 'branch-a': 1, 'branch-b': 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
    });

    expect(layout.renderNodes.some((node) => node.commit.visualId === `branch-a:${branchASha}`)).toBe(true);
    expect(layout.renderNodes.some((node) => node.commit.visualId === `branch-b:${branchASha}`)).toBe(false);
  });

  it('ignores stale branch previews when branch has no unique commits', () => {
    const defaultBranch = 'main';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('deleted-feature-stale', tipSha, 0),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'ff merged work',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [],
        'deleted-feature-stale': [{
          fullSha: tipSha,
          sha: tipSha.slice(0, 7),
          message: 'stale feature preview',
          author: 'test',
          date: '2024-06-01T12:00:00Z',
          parentSha: mainSha,
          parentShas: [mainSha],
          childShas: [],
          kind: 'commit',
        }],
      },
      branchParentByName: { main: null, 'deleted-feature-stale': 'main' },
      branchUniqueAheadCounts: { main: 1, 'deleted-feature-stale': 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    expect(layout.renderNodes.some((node) =>
      node.commit.branchName === 'deleted-feature-stale' && node.commit.id === tipSha,
    )).toBe(false);
    expect(layout.renderNodes.some((node) =>
      node.commit.branchName === defaultBranch && node.commit.id === tipSha,
    )).toBe(true);
  });

  it('places BRANCH_HEAD one row ahead and one lane below the fork parent', () => {
    const defaultBranch = 'main';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('cursor-sdk', tipSha, 0),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const branchCommitPreviews = { main: [], 'cursor-sdk': [] };
    const branchUniqueAheadCounts = { main: 1, 'cursor-sdk': 0 };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: { main: null, 'cursor-sdk': 'main' },
      branchUniqueAheadCounts,
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const placeholderNode = layout.renderNodes.find((node) =>
      node.commit.id.startsWith('BRANCH_HEAD:cursor-sdk:'),
    );
    expect(placeholderNode).toBeDefined();

    const forkParentNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === mainSha,
    );
    expect(forkParentNode).toBeDefined();
    expect(placeholderNode!.row).toBeGreaterThan(forkParentNode!.row);
    expect(placeholderNode!.column).toBeGreaterThan(forkParentNode!.column);
    const sameSlot = layout.renderNodes.filter(
      (node) => node.row === placeholderNode!.row && node.column === placeholderNode!.column,
    );
    expect(sameSlot).toHaveLength(1);
    expect(placeholderNode!.commit.date).toBe(forkParentNode!.commit.date);
  });

  it('aligns placeholder with fork parent row when branch tip is an older commit', () => {
    const defaultBranch = 'main';
    const oldSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const branches = [
      makeBranch(defaultBranch, tipSha, 2),
      makeBranch('worktree-agents', oldSha, 0),
    ];
    branches[1]!.divergedFromSha = mainSha;
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: oldSha,
        sha: oldSha.slice(0, 7),
        branch: defaultBranch,
        message: 'old',
        author: 'test',
        date: '2024-05-15T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: oldSha,
        parentShas: [oldSha],
      },
    ];
    const branchCommitPreviews = { main: [], 'worktree-agents': [] };
    const branchUniqueAheadCounts = { main: 2, 'worktree-agents': 0 };

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: { main: null, 'worktree-agents': 'main' },
      branchUniqueAheadCounts,
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const placeholderNode = layout.renderNodes.find((node) =>
      node.commit.id.startsWith('BRANCH_HEAD:worktree-agents:'),
    );
    const forkNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === mainSha,
    );
    const tipNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === tipSha,
    );
    expect(placeholderNode).toBeDefined();
    expect(forkNode).toBeDefined();
    expect(tipNode).toBeDefined();
    expect(placeholderNode!.row).toBeGreaterThan(forkNode!.row);
    expect(placeholderNode!.column).toBeGreaterThan(forkNode!.column);
    expect(tipNode!.row).toBe(placeholderNode!.row);
    expect(placeholderNode!.commit.date).toBe(forkNode!.commit.date);
  });

  it('places stash nodes one row ahead and one lane below the anchor commit', () => {
    const defaultBranch = 'main';
    const stashId = 'STASH:0';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      {
        ...makeBranch('Stash 1', stashId, 1),
        parentBranch: defaultBranch,
        divergedFromSha: mainSha,
      },
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const branchCommitPreviews: Record<string, BranchCommitPreview[]> = {
      main: [],
      'Stash 1': [
        {
          fullSha: stashId,
          sha: 'Stash 1',
          parentSha: mainSha,
          message: 'wip',
          author: 'You',
          date: '2024-05-01T12:00:00Z',
          kind: 'stash',
        },
      ],
    };
    const branchUniqueAheadCounts = { main: 1, 'Stash 1': 1 };

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: { main: null, 'Stash 1': 'main' },
      branchUniqueAheadCounts,
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const stashNode = layout.renderNodes.find((node) => node.commit.id === stashId);
    const anchorNode = layout.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === mainSha,
    );
    expect(stashNode).toBeDefined();
    expect(anchorNode).toBeDefined();
    expect(stashNode!.row).toBeGreaterThan(anchorNode!.row);
    expect(stashNode!.column).toBeGreaterThan(anchorNode!.column);
    const sameSlot = layout.renderNodes.filter(
      (node) => node.row === stashNode!.row && node.column === stashNode!.column,
    );
    expect(sameSlot).toHaveLength(1);
    const mainLineNodes = layout.renderNodes.filter(
      (node) => node.commit.branchName === defaultBranch && node.commit.kind !== 'stash',
    );
    for (const mainNode of mainLineNodes) {
      expect(mainNode.column).not.toBe(stashNode!.column);
      expect(mainNode.y).not.toBe(stashNode!.y);
    }
  });

  it('keeps open clump commits in one timeline column and distinct lanes', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const branchCommitPreviews = { main: [], feature: [] };
    const branchUniqueAheadCounts = { main: 1, feature: 3 };
    const baseInput = {
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: {
        feature: [unpushedA, unpushedB, unpushedC],
      },
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts,
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };

    const collapsed = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set<string>(),
    });
    const clusterKey = [...collapsed.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();

    const opened = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set([clusterKey!]),
    });
    const clumpNodes = opened.renderNodes.filter(
      (node) => opened.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    expect(clumpNodes.length).toBeGreaterThan(1);
    expect(new Set(clumpNodes.map((node) => node.row)).size).toBe(1);
    expect(new Set(clumpNodes.map((node) => node.column)).size).toBe(clumpNodes.length);

    const nonClumpNodeIds = (nodes: typeof collapsed.renderNodes) =>
      nodes
        .filter((node) => opened.clusterKeyByCommitId.get(node.commit.visualId) !== clusterKey)
        .map((node) => node.commit.visualId)
        .sort();
    const collapsedIds = nonClumpNodeIds(collapsed.renderNodes);
    const openedIds = nonClumpNodeIds(opened.renderNodes);
    expect(openedIds).toEqual(collapsedIds);
    const closedAgain = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set<string>(),
    });
    expect(
      closedAgain.renderNodes.map((node) => [node.commit.visualId, node.row, node.column]),
    ).toEqual(
      collapsed.renderNodes.map((node) => [node.commit.visualId, node.row, node.column]),
    );
  });

  it('assigns open clump members to contiguous columns owned by the lead', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const collapsed = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set<string>(),
      manuallyOpenedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'vertical' as const,
    });
    const clusterKey = [...collapsed.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set<string>(),
      manuallyOpenedClumps: new Set([clusterKey!]),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'vertical' as const,
    });

    expect(clusterKey).toBeDefined();
    const clumpNodes = layout.renderNodes.filter(
      (node) => layout.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    expect(clumpNodes.length).toBe(3);
    const leadVisualId = layout.leadByClusterKey.get(clusterKey!)!;
    const firstVisualId = layout.firstByClusterKey.get(clusterKey!)!;
    const leadNode = clumpNodes.find((node) => node.commit.visualId === leadVisualId);
    const firstNode = clumpNodes.find((node) => node.commit.visualId === firstVisualId);
    expect(leadNode).toBeDefined();
    expect(firstNode).toBeDefined();
    const bandStartColumn = firstNode!.column;
    const sortedColumns = [...clumpNodes].map((node) => node.column).sort((left, right) => left - right);
    expect(sortedColumns).toEqual([bandStartColumn, bandStartColumn + 1, bandStartColumn + 2]);
    expect(leadNode!.column).toBe(bandStartColumn + 2);
    expect(leadNode!.x).toBe(firstNode!.x);
  });

  it('places open horizontal clump lanes oldest at top and newest at bottom without sharing cells', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
    ];
    const baseInput = {
      branches,
      mergeNodes: [],
      directCommits: [
        {
          fullSha: mainSha,
          sha: mainSha.slice(0, 7),
          branch: defaultBranch,
          message: 'root',
          author: 'test',
          date: '2024-05-01T12:00:00Z',
          parentSha: null,
          parentShas: [],
        },
        {
          fullSha: tipSha,
          sha: tipSha.slice(0, 7),
          branch: defaultBranch,
          message: 'tip',
          author: 'test',
          date: '2024-06-02T12:00:00Z',
          parentSha: mainSha,
          parentShas: [mainSha],
        },
      ],
      unpushedDirectCommits: [
        {
          fullSha: unpushedA,
          sha: unpushedA.slice(0, 7),
          branch: 'feature',
          message: 'first',
          author: 'test',
          date: '2024-06-03T10:00:00Z',
          parentSha: tipSha,
          parentShas: [tipSha],
        },
        {
          fullSha: unpushedB,
          sha: unpushedB.slice(0, 7),
          branch: 'feature',
          message: 'second',
          author: 'test',
          date: '2024-06-03T11:00:00Z',
          parentSha: unpushedA,
          parentShas: [unpushedA],
        },
        {
          fullSha: unpushedC,
          sha: unpushedC.slice(0, 7),
          branch: 'feature',
          message: 'third',
          author: 'test',
          date: '2024-06-03T12:00:00Z',
          parentSha: unpushedB,
          parentShas: [unpushedB],
        },
      ],
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };
    const collapsed = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set<string>(),
    });
    const clusterKey = [...collapsed.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();
    const opened = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set([clusterKey!]),
    });
    const clumpNodes = opened.renderNodes.filter(
      (node) => opened.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    expect(clumpNodes.length).toBe(3);
    const leadVisualId = opened.leadByClusterKey.get(clusterKey!)!;
    const firstVisualId = opened.firstByClusterKey.get(clusterKey!)!;
    const leadNode = clumpNodes.find((node) => node.commit.visualId === leadVisualId);
    const firstNode = clumpNodes.find((node) => node.commit.visualId === firstVisualId);
    expect(leadNode).toBeDefined();
    expect(firstNode).toBeDefined();
    const bandStartColumn = firstNode!.column;
    expect(new Set(clumpNodes.map((node) => node.column))).toEqual(
      new Set([bandStartColumn, bandStartColumn + 1, bandStartColumn + 2]),
    );
    expect(leadNode!.column).toBe(bandStartColumn + 2);
    expect(leadNode!.y).toBeGreaterThan(firstNode!.y);
    const chronologicalNodes = [...clumpNodes].sort(
      (left, right) => new Date(left.commit.date).getTime() - new Date(right.commit.date).getTime(),
    );
    expect(chronologicalNodes.map((node) => node.column)).toEqual([bandStartColumn, bandStartColumn + 1, bandStartColumn + 2]);
    expect(chronologicalNodes.map((node) => node.y)).toEqual([...chronologicalNodes].map((node) => node.y).sort((a, b) => a - b));
    const clumpCells = new Set(clumpNodes.map((node) => `${node.row}:${node.column}`));
    const nonClumpNodesInBand = opened.renderNodes.filter(
      (node) =>
        opened.clusterKeyByCommitId.get(node.commit.visualId) !== clusterKey
        && clumpCells.has(`${node.row}:${node.column}`),
    );
    expect(nonClumpNodesInBand).toHaveLength(0);
    expect(new Set(clumpNodes.map((node) => node.x)).size).toBe(1);
    expect(new Set(clumpNodes.map((node) => node.y)).size).toBe(3);

    const collapsedClumpNode = collapsed.renderNodes.find(
      (node) => collapsed.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    )!;
    const lanePitch = ROW_HEIGHT + ROW_GAP / GRID_LAYOUT_RENDER_ZOOM + 20 / GRID_LAYOUT_RENDER_ZOOM;
    const movedOwnerColumn = collapsedClumpNode.column + 4;
    const movedOrigin = {
      x: collapsedClumpNode.x,
      y: TOP_PADDING + movedOwnerColumn * lanePitch,
    };
    const overriddenMember = collapsed.allCommits.find(
      (commit) =>
        collapsed.clusterKeyByCommitId.get(commit.visualId) === clusterKey
        && commit.visualId !== collapsed.leadByClusterKey.get(clusterKey!),
    )!;
    const nodePositionOverrides: NodePositionOverrides = {};
    assignNodePositionOverride(nodePositionOverrides, overriddenMember, movedOrigin);
    nodePositionOverrides[getStableNodePositionKey(overriddenMember)] = {
      x: collapsedClumpNode.x,
      y: collapsedClumpNode.y,
    };
    const movedOpened = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set([clusterKey!]),
      nodePositionOverrides,
    });
    const movedClumpNodes = movedOpened.renderNodes.filter(
      (node) => movedOpened.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    const movedFirstNode = movedClumpNodes.find(
      (node) => node.commit.visualId === movedOpened.firstByClusterKey.get(clusterKey!),
    )!;
    const movedLeadNode = movedClumpNodes.find(
      (node) => node.commit.visualId === movedOpened.leadByClusterKey.get(clusterKey!),
    )!;
    expect(movedFirstNode.column).not.toBe(movedOwnerColumn);
    expect(movedLeadNode.column).toBe(movedFirstNode.column + movedClumpNodes.length - 1);
    expect(movedLeadNode.y).toBeGreaterThan(movedFirstNode.y);
  });

  it('keeps sibling clump lanes stable when another clump opens', () => {
    const defaultBranch = 'main';
    const primaryA = '1111111111111111111111111111111111111111';
    const primaryB = '2222222222222222222222222222222222222222';
    const primaryC = '3333333333333333333333333333333333333333';
    const siblingA = '4444444444444444444444444444444444444444';
    const siblingB = '5555555555555555555555555555555555555555';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('primary', primaryC, 3, defaultBranch),
      makeBranch('sibling', siblingB, 2, defaultBranch),
    ];
    const baseInput = {
      branches,
      mergeNodes: [],
      directCommits: [
        {
          fullSha: mainSha,
          sha: mainSha.slice(0, 7),
          branch: defaultBranch,
          message: 'root',
          author: 'test',
          date: '2024-05-01T12:00:00Z',
          parentSha: null,
          parentShas: [],
        },
        {
          fullSha: tipSha,
          sha: tipSha.slice(0, 7),
          branch: defaultBranch,
          message: 'tip',
          author: 'test',
          date: '2024-06-01T12:00:00Z',
          parentSha: mainSha,
          parentShas: [mainSha],
        },
      ],
      unpushedDirectCommits: [
        {
          fullSha: primaryA,
          sha: primaryA.slice(0, 7),
          branch: 'primary',
          message: 'primary first',
          author: 'test',
          date: '2024-06-02T10:00:00Z',
          parentSha: tipSha,
          parentShas: [tipSha],
        },
        {
          fullSha: primaryB,
          sha: primaryB.slice(0, 7),
          branch: 'primary',
          message: 'primary second',
          author: 'test',
          date: '2024-06-02T11:00:00Z',
          parentSha: primaryA,
          parentShas: [primaryA],
        },
        {
          fullSha: primaryC,
          sha: primaryC.slice(0, 7),
          branch: 'primary',
          message: 'primary tip',
          author: 'test',
          date: '2024-06-02T12:00:00Z',
          parentSha: primaryB,
          parentShas: [primaryB],
        },
        {
          fullSha: siblingA,
          sha: siblingA.slice(0, 7),
          branch: 'sibling',
          message: 'sibling first',
          author: 'test',
          date: '2024-06-02T09:30:00Z',
          parentSha: tipSha,
          parentShas: [tipSha],
        },
        {
          fullSha: siblingB,
          sha: siblingB.slice(0, 7),
          branch: 'sibling',
          message: 'sibling tip',
          author: 'test',
          date: '2024-06-02T13:00:00Z',
          parentSha: siblingA,
          parentShas: [siblingA],
        },
      ],
      unpushedCommitShasByBranch: {
        primary: [primaryA, primaryB, primaryC],
        sibling: [siblingA, siblingB],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], primary: [], sibling: [] },
      branchParentByName: { main: null, primary: 'main', sibling: 'main' },
      branchUniqueAheadCounts: { main: 1, primary: 3, sibling: 2 },
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };
    const closed = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set<string>(),
    });
    const primaryClusterKey = closed.clusterKeyByCommitId.get(`primary:${primaryC}`);
    const siblingClusterKey = closed.clusterKeyByCommitId.get(`sibling:${siblingB}`);
    expect(primaryClusterKey).toBeDefined();
    expect(siblingClusterKey).toBeDefined();
    const closedSiblingNode = closed.renderNodes.find(
      (node) => closed.clusterKeyByCommitId.get(node.commit.visualId) === siblingClusterKey,
    );
    expect(closedSiblingNode).toBeDefined();

    const opened = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set([primaryClusterKey!]),
    });
    const openedSiblingNode = opened.renderNodes.find(
      (node) => opened.clusterKeyByCommitId.get(node.commit.visualId) === siblingClusterKey,
    );
    expect(openedSiblingNode).toBeDefined();
    expect(openedSiblingNode!.column).toBe(closedSiblingNode!.column);
  });

  it('does not let an opened clump member predate and reorder a sibling clump', () => {
    const defaultBranch = 'main';
    const primaryA = '1111111111111111111111111111111111111111';
    const primaryB = '2222222222222222222222222222222222222222';
    const siblingA = '3333333333333333333333333333333333333333';
    const siblingB = '4444444444444444444444444444444444444444';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('primary', primaryB, 2, defaultBranch),
      makeBranch('sibling', siblingB, 2, defaultBranch),
    ];
    const baseInput = {
      branches,
      mergeNodes: [],
      directCommits: [
        {
          fullSha: mainSha,
          sha: mainSha.slice(0, 7),
          branch: defaultBranch,
          message: 'root',
          author: 'test',
          date: '2024-05-01T12:00:00Z',
          parentSha: null,
          parentShas: [],
        },
        {
          fullSha: tipSha,
          sha: tipSha.slice(0, 7),
          branch: defaultBranch,
          message: 'tip',
          author: 'test',
          date: '2024-06-01T12:00:00Z',
          parentSha: mainSha,
          parentShas: [mainSha],
        },
      ],
      unpushedDirectCommits: [
        {
          fullSha: primaryA,
          sha: primaryA.slice(0, 7),
          branch: 'primary',
          message: 'primary early',
          author: 'test',
          date: '2024-06-02T09:00:00Z',
          parentSha: tipSha,
          parentShas: [tipSha],
        },
        {
          fullSha: primaryB,
          sha: primaryB.slice(0, 7),
          branch: 'primary',
          message: 'primary late tip',
          author: 'test',
          date: '2024-06-02T14:00:00Z',
          parentSha: primaryA,
          parentShas: [primaryA],
        },
        {
          fullSha: siblingA,
          sha: siblingA.slice(0, 7),
          branch: 'sibling',
          message: 'sibling middle',
          author: 'test',
          date: '2024-06-02T11:00:00Z',
          parentSha: tipSha,
          parentShas: [tipSha],
        },
        {
          fullSha: siblingB,
          sha: siblingB.slice(0, 7),
          branch: 'sibling',
          message: 'sibling middle tip',
          author: 'test',
          date: '2024-06-02T12:00:00Z',
          parentSha: siblingA,
          parentShas: [siblingA],
        },
      ],
      unpushedCommitShasByBranch: {
        primary: [primaryA, primaryB],
        sibling: [siblingA, siblingB],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], primary: [], sibling: [] },
      branchParentByName: { main: null, primary: 'main', sibling: 'main' },
      branchUniqueAheadCounts: { main: 1, primary: 2, sibling: 2 },
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };
    const closed = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set<string>(),
    });
    const primaryClusterKey = closed.clusterKeyByCommitId.get(`primary:${primaryB}`);
    const siblingClusterKey = closed.clusterKeyByCommitId.get(`sibling:${siblingB}`);
    expect(primaryClusterKey).toBeDefined();
    expect(siblingClusterKey).toBeDefined();
    const closedPrimaryNode = closed.renderNodes.find(
      (node) => closed.clusterKeyByCommitId.get(node.commit.visualId) === primaryClusterKey,
    );
    const closedSiblingNode = closed.renderNodes.find(
      (node) => closed.clusterKeyByCommitId.get(node.commit.visualId) === siblingClusterKey,
    );
    expect(closedPrimaryNode).toBeDefined();
    expect(closedSiblingNode).toBeDefined();

    const opened = computeBranchGridLayout({
      ...baseInput,
      manuallyOpenedClumps: new Set([primaryClusterKey!]),
    });
    const openedPrimaryLead = opened.renderNodes.find((node) => node.commit.visualId === `primary:${primaryB}`);
    const openedSiblingNode = opened.renderNodes.find(
      (node) => opened.clusterKeyByCommitId.get(node.commit.visualId) === siblingClusterKey,
    );
    expect(openedPrimaryLead).toBeDefined();
    expect(openedSiblingNode).toBeDefined();
    expect(openedPrimaryLead!.column > openedSiblingNode!.column).toBe(
      closedPrimaryNode!.column > closedSiblingNode!.column,
    );
  });

  it('keeps collapsed clump on a single lane column', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set<string>(),
      manuallyOpenedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'vertical' as const,
    });
    const clusterKey = [...layout.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();
    const clumpNode = layout.renderNodes.find(
      (node) => layout.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    expect(clumpNode).toBeDefined();
    expect(layout.renderNodes.filter(
      (node) => layout.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    )).toHaveLength(1);
    expect(layout.leadByClusterKey.get(clusterKey!)).toBe(clumpNode!.commit.visualId);
    const usedColumns = [...new Set(layout.renderNodes.map((node) => node.column))].sort((a, b) => a - b);
    expect(usedColumns).toEqual(Array.from({ length: usedColumns.length }, (_, column) => column));

    const focusedButManuallyClosed = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set([clusterKey!]),
      manuallyOpenedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: unpushedA,
      checkedOutRef: null,
      orientation: 'vertical' as const,
    });
    expect(focusedButManuallyClosed.renderNodes.filter(
      (node) => focusedButManuallyClosed.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    )).toHaveLength(1);
  });

  it('keeps a collapsed clump override when a new commit becomes the lead', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const unpushedD = 'ffffffffffffffffffffffffffffffffffffffff';
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const clumpCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const baseInput = {
      mergeNodes: [],
      directCommits,
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      manuallyClosedClumps: new Set<string>(),
      manuallyOpenedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };
    const before = computeBranchGridLayout({
      ...baseInput,
      branches: [
        makeBranch(defaultBranch, tipSha, 1),
        makeBranch('feature', unpushedC, 3, defaultBranch),
      ],
      unpushedDirectCommits: clumpCommits,
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC] },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
    });
    const clusterKey = [...before.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();
    const oldClumpNode = before.renderNodes.find(
      (node) => before.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    )!;
    expect(oldClumpNode.commit.id).toBe(unpushedC);
    const movedPosition = { row: oldClumpNode.row + 5, column: oldClumpNode.column + 4 };
    const nodePositionOverrides: NodePositionOverrides = {};
    assignNodePositionOverride(nodePositionOverrides, oldClumpNode.commit, movedPosition);

    const after = computeBranchGridLayout({
      ...baseInput,
      branches: [
        makeBranch(defaultBranch, tipSha, 1),
        makeBranch('feature', unpushedD, 4, defaultBranch),
      ],
      unpushedDirectCommits: [
        ...clumpCommits,
        {
          fullSha: unpushedD,
          sha: unpushedD.slice(0, 7),
          branch: 'feature',
          message: 'fourth',
          author: 'test',
          date: '2024-06-03T13:00:00Z',
          parentSha: unpushedC,
          parentShas: [unpushedC],
        },
      ],
      unpushedCommitShasByBranch: { feature: [unpushedA, unpushedB, unpushedC, unpushedD] },
      branchUniqueAheadCounts: { main: 1, feature: 4 },
      nodePositionOverrides,
    });
    const afterClusterKey = after.clusterKeyByCommitId.get(`feature:${unpushedD}`);
    expect(afterClusterKey).toBeDefined();
    const newClumpNode = after.renderNodes.find(
      (node) => after.clusterKeyByCommitId.get(node.commit.visualId) === afterClusterKey,
    )!;
    expect(newClumpNode.commit.id).toBe(unpushedD);
    expect(newClumpNode.row).toBe(movedPosition.row);
    expect(newClumpNode.column).toBe(movedPosition.column);
  });

  it('keeps incoming ancestry connector to collapsed clump lead from outside parent', () => {
    const defaultBranch = 'main';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: {
        feature: [unpushedA, unpushedB, unpushedC],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const clusterKey = [...layout.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();

    const clumpRenderNodes = layout.renderNodes.filter(
      (node) => layout.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    expect(clumpRenderNodes).toHaveLength(1);

    const leadVisualId = layout.leadByClusterKey.get(clusterKey!)!;
    expect(clumpRenderNodes[0]!.commit.visualId).toBe(leadVisualId);

    const forkParentVisualId = `${defaultBranch}:${tipSha}`;
    const incomingToLead = layout.connectors.find(
      (connector) =>
        connector.toCommitVisualId === leadVisualId
        && connector.fromCommitVisualId === forkParentVisualId,
    );
    expect(incomingToLead).toBeDefined();
  });

  it('places collapsed clump after every source parent of the earliest member', () => {
    const defaultBranch = 'main';
    const sideSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const mergeFirstSha = 'dddddddddddddddddddddddddddddddddddddddd';
    const clumpMiddleSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const clumpTipSha = 'ffffffffffffffffffffffffffffffffffffffff';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('side', sideSha, 1, defaultBranch),
      makeBranch('feature', clumpTipSha, 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'main tip',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
      {
        fullSha: sideSha,
        sha: sideSha.slice(0, 7),
        branch: 'side',
        message: 'side parent',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: mergeFirstSha,
        sha: mergeFirstSha.slice(0, 7),
        branch: 'feature',
        message: 'merge first',
        author: 'test',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha, sideSha],
      },
      {
        fullSha: clumpMiddleSha,
        sha: clumpMiddleSha.slice(0, 7),
        branch: 'feature',
        message: 'middle',
        author: 'test',
        date: '2024-06-03T11:00:00Z',
        parentSha: mergeFirstSha,
        parentShas: [mergeFirstSha],
      },
      {
        fullSha: clumpTipSha,
        sha: clumpTipSha.slice(0, 7),
        branch: 'feature',
        message: 'tip',
        author: 'test',
        date: '2024-06-03T12:00:00Z',
        parentSha: clumpMiddleSha,
        parentShas: [clumpMiddleSha],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: {
        feature: [mergeFirstSha, clumpMiddleSha, clumpTipSha],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], side: [], feature: [] },
      branchParentByName: { main: null, side: 'main', feature: 'main' },
      branchUniqueAheadCounts: { main: 1, side: 1, feature: 3 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const clusterKey = [...layout.clusterCounts.entries()].find(([, count]) => count > 1)?.[0];
    expect(clusterKey).toBeDefined();
    expect(layout.firstByClusterKey.get(clusterKey!)).toBe(`feature:${mergeFirstSha}`);

    const clumpNode = layout.renderNodes.find(
      (node) => layout.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    );
    const mainParentNode = layout.renderNodes.find((node) => node.commit.id === tipSha);
    const sideParentNode = layout.renderNodes.find((node) => node.commit.id === sideSha);
    expect(clumpNode).toBeDefined();
    expect(mainParentNode).toBeDefined();
    expect(sideParentNode).toBeDefined();
    expect(clumpNode!.row).toBeGreaterThan(mainParentNode!.row);
    expect(clumpNode!.row).toBeGreaterThan(sideParentNode!.row);
    expect(clumpNode!.column).toBeGreaterThan(mainParentNode!.column);
    expect(clumpNode!.column).toBeGreaterThan(sideParentNode!.column);
    expect(
      layout.renderNodes.filter(
        (node) =>
          node.column === clumpNode!.column
          && layout.clusterKeyByCommitId.get(node.commit.visualId) !== clusterKey,
      ),
    ).toHaveLength(0);

    const usedColumns = [...new Set(layout.renderNodes.map((node) => node.column))].sort((a, b) => a - b);
    expect(usedColumns).toEqual(usedColumns.map((_, index) => index));
  });

  it('interleaves stash lanes by date between fork parent and newer branch work', () => {
    const defaultBranch = 'main';
    const stashId = 'STASH:0';
    const unpushedA = 'cccccccccccccccccccccccccccccccccccccccc';
    const unpushedB = 'dddddddddddddddddddddddddddddddddddddddd';
    const unpushedC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', unpushedC, 3, defaultBranch),
      {
        ...makeBranch('Stash 1', stashId, 1),
        parentBranch: defaultBranch,
        divergedFromSha: mainSha,
      },
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: unpushedA,
        sha: unpushedA.slice(0, 7),
        branch: 'feature',
        message: 'first',
        author: 'test',
        date: '2024-06-10T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: unpushedB,
        sha: unpushedB.slice(0, 7),
        branch: 'feature',
        message: 'second',
        author: 'test',
        date: '2024-06-10T11:00:00Z',
        parentSha: unpushedA,
        parentShas: [unpushedA],
      },
      {
        fullSha: unpushedC,
        sha: unpushedC.slice(0, 7),
        branch: 'feature',
        message: 'third',
        author: 'test',
        date: '2024-06-10T12:00:00Z',
        parentSha: unpushedB,
        parentShas: [unpushedB],
      },
    ];
    const branchCommitPreviews: Record<string, BranchCommitPreview[]> = {
      main: [],
      feature: [],
      'Stash 1': [
        {
          fullSha: stashId,
          sha: 'Stash 1',
          parentSha: mainSha,
          message: 'wip',
          author: 'You',
          date: '2024-05-01T12:00:00Z',
          kind: 'stash',
        },
      ],
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: {
        feature: [unpushedA, unpushedB, unpushedC],
      },
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: { main: null, feature: 'main', 'Stash 1': 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3, 'Stash 1': 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'vertical',
    });

    const stashNode = layout.renderNodes.find((node) => node.commit.id === stashId);
    const mainNode = layout.renderNodes.find((node) => node.commit.id === mainSha);
    const featureTipNode = layout.renderNodes.find((node) => node.commit.id === unpushedC);
    expect(stashNode).toBeDefined();
    expect(mainNode).toBeDefined();
    expect(featureTipNode).toBeDefined();
    expect(stashNode!.column).toBeGreaterThan(mainNode!.column);
    expect(stashNode!.column).toBeLessThan(featureTipNode!.column);
    expect(stashNode!.row).toBeGreaterThan(mainNode!.row);
    const maxColumn = Math.max(...layout.renderNodes.map((node) => node.column));
    expect(stashNode!.column).toBeLessThan(maxColumn);
  });

  it('places fork children of the same parent on one timeline row', () => {
    const defaultBranch = 'main';
    const forkSha = 'be7d231be7d231be7d231be7d231be7d231be7';
    const mainChildSha = '5dcf2515dcf2515dcf2515dcf2515dcf2515';
    const cursorChildOneSha = '2eac3db2eac3db2eac3db2eac3db2eac3db2';
    const cursorChildTwoSha = '71adc9bf71adc9bf71adc9bf71adc9bf71adc9';
    const sharedTime = '2026-05-25T15:10:00Z';
    const branches = [
      makeBranch(defaultBranch, mainChildSha, 2),
      makeBranch('cursor/edow', cursorChildOneSha, 1, defaultBranch),
      makeBranch('cursor/hp17', cursorChildTwoSha, 1, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: forkSha,
        sha: forkSha.slice(0, 7),
        branch: defaultBranch,
        message: 'Add camera p…',
        author: 'test',
        date: '2026-05-25T15:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: mainChildSha,
        sha: mainChildSha.slice(0, 7),
        branch: defaultBranch,
        message: 'Keep macOS t…',
        author: 'test',
        date: sharedTime,
        parentSha: forkSha,
        parentShas: [forkSha],
      },
      {
        fullSha: cursorChildOneSha,
        sha: cursorChildOneSha.slice(0, 7),
        branch: 'cursor/edow',
        message: 'Persist windo…',
        author: 'test',
        date: sharedTime,
        parentSha: forkSha,
        parentShas: [forkSha],
      },
      {
        fullSha: cursorChildTwoSha,
        sha: cursorChildTwoSha.slice(0, 7),
        branch: 'cursor/hp17',
        message: 'Animate sideb…',
        author: 'test',
        date: sharedTime,
        parentSha: forkSha,
        parentShas: [forkSha],
      },
    ];
    const branchCommitPreviews = {
      main: [],
      'cursor/edow': [],
      'cursor/hp17': [],
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews,
      branchParentByName: {
        main: null,
        'cursor/edow': defaultBranch,
        'cursor/hp17': defaultBranch,
      },
      branchUniqueAheadCounts: { main: 2, 'cursor/edow': 1, 'cursor/hp17': 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const forkNode = layout.renderNodes.find((node) => node.commit.id === forkSha);
    const mainChildNode = layout.renderNodes.find((node) => node.commit.id === mainChildSha);
    const cursorOneNode = layout.renderNodes.find((node) => node.commit.id === cursorChildOneSha);
    const cursorTwoNode = layout.renderNodes.find((node) => node.commit.id === cursorChildTwoSha);
    expect(forkNode).toBeDefined();
    expect(mainChildNode).toBeDefined();
    expect(cursorOneNode).toBeDefined();
    expect(cursorTwoNode).toBeDefined();
    expect(mainChildNode!.row).toBeGreaterThan(forkNode!.row);
    expect(mainChildNode!.row).toBe(cursorOneNode!.row);
    expect(mainChildNode!.row).toBe(cursorTwoNode!.row);
    expect(new Set([mainChildNode!.column, cursorOneNode!.column, cursorTwoNode!.column]).size).toBe(3);
  });

  it('places fork children on one row when fork tips differ in timestamp', () => {
    const defaultBranch = 'main';
    const forkSha = 'be7d231be7d231be7d231be7d231be7d231be7';
    const mainChildSha = 'ac3ddcaac3ddcaac3ddcaac3ddcaac3ddcaac3';
    const cursorChildOneSha = '2eac3db2eac3db2eac3db2eac3db2eac3db2';
    const cursorChildTwoSha = '71adc9bf71adc9bf71adc9bf71adc9bf71adc9';
    const branches = [
      makeBranch(defaultBranch, mainChildSha, 1),
      makeBranch('cursor/edow', cursorChildOneSha, 1, defaultBranch),
      makeBranch('cursor/hp17', cursorChildTwoSha, 1, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: forkSha,
        sha: forkSha.slice(0, 7),
        branch: defaultBranch,
        message: 'Add camera p…',
        author: 'test',
        date: '2026-05-25T15:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: mainChildSha,
        sha: mainChildSha.slice(0, 7),
        branch: defaultBranch,
        message: 'Align simultane…',
        author: 'test',
        date: '2026-05-25T15:10:00Z',
        parentSha: forkSha,
        parentShas: [forkSha],
      },
      {
        fullSha: cursorChildOneSha,
        sha: cursorChildOneSha.slice(0, 7),
        branch: 'cursor/edow',
        message: 'Persist windo…',
        author: 'test',
        date: '2026-05-25T18:00:00Z',
        parentSha: forkSha,
        parentShas: [forkSha],
      },
      {
        fullSha: cursorChildTwoSha,
        sha: cursorChildTwoSha.slice(0, 7),
        branch: 'cursor/hp17',
        message: 'Animate sideb…',
        author: 'test',
        date: '2026-05-25T19:30:00Z',
        parentSha: forkSha,
        parentShas: [forkSha],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: { main: [], 'cursor/edow': [], 'cursor/hp17': [] },
      branchParentByName: {
        main: null,
        'cursor/edow': defaultBranch,
        'cursor/hp17': defaultBranch,
      },
      branchUniqueAheadCounts: { main: 1, 'cursor/edow': 1, 'cursor/hp17': 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const forkNode = layout.renderNodes.find((node) => node.commit.id === forkSha);
    const mainChildNode = layout.renderNodes.find((node) => node.commit.id === mainChildSha);
    const cursorOneNode = layout.renderNodes.find((node) => node.commit.id === cursorChildOneSha);
    const cursorTwoNode = layout.renderNodes.find((node) => node.commit.id === cursorChildTwoSha);
    expect(forkNode).toBeDefined();
    expect(mainChildNode).toBeDefined();
    expect(cursorOneNode).toBeDefined();
    expect(cursorTwoNode).toBeDefined();
    expect(mainChildNode!.row).toBeGreaterThan(forkNode!.row);
    expect(mainChildNode!.row).toBe(cursorOneNode!.row);
    expect(mainChildNode!.row).toBe(cursorTwoNode!.row);
  });

  it('forms clumps based on user/author', () => {
    const defaultBranch = 'main';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', 'sha3', 3, defaultBranch),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'root',
        author: 'Alice',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'tip',
        author: 'Alice',
        date: '2024-06-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const unpushedDirectCommits: DirectCommit[] = [
      {
        fullSha: 'sha1',
        sha: 'sha1'.padEnd(7, '0'),
        branch: 'feature',
        message: 'commit 1',
        author: 'Alice',
        date: '2024-06-03T10:00:00Z',
        parentSha: tipSha,
        parentShas: [tipSha],
      },
      {
        fullSha: 'sha2',
        sha: 'sha2'.padEnd(7, '0'),
        branch: 'feature',
        message: 'commit 2',
        author: 'Bob',
        date: '2024-06-03T11:00:00Z',
        parentSha: 'sha1',
        parentShas: ['sha1'],
      },
      {
        fullSha: 'sha3',
        sha: 'sha3'.padEnd(7, '0'),
        branch: 'feature',
        message: 'commit 3',
        author: 'Alice',
        date: '2024-06-03T12:00:00Z',
        parentSha: 'sha2',
        parentShas: ['sha2'],
      },
    ];

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits,
      unpushedCommitShasByBranch: {
        feature: ['sha1', 'sha2', 'sha3'],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set(),
      manuallyOpenedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    // Check cluster counts
    // 'sha1', 'sha2', and 'sha3' are on 'feature' branch.
    // Since they have different authors (Alice, Bob, Alice), they should NOT group into a single cluster.
    // Instead, they should be in separate clusters (of count 1).
    const key1 = layout.clusterKeyByCommitId.get('feature:sha1');
    const key2 = layout.clusterKeyByCommitId.get('feature:sha2');
    const key3 = layout.clusterKeyByCommitId.get('feature:sha3');

    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key3).toBeDefined();
    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(key1).not.toBe(key3);

    // Let's verify that if they had the same author, they would clump
    const unpushedSameAuthor = unpushedDirectCommits.map(c => ({ ...c, author: 'Alice' }));
    const layoutSame = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: unpushedSameAuthor,
      unpushedCommitShasByBranch: {
        feature: ['sha1', 'sha2', 'sha3'],
      },
      defaultBranch,
      branchCommitPreviews: { main: [], feature: [] },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 3 },
      manuallyClosedClumps: new Set(),
      manuallyOpenedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const keySame1 = layoutSame.clusterKeyByCommitId.get('feature:sha1');
    const keySame2 = layoutSame.clusterKeyByCommitId.get('feature:sha2');
    const keySame3 = layoutSame.clusterKeyByCommitId.get('feature:sha3');

    expect(keySame1).toBeDefined();
    expect(keySame1).toBe(keySame2);
    expect(keySame1).toBe(keySame3);
  });

  it('renders remote-only branch commit from previews when directCommits are missing', () => {
    const defaultBranch = 'main';
    const forkSha = '137b96427d9da931373c1d7bf368cbd2b237f913';
    const remoteTipSha = 'c131b6f10b7737b2974df51887149d9127b2a648';
    const remoteBranchName = 'cursor/commit-app-previews-7896';
    const branches: Branch[] = [
      {
        ...makeBranch(defaultBranch, 'dddddddddddddddddddddddddddddddddddddddd', 32),
        headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      },
      {
        name: remoteBranchName,
        commitsAhead: 1,
        commitsBehind: 0,
        lastCommitDate: '2026-05-28T12:00:00Z',
        lastCommitAuthor: 'dev',
        status: 'fresh',
        remoteSyncStatus: 'on-github',
        unpushedCommits: 0,
        headSha: remoteTipSha,
        parentBranch: defaultBranch,
        divergedFromSha: forkSha,
      },
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: forkSha,
        sha: forkSha.slice(0, 7),
        branch: defaultBranch,
        message: 'origin/main tip',
        author: 'dev',
        date: '2026-05-20T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        [remoteBranchName]: [{
          fullSha: remoteTipSha,
          sha: remoteTipSha.slice(0, 7),
          parentSha: forkSha,
          message: 'Add static app preview screenshots per commit',
          author: 'dev',
          date: '2026-05-28T12:00:00Z',
          kind: 'commit',
          isRemote: true,
        }],
      },
      branchParentByName: {
        main: null,
        [remoteBranchName]: defaultBranch,
      },
      branchUniqueAheadCounts: {
        [remoteBranchName]: 1,
      },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    const remoteNode = layout.renderNodes.find(
      (node) => node.commit.branchName === remoteBranchName && node.commit.id === remoteTipSha,
    );
    expect(remoteNode).toBeDefined();
  });

  it('does not invent a chain between commits whose Git parents are missing', () => {
    const defaultBranch = 'main';
    const missingParent = '9999999999999999999999999999999999999999';
    const firstSha = '1111111111111111111111111111111111111111';
    const secondSha = '2222222222222222222222222222222222222222';
    const thirdSha = '3333333333333333333333333333333333333333';
    const directCommits: DirectCommit[] = [
      {
        fullSha: firstSha,
        sha: firstSha.slice(0, 7),
        branch: defaultBranch,
        message: 'first fork child',
        author: 'first',
        date: '2026-08-03T10:06:00Z',
        parentSha: missingParent,
        parentShas: [missingParent],
      },
      {
        fullSha: secondSha,
        sha: secondSha.slice(0, 7),
        branch: defaultBranch,
        message: 'second fork child',
        author: 'second',
        date: '2026-08-03T09:38:00Z',
        parentSha: missingParent,
        parentShas: [missingParent],
      },
      {
        fullSha: thirdSha,
        sha: thirdSha.slice(0, 7),
        branch: defaultBranch,
        message: 'third fork child',
        author: 'third',
        date: '2026-08-03T09:19:00Z',
        parentSha: missingParent,
        parentShas: [missingParent],
      },
    ];
    const layout = computeBranchGridLayout({
      branches: [makeBranch(defaultBranch, firstSha, 3)],
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: { [defaultBranch]: [] },
      branchParentByName: { [defaultBranch]: null },
      branchUniqueAheadCounts: { [defaultBranch]: 3 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
    });

    expect(layout.renderNodes).toHaveLength(3);
    expect(layout.connectors.filter((connector) => connector.connectorEdgeKind === 'chain')).toEqual([]);
  });
});
