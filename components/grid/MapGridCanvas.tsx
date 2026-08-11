import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MouseEvent, MutableRefObject, ReactNode, RefObject, SetStateAction, WheelEvent } from 'react';
import type { WorktreeInfo } from '../../types';
import { AnimatePresence, useReducedMotion } from 'framer-motion';
import { CARD_BODY_TOP_OFFSET, CARD_HEIGHT, CARD_WIDTH } from './LayoutGrid';
import {
  applyPersistedPathStrings,
  collectPathStringsForPersistence,
  type ConnectorPathCacheEntry,
} from './mapGridConnectorPathCache';
import { MapGridConnectorLayer } from './MapGridConnectorLayer';
import {
  pulseMapGridBackgroundActivity,
  setMapGridBackgroundActivity,
} from './mapGridBackgroundActivity';
import {
  buildConnectorPathCacheScopeKey,
  computeConnectorLayoutDigest,
  mergePersistedConnectorPaths,
  readPersistedConnectorPaths,
} from './mapGridConnectorPathPersistence';
import { buildMapGridCardSlotAssignments, computeMapGridCardSlotCount } from './MapGridCardVirtualizer';
import {
  accentCssVars,
  isWorkingTreeCommitId,
  LEGACY_WORKING_TREE_ID,
  resolveWorktreeCommitTileShapeCssVar,
  worktreeAccentActive,
  worktreeStableKey,
  type WorktreeAccentToken,
  type WorktreeSession,
} from '../../lib/worktreeSessions';
import { DIRTY_WORKTREE_BUILDING_LABEL, resolveWorktreeDraftDisplayLabel, type WorktreeDraftDisplay } from '../../src/worktreeDraftMessages';
import {
  cn,
  computeViewportCullBounds,
  GRID_COMMIT_CORNER_RADIUS_BASE_PX,
  isCommitUnpushedOnBranch,
  formatRemoteCommitHeaderLabel,
  formatWorktreeNodeHeaderLabel,
  worktreeSessionDisplayName,
} from './mapGridUtils';

import type { Connector, ConnectorFace, Node, NodePositionOverrides } from './LayoutGrid';
import type { MapGridCameraState, MapGridCameraTargetLayout } from './useMapGridCamera';
import { getNodePositionOverride } from './nodePositionOverrides';
import {
  TILE_DEFAULT_OMISSION_RATE,
  TILE_UNCOMMITTED_OMISSION_RATE,
} from '@cobble/tile-pattern-core';
import { CommitNodeTilePattern, type CommitNodeTilePatternHandle } from './CommitNodeTilePattern';

const EMPTY_NODE_POSITION_OVERRIDES: NodePositionOverrides = {};
const EMPTY_DRAG_PREVIEW: Record<string, { x: number; y: number }> = {};
const EMPTY_ADJUSTED_ANCHOR_MAP = new Map<string, { x: number; y: number }>();

const WORKING_DOT_CYCLE_MS = 450;

const WorkingDots = () => {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setDotCount((previous) => (previous + 1) % 4);
    }, WORKING_DOT_CYCLE_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return <span className="inline-block min-w-[0.75em]" aria-hidden="true">{'.'.repeat(dotCount)}</span>;
};

type MapGridCommitWrapperProps = {
  className?: string;
  style?: CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  onPointerEnter?: React.PointerEventHandler<HTMLDivElement>;
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
  onPointerUp?: React.PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  dataCommitCard?: string;
  dataCommitVisualId?: string;
  dataClusterKey?: string;
  visualRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
};

const MapGridCommitWrapper = forwardRef<HTMLDivElement, MapGridCommitWrapperProps>(function MapGridCommitWrapper({
  className,
  style,
  onClick,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  dataCommitCard,
  dataCommitVisualId,
  dataClusterKey,
  visualRef,
  children,
}, ref) {
  return (
    <div
      ref={ref}
      className={className}
      data-commit-card={dataCommitCard}
      data-commit-visual-id={dataCommitVisualId}
      data-cluster-key={dataClusterKey}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      style={style}
    >
      <div
        ref={visualRef}
        className="h-full w-full"
      >
        {children}
      </div>
    </div>
  );
});

const COMMIT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const CARD_LAYOUT_HEIGHT = CARD_BODY_TOP_OFFSET + CARD_HEIGHT + 4;

type CommitCardProps = {
  node: Node;
  cardLeft: number;
  cardTop: number;
  displayZoom: number;
  isSelectedCommit: boolean;
  normalizedSearchQuery: string;
  matchingNodeIds: Set<string>;
  focusedCommitId: string | null;
  manuallyOpenedClumps: Set<string>;
  renderedOpenClumps: Set<string>;
  manuallyClosedClumps: Set<string>;
  closingClumps: Set<string>;
  defaultCollapsedClumps: Set<string>;
  leadByClusterKey: Map<string, string>;
  firstByClusterKey: Map<string, string>;
  clusterKeyByCommitId: Map<string, string>;
  clusterCounts: Map<string, number>;
  unpushedCommitShasSetByBranch: Map<string, Set<string>>;
  remoteCommitShas: Set<string>;
  worktreeAccentByCommitId: Map<string, WorktreeAccentToken>;
  worktreeSessions: WorktreeSession[];
  worktreeDraftByWorkingTreeId?: ReadonlyMap<string, WorktreeDraftDisplay>;
  previewedNodeId?: string | null;
  previewedWorktreeNodeIds?: string[];
  terminalCountByWorkingTreeId: Readonly<Record<string, number>>;
  worktrees: WorktreeInfo[];
  currentRepoPath?: string;
  onShowContextMenu?: (
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus' | 'commit' | 'stash' | 'empty-branch',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo,
    commitSha?: string,
    commitLabel?: string,
    commitText?: string,
    branchName?: string
  ) => void;
  onCommitCardClick: (event: MouseEvent, node: Node) => void;
  onNodePointerDown: (event: React.PointerEvent<HTMLDivElement>, node: Node) => void;
  onNodePointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNodePointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClusterToggle: (clusterKey: string, anchor: { x: number; y: number }) => void;
  /** Skip search-hit scale transform during camera motion (reduces compositor layers). */
  suppressSearchMatchScale?: boolean;
  /** Disable layout transitions while the camera is moving. */
  suspendTileAnimations?: boolean;
  animateClumpEntry?: boolean;
  animateClumpExit?: boolean;
  clumpAnimationIndex?: number;
  clumpExitAnimationIndex?: number;
  reduceMotion?: boolean;
  commitInProgress?: boolean;
  registerCameraTarget: (element: HTMLElement | SVGElement, layout?: MapGridCameraTargetLayout) => () => void;
};

function areCommitCardPropsEqual(prev: Readonly<CommitCardProps>, next: Readonly<CommitCardProps>): boolean {
  const prevIds = prev.previewedWorktreeNodeIds;
  const nextIds = next.previewedWorktreeNodeIds;
  const previewedWorktreeNodeIdsEqual =
    prevIds === nextIds ||
    Boolean(prevIds && nextIds && prevIds.length === nextIds.length && prevIds.every((v, i) => v === nextIds[i]));

  return (
    prev.node === next.node &&
    prev.cardLeft === next.cardLeft &&
    prev.cardTop === next.cardTop &&
    prev.displayZoom === next.displayZoom &&
    prev.isSelectedCommit === next.isSelectedCommit &&
    prev.normalizedSearchQuery === next.normalizedSearchQuery &&
    prev.matchingNodeIds === next.matchingNodeIds &&
    prev.focusedCommitId === next.focusedCommitId &&
    prev.manuallyOpenedClumps === next.manuallyOpenedClumps &&
    prev.renderedOpenClumps === next.renderedOpenClumps &&
    prev.manuallyClosedClumps === next.manuallyClosedClumps &&
    prev.closingClumps === next.closingClumps &&
    prev.defaultCollapsedClumps === next.defaultCollapsedClumps &&
    prev.leadByClusterKey === next.leadByClusterKey &&
    prev.firstByClusterKey === next.firstByClusterKey &&
    prev.clusterKeyByCommitId === next.clusterKeyByCommitId &&
    prev.clusterCounts === next.clusterCounts &&
    prev.unpushedCommitShasSetByBranch === next.unpushedCommitShasSetByBranch &&
    prev.remoteCommitShas === next.remoteCommitShas &&
    prev.worktreeAccentByCommitId === next.worktreeAccentByCommitId &&
    prev.worktreeSessions === next.worktreeSessions &&
    prev.worktreeDraftByWorkingTreeId === next.worktreeDraftByWorkingTreeId &&
    prev.previewedNodeId === next.previewedNodeId &&
    previewedWorktreeNodeIdsEqual &&
    prev.terminalCountByWorkingTreeId === next.terminalCountByWorkingTreeId &&
    prev.worktrees === next.worktrees &&
    prev.currentRepoPath === next.currentRepoPath &&
    prev.suppressSearchMatchScale === next.suppressSearchMatchScale &&
    prev.suspendTileAnimations === next.suspendTileAnimations &&
    prev.animateClumpEntry === next.animateClumpEntry &&
    prev.animateClumpExit === next.animateClumpExit &&
    prev.clumpAnimationIndex === next.clumpAnimationIndex &&
    prev.clumpExitAnimationIndex === next.clumpExitAnimationIndex &&
    prev.reduceMotion === next.reduceMotion &&
    prev.commitInProgress === next.commitInProgress
  );
}

const MapGridCommitCard = memo(function MapGridCommitCard({
  node,
  cardLeft,
  cardTop,
  displayZoom,
  isSelectedCommit,
  normalizedSearchQuery,
  matchingNodeIds,
  focusedCommitId,
  manuallyOpenedClumps,
  renderedOpenClumps,
  manuallyClosedClumps,
  closingClumps,
  defaultCollapsedClumps,
  leadByClusterKey,
  firstByClusterKey,
  clusterKeyByCommitId,
  clusterCounts,
  unpushedCommitShasSetByBranch,
  remoteCommitShas,
  worktreeAccentByCommitId,
  worktreeSessions,
  worktreeDraftByWorkingTreeId,
  previewedNodeId,
  previewedWorktreeNodeIds = [],
  terminalCountByWorkingTreeId,
  worktrees,
  currentRepoPath,
  onShowContextMenu,
  onCommitCardClick,
  onNodePointerDown,
  onNodePointerMove,
  onNodePointerUp,
  onClusterToggle,
  suppressSearchMatchScale = false,
  suspendTileAnimations = false,
  animateClumpEntry = false,
  animateClumpExit = false,
  clumpAnimationIndex = 0,
  clumpExitAnimationIndex = 0,
  reduceMotion = false,
  commitInProgress = false,
  registerCameraTarget,
}: CommitCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cardVisualRef = useRef<HTMLDivElement | null>(null);
  const previousPositionRef = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    return registerCameraTarget(element, { layoutX: cardLeft, layoutY: cardTop });
  }, [registerCameraTarget, cardLeft, cardTop]);
  useLayoutEffect(() => {
    const previous = previousPositionRef.current;
    previousPositionRef.current = { left: cardLeft, top: cardTop };
    const visual = cardVisualRef.current;
    if (!previous || !visual || suspendTileAnimations || reduceMotion) return;
    const x = previous.left - cardLeft;
    const y = previous.top - cardTop;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
    const animation = visual.animate(
      [{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 170, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    return () => animation.cancel();
  }, [cardLeft, cardTop, reduceMotion, suspendTileAnimations]);
  useEffect(() => {
    const visual = cardVisualRef.current;
    if (!visual || reduceMotion) return;
    if (animateClumpEntry) {
      const animation = visual.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: 110,
          delay: Math.min(clumpAnimationIndex, 5) * 16,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'both',
        },
      );
      return () => animation.cancel();
    }
    visual.style.opacity = '1';
  }, [animateClumpEntry, clumpAnimationIndex, reduceMotion]);
  useEffect(() => {
    const visual = cardVisualRef.current;
    if (!visual) return;
    if (!animateClumpExit) {
      visual.style.opacity = '1';
      return;
    }
    if (reduceMotion) {
      visual.style.opacity = '0';
      return () => {
        visual.style.opacity = '1';
      };
    }
    const animation = visual.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      {
        duration: 110,
        delay: Math.min(clumpExitAnimationIndex, 5) * 16,
        easing: 'cubic-bezier(0.7, 0, 0.84, 0)',
        fill: 'forwards',
      },
    );
    return () => animation.cancel();
  }, [animateClumpExit, clumpExitAnimationIndex, reduceMotion]);
  const commitId = node.commit.id;
  const visualId = node.commit.visualId;
  const branchName = node.commit.branchName;
  const clusterKey = clusterKeyByCommitId.get(visualId) ?? null;
  const isClusterOpen = clusterKey
    ? !closingClumps.has(clusterKey) && !manuallyClosedClumps.has(clusterKey) && (
      renderedOpenClumps.has(clusterKey) ||
      manuallyOpenedClumps.has(clusterKey) ||
      !defaultCollapsedClumps.has(clusterKey)
    )
    : false;
  const clumpCount = clusterKey ? clusterCounts.get(clusterKey) ?? 1 : 1;
  const isClusterLead = clusterKey ? leadByClusterKey.get(clusterKey) === visualId : false;
  const isClusterCaretHost =
    clusterKey != null && clumpCount > 1
      ? isClusterOpen
        ? firstByClusterKey.get(clusterKey) === visualId
        : isClusterLead
      : false;
  const isPreviewedWorktreeCommit = previewedWorktreeNodeIds.includes(commitId);
  const isPreviewedCommit = previewedNodeId === visualId || previewedNodeId === commitId || isPreviewedWorktreeCommit;
  const terminalCount = terminalCountByWorkingTreeId[commitId] ?? 0;
  const isLocalUncommitted = isWorkingTreeCommitId(commitId) || node.commit.kind === 'uncommitted';
  const accentToken = worktreeAccentByCommitId.get(commitId) ?? null;
  const isStashedCommit =
    (node.commit.kind === 'stash' || commitId.startsWith('STASH:')) && !commitId.startsWith('BRANCH_HEAD:');
  const isEmptyBranchNode = commitId.startsWith('BRANCH_HEAD:');
  const uncommittedSession = isLocalUncommitted
    ? worktreeSessions.find((session) => session.workingTreeId === commitId)
    : undefined;
  const isDirtyWorktreeNode = isLocalUncommitted && (uncommittedSession?.hasUncommittedChanges ?? false);
  const isUnpushedOnBranch =
    !isLocalUncommitted &&
    isCommitUnpushedOnBranch(commitId, branchName, unpushedCommitShasSetByBranch);
  const isUnpushedCommit = isUnpushedOnBranch;
  const isExplicitRemoteCommit = node.commit.isRemote === true;
  const isRemoteCommit =
    !isLocalUncommitted &&
    !isUnpushedCommit &&
    (isExplicitRemoteCommit || remoteCommitShas.has(commitId));
  const isFocused = focusedCommitId === commitId;
  const isSearchActive = !!normalizedSearchQuery;
  const isSearchMatch = isSearchActive && matchingNodeIds.has(commitId);
  const stashIndexMatch = /^STASH:(\d+)$/.exec(node.commit.id);
  const stashHeaderLabel = stashIndexMatch ? `Stash ${Number.parseInt(stashIndexMatch[1], 10) + 1}` : null;
  const stashBodyMessage = isStashedCommit
    ? (node.commit.message.trim() && node.commit.message.trim() !== 'cobble'
        ? node.commit.message
        : 'Stashed changes')
    : node.commit.message;

  const hasWorktreeAccent = worktreeAccentActive(isLocalUncommitted, accentToken);
  const showWorktreeAccent = hasWorktreeAccent && !isSelectedCommit;
  const accentColors = accentToken ? accentCssVars(accentToken) : null;

  const selectedCommitTextClass = showWorktreeAccent
    ? ''
    : isSelectedCommit
      ? 'text-select'
      : 'text-foreground';
  const selectedCommitTextStyle: CSSProperties | undefined = showWorktreeAccent && accentColors
    ? { color: accentColors.fg }
    : isSelectedCommit
      ? { color: 'var(--select)' }
      : undefined;
  /** Stash-like animated tile pattern (working tree, stash, empty branch). */
  const showCommitTilePattern = true;
  /** Animated noisy gaps (working tree, stash, empty branch). Unpushed uses static gaps only. */
  const commitTileAnimateGaps = (isDirtyWorktreeNode && !commitInProgress) || isStashedCommit || isEmptyBranchNode;
  const commitTileCloudyGaps = isRemoteCommit;
  const commitTileRandomGaps =
    commitTileAnimateGaps
    || (isUnpushedCommit && !commitTileCloudyGaps)
    || (isDirtyWorktreeNode && !commitInProgress);
  const commitTileOmissionRate = commitTileAnimateGaps
    ? TILE_UNCOMMITTED_OMISSION_RATE
    : TILE_DEFAULT_OMISSION_RATE;
  const commitTilePatternMode = commitTileAnimateGaps
    ? 'animated'
    : commitTileCloudyGaps
      ? 'cloudy'
      : commitTileRandomGaps
        ? 'gapped'
        : 'solid';
  const useRoundedCardOutline = showCommitTilePattern;
  const outlineCornerRadiusCss = useRoundedCardOutline
    ? `calc(${GRID_COMMIT_CORNER_RADIUS_BASE_PX}px * var(--map-inv-zoom, 1))`
    : '0';
  const cardTextStyle = selectedCommitTextStyle;

  const wrapperClassName = cn(
    'group absolute z-20',
    isSearchActive && !isSearchMatch && !isFocused ? 'opacity-10' : '',
    isSearchActive && isSearchMatch && !suppressSearchMatchScale && !isFocused ? 'scale-[1.01]' : '',
    isFocused ? 'z-30' : '',
  );

  const shortSha = node.commit.id.slice(0, 7);
  const headerLabel = isEmptyBranchNode
    ? node.commit.branchName
    : isLocalUncommitted && uncommittedSession
      ? formatWorktreeNodeHeaderLabel(uncommittedSession)
      : isStashedCommit && stashHeaderLabel
          ? stashHeaderLabel
          : isRemoteCommit && branchName
            ? formatRemoteCommitHeaderLabel(branchName, node.commit.id)
            : node.commit.branchName
              ? `${node.commit.branchName}/${shortSha}`
              : shortSha;

  const draftPreview = isLocalUncommitted
    ? worktreeDraftByWorkingTreeId?.get(commitId)
    : undefined;
  const displayLabel = draftPreview
    ? resolveWorktreeDraftDisplayLabel(draftPreview)
    : isDirtyWorktreeNode
      ? DIRTY_WORKTREE_BUILDING_LABEL
      : '';
  const showWorkingDots = isDirtyWorktreeNode
    && displayLabel === DIRTY_WORKTREE_BUILDING_LABEL;
  const bodyContent: ReactNode = isDirtyWorktreeNode
    ? (
        <>
          {displayLabel}
          {showWorkingDots ? <WorkingDots /> : null}
        </>
      )
    : isLocalUncommitted || isEmptyBranchNode
      ? ''
      : stashBodyMessage;

  const handleClick = (event: MouseEvent) => onCommitCardClick(event, node);
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => onNodePointerDown(event, node);
  const handleClusterButtonClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (!clusterKey) return;
    const rect = cardRef.current?.getBoundingClientRect();
    onClusterToggle(clusterKey, { x: rect?.left ?? event.clientX, y: rect?.top ?? event.clientY });
  };
  const scaledTextStyle: CSSProperties = {
    fontSize: 'calc(0.875rem * var(--map-inv-zoom, 1))',
    lineHeight: 1,
    ...cardTextStyle,
  };
  const scaledBodyTextStyle: CSSProperties = {
    fontSize: 'calc(0.875rem * var(--map-inv-zoom, 1))',
    lineHeight: 1.25,
    ...cardTextStyle,
  };
  const softInvZoom = 'calc(0.5 * (1 + var(--map-inv-zoom, 1)))';
  const scaledBodyInsetStyle: CSSProperties = {
    padding: `calc(0.75rem * ${softInvZoom}) calc(0.9rem * ${softInvZoom})`,
  };
  const scaledMetaTopStyle: CSSProperties = {
    paddingTop: `calc(1.85rem * ${softInvZoom})`,
    gap: `calc(1.5rem * ${softInvZoom})`,
  };

  const commitTileShapeCssVar = resolveWorktreeCommitTileShapeCssVar(
    accentToken,
    isSelectedCommit,
    showCommitTilePattern,
  );

  const commitTileHoverTintColor = !showCommitTilePattern
    ? null
    : isSelectedCommit
      ? 'var(--select)'
      : accentColors
        ? accentColors.fg
        : 'var(--foreground)';

  const cardBodyRef = useRef<HTMLDivElement>(null);
  const tilePatternRef = useRef<CommitNodeTilePatternHandle>(null);
  const isTileHoverTrackingRef = useRef(false);

  const applyTilePatternAtClient = useCallback(
    (clientX: number, clientY: number) => {
      if (!commitTileShapeCssVar) {
        return;
      }
      const body = cardBodyRef.current;
      if (!body) {
        return;
      }
      const rect = body.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const layoutX = ((clientX - rect.left) / rect.width) * CARD_WIDTH;
      const layoutY = ((clientY - rect.top) / rect.height) * CARD_HEIGHT;
      tilePatternRef.current?.applyPointer(layoutX, layoutY);
    },
    [commitTileShapeCssVar],
  );

  const handleCardPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      onNodePointerMove(event);
    },
    [onNodePointerMove],
  );

  const stopTileHoverTracking = useCallback(() => {
    isTileHoverTrackingRef.current = false;
    tilePatternRef.current?.endHover();
  }, []);

  const isClientInsideCard = useCallback((clientX: number, clientY: number) => {
    const card = cardRef.current;
    if (!card) {
      return false;
    }
    const rect = card.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }, []);

  useLayoutEffect(() => {
    if (!commitTileShapeCssVar) {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (!isTileHoverTrackingRef.current) {
        return;
      }
      if (!isClientInsideCard(event.clientX, event.clientY)) {
        stopTileHoverTracking();
        return;
      }
      applyTilePatternAtClient(event.clientX, event.clientY);
    };

    const handleCardPointerEnter = (event: PointerEvent) => {
      isTileHoverTrackingRef.current = true;
      tilePatternRef.current?.startHover();
      applyTilePatternAtClient(event.clientX, event.clientY);
      window.addEventListener('pointermove', handleWindowPointerMove);
    };

    const handleCardPointerLeave = (event: PointerEvent) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && card.contains(relatedTarget)) {
        return;
      }
      window.removeEventListener('pointermove', handleWindowPointerMove);
      stopTileHoverTracking();
    };

    card.addEventListener('pointerenter', handleCardPointerEnter);
    card.addEventListener('pointerleave', handleCardPointerLeave);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      card.removeEventListener('pointerenter', handleCardPointerEnter);
      card.removeEventListener('pointerleave', handleCardPointerLeave);
      if (isTileHoverTrackingRef.current) {
        isTileHoverTrackingRef.current = false;
        tilePatternRef.current?.endHover();
      }
    };
  }, [
    applyTilePatternAtClient,
    commitTileShapeCssVar,
    isClientInsideCard,
    stopTileHoverTracking,
    visualId,
  ]);

  return (
    <MapGridCommitWrapper
      ref={cardRef}
      dataCommitCard="true"
      dataCommitVisualId={visualId}
      dataClusterKey={clusterKey ?? undefined}
      visualRef={cardVisualRef}
      className={wrapperClassName}
      style={{
        left: cardLeft,
        top: cardTop,
        width: CARD_WIDTH,
        height: CARD_LAYOUT_HEIGHT,
        overflow: 'visible',
        contain: 'layout style',
      }}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handleCardPointerMove}
      onPointerUp={onNodePointerUp}
      onPointerCancel={onNodePointerUp}
      onContextMenu={(event) => {
        if (!onShowContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        
        if (!isSelectedCommit) {
          onCommitCardClick(event as any, node);
        }
        
        if (isLocalUncommitted) {
          let wtInfo = undefined;
          if (uncommittedSession) {
            const targetNorm = uncommittedSession.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            wtInfo = worktrees.find((w) => w.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === targetNorm);
          }
          if (!wtInfo) {
            if (commitId === LEGACY_WORKING_TREE_ID) {
              wtInfo = worktrees.find((w) => w.isCurrent);
            } else if (commitId.startsWith(`${LEGACY_WORKING_TREE_ID}:`)) {
              const stableKey = commitId.substring(LEGACY_WORKING_TREE_ID.length + 1);
              wtInfo = worktrees.find((w) => worktreeStableKey(w.path) === stableKey);
            }
          }
          onShowContextMenu(
            event,
            'worktree',
            currentRepoPath || '',
            wtInfo?.path,
            wtInfo,
            commitId,
            headerLabel,
            displayLabel
          );
        } else if (isEmptyBranchNode) {
          onShowContextMenu(
            event,
            'empty-branch',
            currentRepoPath || '',
            undefined,
            undefined,
            commitId,
            headerLabel,
            undefined,
            node.commit.branchName
          );
        } else if (isStashedCommit) {
          onShowContextMenu(
            event,
            'stash',
            currentRepoPath || '',
            undefined,
            undefined,
            commitId,
            headerLabel,
            node.commit.message
          );
        } else {
          onShowContextMenu(
            event,
            'commit',
            currentRepoPath || '',
            undefined,
            undefined,
            commitId,
            headerLabel,
            node.commit.message,
            node.commit.branchName
          );
        }
      }}
    >
      <div
        className={cn("absolute left-0 z-30 w-full", selectedCommitTextClass)}
        style={{
          fontSize: 'calc(0.875rem * var(--map-inv-zoom, 1))',
          top: 'calc(-1.2rem * var(--map-inv-zoom, 1) - 0.4rem)',
          ...cardTextStyle,
        }}
      >
        <div
          className="flex w-full min-w-0 items-center justify-between bg-transparent pb-0"
          style={{ gap: 'calc(2px * var(--map-inv-zoom, 1))' }}
        >
          <div
            className="flex min-w-0 flex-1 items-center"
            style={{ gap: 'calc(2px * var(--map-inv-zoom, 1))' }}
          >
            {isPreviewedCommit && !isLocalUncommitted ? (
              <PreviewIcon
                aria-label="Preview running"
                className="h-[1em] w-[1em] shrink-0"
              />
            ) : null}
            <div
              className={cn(
                'min-w-0 flex-1 font-normal overflow-hidden text-ellipsis whitespace-nowrap',
              )}
            >
              {headerLabel}
            </div>
          </div>
          <div
            className="flex shrink-0 items-center"
            style={{ gap: 'calc(2px * var(--map-inv-zoom, 1))' }}
          >
            {isLocalUncommitted && isPreviewedCommit ? (
              <PreviewIcon
                aria-label="Preview running"
                className="h-[1em] w-[1em] shrink-0"
              />
            ) : null}
            {!isLocalUncommitted && terminalCount > 0 ? (
              <span
                aria-label={`${terminalCount} running terminal${terminalCount === 1 ? '' : 's'}`}
                className="inline-flex items-center font-normal leading-none"
              >
                {terminalCount > 1 ? terminalCount : null}
                <TerminalIcon className="h-[1em] w-[1em] shrink-0 ml-[0.15em]" />
              </span>
            ) : null}
            {isClusterCaretHost ? (
              <button
                type="button"
                aria-label={isClusterOpen ? `Collapse ${clumpCount} commits` : `Expand ${clumpCount} commits`}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={handleClusterButtonClick}
                className="-m-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-md bg-transparent p-1 font-normal leading-none transition-colors hover:bg-accent active:bg-muted"
                style={{
                  ...scaledTextStyle,
                  minHeight: 'calc(1.5rem * var(--map-inv-zoom, 1))',
                  minWidth: 'calc(1.5rem * var(--map-inv-zoom, 1))',
                  padding: 'calc(0.25rem * var(--map-inv-zoom, 1))',
                }}
              >
                {isClusterOpen ? (
                  <span className="-translate-x-[1px] translate-y-[2px] leading-none" style={{ fontSize: 'calc(1rem * var(--map-inv-zoom, 1))' }}>⌃</span>
                ) : (
                  `+${clumpCount - 1}`
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div
        ref={cardBodyRef}
        className={cn(
          'absolute left-0 h-[176px] w-full cursor-grab overflow-hidden active:cursor-grabbing',
          useRoundedCardOutline ? 'rounded-tr-xl rounded-br-xl rounded-bl-xl rounded-tl-none' : '',
          showCommitTilePattern
            ? 'bg-background'
            : showWorktreeAccent && accentToken && !isUnpushedCommit && !commitTileCloudyGaps
              ? ''
              : isSelectedCommit && !isUnpushedCommit && !commitTileCloudyGaps
                ? 'bg-select-muted'
                : isUnpushedCommit || commitTileCloudyGaps
                  ? 'bg-background'
                  : 'bg-muted',
        )}
        style={{
          top: 0,
          border: 'none',
          boxShadow: 'none',
          borderTopLeftRadius: 0,
          borderTopRightRadius: outlineCornerRadiusCss,
          borderBottomRightRadius: outlineCornerRadiusCss,
          borderBottomLeftRadius: outlineCornerRadiusCss,
          contain: 'layout paint style',
          ...(showWorktreeAccent && accentToken && !showCommitTilePattern && !isUnpushedCommit && !commitTileCloudyGaps
            ? { backgroundColor: `var(--${accentToken}-muted)` }
            : {}),
        }}
      >
        {commitTileShapeCssVar && commitTileHoverTintColor ? (
          <CommitNodeTilePattern
            key={`${visualId}:${commitTilePatternMode}`}
            ref={tilePatternRef}
            seed={visualId}
            shapeFillCssVar={commitTileShapeCssVar}
            hoverTintColor={commitTileHoverTintColor}
            displayZoom={displayZoom}
            randomTileGaps={commitTileRandomGaps}
            animateTileGaps={commitTileAnimateGaps}
            cloudyTileGaps={commitTileCloudyGaps}
            tileOmissionRate={commitTileOmissionRate}
          />
        ) : null}
        <div
          className="pointer-events-none relative z-10 flex h-full min-h-0 flex-col"
          style={scaledBodyInsetStyle}
        >
          <div className="min-h-0 flex-1">
            <div
              className={cn(
                'pointer-events-auto max-w-[38rem] select-none font-normal tracking-tight text-foreground',
                selectedCommitTextClass,
                displayZoom <= 0.5 ? 'overflow-hidden text-ellipsis whitespace-nowrap' : 'break-words whitespace-pre-line',
              )}
              style={scaledBodyTextStyle}
              aria-label={isDirtyWorktreeNode ? displayLabel : undefined}
            >
              {bodyContent}
            </div>
          </div>
          {displayZoom > 0.5 ? (
            <div className="mt-auto flex items-end justify-between" style={scaledMetaTopStyle}>
              <div
                className={cn('pointer-events-auto select-none font-normal', selectedCommitTextClass)}
                style={scaledTextStyle}
              >
                {isLocalUncommitted && uncommittedSession ? (
                  worktreeSessionDisplayName(uncommittedSession)
                ) : (
                  `@${node.commit.author}`
                )}
              </div>
              <div
                className={cn('pointer-events-auto select-none font-normal', selectedCommitTextClass)}
                style={scaledTextStyle}
              >
                {isLocalUncommitted ? (
                  terminalCount > 0 ? (
                    <span
                      aria-label={`${terminalCount} running terminal${terminalCount === 1 ? '' : 's'}`}
                      className="inline-flex items-center font-normal leading-none"
                    >
                      {terminalCount > 1 ? terminalCount : null}
                      <TerminalIcon className="h-[1em] w-[1em] shrink-0 ml-[0.15em]" />
                    </span>
                  ) : null
                ) : (
                  COMMIT_DATE_FORMATTER.format(new Date(node.commit.date))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </MapGridCommitWrapper>
  );
}, areCommitCardPropsEqual);

type RenderConnector = {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  zIndex: number;
  fromFace?: ConnectorFace;
  toFace?: ConnectorFace;
};

function anchorForFace(x: number, y: number, face?: ConnectorFace): { x: number; y: number } {
  switch (face) {
    case 'left':
      return { x, y: y + CARD_HEIGHT / 2 };
    case 'right':
      return { x: x + CARD_WIDTH, y: y + CARD_HEIGHT / 2 };
    case 'top':
      return { x: x + CARD_WIDTH / 2, y };
    case 'bottom':
      return { x: x + CARD_WIDTH / 2, y: y + CARD_HEIGHT };
    case 'mid-h':
      return { x: x + CARD_WIDTH / 2, y: y + CARD_HEIGHT / 2 };
    default:
      return { x: x + CARD_WIDTH / 2, y: y + CARD_HEIGHT / 2 };
  }
}

const CONNECTOR_FACES: ReadonlyArray<ConnectorFace> = ['left', 'right', 'top', 'bottom', 'mid-h'];

function adjustedAnchorKey(face: ConnectorFace, x: number, y: number): string {
  return `${face}:${Math.round(x)}:${Math.round(y)}`;
}

type Props = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  mapPadHostRef: RefObject<HTMLDivElement | null>;
  registerCameraTarget: (element: HTMLElement | SVGElement, layout?: MapGridCameraTargetLayout) => () => void;
  renderedCameraRef: RefObject<MapGridCameraState>;
  isMarqueeSelecting: boolean;
  contentWidth: number;
  contentHeight: number;
  isCameraMovingRef: MutableRefObject<boolean>;
  panEpoch: number;
  cameraRenderTick: number;
  viewportClientSize: { width: number; height: number } | null;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onNodePointerDown: (event: React.PointerEvent<HTMLDivElement>, node: Node) => void;
  onNodePointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNodePointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  displayZoom: number;
  selectedVisibleCommitShas: string[];
  normalizedSearchQuery: string;
  matchingNodeIds: Set<string>;
  focusedCommitId: string | null;
  visibleRenderNodes: Node[];
  layoutNodes: Node[];
  manuallyOpenedClumps: Set<string>;
  renderedOpenClumps: Set<string>;
  manuallyClosedClumps: Set<string>;
  defaultCollapsedClumps: Set<string>;
  leadByClusterKey: Map<string, string>;
  firstByClusterKey: Map<string, string>;
  clusterKeyByCommitId: Map<string, string>;
  clusterCounts: Map<string, number>;
  commitCornerRadiusPx: number;
  lineStrokeWidth: number;
  connectors: Connector[];
  mergeConnectors: Connector[];
  cullConnectorPath: (connector: { id: string; fromX: number; fromY: number; toX: number; toY: number; fromFace?: ConnectorFace; toFace?: ConnectorFace }) => boolean;
  flushCameraReactTick: () => void;
  syncCamera: (panX: number, panY: number, zoom: number, options?: { animate?: boolean; persist?: boolean }) => void;
  setManuallyOpenedClumps: Dispatch<SetStateAction<Set<string>>>;
  setManuallyClosedClumps: Dispatch<SetStateAction<Set<string>>>;
  onCommitCardClick: (event: MouseEvent, node: Node) => void;
  unpushedCommitShasSetByBranch: Map<string, Set<string>>;
  remoteCommitShas: Set<string>;
  worktreeAccentByCommitId: Map<string, WorktreeAccentToken>;
  worktreeSessions: WorktreeSession[];
  worktreeDraftByWorkingTreeId?: ReadonlyMap<string, WorktreeDraftDisplay>;
  previewedNodeId?: string | null;
  previewedWorktreeNodeIds?: string[];
  terminalCountByWorkingTreeId: Readonly<Record<string, number>>;
  worktrees: WorktreeInfo[];
  currentRepoPath?: string;
  onShowContextMenu?: (
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus' | 'commit' | 'stash' | 'empty-branch',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo,
    commitSha?: string,
    commitLabel?: string,
    commitText?: string,
    branchName?: string
  ) => void;
  orientation?: 'vertical' | 'horizontal';
  dragPreviewByNodeId?: NodePositionOverrides;
  nodePositionOverrides?: NodePositionOverrides;
  connectorPathCacheScopeBase: string;
  commitInProgress?: boolean;
};

// Freeze connector source arrays during pan; cull list still refreshes via cameraRenderTick.
const PAN_STABLE_CONNECTOR_PROPS = new Set<keyof Props>(['connectors', 'mergeConnectors']);

function areMapGridCanvasPropsEqual(prev: Readonly<Props>, next: Readonly<Props>) {
  const keepConnectorRefsFrozen = prev.isCameraMovingRef.current && next.isCameraMovingRef.current;
  for (const key of Object.keys(prev) as Array<keyof Props>) {
    if (keepConnectorRefsFrozen && PAN_STABLE_CONNECTOR_PROPS.has(key)) continue;
    if (prev[key] !== next[key]) return false;
  }
  for (const key of Object.keys(next) as Array<keyof Props>) {
    if (key in prev) continue;
    if (keepConnectorRefsFrozen && PAN_STABLE_CONNECTOR_PROPS.has(key)) continue;
    return false;
  }
  return true;
}

const MapGridCanvas = memo(function MapGridCanvas({
  scrollContainerRef,
  mapPadHostRef,
  registerCameraTarget,
  renderedCameraRef,
  isMarqueeSelecting,
  contentWidth: _contentWidth,
  contentHeight: _contentHeight,
  isCameraMovingRef,
  panEpoch,
  cameraRenderTick,
  viewportClientSize,
  onWheel,
  onMouseDown,
  onNodePointerDown,
  onNodePointerMove,
  onNodePointerUp,
  displayZoom,
  selectedVisibleCommitShas,
  normalizedSearchQuery,
  matchingNodeIds,
  focusedCommitId,
  visibleRenderNodes,
  layoutNodes,
  manuallyOpenedClumps,
  renderedOpenClumps,
  manuallyClosedClumps,
  defaultCollapsedClumps,
  leadByClusterKey,
  firstByClusterKey,
  clusterKeyByCommitId,
  clusterCounts,
  commitCornerRadiusPx,
  lineStrokeWidth,
  connectors,
  mergeConnectors,
  cullConnectorPath,
  syncCamera,
  setManuallyOpenedClumps,
  setManuallyClosedClumps,
  onCommitCardClick,
  unpushedCommitShasSetByBranch,
  remoteCommitShas,
  worktreeAccentByCommitId,
  worktreeSessions,
  worktreeDraftByWorkingTreeId,
  previewedNodeId,
  previewedWorktreeNodeIds,
  terminalCountByWorkingTreeId,
  worktrees,
  currentRepoPath,
  onShowContextMenu,
  dragPreviewByNodeId = EMPTY_DRAG_PREVIEW,
  nodePositionOverrides = EMPTY_NODE_POSITION_OVERRIDES,
  connectorPathCacheScopeBase,
  commitInProgress = false,
}: Props) {
  const connectorPath2dCacheRef = useRef<Map<string, ConnectorPathCacheEntry>>(new Map());
  const connectorPersistScopeRef = useRef<string | null>(null);

  const selectedShaSet = useMemo(() => new Set(selectedVisibleCommitShas), [selectedVisibleCommitShas]);

  const pendingClumpCameraAnchorRef = useRef<{ clusterKey: string; x: number; y: number } | null>(null);
  const [closingClumps, setClosingClumps] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setClosingClumps(new Set());
  }, [currentRepoPath]);
  useEffect(() => {
    setClosingClumps((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const clusterKey of previous) {
        if (renderedOpenClumps.has(clusterKey)) continue;
        next.delete(clusterKey);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [renderedOpenClumps]);
  const handleClusterToggle = useCallback((clusterKey: string, anchor: { x: number; y: number }) => {
    pendingClumpCameraAnchorRef.current = { clusterKey, ...anchor };
    const isDefaultOpen = !defaultCollapsedClumps.has(clusterKey);
    const isOpen =
      !closingClumps.has(clusterKey) && !manuallyClosedClumps.has(clusterKey) && (
        renderedOpenClumps.has(clusterKey) ||
        manuallyOpenedClumps.has(clusterKey) ||
        isDefaultOpen
      );
    if (isOpen) {
      setClosingClumps((previous) => new Set(previous).add(clusterKey));
      if (isDefaultOpen) {
        setManuallyOpenedClumps((previous) => {
          if (!previous.has(clusterKey)) return previous;
          const next = new Set(previous);
          next.delete(clusterKey);
          return next;
        });
        setManuallyClosedClumps((previous) => {
          if (previous.has(clusterKey)) return previous;
          return new Set(previous).add(clusterKey);
        });
      } else {
        setManuallyClosedClumps((previous) => {
          if (!previous.has(clusterKey)) return previous;
          const next = new Set(previous);
          next.delete(clusterKey);
          return next;
        });
        setManuallyOpenedClumps((previous) => {
          if (!previous.has(clusterKey)) return previous;
          const next = new Set(previous);
          next.delete(clusterKey);
          return next;
        });
      }
      return;
    }
    setClosingClumps((previous) => {
      if (!previous.has(clusterKey)) return previous;
      const next = new Set(previous);
      next.delete(clusterKey);
      return next;
    });
    if (isDefaultOpen) {
      setManuallyOpenedClumps((prev) => {
        if (!prev.has(clusterKey)) return prev;
        const next = new Set(prev);
        next.delete(clusterKey);
        return next;
      });
      setManuallyClosedClumps((prev) => {
        const next = new Set(prev);
        if (next.has(clusterKey)) next.delete(clusterKey);
        else next.add(clusterKey);
        return next;
      });
    } else {
      setManuallyClosedClumps((prev) => {
        if (!prev.has(clusterKey)) return prev;
        const next = new Set(prev);
        next.delete(clusterKey);
        return next;
      });
      setManuallyOpenedClumps((prev) => {
        const next = new Set(prev);
        if (next.has(clusterKey)) next.delete(clusterKey);
        else next.add(clusterKey);
        return next;
      });
    }
  }, [
    clusterCounts,
    closingClumps,
    defaultCollapsedClumps,
    manuallyClosedClumps,
    manuallyOpenedClumps,
    renderedOpenClumps,
    setManuallyOpenedClumps,
    setManuallyClosedClumps,
  ]);

  useLayoutEffect(() => {
    const pending = pendingClumpCameraAnchorRef.current;
    if (!pending) return;
    const firstVisualId = firstByClusterKey.get(pending.clusterKey);
    const anchorNode = visibleRenderNodes.find((node) => node.commit.visualId === firstVisualId);
    if (!anchorNode) return;
    const element = document.querySelector<HTMLElement>(
      `[data-commit-visual-id="${CSS.escape(anchorNode.commit.visualId)}"][data-commit-card="true"]`,
    );
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const deltaX = pending.x - rect.left;
    const deltaY = pending.y - rect.top;
    pendingClumpCameraAnchorRef.current = null;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    const camera = renderedCameraRef.current;
    syncCamera(camera.panX + deltaX, camera.panY + deltaY, camera.zoom, { persist: false });
  }, [firstByClusterKey, renderedCameraRef, syncCamera, visibleRenderNodes]);

  const optimisticallyHiddenVisualIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const node of visibleRenderNodes) {
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      if (!clusterKey || !closingClumps.has(clusterKey)) continue;
      if (leadByClusterKey.get(clusterKey) === node.commit.visualId) continue;
      hidden.add(node.commit.visualId);
    }
    return hidden;
  }, [closingClumps, clusterKeyByCommitId, leadByClusterKey, visibleRenderNodes]);

  const adjustedAnchorByOriginalKey = useMemo(() => {
    const overrideKeys = Object.keys(nodePositionOverrides);
    const dragKeys = Object.keys(dragPreviewByNodeId);
    if (overrideKeys.length === 0 && dragKeys.length === 0) return EMPTY_ADJUSTED_ANCHOR_MAP;
    const map = new Map<string, { x: number; y: number }>();
    for (const node of layoutNodes) {
      const persistedOverride = getNodePositionOverride(nodePositionOverrides, node.commit);
      const dragPreview = dragPreviewByNodeId[node.commit.visualId];
      const effectiveX = dragPreview?.x ?? persistedOverride?.x ?? node.x;
      const effectiveY = dragPreview?.y ?? persistedOverride?.y ?? node.y;
      if (Math.abs(effectiveX - node.x) < 0.001 && Math.abs(effectiveY - node.y) < 0.001) continue;
      for (const face of CONNECTOR_FACES) {
        const orig = anchorForFace(node.x, node.y, face);
        const next = anchorForFace(effectiveX, effectiveY, face);
        map.set(adjustedAnchorKey(face, orig.x, orig.y), next);
      }
    }
    return map;
  }, [layoutNodes, nodePositionOverrides, dragPreviewByNodeId]);

  const adjustEndpoint = useCallback(
    (endpointX: number, endpointY: number, face: ConnectorFace | undefined): { x: number; y: number } => {
      if (!face || adjustedAnchorByOriginalKey.size === 0) return { x: endpointX, y: endpointY };
      const next = adjustedAnchorByOriginalKey.get(adjustedAnchorKey(face, endpointX, endpointY));
      return next ?? { x: endpointX, y: endpointY };
    },
    [adjustedAnchorByOriginalKey],
  );

  const buildVisibleConnectors = useCallback(
    (
      source: Connector[],
      cull: (connector: {
        id: string;
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        fromFace?: ConnectorFace;
        toFace?: ConnectorFace;
      }) => boolean,
    ): RenderConnector[] => {
      const filtered = source.filter(cull);
      return filtered.map((connector) => {
        const from = adjustEndpoint(connector.fromX, connector.fromY, connector.fromFace);
        const to = adjustEndpoint(connector.toX, connector.toY, connector.toFace);
        return { ...connector, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
      });
    },
    [adjustEndpoint],
  );

  const visibleMergeConnectors = useMemo(
    () => buildVisibleConnectors(
      mergeConnectors.filter((connector) =>
        !optimisticallyHiddenVisualIds.has(connector.fromCommitVisualId ?? '')
        && !optimisticallyHiddenVisualIds.has(connector.toCommitVisualId ?? '')),
      cullConnectorPath,
    ),
    [mergeConnectors, cullConnectorPath, buildVisibleConnectors, cameraRenderTick, optimisticallyHiddenVisualIds],
  );

  const visibleConnectors = useMemo(
    () => buildVisibleConnectors(
      connectors.filter((connector) =>
        !optimisticallyHiddenVisualIds.has(connector.fromCommitVisualId ?? '')
        && !optimisticallyHiddenVisualIds.has(connector.toCommitVisualId ?? '')),
      cullConnectorPath,
    ),
    [connectors, cullConnectorPath, buildVisibleConnectors, cameraRenderTick, optimisticallyHiddenVisualIds],
  );

  const connectorsForPathCache = useMemo(() => {
    const admitAll = () => true;
    return [
      ...buildVisibleConnectors(mergeConnectors, admitAll),
      ...buildVisibleConnectors(connectors, admitAll),
    ];
  }, [mergeConnectors, connectors, buildVisibleConnectors]);

  const connectorPathCacheScopeKey = useMemo(() => {
    const digest = computeConnectorLayoutDigest(connectorsForPathCache, commitCornerRadiusPx);
    return buildConnectorPathCacheScopeKey(connectorPathCacheScopeBase, digest, commitCornerRadiusPx);
  }, [connectorsForPathCache, commitCornerRadiusPx, connectorPathCacheScopeBase]);

  const flushConnectorPathCachePersist = useCallback(() => {
    if (isCameraMovingRef.current) return;
    const scopeKey = connectorPersistScopeRef.current;
    if (!scopeKey) return;
    const entries = collectPathStringsForPersistence(
      connectorPath2dCacheRef.current,
      connectorsForPathCache,
      commitCornerRadiusPx,
    );
    const count = Object.keys(entries).length;
    if (count === 0) return;
    setMapGridBackgroundActivity('connector-idb-write', 'Connector cache save (IDB)', true, `${count} paths`);
    void mergePersistedConnectorPaths(scopeKey, entries).finally(() => {
      setMapGridBackgroundActivity('connector-idb-write', 'Connector cache save (IDB)', false);
    });
  }, [commitCornerRadiusPx, connectorsForPathCache, isCameraMovingRef]);

  useEffect(() => {
    connectorPersistScopeRef.current = connectorPathCacheScopeKey;
    let cancelled = false;
    setMapGridBackgroundActivity('connector-idb-read', 'Connector cache load (IDB)', true);

    void readPersistedConnectorPaths(connectorPathCacheScopeKey).then((entries) => {
      if (cancelled) return;
      const applied = applyPersistedPathStrings(connectorPath2dCacheRef.current, entries);
      setMapGridBackgroundActivity(
        'connector-idb-read',
        'Connector cache load (IDB)',
        false,
        `${applied} paths hydrated`,
      );
    });

    return () => {
      cancelled = true;
      setMapGridBackgroundActivity('connector-idb-read', 'Connector cache load (IDB)', false);
    };
  }, [connectorPathCacheScopeKey]);

  useEffect(() => {
    const handlePageHide = () => flushConnectorPathCachePersist();
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      flushConnectorPathCachePersist();
    };
  }, [flushConnectorPathCachePersist]);

  useEffect(() => {
    const count = visibleMergeConnectors.length + visibleConnectors.length;
    pulseMapGridBackgroundActivity('connector-draw', 'Connector SVG update', `${count} paths`);
  }, [cameraRenderTick, panEpoch, visibleMergeConnectors, visibleConnectors]);

  const stickyCardSlotOrderRef = useRef<string[]>([]);
  const projectedClumpVisualIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of visibleRenderNodes) {
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      if (!clusterKey || !renderedOpenClumps.has(clusterKey)) continue;
      ids.add(node.commit.visualId);
    }
    return ids;
  }, [clusterKeyByCommitId, renderedOpenClumps, visibleRenderNodes]);

  const collapsedClumpVisualIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of visibleRenderNodes) {
      const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
      if (!clusterKey) continue;
      const count = clusterCounts.get(clusterKey) ?? 1;
      if (count <= 1) continue;
      const isOpen =
        !closingClumps.has(clusterKey) && !manuallyClosedClumps.has(clusterKey) && (
          renderedOpenClumps.has(clusterKey) ||
          manuallyOpenedClumps.has(clusterKey) ||
          !defaultCollapsedClumps.has(clusterKey)
        );
      if (!isOpen) {
        ids.add(node.commit.visualId);
      }
    }
    return ids;
  }, [
    clusterKeyByCommitId,
    clusterCounts,
    closingClumps,
    renderedOpenClumps,
    manuallyOpenedClumps,
    defaultCollapsedClumps,
    manuallyClosedClumps,
    visibleRenderNodes,
  ]);

  const cardSlotAssignments = useMemo(() => {
    const viewportW = viewportClientSize?.width ?? 0;
    const viewportH = viewportClientSize?.height ?? 0;
    const slotCount = computeMapGridCardSlotCount(viewportW, viewportH, displayZoom);
    const camera = renderedCameraRef.current;
    const bounds = computeViewportCullBounds(viewportW, viewportH, camera);
    const centerX = bounds ? (bounds.left + bounds.right) / 2 : 0;
    const centerY = bounds ? (bounds.top + bounds.bottom) / 2 : 0;
    const panStable = isCameraMovingRef.current;

    const assignments = buildMapGridCardSlotAssignments(
      slotCount,
      visibleRenderNodes,
      dragPreviewByNodeId,
      nodePositionOverrides,
      centerX,
      centerY,
      panStable ? stickyCardSlotOrderRef.current : [],
      projectedClumpVisualIds,
      collapsedClumpVisualIds,
    );

    if (panStable) {
      stickyCardSlotOrderRef.current = assignments.map((assignment) => assignment.node.commit.visualId);
    } else {
      stickyCardSlotOrderRef.current = [];
    }

    return assignments;
  }, [
    visibleRenderNodes,
    viewportClientSize,
    displayZoom,
    panEpoch,
    dragPreviewByNodeId,
    nodePositionOverrides,
    projectedClumpVisualIds,
    collapsedClumpVisualIds,
    renderedCameraRef,
    isCameraMovingRef,
  ]);

  const isCameraMoving = isCameraMovingRef.current;
  const suppressSearchMatchScale = isCameraMoving;
  const reduceMotion = useReducedMotion() ?? false;
  const previousOpenClumpsRef = useRef<Set<string> | null>(null);
  const [openingClumps, setOpeningClumps] = useState<Set<string>>(() => new Set());
  const openingClumpTimeoutsRef = useRef(new Map<string, number>());
  useEffect(() => {
    const previous = previousOpenClumpsRef.current;
    previousOpenClumpsRef.current = new Set(renderedOpenClumps);
    if (!previous) return;
    const newlyOpened = [...renderedOpenClumps].filter((clusterKey) => !previous.has(clusterKey));
    if (newlyOpened.length === 0) return;
    setOpeningClumps((current) => {
      const next = new Set(current);
      newlyOpened.forEach((clusterKey) => next.add(clusterKey));
      return next;
    });
    for (const clusterKey of newlyOpened) {
      const existing = openingClumpTimeoutsRef.current.get(clusterKey);
      if (existing != null) window.clearTimeout(existing);
      const count = clusterCounts.get(clusterKey) ?? 1;
      const timeout = window.setTimeout(() => {
        openingClumpTimeoutsRef.current.delete(clusterKey);
        setOpeningClumps((current) => {
          const next = new Set(current);
          next.delete(clusterKey);
          return next;
        });
      }, 110 + Math.min(Math.max(0, count - 1), 5) * 16);
      openingClumpTimeoutsRef.current.set(clusterKey, timeout);
    }
  }, [clusterCounts, renderedOpenClumps]);
  useEffect(() => () => {
    for (const timeout of openingClumpTimeoutsRef.current.values()) window.clearTimeout(timeout);
  }, []);

  const clumpAnimationLayout = useMemo(() => {
    const assignmentsByClump = new Map<string, typeof cardSlotAssignments>();
    for (const assignment of cardSlotAssignments) {
      const clusterKey = clusterKeyByCommitId.get(assignment.node.commit.visualId);
      if (!clusterKey || !renderedOpenClumps.has(clusterKey)) continue;
      const assignments = assignmentsByClump.get(clusterKey) ?? [];
      assignments.push(assignment);
      assignmentsByClump.set(clusterKey, assignments);
    }

    const layout = new Map<string, { entryIndex: number; exitIndex: number }>();
    for (const [clusterKey, assignments] of assignmentsByClump) {
      const leadVisualId = leadByClusterKey.get(clusterKey);
      const openingOrder = [...assignments].sort((left, right) =>
          new Date(left.node.commit.date).getTime() - new Date(right.node.commit.date).getTime()
          || left.node.commit.id.localeCompare(right.node.commit.id)
          || left.node.commit.visualId.localeCompare(right.node.commit.visualId));
      const closingOrder = [...openingOrder].reverse();
      if (leadVisualId) {
        const leadIndex = closingOrder.findIndex((assignment) => assignment.node.commit.visualId === leadVisualId);
        if (leadIndex > 0) closingOrder.unshift(...closingOrder.splice(leadIndex, 1));
      }
      openingOrder.forEach((assignment, entryIndex) => {
        layout.set(assignment.node.commit.visualId, {
          entryIndex,
          exitIndex: closingOrder.findIndex(
            (candidate) => candidate.node.commit.visualId === assignment.node.commit.visualId,
          ),
        });
      });
    }
    return layout;
  }, [cardSlotAssignments, clusterKeyByCommitId, leadByClusterKey, renderedOpenClumps]);

  return (
    <div
      ref={scrollContainerRef}
      className="relative flex-1 min-h-0 overflow-hidden"
      style={{
        cursor: isMarqueeSelecting ? 'crosshair' : 'default',
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
    >
      <div ref={mapPadHostRef} className="absolute inset-0 overflow-visible p-2.5">
        <MapGridConnectorLayer
            mergeConnectors={visibleMergeConnectors}
            connectors={visibleConnectors}
            cornerRadiusPx={commitCornerRadiusPx}
            strokeWidth={lineStrokeWidth}
            pathCache={connectorPath2dCacheRef.current}
            registerCameraTarget={registerCameraTarget}
          />
          <AnimatePresence initial={false}>
          {cardSlotAssignments.map((assignment) => {
            const { node, cardLeft, cardTop } = assignment;
            const clusterKey = clusterKeyByCommitId.get(node.commit.visualId);
            const isClumpMember = clusterKey != null && renderedOpenClumps.has(clusterKey);
            const animationLayout = clumpAnimationLayout.get(node.commit.visualId);
            return (
              <MapGridCommitCard
                key={node.commit.visualId}
                node={node}
                cardLeft={cardLeft}
                cardTop={cardTop}
                displayZoom={displayZoom}
                isSelectedCommit={selectedShaSet.has(node.commit.id)}
                normalizedSearchQuery={normalizedSearchQuery}
                matchingNodeIds={matchingNodeIds}
                focusedCommitId={focusedCommitId}
                manuallyOpenedClumps={manuallyOpenedClumps}
                renderedOpenClumps={renderedOpenClumps}
                manuallyClosedClumps={manuallyClosedClumps}
                closingClumps={closingClumps}
                defaultCollapsedClumps={defaultCollapsedClumps}
                leadByClusterKey={leadByClusterKey}
                firstByClusterKey={firstByClusterKey}
                clusterKeyByCommitId={clusterKeyByCommitId}
                clusterCounts={clusterCounts}
                unpushedCommitShasSetByBranch={unpushedCommitShasSetByBranch}
                remoteCommitShas={remoteCommitShas}
                worktreeAccentByCommitId={worktreeAccentByCommitId}
                worktreeSessions={worktreeSessions}
                worktreeDraftByWorkingTreeId={worktreeDraftByWorkingTreeId}
                previewedNodeId={previewedNodeId}
                previewedWorktreeNodeIds={previewedWorktreeNodeIds}
                terminalCountByWorkingTreeId={terminalCountByWorkingTreeId}
                worktrees={worktrees}
                currentRepoPath={currentRepoPath}
                onShowContextMenu={onShowContextMenu}
                onCommitCardClick={onCommitCardClick}
                onNodePointerDown={onNodePointerDown}
                onNodePointerMove={onNodePointerMove}
                onNodePointerUp={onNodePointerUp}
                onClusterToggle={handleClusterToggle}
                suppressSearchMatchScale={suppressSearchMatchScale}
                animateClumpEntry={!isCameraMoving && isClumpMember && openingClumps.has(clusterKey)}
                animateClumpExit={
                  clusterKey != null
                  && closingClumps.has(clusterKey)
                  && leadByClusterKey.get(clusterKey) !== node.commit.visualId
                }
                clumpAnimationIndex={animationLayout?.entryIndex ?? 0}
                clumpExitAnimationIndex={animationLayout?.exitIndex ?? 0}
                reduceMotion={reduceMotion}
                commitInProgress={commitInProgress}
                registerCameraTarget={registerCameraTarget}
              />
            );
        })}
          </AnimatePresence>
      </div>
    </div>
  );
}, areMapGridCanvasPropsEqual);

export default MapGridCanvas;

function TerminalIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path
        d="M10.7272 2.33331H3.27208C2.10812 2.33331 1.16455 3.27688 1.16455 4.44084V9.55912C1.16455 10.7231 2.10812 11.6666 3.27208 11.6666H10.7272C11.8911 11.6666 12.8347 10.7231 12.8347 9.55912V4.44084C12.8347 3.27688 11.8911 2.33331 10.7272 2.33331Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.79736 5.01288L5.78446 6.99998L3.79736 8.98707M7.44037 8.98707H10.0898"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PreviewIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path
        d="M4.21449 11.4349L10.8684 7.76319C11.4716 7.43033 11.4713 6.56324 10.8679 6.23073L4.21404 2.56418C3.63088 2.24284 2.91675 2.6647 2.91675 3.33053L2.91675 10.6688C2.91675 11.3348 3.63132 11.7567 4.21449 11.4349Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
