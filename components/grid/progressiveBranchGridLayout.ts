import type { Branch, DirectCommit } from '../../types';
import type { BranchGridLayoutInput } from './branchGridLayoutModel';

const PROGRESSIVE_ITEM_LIMITS = [500, 1_500, 3_500, 7_000, 12_000] as const;

const safeTime = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const fullSha = (value: { fullSha: string; sha: string }): string => value.fullSha || value.sha;

const allCommitShas = (input: BranchGridLayoutInput): Set<string> => {
  const shas = new Set<string>();
  for (const commit of input.directCommits) shas.add(fullSha(commit));
  for (const commit of input.unpushedDirectCommits) shas.add(fullSha(commit));
  for (const previews of Object.values(input.branchCommitPreviews)) {
    for (const preview of previews) shas.add(fullSha(preview));
  }
  return shas;
};

export const estimateBranchGridLayoutItems = (input: BranchGridLayoutInput): number =>
  input.branches.length + allCommitShas(input).size;

export const progressiveBranchGridLayoutLimits = (totalItems: number): number[] => {
  if (totalItems <= 0) return [0];
  const limits = PROGRESSIVE_ITEM_LIMITS.filter((limit) => limit < totalItems);
  return [...limits, totalItems];
};

const prioritizedBranches = (input: BranchGridLayoutInput): Branch[] => {
  const pinnedNames = new Set<string>([input.defaultBranch]);
  if (input.checkedOutRef?.branchName) pinnedNames.add(input.checkedOutRef.branchName);
  for (const session of input.worktreeSessions ?? []) {
    if (session.branchName) pinnedNames.add(session.branchName);
  }

  return input.branches
    .map((branch, index) => ({ branch, index }))
    .sort((left, right) => {
      const pinnedDelta = Number(pinnedNames.has(right.branch.name)) - Number(pinnedNames.has(left.branch.name));
      if (pinnedDelta !== 0) return pinnedDelta;
      const dateDelta = safeTime(right.branch.lastCommitDate) - safeTime(left.branch.lastCommitDate);
      if (dateDelta !== 0) return dateDelta;
      return left.index - right.index;
    })
    .map(({ branch }) => branch);
};

type CommitCandidate = {
  sha: string;
  parentShas: string[];
  date: string;
  branchNames: Set<string>;
  index: number;
};

const collectCommitCandidates = (input: BranchGridLayoutInput): Map<string, CommitCandidate> => {
  const candidates = new Map<string, CommitCandidate>();
  let index = 0;
  const add = (
    commit: Pick<DirectCommit, 'fullSha' | 'sha' | 'parentSha' | 'parentShas' | 'date'>,
    branchName: string,
  ) => {
    const sha = fullSha(commit);
    const existing = candidates.get(sha);
    if (existing) {
      existing.branchNames.add(branchName);
      return;
    }
    candidates.set(sha, {
      sha,
      parentShas: commit.parentShas?.length
        ? commit.parentShas
        : commit.parentSha
          ? [commit.parentSha]
          : [],
      date: commit.date,
      branchNames: new Set([branchName]),
      index,
    });
    index += 1;
  };

  for (const commit of input.directCommits) add(commit, commit.branch);
  for (const commit of input.unpushedDirectCommits) add(commit, commit.branch);
  for (const [branchName, previews] of Object.entries(input.branchCommitPreviews)) {
    for (const preview of previews) {
      add(
        {
          ...preview,
          parentShas: preview.parentShas ?? [],
        },
        branchName,
      );
    }
  }
  return candidates;
};

const selectCommitShas = (
  input: BranchGridLayoutInput,
  selectedBranchNames: ReadonlySet<string>,
  commitLimit: number,
): Set<string> => {
  const candidates = collectCommitCandidates(input);
  const branchRank = new Map(
    prioritizedBranches(input).map((branch, index) => [branch.name, index]),
  );
  const pinnedShas = new Set<string>();
  if (input.checkedOutRef?.headSha) pinnedShas.add(input.checkedOutRef.headSha);
  if (input.checkedOutRef?.parentSha) pinnedShas.add(input.checkedOutRef.parentSha);
  if (input.gridFocusSha) pinnedShas.add(input.gridFocusSha);
  for (const session of input.worktreeSessions ?? []) {
    pinnedShas.add(session.headSha);
    if (session.parentSha) pinnedShas.add(session.parentSha);
  }
  for (const branch of input.branches) {
    if (selectedBranchNames.has(branch.name)) pinnedShas.add(branch.headSha);
  }

  const eligibleCandidates = [...candidates.values()].filter((candidate) =>
    pinnedShas.has(candidate.sha)
    || [...candidate.branchNames].some((name) => selectedBranchNames.has(name)),
  );
  const eligibleShas = new Set(eligibleCandidates.map((candidate) => candidate.sha));
  const ordered = eligibleCandidates.sort((left, right) => {
    const pinnedDelta = Number(pinnedShas.has(right.sha)) - Number(pinnedShas.has(left.sha));
    if (pinnedDelta !== 0) return pinnedDelta;
    const leftBranchRank = Math.min(...[...left.branchNames].map((name) => branchRank.get(name) ?? Number.MAX_SAFE_INTEGER));
    const rightBranchRank = Math.min(...[...right.branchNames].map((name) => branchRank.get(name) ?? Number.MAX_SAFE_INTEGER));
    if (leftBranchRank !== rightBranchRank) return leftBranchRank - rightBranchRank;
    const dateDelta = safeTime(right.date) - safeTime(left.date);
    if (dateDelta !== 0) return dateDelta;
    return left.index - right.index;
  });

  const selected = new Set<string>();
  const addWithParents = (sha: string) => {
    const pending = [sha];
    while (pending.length > 0 && selected.size < commitLimit) {
      const currentSha = pending.pop();
      if (!currentSha || selected.has(currentSha)) continue;
      const candidate = candidates.get(currentSha);
      if (!candidate || !eligibleShas.has(currentSha)) continue;
      selected.add(currentSha);
      for (let index = candidate.parentShas.length - 1; index >= 0; index -= 1) {
        pending.push(candidate.parentShas[index]);
      }
    }
  };
  for (const candidate of ordered) {
    if (selected.size >= commitLimit) break;
    addWithParents(candidate.sha);
  }
  return selected;
};

const filterRecord = <T,>(
  source: Record<string, T>,
  selectedBranchNames: ReadonlySet<string>,
): Record<string, T> => Object.fromEntries(
  Object.entries(source).filter(([branchName]) => selectedBranchNames.has(branchName)),
);

export const sliceBranchGridLayoutInput = (
  input: BranchGridLayoutInput,
  itemLimit: number,
): BranchGridLayoutInput => {
  const totalItems = estimateBranchGridLayoutItems(input);
  if (itemLimit >= totalItems) return input;

  const branchLimit = Math.min(
    input.branches.length,
    Math.max(1, Math.min(Math.floor(itemLimit * 0.35), itemLimit - 1)),
  );
  const selectedBranchNames = new Set(
    prioritizedBranches(input).slice(0, branchLimit).map((branch) => branch.name),
  );
  const selectedBranches = input.branches.filter((branch) => selectedBranchNames.has(branch.name));
  const selectedShas = selectCommitShas(input, selectedBranchNames, Math.max(1, itemLimit - branchLimit));
  const hasSelectedSha = (commit: { fullSha: string; sha: string }) => selectedShas.has(fullSha(commit));
  const branchCommitPreviews = Object.fromEntries(
    Object.entries(input.branchCommitPreviews)
      .filter(([branchName]) => selectedBranchNames.has(branchName))
      .map(([branchName, previews]) => [branchName, previews.filter(hasSelectedSha)]),
  );

  return {
    ...input,
    branches: selectedBranches,
    directCommits: input.directCommits.filter((commit) =>
      selectedBranchNames.has(commit.branch) && hasSelectedSha(commit),
    ),
    unpushedDirectCommits: input.unpushedDirectCommits.filter((commit) =>
      selectedBranchNames.has(commit.branch) && hasSelectedSha(commit),
    ),
    branchCommitPreviews,
    mergeNodes: input.mergeNodes.filter((mergeNode) =>
      selectedBranchNames.has(mergeNode.targetBranch)
      && (selectedShas.has(mergeNode.fullSha) || selectedShas.has(mergeNode.targetCommitSha)),
    ),
    unpushedCommitShasByBranch: Object.fromEntries(
      Object.entries(input.unpushedCommitShasByBranch ?? {})
        .filter(([branchName]) => selectedBranchNames.has(branchName))
        .map(([branchName, shas]) => [branchName, shas.filter((sha) => selectedShas.has(sha))]),
    ),
    branchParentByName: filterRecord(input.branchParentByName ?? {}, selectedBranchNames),
    branchUniqueAheadCounts: filterRecord(input.branchUniqueAheadCounts, selectedBranchNames),
    graphLayoutSignature: `${input.graphLayoutSignature ?? ''}::progress:${itemLimit}:${totalItems}`,
  };
};

export type ProgressiveBranchGridLayoutStage = {
  input: BranchGridLayoutInput;
  processedItems: number;
  totalItems: number;
  complete: boolean;
  stageIndex: number;
  stageCount: number;
};

export const buildProgressiveBranchGridLayoutStages = (
  input: BranchGridLayoutInput,
): ProgressiveBranchGridLayoutStage[] => {
  const totalItems = estimateBranchGridLayoutItems(input);
  const limits = progressiveBranchGridLayoutLimits(totalItems);
  return limits.map((limit, index) => ({
    input: sliceBranchGridLayoutInput(input, limit),
    processedItems: limit,
    totalItems,
    complete: limit >= totalItems,
    stageIndex: index + 1,
    stageCount: limits.length,
  }));
};
