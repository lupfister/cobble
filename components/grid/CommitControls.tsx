import { isWorkingTreeCommitId, type WorktreeSession } from '../../lib/worktreeSessions';
import { parseMapCheckoutTarget } from './mapCheckoutTarget';
import type { Node } from './LayoutGrid';
import ToolbarActionContent from './ToolbarActionContent';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, memo } from 'react';
import { cn } from './mapGridUtils';
import type { WorktreeDraftDisplay } from '../../src/worktreeDraftMessages';

type PushTarget = {
  branchName: string;
  targetSha: string;
  commitCount: number;
};

type SelectedCommitTargetOption = {
  options: Array<{ targetSha: string; targetBranch: string; sourceRefs: string[] }>;
  targetBranch: string | null;
  sources: string[];
};

type Props = {
  compactLabels?: boolean;
  selectedVisibleCommitShas: string[];
  commitInProgress: boolean;
  commitDisabled: boolean;
  stageInProgress: boolean;
  stashInProgress: boolean;
  stashDisabled: boolean;
  pushInProgress: boolean;
  createBranchFromNodeInProgress: boolean;
  onCommitLocalChanges?: (message: string, worktreePaths: string[]) => Promise<boolean>;
  onAutoCommitLocalChanges?: (worktreePaths: string[]) => Promise<boolean>;
  onStageAllChanges?: (() => boolean | void | Promise<void> | Promise<boolean>) | undefined;
  onStashLocalChanges?: (worktreePaths: string[]) => Promise<void> | void;
  onPushAllBranches?: () => Promise<void> | void;
  onPushCurrentBranch?: (targetPath?: string) => Promise<void> | void;
  onPushCommitTargets?: (targets: Array<{ branchName: string; targetSha: string }>) => Promise<void> | void;
  onSquashCommitRange?: (target: { branchName: string; commitShas: string[] }) => Promise<void> | void;
  onPreviewSelectedNode?: () => Promise<void> | void;
  previewInProgress?: boolean;
  onMergeRefsIntoBranch?: (sourceRefs: string[], targetBranch: string) => Promise<void> | void;
  selectedPushTargets: PushTarget[];
  selectedSquashTarget?: { branchName: string; commitShas: string[] } | null;
  squashInProgress?: boolean;
  pushableRemoteBranchCount: number;
  selectedCommitTargetOption: SelectedCommitTargetOption;
  mergeInProgress: boolean;
  mergeTargetCommitSha: string | null;
  setMergeTargetCommitSha: (sha: string | null) => void;
  onWriteCommit?: () => void;
  setNewBranchDialogOpen: (open: boolean) => void;
  onCreateGeneratedBranch?: (worktreePath: string, branchName: string) => Promise<void>;
  worktreeDraftByWorkingTreeId?: ReadonlyMap<string, WorktreeDraftDisplay>;
  hideMergeControls?: boolean;
  dirtyWorktreePaths?: string[];
  selectedDirtyWorktreePaths?: string[];

  // Overhaul Props
  selectedPreviewNode?: Node | null;
  worktreeSessions?: WorktreeSession[];
  currentRepoPath?: string;
  onCommitClick?: (target: { commitSha: string; branchName?: string; worktreePath: string }) => void | Promise<void>;
  onCreateTerminal?: (projectPath: string, worktreePath: string) => void;
  onCreateWorktree?: (projectPath: string, branchOrCommit?: string) => void;
};

function CommitControls({
  selectedVisibleCommitShas,
  commitInProgress,
  stashInProgress,
  pushInProgress,
  createBranchFromNodeInProgress,
  onAutoCommitLocalChanges,
  onStashLocalChanges,
  onPushAllBranches,
  onPushCurrentBranch,
  onPushCommitTargets,
  onSquashCommitRange,
  onPreviewSelectedNode,
  previewInProgress = false,
  selectedPushTargets,
  selectedSquashTarget = null,
  squashInProgress = false,
  pushableRemoteBranchCount,
  onWriteCommit,
  setNewBranchDialogOpen,
  onCreateGeneratedBranch,
  worktreeDraftByWorkingTreeId,
  selectedDirtyWorktreePaths = [],

  selectedPreviewNode,
  worktreeSessions = [],
  currentRepoPath,
  onCommitClick,
  onCreateTerminal,
  onCreateWorktree,
}: Props) {
  const [activeDropdown, setActiveDropdown] = useState<'commit' | 'preview' | 'checkout' | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Original buttons styling tokens
  const controlClassName =
    'inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-background';

  const menuButtonClassName = (enabled: boolean, loading: boolean) =>
    cn(
      controlClassName,
      'w-full justify-start whitespace-nowrap border-0 bg-transparent px-2 hover:bg-muted',
      !enabled && 'text-foreground opacity-50',
      loading && 'pointer-events-none',
    );

  // Recency states persisted to Local Storage
  const [commitAction, setCommitAction] = useState<'commit' | 'commit-push' | 'stash'>(() => {
    const saved = localStorage.getItem('cobble:last-commit-action');
    if (saved === 'commit' || saved === 'commit-push' || saved === 'stash') return saved;
    return 'commit';
  });

  const [previewAction, setPreviewAction] = useState<'preview' | 'terminal'>(() => {
    const saved = localStorage.getItem('cobble:last-preview-action');
    if (saved === 'preview' || saved === 'terminal') return saved;
    return 'preview';
  });

  const selectedWorktreeSession = selectedPreviewNode
    ? worktreeSessions.find((session) => session.workingTreeId === selectedPreviewNode.commit.id)
    : undefined;
  const generatedBranchName = selectedWorktreeSession?.hasUncommittedChanges
    ? worktreeDraftByWorkingTreeId?.get(selectedWorktreeSession.workingTreeId)?.branchName?.trim() ?? ''
    : '';
  const usesGeneratedBranchAction = Boolean(selectedWorktreeSession?.hasUncommittedChanges);

  const [checkoutAction, setCheckoutAction] = useState<'checkout' | 'new-worktree'>(() => {
    const saved = localStorage.getItem('cobble:worktree-centered-checkout-action');
    if (saved === 'checkout' || saved === 'new-worktree') return saved;
    return 'new-worktree';
  });

  // Close dropdown on click outside
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      setActiveDropdown(null);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  // Determine selection type state
  const isSelectionEmpty = selectedVisibleCommitShas.length === 0;
  const hasSingleSelectedNode = selectedPreviewNode != null;
  const isSelectedWorktree = selectedPreviewNode != null && (
    isWorkingTreeCommitId(selectedPreviewNode.commit.id) ||
    selectedPreviewNode.commit.kind === 'uncommitted'
  );
  const isSelectedStash = selectedPreviewNode != null && (
    selectedPreviewNode.commit.id.startsWith('STASH:') ||
    selectedPreviewNode.commit.kind === 'stash'
  );
  const isSelectedStashOrPlaceholder = selectedPreviewNode != null && (
    selectedPreviewNode.commit.kind === 'branch-created' ||
    selectedPreviewNode.commit.id.startsWith('BRANCH_HEAD:')
  );

  const selectedSession = selectedPreviewNode
    ? worktreeSessions.find((s) => s.workingTreeId === selectedPreviewNode.commit.id)
    : null;
  const isDirtyWorktree = selectedSession?.hasUncommittedChanges ?? false;

  const showPush = selectedPushTargets.length > 0;
  const showSquash = selectedSquashTarget != null;
  const pushTargets = selectedPushTargets.map((target) => ({
    branchName: target.branchName,
    targetSha: target.targetSha,
  }));
  const selectedPushCommitCount = selectedPushTargets.reduce((sum, target) => sum + Math.max(0, target.commitCount), 0);
  const pushSelectionIcon = selectedPushCommitCount === 1 ? 'push-single' : 'push-multiple';
  const pushAllIcon = pushableRemoteBranchCount === 1 ? 'push-single' : 'push-multiple';

  const pushLabel = 'Push Selected...';

  // Action execution wrappers
  const runCommitAction = async (action: 'commit' | 'commit-push' | 'stash') => {
    if (!selectedPreviewNode) return;
    const selectedSha = selectedPreviewNode.commit.id;
    const selectedSession = worktreeSessions.find((s) => s.workingTreeId === selectedSha);
    if (!selectedSession) return;

    const paths = selectedDirtyWorktreePaths.length > 0 ? selectedDirtyWorktreePaths : [selectedSession.path];
    if (action === 'commit') {
      await onAutoCommitLocalChanges?.(paths);
    } else if (action === 'commit-push') {
      const success = await onAutoCommitLocalChanges?.(paths);
      if (success) {
        await onPushCurrentBranch?.(selectedSession.path);
      }
    } else if (action === 'stash') {
      await onStashLocalChanges?.([selectedSession.path]);
    }
  };

  const runPreviewAction = async (action: 'preview' | 'terminal') => {
    if (!selectedPreviewNode) return;
    const selectedSha = selectedPreviewNode.commit.id;
    const selectedSession = worktreeSessions.find((s) => s.workingTreeId === selectedSha);
    if (!selectedSession) return;

    if (action === 'preview') {
      await onPreviewSelectedNode?.();
    } else if (action === 'terminal') {
      onCreateTerminal?.(currentRepoPath || '', selectedSession.path);
    }
  };

  const runCheckoutAction = async (action: 'checkout' | 'new-worktree') => {
    if (!selectedPreviewNode) return;
    const checkoutTarget = parseMapCheckoutTarget(selectedPreviewNode);
    if (!checkoutTarget) return;

    if (action === 'checkout') {
      await onCommitClick?.({
        commitSha: checkoutTarget.commitSha,
        branchName: checkoutTarget.branchName,
        worktreePath: currentRepoPath || '',
      });
    } else if (action === 'new-worktree') {
      const ref = checkoutTarget.branchName || checkoutTarget.commitSha;
      const branchOrCommit = ref.startsWith('STASH:') ? `stash@{${ref.slice(6)}}` : ref;
      onCreateWorktree?.(currentRepoPath || '', branchOrCommit);
    }
  };

  // Rendering for the 4 states:
  return (
    <div ref={containerRef} className="window-no-drag pointer-events-none z-[60] flex w-full justify-start">
      <div className="pointer-events-auto flex w-fit max-w-full flex-nowrap items-center justify-start gap-[9px]">
        {/* STATE 1: Nothing selected */}
        {isSelectionEmpty && (
          <>
            {pushableRemoteBranchCount > 0 && (
              <button
                type="button"
                onClick={() => void onPushAllBranches?.()}
                disabled={pushInProgress}
                className={controlClassName}
              >
                <ToolbarActionContent
                  icon={pushAllIcon}
                  label="Push All"
                  loading={pushInProgress}
                />
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewBranchDialogOpen(true)}
              disabled={createBranchFromNodeInProgress}
              className={cn(controlClassName, 'pointer-events-auto relative z-10 !bg-background !border-border hover:!bg-muted')}
            >
              <ToolbarActionContent
                icon="branch-new-root"
                label="New Root Branch..."
                loading={createBranchFromNodeInProgress}
              />
            </button>
          </>
        )}

        {/* STATE 2: Selected Worktree */}
        {!isSelectionEmpty && isSelectedWorktree && (
          <>
            {/* Commit Actions Split-Button Dropdown */}
            {isDirtyWorktree && (
              <div className="pointer-events-auto relative z-10 inline-flex h-7 items-stretch rounded-md border border-border bg-background">
                <button
                  type="button"
                  onClick={() => void runCommitAction(commitAction)}
                  disabled={commitInProgress || stashInProgress}
                  className={cn(controlClassName, 'h-full rounded-r-none border-0 bg-transparent pr-1 hover:bg-muted')}
                >
                  {commitAction === 'commit' && (
                    <ToolbarActionContent icon="commit" label="Commit" loading={commitInProgress} />
                  )}
                  {commitAction === 'commit-push' && (
                    <ToolbarActionContent icon="push-single" label="Commit & Push" loading={commitInProgress || pushInProgress} />
                  )}
                  {commitAction === 'stash' && (
                    <ToolbarActionContent icon="stash" label="Stash" loading={stashInProgress} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDropdown((curr) => (curr === 'commit' ? null : 'commit'))}
                  className={cn(controlClassName, 'h-full rounded-l-none border-0 bg-transparent pl-1 hover:bg-muted')}
                >
                  <ChevronDown strokeWidth={1.875} className="h-4 w-4 shrink-0 text-foreground" />
                </button>
                {activeDropdown === 'commit' && (
                  <div className="context-menu-panel absolute left-[-1px] top-full z-[70] mt-2 inline-flex w-max min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background p-1" data-outer-radius="md">
                    <button
                      type="button"
                      onClick={() => {
                        setCommitAction('commit');
                        localStorage.setItem('cobble:last-commit-action', 'commit');
                        setActiveDropdown(null);
                        void runCommitAction('commit');
                      }}
                      className={menuButtonClassName(true, commitInProgress)}
                    >
                      <ToolbarActionContent icon="commit" label="Commit" loading={commitInProgress} iconClassName="mr-1.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommitAction('commit-push');
                        localStorage.setItem('cobble:last-commit-action', 'commit-push');
                        setActiveDropdown(null);
                        void runCommitAction('commit-push');
                      }}
                      className={menuButtonClassName(true, commitInProgress || pushInProgress)}
                    >
                      <ToolbarActionContent icon="push-single" label="Commit & Push" loading={commitInProgress || pushInProgress} iconClassName="mr-1.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommitAction('stash');
                        localStorage.setItem('cobble:last-commit-action', 'stash');
                        setActiveDropdown(null);
                        void runCommitAction('stash');
                      }}
                      className={menuButtonClassName(true, stashInProgress)}
                    >
                      <ToolbarActionContent icon="stash" label="Stash" loading={stashInProgress} iconClassName="mr-1.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveDropdown(null);
                        onWriteCommit?.();
                      }}
                      className={menuButtonClassName(true, false)}
                    >
                      <ToolbarActionContent icon="commit" label="Edit Message" iconClassName="mr-1.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Create Branch Button */}
            <button
              type="button"
              onClick={() => {
                if (usesGeneratedBranchAction && selectedWorktreeSession && generatedBranchName) {
                  void onCreateGeneratedBranch?.(selectedWorktreeSession.path, generatedBranchName);
                  return;
                }
                setNewBranchDialogOpen(true);
              }}
              disabled={
                createBranchFromNodeInProgress
                || (usesGeneratedBranchAction && (!generatedBranchName || !onCreateGeneratedBranch))
              }
              className={cn(controlClassName, 'pointer-events-auto relative z-10 !bg-background !border-border hover:!bg-muted')}
            >
              <ToolbarActionContent
                icon="branch-new"
                label={(() => {
                  const rawName = usesGeneratedBranchAction
                    ? generatedBranchName || 'Building'
                    : selectedWorktreeSession?.branchName || 'detached';
                  const maxLen = 20;
                  return rawName.length > maxLen ? `${rawName.substring(0, maxLen)}...` : rawName;
                })()}
                loading={createBranchFromNodeInProgress}
              />
            </button>

            {/* Preview/Terminal Split-Button Dropdown */}
            <div className="pointer-events-auto relative z-10 inline-flex h-7 items-stretch rounded-md border border-border bg-background">
              <button
                type="button"
                onClick={() => void runPreviewAction(previewAction)}
                disabled={previewInProgress}
                className={cn(controlClassName, 'h-full rounded-r-none border-0 bg-transparent pr-1 hover:bg-muted')}
              >
                {previewAction === 'preview' ? (
                  <ToolbarActionContent icon="preview" label="Preview" loading={previewInProgress} />
                ) : (
                  <ToolbarActionContent icon="terminal" label="Terminal" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveDropdown((curr) => (curr === 'preview' ? null : 'preview'))}
                className={cn(controlClassName, 'h-full rounded-l-none border-0 bg-transparent pl-1 hover:bg-muted')}
              >
                <ChevronDown strokeWidth={1.875} className="h-4 w-4 shrink-0 text-foreground" />
              </button>
              {activeDropdown === 'preview' && (
                <div className="context-menu-panel absolute left-[-1px] top-full z-[70] mt-2 inline-flex w-max min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background p-1" data-outer-radius="md">
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewAction('preview');
                      localStorage.setItem('cobble:last-preview-action', 'preview');
                      setActiveDropdown(null);
                      void runPreviewAction('preview');
                    }}
                    className={menuButtonClassName(true, previewInProgress)}
                  >
                    <ToolbarActionContent icon="preview" label="Preview" loading={previewInProgress} iconClassName="mr-1.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewAction('terminal');
                      localStorage.setItem('cobble:last-preview-action', 'terminal');
                      setActiveDropdown(null);
                      void runPreviewAction('terminal');
                    }}
                    className={menuButtonClassName(true, false)}
                  >
                    <ToolbarActionContent icon="terminal" label="Terminal" iconClassName="mr-1.5" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* STATE 3: Selected Stash / Placeholder Branch Node */}
        {!isSelectionEmpty && isSelectedStashOrPlaceholder && (
          <>
            <div className="pointer-events-auto relative z-10 inline-flex h-7 items-stretch rounded-md border border-border bg-background">
              <button
                type="button"
                onClick={() => void runCheckoutAction(checkoutAction)}
                className={cn(controlClassName, 'h-full rounded-r-none border-0 bg-transparent pr-1 hover:bg-muted')}
              >
                {checkoutAction === 'checkout' ? (
                  <ToolbarActionContent icon="commit" label="Checkout" />
                ) : (
                  <ToolbarActionContent icon="new-worktree" label="New Worktree" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveDropdown((curr) => (curr === 'checkout' ? null : 'checkout'))}
                className={cn(controlClassName, 'h-full rounded-l-none border-0 bg-transparent pl-1 hover:bg-muted')}
              >
                <ChevronDown strokeWidth={1.875} className="h-4 w-4 shrink-0 text-foreground" />
              </button>
              {activeDropdown === 'checkout' && (
                <div className="context-menu-panel absolute left-[-1px] top-full z-[70] mt-2 inline-flex w-max min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background p-1" data-outer-radius="md">
                  <button
                    type="button"
                    onClick={() => {
                      setCheckoutAction('checkout');
                      localStorage.setItem('cobble:worktree-centered-checkout-action', 'checkout');
                      setActiveDropdown(null);
                      void runCheckoutAction('checkout');
                    }}
                    className={menuButtonClassName(true, false)}
                  >
                    <ToolbarActionContent icon="commit" label="Checkout" iconClassName="mr-1.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCheckoutAction('new-worktree');
                      localStorage.setItem('cobble:worktree-centered-checkout-action', 'new-worktree');
                      setActiveDropdown(null);
                      void runCheckoutAction('new-worktree');
                    }}
                    className={menuButtonClassName(true, false)}
                  >
                    <ToolbarActionContent icon="new-worktree" label="New Worktree" iconClassName="mr-1.5" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* STATE 4: Selected Commit Node */}
        {!isSelectionEmpty && !isSelectedWorktree && !isSelectedStashOrPlaceholder && (
          <>
            {/* Preview Button */}
            {hasSingleSelectedNode && !isSelectedStash && (
              <button
                type="button"
                onClick={() => void onPreviewSelectedNode?.()}
                disabled={previewInProgress}
                className={cn(controlClassName, 'pointer-events-auto relative z-10 !border-border !bg-background hover:!bg-muted')}
              >
                <ToolbarActionContent
                  icon="preview"
                  label="Preview"
                  loading={previewInProgress}
                />
              </button>
            )}

            {/* Push Button */}
            {showPush && !isSelectedStash && (
              <button
                type="button"
                onClick={() => {
                  void onPushCommitTargets?.(pushTargets);
                }}
                disabled={pushInProgress}
                className={cn(controlClassName, 'pointer-events-auto relative z-10 !border-border !bg-background hover:!bg-muted')}
              >
                <ToolbarActionContent
                  icon={pushSelectionIcon}
                  label={pushLabel}
                  loading={pushInProgress}
                />
              </button>
            )}

            {showSquash && !isSelectedStash && (
              <button
                type="button"
                onClick={() => {
                  if (selectedSquashTarget) void onSquashCommitRange?.(selectedSquashTarget);
                }}
                disabled={squashInProgress}
                className={cn(controlClassName, 'pointer-events-auto relative z-10 !border-border !bg-background hover:!bg-muted')}
              >
                <ToolbarActionContent
                  icon="commit"
                  label="Squash"
                  loading={squashInProgress}
                />
              </button>
            )}

            {/* Checkout Actions Split-Button Dropdown */}
            {hasSingleSelectedNode && (
              <div className="pointer-events-auto relative z-10 inline-flex h-7 items-stretch rounded-md border border-border bg-background">
                <button
                  type="button"
                  onClick={() => void runCheckoutAction(checkoutAction)}
                  className={cn(controlClassName, 'h-full rounded-r-none border-0 bg-transparent pr-1 hover:bg-muted')}
                >
                  {checkoutAction === 'checkout' ? (
                    <ToolbarActionContent icon="commit" label="Checkout" />
                  ) : (
                    <ToolbarActionContent icon="new-worktree" label="New Worktree" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDropdown((curr) => (curr === 'checkout' ? null : 'checkout'))}
                  className={cn(controlClassName, 'h-full rounded-l-none border-0 bg-transparent pl-1 hover:bg-muted')}
                >
                  <ChevronDown strokeWidth={1.875} className="h-4 w-4 shrink-0 text-foreground" />
                </button>
                {activeDropdown === 'checkout' && (
                  <div className="context-menu-panel absolute left-[-1px] top-full z-[70] mt-2 inline-flex w-max min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background p-1" data-outer-radius="md">
                    <button
                      type="button"
                      onClick={() => {
                        setCheckoutAction('checkout');
                        localStorage.setItem('cobble:worktree-centered-checkout-action', 'checkout');
                        setActiveDropdown(null);
                        void runCheckoutAction('checkout');
                      }}
                      className={menuButtonClassName(true, false)}
                    >
                      <ToolbarActionContent icon="commit" label="Checkout" iconClassName="mr-1.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCheckoutAction('new-worktree');
                        localStorage.setItem('cobble:worktree-centered-checkout-action', 'new-worktree');
                        setActiveDropdown(null);
                        void runCheckoutAction('new-worktree');
                      }}
                      className={menuButtonClassName(true, false)}
                    >
                      <ToolbarActionContent icon="new-worktree" label="New Worktree" iconClassName="mr-1.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default memo(CommitControls);
