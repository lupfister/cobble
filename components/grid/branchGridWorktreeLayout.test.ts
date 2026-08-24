import { describe, expect, it } from 'vitest';
import type { Branch, BranchCommitPreview, DirectCommit } from '../../types';
import { buildWorktreeSessions } from '../../lib/worktreeSessions';
import type { WorktreeInfo } from '../../types';
import { ROW_GAP, ROW_HEIGHT, TOP_PADDING } from './LayoutGrid';
import { computeBranchGridLayout, GRID_LAYOUT_RENDER_ZOOM } from './branchGridLayoutModel';
import { assignNodePositionOverride } from './nodePositionOverrides';

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

const wt = (overrides: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: '/repo/wt-feature',
  pathExists: true,
  headSha: tipSha,
  branchName: 'cursor-sdk',
  parentSha: mainSha,
  isCurrent: false,
  isPrunable: false,
  hasUncommittedChanges: false,
  ...overrides,
});

describe('computeBranchGridLayout worktree nodes', () => {
  it('renders worktree node to the right of parent without BRANCH_HEAD when session covers empty branch', () => {
    const defaultBranch = 'main';
    const parentDate = '2024-06-01T12:00:00Z';
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions([wt({ path: '/repo/wt-feature' })], '/repo');
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [],
        'cursor-sdk': [worktreePreview],
      },
      branchParentByName: { main: null, 'cursor-sdk': 'main' },
      branchUniqueAheadCounts: { main: 1, 'cursor-sdk': 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    expect(layout.renderNodes.some((node) => node.commit.id.startsWith('BRANCH_HEAD:cursor-sdk:'))).toBe(false);
    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const parentNode = layout.renderNodes.find((node) => node.commit.id === tipSha);
    expect(worktreeNode).toBeDefined();
    expect(parentNode).toBeDefined();
    expect(worktreeNode!.row).toBe(parentNode!.row + 1);
    expect(worktreeNode!.column).toBeGreaterThan(parentNode!.column);
    expect(worktreeNode!.commit.date).toBe(parentDate);
  });

  it('draws only an incoming connector from the checkout parent to the worktree node', () => {
    const defaultBranch = 'main';
    const parentDate = '2024-06-01T12:00:00Z';
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions([wt({ path: '/repo/wt-feature' })], '/repo');
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [],
        'cursor-sdk': [worktreePreview],
      },
      branchParentByName: { main: null, 'cursor-sdk': 'main' },
      branchUniqueAheadCounts: { main: 1, 'cursor-sdk': 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeId = sessions[0]!.workingTreeId;
    const worktreeVisualId = layout.renderNodes.find((node) => node.commit.id === worktreeId)?.commit.visualId;
    const parentVisualId = layout.renderNodes.find((node) => node.commit.id === tipSha)?.commit.visualId;
    expect(worktreeVisualId).toBeDefined();
    expect(parentVisualId).toBeDefined();

    const incoming = layout.connectors.filter((connector) => connector.toCommitVisualId === worktreeVisualId);
    const outgoing = layout.connectors.filter((connector) => connector.fromCommitVisualId === worktreeVisualId);
    const mergeOutgoing = layout.mergeConnectors.filter(
      (connector) => connector.fromCommitVisualId === worktreeVisualId,
    );

    expect(incoming.some((connector) => connector.fromCommitVisualId === parentVisualId)).toBe(true);
    expect(outgoing).toHaveLength(0);
    expect(mergeOutgoing).toHaveLength(0);
  });

  it('keeps a worktree after its visible parent even with a stale position override', () => {
    const defaultBranch = 'main';
    const parentDate = '2024-06-01T12:00:00Z';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('lapis', tipSha, 0),
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
        message: 'auto-expand-sidebar',
        author: 'test',
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo/.worktrees/lapis', branchName: 'lapis', headSha: tipSha })],
      '/repo',
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!],
        lapis: [worktreePreview],
      },
      branchParentByName: { main: null, lapis: defaultBranch },
      branchUniqueAheadCounts: { main: 1, lapis: 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      worktreeSessions: sessions,
      orientation: 'horizontal',
      nodePositionOverrides: {
        [sessions[0]!.workingTreeId]: { row: 1, column: 0 },
      },
    });

    const parentNode = layout.renderNodes.find((node) => node.commit.id === tipSha);
    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    expect(parentNode).toBeDefined();
    expect(worktreeNode).toBeDefined();
    expect(worktreeNode!.row).toBeGreaterThan(parentNode!.row);
    expect(worktreeNode!.column).toBeGreaterThan(parentNode!.column);
  });

  it('steps the primary worktree one timeline slot right when it shares the parent lane', () => {
    const defaultBranch = 'main';
    const parentDate = '2024-06-01T12:00:00Z';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch('feature', tipSha, 1),
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!, worktreePreview],
        feature: [directCommits[1]!],
      },
      branchParentByName: { main: null, feature: 'main' },
      branchUniqueAheadCounts: { main: 1, feature: 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const mainTipNode = layout.nodes.find(
      (node) => node.commit.id === tipSha && node.commit.branchName === 'main',
    );
    expect(worktreeNode).toBeDefined();
    expect(mainTipNode).toBeDefined();
    expect(worktreeNode!.row).toBeGreaterThanOrEqual(mainTipNode!.row);
    expect(worktreeNode!.column).toBeGreaterThan(mainTipNode!.column);
    expect(worktreeNode!.y).toBeGreaterThan(mainTipNode!.y);
  });

  it('keeps primary worktree on the checkout lane when HEAD is only visible as a collapsed clump lead', () => {
    const defaultBranch = 'main';
    const parentDate = '2024-06-01T12:00:00Z';
    const olderSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const branches = [makeBranch(defaultBranch, tipSha, 2)];
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
        fullSha: olderSha,
        sha: olderSha.slice(0, 7),
        branch: defaultBranch,
        message: 'older',
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
        date: parentDate,
        parentSha: olderSha,
        parentShas: [olderSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!, directCommits[2]!, worktreePreview],
      },
      branchParentByName: { main: null },
      branchUniqueAheadCounts: { main: 2 },
      unpushedCommitShasByBranch: { main: [olderSha, tipSha] },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const headLeadNode = layout.renderNodes.find((node) => node.commit.id === tipSha);
    expect(worktreeNode).toBeDefined();
    expect(headLeadNode).toBeDefined();
    expect(worktreeNode!.column).toBeGreaterThan(headLeadNode!.column);
    expect(worktreeNode!.row).toBe(headLeadNode!.row + 1);
    expect(worktreeNode!.y).toBeGreaterThan(headLeadNode!.y);
  });

  it('positions worktree below HEAD when the parent clump opens', () => {
    const defaultBranch = 'main';
    const olderSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const parentDate = '2024-05-15T12:00:00Z';
    const branches = [makeBranch(defaultBranch, tipSha, 2)];
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
        fullSha: olderSha,
        sha: olderSha.slice(0, 7),
        branch: defaultBranch,
        message: 'checked out parent',
        author: 'test',
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'newer clump member',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: olderSha,
        parentShas: [olderSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const collapsed = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: { main: [directCommits[1]!, directCommits[2]!, worktreePreview] },
      branchParentByName: { main: null },
      branchUniqueAheadCounts: { main: 2 },
      unpushedCommitShasByBranch: { main: [olderSha, tipSha] },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });
    const clusterKey = collapsed.clusterKeyByCommitId.get(`${defaultBranch}:${tipSha}`);
    expect(clusterKey).toBeDefined();

    const opened = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: { main: [directCommits[1]!, directCommits[2]!, worktreePreview] },
      branchParentByName: { main: null },
      branchUniqueAheadCounts: { main: 2 },
      unpushedCommitShasByBranch: { main: [olderSha, tipSha] },
      manuallyOpenedClumps: new Set([clusterKey!]),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });
    const latestNode = opened.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === tipSha,
    );
    const worktreeNode = opened.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    expect(latestNode).toBeDefined();
    expect(worktreeNode).toBeDefined();
    expect(worktreeNode!.row).toBe(latestNode!.row + 1);
    expect(worktreeNode!.column).toBe(latestNode!.column + 1);
    expect(
      opened.connectors.some(
        (connector) =>
          connector.fromCommitVisualId === latestNode!.commit.visualId
          && connector.toCommitVisualId === worktreeNode!.commit.visualId,
      ),
    ).toBe(true);

    const collapsedParentNode = collapsed.renderNodes.find(
      (node) => collapsed.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey,
    )!;
    const lanePitch = ROW_HEIGHT + ROW_GAP / GRID_LAYOUT_RENDER_ZOOM + 20 / GRID_LAYOUT_RENDER_ZOOM;
    const movedOwnerColumn = collapsedParentNode.column + 5;
    const nodePositionOverrides = {};
    assignNodePositionOverride(nodePositionOverrides, latestNode!.commit, {
      x: collapsedParentNode.x,
      y: TOP_PADDING + movedOwnerColumn * lanePitch,
    });

    const movedOpened = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: { main: [directCommits[1]!, directCommits[2]!, worktreePreview] },
      branchParentByName: { main: null },
      branchUniqueAheadCounts: { main: 2 },
      unpushedCommitShasByBranch: { main: [olderSha, tipSha] },
      manuallyOpenedClumps: new Set([clusterKey!]),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
      nodePositionOverrides,
    });
    const movedLatestNode = movedOpened.renderNodes.find(
      (node) => node.commit.branchName === defaultBranch && node.commit.id === tipSha,
    );
    const movedClumpColumns = movedOpened.renderNodes
      .filter((node) => movedOpened.clusterKeyByCommitId.get(node.commit.visualId) === clusterKey)
      .map((node) => node.column);
    expect(movedLatestNode).toBeDefined();
    expect(movedLatestNode!.column).toBe(Math.max(...movedClumpColumns));
    const movedWorktreeNode = movedOpened.renderNodes.find(
      (node) => node.commit.id === sessions[0]!.workingTreeId,
    );
    expect(movedWorktreeNode).toBeDefined();
    expect(movedWorktreeNode!.column).toBeGreaterThan(Math.max(...movedClumpColumns));
  });

  it('treats a cross-lane worktree attachment as a clump edge on the parent commit', () => {
    const defaultBranch = 'main';
    const olderSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const featureBranch = 'feature-worktree';
    const branches = [
      makeBranch(defaultBranch, tipSha, 2),
      makeBranch(featureBranch, olderSha, 0),
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
        fullSha: olderSha,
        sha: olderSha.slice(0, 7),
        branch: defaultBranch,
        message: 'attached parent',
        author: 'test',
        date: '2024-05-15T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
      {
        fullSha: tipSha,
        sha: tipSha.slice(0, 7),
        branch: defaultBranch,
        message: 'same author after attachment',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: olderSha,
        parentShas: [olderSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo/.worktrees/feature', branchName: featureBranch, headSha: olderSha })],
      '/repo',
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: olderSha,
      message: '',
      author: 'You',
      date: '2024-05-15T12:00:00Z',
      kind: 'uncommitted',
    };

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!, directCommits[2]!],
        [featureBranch]: [worktreePreview],
      },
      branchParentByName: { main: null, [featureBranch]: defaultBranch },
      branchUniqueAheadCounts: { main: 2, [featureBranch]: 0 },
      unpushedCommitShasByBranch: { main: [olderSha, tipSha] },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const parentClusterKey = layout.clusterKeyByCommitId.get(`${defaultBranch}:${olderSha}`);
    const nextClusterKey = layout.clusterKeyByCommitId.get(`${defaultBranch}:${tipSha}`);
    expect(parentClusterKey).toBeDefined();
    expect(nextClusterKey).toBeDefined();
    expect(parentClusterKey).not.toBe(nextClusterKey);
  });

  it('keeps worktrees on distinct branch lanes when multiple sessions share the same HEAD parent', () => {
    const defaultBranch = 'main';
    const branchA = 'cursor/k716';
    const branchB = 'lp-portfolio';
    const parentDate = '2024-06-01T12:00:00Z';
    const branches = [
      makeBranch(defaultBranch, tipSha, 1),
      makeBranch(branchA, tipSha, 0),
      makeBranch(branchB, tipSha, 0),
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [
        wt({ path: '/repo/.worktrees/k716', branchName: branchA, headSha: tipSha }),
        wt({ path: '/repo/.worktrees/lp', branchName: branchB, headSha: tipSha }),
      ],
      '/repo',
    );
    const previewA: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const previewB: BranchCommitPreview = {
      fullSha: sessions[1]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!],
        [branchA]: [previewA],
        [branchB]: [previewB],
      },
      branchParentByName: { main: null, [branchA]: defaultBranch, [branchB]: defaultBranch },
      branchUniqueAheadCounts: { main: 1, [branchA]: 0, [branchB]: 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const parentNode = layout.renderNodes.find((node) => node.commit.id === tipSha);
    const worktreeA = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const worktreeB = layout.renderNodes.find((node) => node.commit.id === sessions[1]!.workingTreeId);
    expect(parentNode).toBeDefined();
    expect(worktreeA).toBeDefined();
    expect(worktreeB).toBeDefined();
    expect(worktreeA!.row).toBe(parentNode!.row + 1);
    expect(worktreeB!.row).toBe(parentNode!.row + 1);
    expect(worktreeA!.column).not.toBe(worktreeB!.column);
    expect(worktreeA!.x).toBe(worktreeB!.x);
    expect(worktreeA!.y).not.toBe(worktreeB!.y);
    expect(worktreeA!.x).toBeGreaterThan(parentNode!.x);
  });

  it('pins primary worktree to HEAD on main when session lane is main (local) but parentSha is on main', () => {
    const defaultBranch = 'main';
    const localBranch = `${defaultBranch} (local)`;
    const parentDate = '2024-06-01T12:00:00Z';
    const branches = [
      makeBranch(defaultBranch, tipSha, 0),
      {
        ...makeBranch(localBranch, tipSha, 1),
        parentBranch: defaultBranch,
        remoteSyncStatus: 'unpushed' as const,
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: localBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: localBranch, headSha: tipSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!],
        [localBranch]: [worktreePreview],
      },
      branchParentByName: { main: null, [localBranch]: defaultBranch },
      branchUniqueAheadCounts: { main: 0, [localBranch]: 1 },
      unpushedCommitShasByBranch: { [localBranch]: [tipSha] },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: localBranch, headSha: tipSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const headNode = layout.renderNodes.find(
      (node) => node.commit.id === tipSha && node.commit.branchName === defaultBranch,
    );
    expect(worktreeNode).toBeDefined();
    expect(headNode).toBeDefined();
    expect(worktreeNode!.column).toBeGreaterThan(headNode!.column);
    expect(worktreeNode!.row).toBe(headNode!.row + 1);
    expect(worktreeNode!.y).toBeGreaterThan(headNode!.y);
  });

  it('keeps worktree on branch lane when session branch name differs from layout branch', () => {
    const defaultBranch = 'main';
    const localBranch = `${defaultBranch} (local)`;
    const parentDate = '2024-06-01T12:00:00Z';
    const branches = [
      makeBranch(defaultBranch, tipSha, 0),
      { ...makeBranch(localBranch, tipSha, 1), parentBranch: defaultBranch, remoteSyncStatus: 'unpushed' as const },
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
        date: parentDate,
        parentSha: mainSha,
        parentShas: [mainSha],
      },
    ];
    const worktreePreview: BranchCommitPreview = {
      fullSha: 'WORKING_TREE',
      sha: 'uncommitted',
      parentSha: tipSha,
      message: '',
      author: 'You',
      date: parentDate,
      kind: 'uncommitted',
    };
    const layoutInputs = {
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: {
        main: [directCommits[1]!],
        [localBranch]: [worktreePreview],
      },
      branchParentByName: { main: null, [localBranch]: defaultBranch },
      branchUniqueAheadCounts: { main: 0, [localBranch]: 1 },
      unpushedCommitShasByBranch: { [localBranch]: [tipSha] },
      manuallyOpenedClumps: new Set<string>(),
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: localBranch, headSha: tipSha, hasUncommittedChanges: false },
      orientation: 'horizontal' as const,
    };
    const alignedSessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: localBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: localBranch, headSha: tipSha, hasUncommittedChanges: false },
    );
    const misalignedSessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: tipSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: tipSha, hasUncommittedChanges: false },
    );
    const aligned = computeBranchGridLayout({
      ...layoutInputs,
      worktreeSessions: alignedSessions,
    });
    const misaligned = computeBranchGridLayout({
      ...layoutInputs,
      worktreeSessions: misalignedSessions,
    });
    const alignedNode = aligned.renderNodes.find((node) => node.commit.id === 'WORKING_TREE');
    const misalignedNode = misaligned.renderNodes.find((node) => node.commit.id === 'WORKING_TREE');
    const headNode = aligned.renderNodes.find(
      (node) => node.commit.id === tipSha && node.commit.branchName === defaultBranch,
    );
    expect(alignedNode).toBeDefined();
    expect(misalignedNode).toBeDefined();
    expect(headNode).toBeDefined();
    expect(alignedNode!.column).toBeGreaterThan(headNode!.column);
    expect(misalignedNode!.column).toBeGreaterThan(headNode!.column);
  });

  it('does not push a worktree below a later visible node when its real parent resolves', () => {
    const defaultBranch = 'main';
    const worktreeParentSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const laterSha = 'cccccccccccccccccccccccccccccccccccccccc';
    const branches = [makeBranch(defaultBranch, laterSha, 2)];
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
        fullSha: worktreeParentSha,
        sha: worktreeParentSha.slice(0, 7),
        branch: defaultBranch,
        message: 'worktree parent',
        author: 'test',
        date: '2024-05-02T12:00:00Z',
        parentSha: mainSha,
        parentShas: [mainSha],
      },
      {
        fullSha: laterSha,
        sha: laterSha.slice(0, 7),
        branch: defaultBranch,
        message: 'later visible commit',
        author: 'test',
        date: '2024-06-01T12:00:00Z',
        parentSha: worktreeParentSha,
        parentShas: [worktreeParentSha],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: worktreeParentSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: worktreeParentSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: worktreeParentSha,
      message: '',
      author: 'You',
      date: '2024-05-02T12:00:00Z',
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: directCommits.slice(1),
      defaultBranch,
      branchCommitPreviews: { [defaultBranch]: [directCommits[1]!, directCommits[2]!, worktreePreview] },
      branchParentByName: { [defaultBranch]: null },
      branchUniqueAheadCounts: { [defaultBranch]: 2 },
      unpushedCommitShasByBranch: { [defaultBranch]: [worktreeParentSha, laterSha] },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: worktreeParentSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeNode = layout.renderNodes.find((node) => node.commit.id === sessions[0]!.workingTreeId);
    const parentNode = layout.renderNodes.find((node) => node.commit.id === worktreeParentSha);
    const laterNode = layout.renderNodes.find((node) => node.commit.id === laterSha);
    expect(worktreeNode).toBeDefined();
    expect(parentNode).toBeDefined();
    expect(laterNode).toBeDefined();
    expect(worktreeNode!.row).toBe(parentNode!.row + 1);
    expect(worktreeNode!.row).toBeLessThanOrEqual(laterNode!.row);
  });

  it('does not mark broken ancestry when a worktree head is not visible but the lane has a fallback parent', () => {
    const defaultBranch = 'main';
    const hiddenHeadSha = 'dddddddddddddddddddddddddddddddddddddddd';
    const branches = [makeBranch(defaultBranch, hiddenHeadSha, 1)];
    const directCommits: DirectCommit[] = [
      {
        fullSha: mainSha,
        sha: mainSha.slice(0, 7),
        branch: defaultBranch,
        message: 'visible fallback',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
    ];
    const sessions = buildWorktreeSessions(
      [wt({ path: '/repo', branchName: defaultBranch, headSha: hiddenHeadSha, isCurrent: true })],
      '/repo',
      { branchName: defaultBranch, headSha: hiddenHeadSha, hasUncommittedChanges: true },
    );
    const worktreePreview: BranchCommitPreview = {
      fullSha: sessions[0]!.workingTreeId,
      sha: 'uncommitted',
      parentSha: hiddenHeadSha,
      message: '',
      author: 'You',
      date: '2024-05-02T12:00:00Z',
      kind: 'uncommitted',
    };
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: { [defaultBranch]: [worktreePreview] },
      branchParentByName: { [defaultBranch]: null },
      branchUniqueAheadCounts: { [defaultBranch]: 1 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: hiddenHeadSha, hasUncommittedChanges: true },
      worktreeSessions: sessions,
      orientation: 'horizontal',
    });

    const worktreeId = sessions[0]!.workingTreeId;
    const worktreeVisualId = layout.renderNodes.find((node) => node.commit.id === worktreeId)?.commit.visualId;
    const fallbackVisualId = layout.renderNodes.find((node) => node.commit.id === mainSha)?.commit.visualId;
    expect(layout.nodeWarnings.get(worktreeId)).toBeUndefined();
    expect(layout.connectors.some((connector) =>
      connector.fromCommitVisualId === fallbackVisualId && connector.toCommitVisualId === worktreeVisualId
    )).toBe(true);
  });
});
