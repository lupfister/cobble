/// <reference lib="webworker" />
import { computeBranchGridLayout, type BranchGridLayoutInput } from './branchGridLayoutModel';
import { serializeBranchGridLayoutModel, type SerializedBranchGridLayoutModel } from './layoutSnapshot';
import { estimateBranchGridLayoutItems } from './progressiveBranchGridLayout';

export type WorkerBranchGridLayoutInput = Omit<
  BranchGridLayoutInput,
  'manuallyOpenedClumps' | 'manuallyClosedClumps'
> & {
  manuallyOpenedClumps: string[];
  manuallyClosedClumps: string[];
};

export type BranchGridLayoutWorkerRequest = {
  jobId: number;
  input: WorkerBranchGridLayoutInput;
};

export type BranchGridLayoutWorkerSuccess = {
  jobId: number;
  ok: true;
  serialized: SerializedBranchGridLayoutModel;
  complete: boolean;
  capped: boolean;
  processedItems: number;
  totalItems: number;
  stageIndex: number;
  stageCount: number;
};

export type BranchGridLayoutWorkerFailure = {
  jobId: number;
  ok: false;
  error: string;
};

export type BranchGridLayoutWorkerResponse = BranchGridLayoutWorkerSuccess | BranchGridLayoutWorkerFailure;

self.onmessage = (event: MessageEvent<BranchGridLayoutWorkerRequest>) => {
  const { jobId, input } = event.data;
  try {
    const normalizedInput: BranchGridLayoutInput = {
      ...input,
      manuallyOpenedClumps: new Set(input.manuallyOpenedClumps),
      manuallyClosedClumps: new Set(input.manuallyClosedClumps),
      gridSearchQuery: '',
      isDebugOpen: false,
    };
    const totalItems = estimateBranchGridLayoutItems(normalizedInput);
    const model = computeBranchGridLayout(normalizedInput);
    const response: BranchGridLayoutWorkerSuccess = {
      jobId,
      ok: true,
      serialized: serializeBranchGridLayoutModel(model),
      complete: true,
      capped: false,
      processedItems: totalItems,
      totalItems,
      stageIndex: 1,
      stageCount: 1,
    };
    self.postMessage(response);
  } catch (error) {
    const response: BranchGridLayoutWorkerFailure = {
      jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
