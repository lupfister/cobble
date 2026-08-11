import { describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../lib/worktreeSessions';
import type { Branch, BranchCommitPreview, DirectCommit } from '../../types';
import { CARD_BODY_TOP_OFFSET, CARD_HEIGHT, CARD_WIDTH } from './LayoutGrid';
import { computeBranchGridLayout } from './branchGridLayoutModel';
import { getMapGridConnectorPolyline } from './gridPathUtils';

describe('computeBranchGridLayout large graph perf', () => {
  it('completes within a loose CI time budget', () => {
    const defaultBranch = 'main';
    const commitCount = 1_900;
    const shas = Array.from({ length: commitCount }, (_, index) =>
      index.toString(16).padStart(40, '0'));
    const directCommits: DirectCommit[] = shas.map((fullSha, index) => ({
      fullSha,
      sha: fullSha.slice(0, 7),
      branch: defaultBranch,
      message: `commit ${index}`,
      author: 'perf',
      date: `2024-01-${String((index % 27) + 1).padStart(2, '0')}T12:00:00Z`,
      parentSha: index === 0 ? null : shas[index - 1],
      parentShas: index === 0 ? [] : [shas[index - 1]],
      childShas: index === commitCount - 1 ? [] : [shas[index + 1]],
    }));
    const branches: Branch[] = [{
      name: defaultBranch,
      commitsAhead: commitCount,
      commitsBehind: 0,
      lastCommitDate: directCommits[commitCount - 1]?.date ?? '',
      lastCommitAuthor: 'perf',
      status: 'fresh',
      remoteSyncStatus: 'local-only',
      unpushedCommits: 0,
      headSha: shas[commitCount - 1],
      divergedFromSha: shas[0],
    }];

    const input = {
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews: { [defaultBranch]: [] },
      branchParentByName: { [defaultBranch]: null },
      branchUniqueAheadCounts: { [defaultBranch]: commitCount },
      manuallyOpenedClumps: new Set<string>(),
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: null,
      orientation: 'horizontal' as const,
    };
    const started = performance.now();
    const layout = computeBranchGridLayout(input);
    const elapsedMs = performance.now() - started;

    expect(layout.renderNodes.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('keeps worktree ancestry and connector clearance valid above the large-graph threshold', () => {
    const defaultBranch = 'main';
    const rootSha = 'f'.repeat(40);
    const root: DirectCommit = {
      fullSha: rootSha,
      sha: rootSha.slice(0, 7),
      branch: defaultBranch,
      message: 'root',
      author: 'perf',
      date: '2026-01-01T12:00:00Z',
      parentSha: null,
      parentShas: [],
    };
    const featureCount = 260;
    const branches: Branch[] = [{
      name: defaultBranch,
      commitsAhead: 0,
      commitsBehind: 0,
      lastCommitDate: root.date,
      lastCommitAuthor: 'perf',
      status: 'fresh',
      remoteSyncStatus: 'local-only',
      unpushedCommits: 0,
      headSha: rootSha,
    }];
    const branchCommitPreviews: Record<string, BranchCommitPreview[]> = { [defaultBranch]: [] };
    const branchParentByName: Record<string, string | null> = { [defaultBranch]: null };
    const branchUniqueAheadCounts: Record<string, number> = { [defaultBranch]: 0 };
    let checkedOutBranch = '';
    let checkedOutHeadSha = '';

    for (let index = 0; index < featureCount; index += 1) {
      const branchName = `feature-${index}`;
      const firstSha = (index + 1).toString(16).padStart(40, '0');
      const previews: BranchCommitPreview[] = [{
        fullSha: firstSha,
        sha: firstSha.slice(0, 7),
        parentSha: rootSha,
        parentShas: [rootSha],
        message: `feature ${index}`,
        author: 'perf',
        date: `2026-02-${String((index % 27) + 1).padStart(2, '0')}T12:00:00Z`,
      }];
      if (index === featureCount - 1) {
        const secondSha = 'a'.repeat(39) + '1';
        const thirdSha = 'a'.repeat(39) + '2';
        previews.push(
          {
            fullSha: secondSha,
            sha: secondSha.slice(0, 7),
            parentSha: firstSha,
            parentShas: [firstSha],
            message: 'checked out branch middle',
            author: 'perf',
            date: '2026-03-01T12:00:00Z',
          },
          {
            fullSha: thirdSha,
            sha: thirdSha.slice(0, 7),
            parentSha: secondSha,
            parentShas: [secondSha],
            message: 'checked out branch head',
            author: 'perf',
            date: '2026-03-02T12:00:00Z',
          },
          {
            fullSha: 'WORKING_TREE',
            sha: 'uncommitted',
            parentSha: thirdSha,
            message: '',
            author: 'You',
            date: '2026-03-02T12:00:00Z',
            kind: 'uncommitted',
          },
        );
        checkedOutBranch = branchName;
        checkedOutHeadSha = thirdSha;
      }
      const concretePreviews = previews.filter((preview) => preview.kind !== 'uncommitted');
      const headSha = concretePreviews[concretePreviews.length - 1]!.fullSha;
      branches.push({
        name: branchName,
        commitsAhead: previews.filter((preview) => preview.kind !== 'uncommitted').length,
        commitsBehind: 0,
        lastCommitDate: previews[previews.length - 1]!.date,
        lastCommitAuthor: 'perf',
        status: 'fresh',
        remoteSyncStatus: 'local-only',
        unpushedCommits: 0,
        headSha,
        parentBranch: defaultBranch,
        divergedFromSha: rootSha,
      });
      branchCommitPreviews[branchName] = previews;
      branchParentByName[branchName] = defaultBranch;
      branchUniqueAheadCounts[branchName] = previews.filter((preview) => preview.kind !== 'uncommitted').length;
    }

    const worktreeSessions: WorktreeSession[] = [{
      path: '/repo',
      pathExists: true,
      branchName: checkedOutBranch,
      headSha: checkedOutHeadSha,
      parentSha: null,
      hasUncommittedChanges: true,
      isCurrent: true,
      accentToken: 'checked',
      workingTreeId: 'WORKING_TREE',
    }];
    const input = {
      branches,
      mergeNodes: [],
      directCommits: [root],
      unpushedDirectCommits: [],
      defaultBranch,
      branchCommitPreviews,
      branchParentByName,
      branchUniqueAheadCounts,
      manuallyOpenedClumps: new Set<string>(),
      manuallyClosedClumps: new Set<string>(),
      isDebugOpen: false,
      gridSearchQuery: '',
      gridFocusSha: null,
      checkedOutRef: {
        branchName: checkedOutBranch,
        headSha: checkedOutHeadSha,
        hasUncommittedChanges: true,
      },
      worktreeSessions,
      orientation: 'horizontal' as const,
    };
    const collapsed = computeBranchGridLayout(input);
    const clusterKey = collapsed.clusterKeyByCommitId.get(`${checkedOutBranch}:${checkedOutHeadSha}`);
    expect(clusterKey).toBeDefined();
    const layout = computeBranchGridLayout({
      ...input,
      manuallyOpenedClumps: new Set([clusterKey!]),
    });
    expect(layout.renderNodes.length).toBeGreaterThan(240);
    const parent = layout.renderNodes.find((node) => node.commit.id === checkedOutHeadSha)!;
    const worktree = layout.renderNodes.find((node) => node.commit.id === 'WORKING_TREE')!;
    expect(worktree.row).toBe(parent.row + 1);
    expect(worktree.column).toBeGreaterThan(parent.column);

    const renderedNodeByVisualId = new Map(
      layout.renderNodes.map((node) => [node.commit.visualId, node] as const),
    );
    for (const connector of [...layout.connectors, ...layout.mergeConnectors]) {
      const connectorParent = connector.fromCommitVisualId
        ? renderedNodeByVisualId.get(connector.fromCommitVisualId)
        : undefined;
      const connectorChild = connector.toCommitVisualId
        ? renderedNodeByVisualId.get(connector.toCommitVisualId)
        : undefined;
      if (connectorParent && connectorChild) {
        expect(
          connectorChild.row,
          `${connector.id} points backward`,
        ).toBeGreaterThanOrEqual(connectorParent.row);
        expect(
          connectorChild.column,
          `${connector.id} places its child above its parent`,
        ).toBeGreaterThan(connectorParent.column);
      }
      const points = getMapGridConnectorPolyline(
        connector.fromX,
        connector.fromY,
        connector.toX,
        connector.toY,
        connector.fromFace,
        connector.toFace,
      );
      for (const blocker of layout.renderNodes) {
        if (blocker.commit.visualId === connector.fromCommitVisualId) continue;
        if (blocker.commit.visualId === connector.toCommitVisualId) continue;
        const rect = {
          left: blocker.x,
          right: blocker.x + CARD_WIDTH,
          top: blocker.y - CARD_BODY_TOP_OFFSET,
          bottom: blocker.y + CARD_HEIGHT,
        };
        const intersects = points.some((point, pointIndex) => {
          if (pointIndex === 0) return false;
          const previous = points[pointIndex - 1]!;
          const minX = Math.min(previous.x, point.x);
          const maxX = Math.max(previous.x, point.x);
          const minY = Math.min(previous.y, point.y);
          const maxY = Math.max(previous.y, point.y);
          if (Math.abs(previous.x - point.x) < 0.5) {
            return previous.x >= rect.left && previous.x <= rect.right && maxY >= rect.top && minY <= rect.bottom;
          }
          if (Math.abs(previous.y - point.y) < 0.5) {
            return previous.y >= rect.top && previous.y <= rect.bottom && maxX >= rect.left && minX <= rect.right;
          }
          return maxX >= rect.left && minX <= rect.right && maxY >= rect.top && minY <= rect.bottom;
        });
        expect(intersects, `${connector.id} crosses ${blocker.commit.visualId}`).toBe(false);
      }
    }
  });
});
