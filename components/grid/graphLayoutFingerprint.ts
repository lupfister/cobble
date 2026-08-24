/** Cheap rolling hash over commit identity and ownership — O(n), no sort. */
export const hashCommitShaList = (commits: ReadonlyArray<{ fullSha: string; branch?: string }>): string => {
  if (commits.length === 0) return '0:0';
  let hash = commits.length;
  for (const commit of commits) {
    const key = `${commit.branch ?? ''}:${commit.fullSha}`;
    for (let index = 0; index < key.length; index += 1) {
      hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
    }
  }
  return `${commits.length}:${hash >>> 0}`;
};

export const buildGraphLayoutFingerprint = (parts: {
  layoutEpoch: number;
  defaultBranch: string;
  checkedOutBranch: string;
  checkedOutHead: string;
  worktreeSessionSignature: string;
  branchRowsSignature: string;
  directCommitFingerprint: string;
  unpushedCommitFingerprint: string;
  mergeNodesSignature: string;
}): string =>
  [
    'layout-v30-fingerprint',
    parts.layoutEpoch,
    parts.defaultBranch,
    parts.checkedOutBranch,
    parts.checkedOutHead,
    parts.worktreeSessionSignature,
    parts.branchRowsSignature,
    parts.directCommitFingerprint,
    parts.unpushedCommitFingerprint,
    parts.mergeNodesSignature,
  ].join('@@');
