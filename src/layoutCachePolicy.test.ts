import { describe, expect, it } from 'vitest';
import {
  bumpLayoutEpochForRepo,
  layoutCanFinishProjectLoad,
  shouldRebuildLayoutAfterSnapshotApply,
} from './layoutCachePolicy';

describe('snapshot layout cache policy', () => {
  it('keeps the cached layout when a project becomes active', () => {
    expect(shouldRebuildLayoutAfterSnapshotApply({
      force: true,
      allowProjectSwitch: true,
    })).toBe(false);
  });

  it('rebuilds only when the caller reports a topology change', () => {
    expect(shouldRebuildLayoutAfterSnapshotApply({
      force: true,
      needsLayoutRebuild: true,
    })).toBe(true);
  });

  it('does not invalidate another repository when one map is redrawn', () => {
    expect(bumpLayoutEpochForRepo({ '/repo/a': 2, '/repo/b': 4 }, '/repo/a')).toEqual({
      '/repo/a': 3,
      '/repo/b': 4,
    });
  });

  it('finishes a project load only for its current usable layout', () => {
    expect(layoutCanFinishProjectLoad({
      isCurrent: true,
      isComplete: true,
      status: 'ready',
      isPartial: false,
    })).toBe(true);
    expect(layoutCanFinishProjectLoad({
      isCurrent: true,
      isComplete: false,
      status: 'ready',
      isPartial: true,
    })).toBe(true);
    expect(layoutCanFinishProjectLoad({
      isCurrent: false,
      isComplete: true,
      status: 'ready',
      isPartial: false,
    })).toBe(false);
    expect(layoutCanFinishProjectLoad({
      isCurrent: true,
      isComplete: true,
      status: 'computing',
      isPartial: false,
    })).toBe(false);
    expect(layoutCanFinishProjectLoad({
      isCurrent: true,
      isComplete: false,
      status: 'computing',
      isPartial: true,
    })).toBe(false);
  });
});
