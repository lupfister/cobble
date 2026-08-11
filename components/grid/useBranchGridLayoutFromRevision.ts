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
import {
  estimateBranchGridLayoutItems,
  progressiveBranchGridLayoutLimits,
  sliceBranchGridLayoutInput,
} from './progressiveBranchGridLayout';

type LayoutResolveSource = 'hydrated' | 'memory' | 'needs-compute';

export type BranchGridLayoutResolution = {
  model: BranchGridLayoutModel;
  isCurrent: boolean;
  isComplete: boolean;
};

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
const MAX_LAYOUT_WORKER_MS = 15_000;

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

export const layoutModelMatchesManualClumpState = (
  model: BranchGridLayoutModel,
  manuallyOpenedClumps: ReadonlySet<string>,
  manuallyClosedClumps: ReadonlySet<string>,
): boolean => {
  const renderedCountByClusterKey = new Map<string, number>();
  for (const node of model.renderNodes) {
    const clusterKey = model.clusterKeyByCommitId.get(node.commit.visualId);
    if (!clusterKey) continue;
    renderedCountByClusterKey.set(clusterKey, (renderedCountByClusterKey.get(clusterKey) ?? 0) + 1);
  }
  for (const clusterKey of manuallyClosedClumps) {
    if ((model.clusterCounts.get(clusterKey) ?? 1) <= 1) continue;
    if ((renderedCountByClusterKey.get(clusterKey) ?? 0) > 1) return false;
  }
  for (const clusterKey of manuallyOpenedClumps) {
    if ((model.clusterCounts.get(clusterKey) ?? 1) <= 1) continue;
    if ((renderedCountByClusterKey.get(clusterKey) ?? 0) <= 1) return false;
  }
  return true;
};

export type BranchGridLayoutStatus = {
  state: 'idle' | 'computing' | 'ready' | 'error';
  source: 'none' | 'cache' | 'worker' | 'main-small';
  nodeEstimate: number;
  processedItems: number;
  totalItems: number;
  isPartial: boolean;
  durationMs: number | null;
  error: string | null;
  cappedReason: string | null;
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
  const matchesRequestedClumpState = (model: BranchGridLayoutModel): boolean =>
    layoutModelMatchesManualClumpState(
      model,
      revision.manuallyOpenedGridClumps,
      revision.manuallyClosedGridClumps,
    );

  if (
    sharedGridLayoutCacheKey
    && hydratedLayoutKey === sharedGridLayoutCacheKey
    && hydratedLayoutModel
    && !hydratedLooksEmptyButShouldNot
    && canReuseHydratedLayout
    && matchesRequestedClumpState(hydratedLayoutModel)
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
      && matchesRequestedClumpState(fromCache)
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
      && matchesRequestedClumpState(fromCache)
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
}): BranchGridLayoutResolution => {
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
    complete: boolean;
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

  const nodeEstimate = estimateBranchGridLayoutItems(layoutInput);

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
        processedItems: resolved.model ? nodeEstimate : 0,
        totalItems: nodeEstimate,
        isPartial: false,
        durationMs: 0,
        error: null,
        cappedReason: null,
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
      processedItems: 0,
      totalItems: nodeEstimate,
      isPartial: false,
      durationMs: null,
      error: null,
      cappedReason: null,
    });

    const worker = createLayoutWorker();

    const applyModel = (
      model: BranchGridLayoutModel,
      source: BranchGridLayoutStatus['source'],
      progress: {
        complete: boolean;
        capped: boolean;
        processedItems: number;
        totalItems: number;
      },
    ) => {
      if (jobId !== jobIdRef.current) return;
      if (progress.complete && sharedGridLayoutCacheKey) {
        layoutModelCacheRef.current.set(sharedGridLayoutCacheKey, model);
      }
      if (progress.complete && layoutComputeKey) {
        lastServedComputeKeyRef.current = layoutComputeKey;
      }
      startTransition(() => {
        setAsyncLayout({ computeKey: layoutComputeKey, model, complete: progress.complete });
      });
      onStatusChange?.({
        state: progress.complete || progress.capped ? 'ready' : 'computing',
        source,
        nodeEstimate,
        processedItems: progress.processedItems,
        totalItems: progress.totalItems,
        isPartial: !progress.complete,
        durationMs: performance.now() - startedAt,
        error: null,
        cappedReason: progress.capped
          ? `Showing ${progress.processedItems.toLocaleString()} of ${progress.totalItems.toLocaleString()} items. Expansion stopped at the resource limit.`
          : null,
      });
    };

    if (worker) {
      let latestPartial: BranchGridLayoutWorkerResponse | null = null;
      let workerTimeout: number | null = null;
      const clearWorkerTimeout = () => {
        if (workerTimeout != null) window.clearTimeout(workerTimeout);
        workerTimeout = null;
      };
      const reportWorkerError = (message: string) => {
        if (jobId !== jobIdRef.current) return;
        if (latestPartial?.ok) {
          onStatusChange?.({
            state: 'ready',
            source: 'worker',
            nodeEstimate,
            processedItems: latestPartial.processedItems,
            totalItems: latestPartial.totalItems,
            isPartial: true,
            durationMs: performance.now() - startedAt,
            error: null,
            cappedReason: `Showing ${latestPartial.processedItems.toLocaleString()} of ${latestPartial.totalItems.toLocaleString()} items. ${message}`,
          });
          return;
        }
        onStatusChange?.({
          state: 'error',
          source: 'worker',
          nodeEstimate,
          processedItems: 0,
          totalItems: nodeEstimate,
          isPartial: false,
          durationMs: performance.now() - startedAt,
          error: message,
          cappedReason: null,
        });
      };
      const armWorkerTimeout = () => {
        clearWorkerTimeout();
        workerTimeout = window.setTimeout(() => {
          reportWorkerError('Expansion stopped after a stage reached the 15 second resource limit.');
          worker.terminate();
        }, MAX_LAYOUT_WORKER_MS);
      };
      const handleMessage = (event: MessageEvent<BranchGridLayoutWorkerResponse>) => {
        if (event.data.jobId !== jobId) return;
        if (!event.data.ok) {
          console.warn('branch grid layout worker failed:', event.data.error);
          clearWorkerTimeout();
          reportWorkerError(event.data.error);
          worker.terminate();
          return;
        }
        latestPartial = event.data.complete ? latestPartial : event.data;
        applyModel(hydrateBranchGridLayoutModel(event.data.serialized), 'worker', event.data);
        if (event.data.complete || event.data.capped) {
          clearWorkerTimeout();
          worker.terminate();
        } else {
          armWorkerTimeout();
        }
      };
      const handleError = (event: ErrorEvent) => {
        clearWorkerTimeout();
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
      armWorkerTimeout();
      return () => {
        clearWorkerTimeout();
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        worker.terminate();
      };
    }

    const fallbackId = window.setTimeout(() => {
      if (jobId !== jobIdRef.current) return;
      const stageLimit = progressiveBranchGridLayoutLimits(nodeEstimate)
        .filter((candidate) => candidate <= MAX_MAIN_THREAD_FALLBACK_NODES)
        .at(-1) ?? Math.min(nodeEstimate, MAX_MAIN_THREAD_FALLBACK_NODES);
      const complete = stageLimit >= nodeEstimate;
      const stageInput = complete ? layoutInput : sliceBranchGridLayoutInput(layoutInput, stageLimit);
      applyModel(computeBranchGridLayoutWithPerf(stageInput), 'main-small', {
        complete,
        capped: !complete,
        processedItems: stageLimit,
        totalItems: nodeEstimate,
      });
    }, 0);
    return () => window.clearTimeout(fallbackId);
  }, [layoutComputeKey, resolved.source, resolved.model, layoutInput, nodeEstimate, onStatusChange]);

  const currentAsyncLayout = asyncLayout?.computeKey === layoutComputeKey ? asyncLayout : null;
  const asyncLayoutModel = currentAsyncLayout?.model ?? null;
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
  const isCurrent = Boolean(asyncLayoutModel || resolved.model);
  return {
    model: layoutModel,
    isCurrent,
    isComplete: Boolean(resolved.model || currentAsyncLayout?.complete),
  };
};
