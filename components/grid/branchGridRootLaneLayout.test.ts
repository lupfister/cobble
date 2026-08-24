import { describe, expect, it } from 'vitest';
import type { Branch, DirectCommit } from '../../types';
import { computeBranchGridLayout } from './branchGridLayoutModel';

const rootA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const rootB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const childOnA = 'cccccccccccccccccccccccccccccccccccccccc';

const makeBranch = (name: string, headSha: string): Branch => ({
  name,
  commitsAhead: 0,
  commitsBehind: 0,
  lastCommitDate: '2024-06-02T12:00:00Z',
  lastCommitAuthor: 'test',
  status: 'fresh',
  remoteSyncStatus: 'on-github',
  unpushedCommits: 0,
  headSha,
  parentBranch: 'main',
});

describe('computeBranchGridLayout root lane assignment', () => {
  const expectEveryConnectorRightAndDown = (layout: ReturnType<typeof computeBranchGridLayout>) => {
    const nodeByVisualId = new Map(layout.renderNodes.map((node) => [node.commit.visualId, node] as const));
    for (const connector of [...layout.connectors, ...layout.mergeConnectors]) {
      if (!connector.fromCommitVisualId || !connector.toCommitVisualId) continue;
      const parent = nodeByVisualId.get(connector.fromCommitVisualId);
      const child = nodeByVisualId.get(connector.toCommitVisualId);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      const parentClusterKey = layout.clusterKeyByCommitId.get(parent!.commit.visualId);
      const childClusterKey = layout.clusterKeyByCommitId.get(child!.commit.visualId);
      if (parentClusterKey && parentClusterKey === childClusterKey) {
        expect(child!.row).toBe(parent!.row);
        expect(child!.column).toBeGreaterThan(parent!.column);
      } else {
        expect(child!.row).toBeGreaterThan(parent!.row);
        expect(child!.column).toBeGreaterThan(parent!.column);
      }
      expect(child!.x).toBeGreaterThanOrEqual(parent!.x);
      if (parentClusterKey && parentClusterKey === childClusterKey) {
        expect(child!.y).toBeGreaterThan(parent!.y);
      } else {
        expect(child!.y).toBeGreaterThan(parent!.y);
      }
    }
  };

  it('places unrelated root branches in separate columns', () => {
    const defaultBranch = 'main';
    const branches = [
      makeBranch(defaultBranch, childOnA),
      makeBranch('orphan', rootB),
    ];
    const directCommits: DirectCommit[] = [
      {
        fullSha: rootA,
        sha: rootA.slice(0, 7),
        branch: defaultBranch,
        message: 'root main',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: childOnA,
        sha: childOnA.slice(0, 7),
        branch: defaultBranch,
        message: 'child',
        author: 'other',
        date: '2024-06-01T12:00:00Z',
        parentSha: rootA,
        parentShas: [rootA],
      },
      {
        fullSha: rootB,
        sha: rootB.slice(0, 7),
        branch: 'orphan',
        message: 'root orphan',
        author: 'test',
        date: '2024-06-02T12:00:00Z',
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
      branchCommitPreviews: { main: [], orphan: [] },
      branchParentByName: { main: null, orphan: null },
      branchUniqueAheadCounts: { main: 1, orphan: 0 },
      manuallyOpenedClumps: new Set(),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: { branchName: defaultBranch, headSha: childOnA, hasUncommittedChanges: false },
      orientation: 'horizontal',
    });

    const mainNode = layout.renderNodes.find((node) => node.commit.branchName === defaultBranch);
    const orphanRoot = layout.renderNodes.find((node) => node.commit.id === rootB);
    expect(mainNode).toBeDefined();
    expect(orphanRoot).toBeDefined();
    expect(orphanRoot!.column).not.toBe(mainNode!.column);
    expectEveryConnectorRightAndDown(layout);
  });

  it('keeps a same-branch clump override anchored while opening below it', () => {
    const defaultBranch = 'main';
    const branches = [makeBranch(defaultBranch, childOnA)];
    const directCommits: DirectCommit[] = [
      {
        fullSha: rootA,
        sha: rootA.slice(0, 7),
        branch: defaultBranch,
        message: 'root main',
        author: 'test',
        date: '2024-05-01T12:00:00Z',
        parentSha: null,
        parentShas: [],
      },
      {
        fullSha: childOnA,
        sha: childOnA.slice(0, 7),
        branch: defaultBranch,
        message: 'child',
        author: 'other',
        date: '2024-06-01T12:00:00Z',
        parentSha: rootA,
        parentShas: [rootA],
      },
    ];
    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: { main: [] },
      branchParentByName: { main: null },
      branchUniqueAheadCounts: { main: 1 },
      manuallyOpenedClumps: new Set([`cluster:main:start:${rootA}`]),
      manuallyClosedClumps: new Set(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal',
      nodePositionOverrides: {
        [childOnA]: { x: 55, y: 200 },
      },
    });

    const parent = layout.renderNodes.find((node) => node.commit.id === rootA)!;
    const child = layout.renderNodes.find((node) => node.commit.id === childOnA)!;
    expect(child.column).toBeGreaterThan(parent.column);
    expect(child.y).toBeGreaterThan(parent.y);
    expectEveryConnectorRightAndDown(layout);
  });
});
