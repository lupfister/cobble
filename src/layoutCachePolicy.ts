export type SnapshotLayoutApplyOptions = {
  force?: boolean;
  allowProjectSwitch?: boolean;
  needsLayoutRebuild?: boolean;
};

export function shouldRebuildLayoutAfterSnapshotApply(
  options?: SnapshotLayoutApplyOptions,
): boolean {
  return options?.force === true && options.needsLayoutRebuild === true;
}

export function bumpLayoutEpochForRepo(
  previous: Readonly<Record<string, number>>,
  repoPath: string,
): Record<string, number> {
  return {
    ...previous,
    [repoPath]: (previous[repoPath] ?? 0) + 1,
  };
}

export function layoutCanFinishProjectLoad(input: {
  isCurrent: boolean;
  isComplete: boolean;
  status: 'idle' | 'computing' | 'ready' | 'error';
  isPartial: boolean;
}): boolean {
  if (!input.isCurrent) return false;
  if (input.status !== 'ready') return false;
  return input.isComplete || input.isPartial;
}
