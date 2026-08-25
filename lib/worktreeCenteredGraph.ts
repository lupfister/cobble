import type { Branch, BranchCommitPreview, DirectCommit, MergeNode } from '../types';

type CommitLike = BranchCommitPreview | DirectCommit;

export type WorktreeCenteredGraphInput = {
  branches: Branch[];
  worktreeBranchNames: string[];
  directCommits: DirectCommit[];
  unpushedDirectCommits: DirectCommit[];
  branchCommitPreviews: Record<string, BranchCommitPreview[]>;
  mergeNodes: MergeNode[];
  defaultBranch: string;
  branchUniqueAheadCounts: Record<string, number>;
};

export type WorktreeCenteredGraph = WorktreeCenteredGraphInput & {
  hiddenCommitCount: number;
};

const matchesSha = (left: string | null | undefined, right: string | null | undefined): boolean => {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
};

const parentShaOf = (commit: CommitLike): string | null =>
  commit.parentSha ?? commit.parentShas?.[0] ?? null;

const isStructuralState = (commit: CommitLike): boolean =>
  commit.kind != null && commit.kind !== 'commit';

/**
 * Reduces repository history to lines of work. A normal commit remains visible only when it is
 * a branch head or a fork point needed to explain another branch. Worktree and stash states stay
 * visible because they describe active local work rather than historical detail.
 */
export function buildWorktreeCenteredGraph(input: WorktreeCenteredGraphInput): WorktreeCenteredGraph {
  const sourceBranchByName = new Map(input.branches.map((branch) => [branch.name, branch]));
  const visibleBranchNames = new Set<string>([input.defaultBranch]);
  const addBranchProvenance = (branchName: string) => {
    let currentName: string | null = branchName;
    const visited = new Set<string>();
    while (currentName && !visited.has(currentName)) {
      visited.add(currentName);
      visibleBranchNames.add(currentName);
      currentName = sourceBranchByName.get(currentName)?.parentBranch ?? null;
    }
  };
  input.worktreeBranchNames.forEach(addBranchProvenance);
  const branches = input.branches.filter((branch) => visibleBranchNames.has(branch.name));

  const commitBySha = new Map<string, CommitLike>();
  const register = (commit: CommitLike) => {
    if (!commit.fullSha) return;
    const current = commitBySha.get(commit.fullSha);
    if (!current || ('branch' in commit && !('branch' in current))) {
      commitBySha.set(commit.fullSha, commit);
    }
  };
  input.directCommits.forEach(register);
  Object.values(input.branchCommitPreviews).flat().forEach(register);

  const retainedShas = new Set<string>();
  const retainMatchingSha = (sha: string | null | undefined) => {
    if (!sha) return;
    const exact = commitBySha.has(sha) ? sha : Array.from(commitBySha.keys()).find((candidate) => matchesSha(candidate, sha));
    retainedShas.add(exact ?? sha);
  };

  for (const branch of branches) retainMatchingSha(branch.headSha);

  const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
  for (const branch of branches) {
    if (branch.name === input.defaultBranch) continue;
    const forkSha = branch.divergedFromSha ?? branch.createdFromSha ?? branch.presidesFromSha ?? null;
    const parentHead = branch.parentBranch ? branchByName.get(branch.parentBranch)?.headSha : null;
    if (forkSha && !matchesSha(forkSha, parentHead)) retainMatchingSha(forkSha);
  }

  for (const commit of commitBySha.values()) {
    if (!isStructuralState(commit)) continue;
    retainedShas.add(commit.fullSha);
    // A dirty worktree replaces its branch head with a synthetic ID. Keep the real checked-out
    // commit so the worktree always has an ancestry connector into the retained branch graph.
    retainMatchingSha(parentShaOf(commit));
  }

  const nearestRetainedParent = (commit: CommitLike): string | null => {
    let parentSha = parentShaOf(commit);
    const visited = new Set<string>();
    while (parentSha && !Array.from(retainedShas).some((retained) => matchesSha(retained, parentSha))) {
      if (visited.has(parentSha)) return null;
      visited.add(parentSha);
      const parent = commitBySha.get(parentSha)
        ?? Array.from(commitBySha.entries()).find(([sha]) => matchesSha(sha, parentSha))?.[1];
      if (!parent) return null;
      parentSha = parentShaOf(parent);
    }
    return parentSha;
  };

  const rewrite = <T extends CommitLike>(commit: T): T => {
    if (isStructuralState(commit)) return commit;
    const parentSha = nearestRetainedParent(commit);
    return {
      ...commit,
      parentSha,
      parentShas: parentSha ? [parentSha] : [],
      childShas: [],
    };
  };
  const isRetained = (commit: CommitLike) =>
    isStructuralState(commit) || Array.from(retainedShas).some((sha) => matchesSha(sha, commit.fullSha));

  const directCommits = input.directCommits.filter(isRetained).map(rewrite);
  const directShaSet = new Set(directCommits.map((commit) => commit.fullSha));
  const branchCommitPreviews = Object.fromEntries(
    Object.entries(input.branchCommitPreviews)
      .filter(([branchName, previews]) => (
        visibleBranchNames.has(branchName)
        || previews.some(isStructuralState)
      ))
      .map(([branchName, previews]) => [
        branchName,
        previews.filter(isRetained).map(rewrite),
      ]),
  );
  const unpushedDirectCommits = input.unpushedDirectCommits.filter(isRetained).map(rewrite);
  const visibleConcreteByBranch = new Map<string, number>();
  for (const commit of directCommits) {
    if (isStructuralState(commit)) continue;
    visibleConcreteByBranch.set(commit.branch, (visibleConcreteByBranch.get(commit.branch) ?? 0) + 1);
  }

  return {
    ...input,
    branches,
    directCommits,
    unpushedDirectCommits,
    branchCommitPreviews,
    mergeNodes: input.mergeNodes.filter((node) =>
      retainedShas.has(node.fullSha)
      || retainedShas.has(node.sha)
      || retainedShas.has(node.targetCommitSha),
    ),
    branchUniqueAheadCounts: Object.fromEntries(
      branches.map((branch) => [branch.name, Math.max(1, visibleConcreteByBranch.get(branch.name) ?? 1)]),
    ),
    hiddenCommitCount: Math.max(0, input.directCommits.length - directShaSet.size),
  };
}
