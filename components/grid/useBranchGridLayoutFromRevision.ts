import { useEffect, useMemo, useRef, useState, startTransition, type MutableRefObject } from 'react';
import type { BranchGridLayoutModel } from './branchGridLayoutModel';
import {
  buildBranchGridLayoutInput,
  toWorkerBranchGridLayoutInput,
  type BranchGridLayoutRevision,
} from './branchGridLayoutInput';
import { computeBranchGridLayoutWithPerf, markLayoutCacheHit } from './branchGridLayoutPerf';
import type {
  BranchGridLayoutWorkerRequest,
  BranchGridLayoutWorkerResponse,
} from './branchGridLayoutWorker';
import { hydrateBranchGridLayoutModel } from './layoutSnapshot';
import { layoutModelHasWorkingTree } from './workingTreeLayout';

type LayoutResolveSource = 'hydrated' | 'memory' | 'needs-compute';

const EMPTY_LAYOUT_MODEL: BranchGridLayoutModel = {
  branchByName: new Map(),
  laneByName: new Map(),
  mainCommits: [],
  branchCommitsByLane: new Map(),
  branchPreviewSets: new Map(),
  allCommits: [],
  clustersByBranch: new Map(),
  clusterKeyByCommitId: new Map(),
  clusterKeyBySha: new Map(),
  leadByClusterKey: new Map(),
  firstByClusterKey: new Map(),
  clusterCounts: new Map(),
  debugRows: [],
  branchDebugRows: [],
  nodes: [],
  normalizedSearchQuery: '',
  matchingNodes: [],
  matchingNodeIds: new Set(),
  focusedNode: null,
  checkedOutClusterKey: null,
  defaultCollapsedClumps: new Set(),
  visibleCommitsList: [],
  renderNodes: [],
  visibleNodesBySha: new Map(),
  visibleNodeByClusterKey: new Map(),
  pointFormatter: () => '',
  contentWidth: 0,
  contentHeight: 0,
  connectors: [],
  mergeConnectors: [],
  connectorDecisions: [],
  nodeWarnings: new Map(),
  connectorParentShas: new Set(),
  branchStartShas: new Set(),
  branchOffNodeShas: new Set(),
  crossBranchOutgoingShas: new Set(),
  commitIdsWithRenderedAncestry: new Set(),
  branchBaseCommitByName: new Map(),
  firstBranchCommitByName: new Map(),
  mergeDestinations: [],
  mergeTargetBranchesBySourceBranchAndCommitSha: new Map(),
};

const MAX_MAIN_THREAD_FALLBACK_NODES = 1_500;

const createLayoutWorker = (): Worker | null => {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./branchGridLayoutWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
};

export type BranchGridLayoutStatus = {
  state: 'idle' | 'computing' | 'ready' | 'error';
  source: 'none' | 'cache' | 'worker' | 'main-small';
  nodeEstimate: number;
  durationMs: number | null;
  error: string | null;
};

const resolveCachedLayoutModel = (
  revision: BranchGridLayoutRevision,
  sharedGridLayoutCacheKey: string | null,
  hydratedLayoutModel: BranchGridLayoutModel | null,
  hydratedLayoutKey: string | null,
  mapLoading: boolean,
  layoutModelCacheRef: MutableRefObject<Map<string, BranchGridLayoutModel>>,
): { model: BranchGridLayoutModel | null; source: LayoutResolveSource } => {
  const hasWorktreeNodes = revision.worktreeSessions.length > 0;
  const hasGraphSourceData =
    revision.branchesForLayout.length > 0
    || revision.enrichedDirectCommits.length > 0
    || revision.enrichedUnpushedDirectCommits.length > 0;
  const hydratedLooksEmptyButShouldNot =
    Boolean(hydratedLayoutModel)
    && (
      (hydratedLayoutModel?.allCommits.length ?? 0) === 0
      || (hydratedLayoutModel?.renderNodes.length ?? 0) === 0
    )
    && hasGraphSourceData;
  const layoutLooksEmptyButShouldNot = (model: BranchGridLayoutModel | null): boolean =>
    Boolean(model)
    && ((model?.allCommits.length ?? 0) === 0 || (model?.renderNodes.length ?? 0) === 0)
    && hasGraphSourceData;
  const hydratedHasWorkingTree = layoutModelHasWorkingTree(hydratedLayoutModel);
  const canReuseHydratedLayout = hydratedHasWorkingTree === hasWorktreeNodes;

  if (
    sharedGridLayoutCacheKey
    && hydratedLayoutKey === sharedGridLayoutCacheKey
    && hydratedLayoutModel
    && !hydratedLooksEmptyButShouldNot
    && canReuseHydratedLayout
  ) {
    markLayoutCacheHit('hydrated');
    return { model: hydratedLayoutModel, source: 'hydrated' };
  }
  if (mapLoading && sharedGridLayoutCacheKey) {
    const fromCache = layoutModelCacheRef.current.get(sharedGridLayoutCacheKey) ?? null;
    if (
      fromCache
      && !layoutLooksEmptyButShouldNot(fromCache)
      && layoutModelHasWorkingTree(fromCache) === hasWorktreeNodes
    ) {
      markLayoutCacheHit('memory');
      return { model: fromCache, source: 'memory' };
    }
  }
  if (sharedGridLayoutCacheKey) {
    const fromCache = layoutModelCacheRef.current.get(sharedGridLayoutCacheKey);
    if (
      fromCache
      && !layoutLooksEmptyButShouldNot(fromCache)
      && layoutModelHasWorkingTree(fromCache) === hasWorktreeNodes
    ) {
      markLayoutCacheHit('memory');
      return { model: fromCache, source: 'memory' };
    }
  }
  return { model: null, source: 'needs-compute' };
};

const buildLayoutComputeKey = (
  sharedGridLayoutCacheKey: string | null,
  gridFocusSha: string | null,
): string | null => {
  if (!sharedGridLayoutCacheKey) return null;
  return `${sharedGridLayoutCacheKey}::focus:${gridFocusSha ?? ''}`;
};

export const useBranchGridLayoutFromRevision = (params: {
  layoutRevisionForView: BranchGridLayoutRevision;
  sharedGridLayoutCacheKey: string | null;
  hydratedLayoutModel: BranchGridLayoutModel | null;
  hydratedLayoutKey: string | null;
  mapLoading: boolean;
  layoutModelCacheRef: MutableRefObject<Map<string, BranchGridLayoutModel>>;
  onStatusChange?: (status: BranchGridLayoutStatus) => void;
}): BranchGridLayoutModel => {
  const {
    layoutRevisionForView,
    sharedGridLayoutCacheKey,
    hydratedLayoutModel,
    hydratedLayoutKey,
    mapLoading,
    layoutModelCacheRef,
    onStatusChange,
  } = params;

  const lastGoodModelRef = useRef<BranchGridLayoutModel>(EMPTY_LAYOUT_MODEL);
  const lastGoodStorageKeyRef = useRef<string | null>(null);
  const lastGoodGraphSignatureRef = useRef<string | null>(null);
  const lastGoodRepoPathRef = useRef<string | null>(null);
  const lastServedComputeKeyRef = useRef<string | null>(null);
  const [asyncLayout, setAsyncLayout] = useState<{
    computeKey: string | null;
    model: BranchGridLayoutModel;
  } | null>(null);
  const jobIdRef = useRef(0);

  const layoutComputeKey = useMemo(
    () => buildLayoutComputeKey(sharedGridLayoutCacheKey, layoutRevisionForView.gridFocusSha),
    [layoutRevisionForView.gridFocusSha, sharedGridLayoutCacheKey],
  );

  const resolved = useMemo(() => {
    const cached = resolveCachedLayoutModel(
      layoutRevisionForView,
      sharedGridLayoutCacheKey,
      hydratedLayoutModel,
      hydratedLayoutKey,
      mapLoading,
      layoutModelCacheRef,
    );
    if (cached.source !== 'needs-compute' && layoutComputeKey) {
      lastServedComputeKeyRef.current = layoutComputeKey;
    }
    return cached;
  }, [
    layoutRevisionForView,
    sharedGridLayoutCacheKey,
    hydratedLayoutModel,
    hydratedLayoutKey,
    mapLoading,
    layoutModelCacheRef,
    layoutComputeKey,
  ]);

  const layoutInput = useMemo(
    () => buildBranchGridLayoutInput(layoutRevisionForView),
    [layoutRevisionForView],
  );

  const nodeEstimate =
    layoutInput.directCommits.length
    + layoutInput.unpushedDirectCommits.length
    + layoutInput.branches.length;

  useEffect(() => {
    if (resolved.source !== 'needs-compute') {
      setAsyncLayout(null);
      if (resolved.model && layoutComputeKey) {
        lastServedComputeKeyRef.current = layoutComputeKey;
      }
      onStatusChange?.({
        state: resolved.model ? 'ready' : 'idle',
        source: resolved.model ? 'cache' : 'none',
        nodeEstimate,
        durationMs: 0,
        error: null,
      });
      return undefined;
    }

    const jobId = jobIdRef.current + 1;
    jobIdRef.current = jobId;
    const startedAt = performance.now();
    onStatusChange?.({
      state: 'computing',
      source: 'worker',
      nodeEstimate,
      durationMs: null,
      error: null,
    });

    const worker = createLayoutWorker();

    const applyModel = (model: BranchGridLayoutModel, source: BranchGridLayoutStatus['source']) => {
      if (jobId !== jobIdRef.current) return;
      if (sharedGridLayoutCacheKey) {
        layoutModelCacheRef.current.set(sharedGridLayoutCacheKey, model);
      }
      if (layoutComputeKey) {
        lastServedComputeKeyRef.current = layoutComputeKey;
      }
      startTransition(() => {
        setAsyncLayout({ computeKey: layoutComputeKey, model });
      });
      onStatusChange?.({
        state: 'ready',
        source,
        nodeEstimate,
        durationMs: performance.now() - startedAt,
        error: null,
      });
    };

    if (worker) {
      const reportWorkerError = (message: string) => {
        if (jobId !== jobIdRef.current) return;
        onStatusChange?.({
          state: 'error',
          source: 'worker',
          nodeEstimate,
          durationMs: performance.now() - startedAt,
          error: message,
        });
      };
      const handleMessage = (event: MessageEvent<BranchGridLayoutWorkerResponse>) => {
        if (event.data.jobId !== jobId) return;
        if (!event.data.ok) {
          console.warn('branch grid layout worker failed:', event.data.error);
          reportWorkerError(event.data.error);
          worker.terminate();
          return;
        }
        applyModel(hydrateBranchGridLayoutModel(event.data.serialized), 'worker');
        worker.terminate();
      };
      const handleError = (event: ErrorEvent) => {
        reportWorkerError(event.message || 'The map worker stopped unexpectedly.');
        worker.terminate();
      };
      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      const request: BranchGridLayoutWorkerRequest = {
        jobId,
        input: toWorkerBranchGridLayoutInput(layoutInput),
      };
      worker.postMessage(request);
      return () => {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        worker.terminate();
      };
    }

    if (nodeEstimate > MAX_MAIN_THREAD_FALLBACK_NODES) {
      onStatusChange?.({
        state: 'error',
        source: 'none',
        nodeEstimate,
        durationMs: performance.now() - startedAt,
        error: 'The map worker could not start for this large repository.',
      });
      return undefined;
    }

    const fallbackId = window.setTimeout(() => {
      if (jobId !== jobIdRef.current) return;
      applyModel(computeBranchGridLayoutWithPerf(layoutInput), 'main-small');
    }, 0);
    return () => window.clearTimeout(fallbackId);
  }, [layoutComputeKey, resolved.source, resolved.model, layoutInput, nodeEstimate, onStatusChange]);

  const asyncLayoutModel = asyncLayout?.computeKey === layoutComputeKey ? asyncLayout.model : null;
  const isSameRepo =
    layoutRevisionForView.repoPath &&
    lastGoodRepoPathRef.current === layoutRevisionForView.repoPath;
  const layoutModel =
    asyncLayoutModel
    ?? resolved.model
    ?? (
      isSameRepo
      && lastGoodModelRef.current.allCommits.length > 0
        ? lastGoodModelRef.current
        : EMPTY_LAYOUT_MODEL
    );

  if (resolved.model || asyncLayoutModel) {
    lastGoodModelRef.current = layoutModel;
    lastGoodStorageKeyRef.current = sharedGridLayoutCacheKey;
    lastGoodGraphSignatureRef.current = layoutRevisionForView.graphLayoutSignature ?? null;
    lastGoodRepoPathRef.current = layoutRevisionForView.repoPath ?? null;
  } else if (sharedGridLayoutCacheKey !== lastGoodStorageKeyRef.current) {
    lastGoodStorageKeyRef.current = sharedGridLayoutCacheKey;
    lastServedComputeKeyRef.current = null;
  }
  return layoutModel;
};
