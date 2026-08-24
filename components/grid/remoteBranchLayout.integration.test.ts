import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Branch, DirectCommit } from '../../types';
import { computeBranchGridLayout } from './branchGridLayoutModel';

const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();

const hasRemoteBranch = (): boolean => {
  try {
    execSync('git rev-parse --verify origin/cursor/commit-app-previews-7896', { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

describe('remote branch layout integration', () => {
  it('renders origin cursor branch commit on the map with full main history', () => {
    if (!hasRemoteBranch()) return;

    const forkSha = execSync('git merge-base main origin/cursor/commit-app-previews-7896', { cwd: repoRoot })
      .toString()
      .trim();
    const remoteTip = execSync('git rev-parse origin/cursor/commit-app-previews-7896', { cwd: repoRoot })
      .toString()
      .trim();
    const mainHead = execSync('git rev-parse main', { cwd: repoRoot }).toString().trim();
    const mainLog = execSync('git log --first-parent --format="%H|%P|%cI|%s" main', {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    const remoteMeta = execSync('git log -1 --format="%H|%cI|%s|%an" origin/cursor/commit-app-previews-7896', {
      cwd: repoRoot,
    })
      .toString()
      .trim()
      .split('|');
    const [remoteFullSha, remoteDate, remoteMessage, remoteAuthor] = remoteMeta;

    const directCommits: DirectCommit[] = [];
    for (const line of mainLog) {
      const [fullSha, parentShasRaw, date, message] = line.split('|');
      const parentSha = parentShasRaw.split(' ').filter(Boolean)[0] ?? null;
      directCommits.push({
        fullSha,
        sha: fullSha.slice(0, 7),
        branch: 'main',
        message,
        author: 'dev',
        date,
        parentSha,
        parentShas: parentSha ? [parentSha] : [],
        childShas: [],
      });
    }

    const remoteBranchName = 'cursor/commit-app-previews-7896';
    directCommits.push({
      fullSha: remoteFullSha,
      sha: remoteFullSha.slice(0, 7),
      branch: remoteBranchName,
      message: remoteMessage,
      author: remoteAuthor,
      date: remoteDate,
      parentSha: forkSha,
      parentShas: [forkSha],
      childShas: [],
      isRemote: true,
    });

    const branches: Branch[] = [
      {
        name: 'main',
        commitsAhead: 0,
        commitsBehind: 0,
        lastCommitDate: directCommits[0]?.date ?? '',
        lastCommitAuthor: 'dev',
        status: 'fresh',
        remoteSyncStatus: 'on-github',
        unpushedCommits: 0,
        headSha: mainHead,
      },
      {
        name: remoteBranchName,
        commitsAhead: 1,
        commitsBehind: 0,
        lastCommitDate: remoteDate,
        lastCommitAuthor: remoteAuthor,
        status: 'fresh',
        remoteSyncStatus: 'on-github',
        unpushedCommits: 0,
        headSha: remoteTip,
        parentBranch: 'main',
        divergedFromSha: forkSha,
      },
    ];

    const layout = computeBranchGridLayout({
      branches,
      mergeNodes: [],
      directCommits,
      unpushedDirectCommits: [],
      defaultBranch: 'main',
      branchCommitPreviews: {
        [remoteBranchName]: [{
          fullSha: remoteFullSha,
          sha: remoteFullSha.slice(0, 7),
          parentSha: forkSha,
          message: remoteMessage,
          author: remoteAuthor,
          date: remoteDate,
          kind: 'commit',
          isRemote: true,
        }],
      },
      branchParentByName: {
        main: null,
        [remoteBranchName]: 'main',
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

    const forkNode = layout.renderNodes.find((node) => node.commit.id === forkSha);
    const remoteNode = layout.renderNodes.find(
      (node) => node.commit.branchName === remoteBranchName && node.commit.id === remoteFullSha,
    );

    expect(forkNode, `fork ${forkSha.slice(0, 7)} missing from renderNodes`).toBeDefined();
    expect(remoteNode, `remote tip ${remoteFullSha.slice(0, 7)} missing from renderNodes`).toBeDefined();
    expect(remoteNode!.row).toBeGreaterThan(forkNode!.row);
    expect(remoteNode!.column).toBeGreaterThan(forkNode!.column);
  });
});
