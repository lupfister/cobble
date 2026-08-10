import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import CobblePlusIcon from './CobblePlusIcon';
import { ToolbarSvgIcon } from './grid/ToolbarActionContent';
import type { Branch, BranchCommitPreview, TerminalSession, WorktreeInfo } from '../types';
import { accentCssVars, buildWorktreeSessions, workingTreeIdForPath } from '../lib/worktreeSessions';
import { visibleWorktrees } from '../lib/worktreePaths';
import { cn, normalizeRepoPathForCompare, worktreeDisplayName } from './grid/mapGridUtils';
import { Tooltip } from './Tooltip';

const EXPANDED_WORKTREES_KEY = 'cobble:expanded-worktrees';
const EXPANDED_PROJECTS_KEY = 'cobble:expanded-projects';

const projectExpansionKey = (path: string): string =>
  normalizeRepoPathForCompare(path).toLowerCase();

const worktreeExpansionKey = (projectPath: string, worktreePath: string): string =>
  `${projectExpansionKey(projectPath)}:${projectExpansionKey(worktreePath)}`;

const loadSet = (key: string): Set<string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
    return new Set(raw.map((value) => {
      if (key === EXPANDED_WORKTREES_KEY && value.includes(':')) {
        const [projectPath, worktreePath] = value.split(':', 2);
        if (projectPath && worktreePath) {
          return worktreeExpansionKey(projectPath, worktreePath);
        }
      }
      return projectExpansionKey(value);
    }));
  } catch {
    return new Set();
  }
};

const persistSet = (key: string, values: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(values)));
  } catch {
    // Ignore unavailable storage.
  }
};

const samePath = (left: string, right: string) =>
  normalizeRepoPathForCompare(left).toLowerCase() === normalizeRepoPathForCompare(right).toLowerCase();

type SidebarProject = {
  path: string;
  name: string;
  branches: Branch[];
  worktrees: WorktreeInfo[];
  branchCommitPreviews: Record<string, BranchCommitPreview[]>;
  worktreeOrder?: string[];
  terminalOrderMap?: Record<string, string[]>;
};

type Props = {
  projects: SidebarProject[];
  activeProjectPath: string | null;
  terminalSessions: TerminalSession[];
  activeTerminalId: string | null;
  onSelectProject: (path: string) => void | Promise<void>;
  onAddProject: () => void;
  onRemoveProject: (path: string) => void;
  onReorderProjects?: (nextOrder: string[]) => void;
  onReorderWorktrees?: (projectPath: string, nextOrder: string[]) => void;
  onReorderTerminals?: (projectPath: string, worktreePath: string, nextOrder: string[]) => void;
  onRevealProjectInFinder: (path: string) => Promise<void> | void;
  onResetProjectNodePositions?: (path: string) => void;
  onSelectWorktree: (projectPath: string, workingTreeId: string) => void | Promise<void>;
  onCreateTerminal: (projectPath: string, worktreePath: string) => void | Promise<void>;
  onSelectTerminal: (session: TerminalSession) => void;
  onTerminateTerminal?: (id: string) => void | Promise<void>;
  onCreateWorktree?: (projectPath: string) => void | Promise<void>;
  onDeleteWorktree?: (projectPath: string, worktreePath: string) => void | Promise<void>;
  onPreviewWorktree?: (projectPath: string, worktree: WorktreeInfo) => void | Promise<void>;
  onShowContextMenu?: (
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo
  ) => void;
  onCloseContextMenu?: () => void;
  projectLoading?: boolean;
  projectLoadStates?: Record<string, {
    status: 'loading' | 'ready' | 'error';
    phase: string;
    progress: number;
    error?: string | null;
  }>;
  projectError?: string | null;
  className?: string;
  style?: CSSProperties;
  collapsed?: boolean;
};

export const commitPreviewSessions = (sessions: TerminalSession[]): TerminalSession[] => {
  const commitPreviews = sessions.filter((session) => session.kind === 'preview' && session.targetKind === 'commit');
  if (commitPreviews.length <= 1) return commitPreviews;
  const running = commitPreviews.find((session) => session.status === 'running');
  return running ? [running] : [commitPreviews[commitPreviews.length - 1]!];
};

export const previewLabel = (session: TerminalSession): string => {
  if (session.previewUrl) {
    try {
      return new URL(session.previewUrl).port;
    } catch {
      return 'Preview';
    }
  }
  return 'Preview';
};

export const worktreeRefLabel = (worktree: WorktreeInfo): string =>
  worktree.branchName
    ? `${worktree.branchName}/${worktree.headSha.slice(0, 7)}`
    : worktree.headSha.slice(0, 7);

export const visibleNestedSessions = (
  sessions: TerminalSession[],
  worktreePath: string,
  workingTreeId: string,
): TerminalSession[] => sessions.filter((session) =>
  (
    samePath(session.worktreePath, worktreePath)
    || (session.targetKind === 'worktree' && session.targetId === workingTreeId)
  )
  && session.targetKind !== 'commit'
);

type SessionSidebarExpansionTarget = {
  path: string;
  worktrees: WorktreeInfo[];
};

/** Expand project + worktree rows whenever they contain visible terminal/preview sessions. */
export const resolveSessionSidebarExpansion = (
  projects: SessionSidebarExpansionTarget[],
  sessionsByProject: Map<string, TerminalSession[]>,
): { projectKeys: string[]; worktreeKeys: string[] } => {
  const projectKeys: string[] = [];
  const worktreeKeys: string[] = [];

  for (const project of projects) {
    const projectKey = projectExpansionKey(project.path);
    const projectSessions = sessionsByProject.get(projectKey) ?? [];
    if (projectSessions.length === 0) continue;

    projectKeys.push(projectKey);

    for (const worktree of project.worktrees) {
      const workingTreeId = workingTreeIdForPath(worktree.path, worktree.isCurrent);
      const nested = visibleNestedSessions(projectSessions, worktree.path, workingTreeId);
      if (nested.length === 0) continue;
      worktreeKeys.push(worktreeExpansionKey(project.path, worktree.path));
    }
  }

  return { projectKeys, worktreeKeys };
};

export default function DenseBranchSidebar({
  projects,
  activeProjectPath,
  terminalSessions,
  activeTerminalId,
  onSelectProject,
  onAddProject,
  onReorderProjects,
  onReorderWorktrees,
  onReorderTerminals,
  onSelectWorktree,
  onCreateTerminal,
  onSelectTerminal,
  onTerminateTerminal,
  onCreateWorktree: _onCreateWorktree,
  onShowContextMenu,
  onCloseContextMenu,
  projectLoading,
  projectLoadStates = {},
  projectError,
  className,
  style,
  collapsed,
}: Props) {
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(() => loadSet(EXPANDED_WORKTREES_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => loadSet(EXPANDED_PROJECTS_KEY));

  const showContextMenu = (
    event: React.MouseEvent,
    type: 'project' | 'worktree' | 'worktree-plus',
    projectPath: string,
    worktreePath?: string,
    worktree?: WorktreeInfo
  ) => {
    onShowContextMenu?.(event, type, projectPath, worktreePath, worktree);
  };
  
  // Project drag state
  const [dragPendingProjectPath, setDragPendingProjectPath] = useState<string | null>(null);
  const [draggingProjectPath, setDraggingProjectPath] = useState<string | null>(null);
  const [dragPreviewIndex, setDragPreviewIndex] = useState<number | null>(null);
  const [dragGhostRect, setDragGhostRect] = useState<{ x: number; y: number; width: number } | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    path: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    moved: boolean;
  } | null>(null);

  // Worktree drag state
  const [dragPendingWorktreePath, setDragPendingWorktreePath] = useState<string | null>(null);
  const [draggingWorktreePath, setDraggingWorktreePath] = useState<string | null>(null);
  const [dragWorktreePreviewIndex, setDragWorktreePreviewIndex] = useState<number | null>(null);
  const [dragWorktreeGhostRect, setDragWorktreeGhostRect] = useState<{ x: number; y: number; width: number } | null>(null);
  const dragWorktreeStateRef = useRef<{
    active: boolean;
    projectPath: string;
    worktreePath: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    moved: boolean;
  } | null>(null);

  // Terminal/Preview drag state
  const [dragPendingTerminalId, setDragPendingTerminalId] = useState<string | null>(null);
  const [draggingTerminalId, setDraggingTerminalId] = useState<string | null>(null);
  const [dragTerminalPreviewIndex, setDragTerminalPreviewIndex] = useState<number | null>(null);
  const [dragTerminalGhostRect, setDragTerminalGhostRect] = useState<{ x: number; y: number; width: number } | null>(null);
  const dragTerminalStateRef = useRef<{
    active: boolean;
    worktreePath: string;
    terminalId: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    moved: boolean;
  } | null>(null);

  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const suppressProjectSelectRef = useRef(false);
  const dragRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activeProjectPath) return;
    const projectKey = projectExpansionKey(activeProjectPath);
    setExpandedProjects((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      persistSet(EXPANDED_PROJECTS_KEY, next);
      return next;
    });
  }, [activeProjectPath]);

  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, TerminalSession[]>();
    for (const session of terminalSessions) {
      const key = normalizeRepoPathForCompare(session.projectPath).toLowerCase();
      grouped.set(key, [...(grouped.get(key) ?? []), session]);
    }
    return grouped;
  }, [terminalSessions]);

  const toggle = (key: string, values: Set<string>, setValues: (next: Set<string>) => void, storageKey: string) => {
    const next = new Set(values);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setValues(next);
    persistSet(storageKey, next);
  };

  const expandWorktree = (key: string) => {
    setExpandedWorktrees((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      persistSet(EXPANDED_WORKTREES_KEY, next);
      return next;
    });
  };

  useEffect(() => {
    const { projectKeys, worktreeKeys } = resolveSessionSidebarExpansion(projects, sessionsByProject);
    if (projectKeys.length > 0) {
      setExpandedProjects((current) => {
        let changed = false;
        const next = new Set(current);
        for (const projectKey of projectKeys) {
          if (next.has(projectKey)) continue;
          next.add(projectKey);
          changed = true;
        }
        if (!changed) return current;
        persistSet(EXPANDED_PROJECTS_KEY, next);
        return next;
      });
    }
    for (const worktreeKey of worktreeKeys) {
      expandWorktree(worktreeKey);
    }
  }, [projects, sessionsByProject, terminalSessions]);

  const orderedProjects = projects;
  const renderedProjects = useMemo(() => {
    if (!draggingProjectPath) return orderedProjects;
    const movingProject = orderedProjects.find((project) => project.path === draggingProjectPath);
    if (!movingProject) return orderedProjects;
    const baseProjects = orderedProjects.filter((project) => project.path !== draggingProjectPath);
    if (dragPreviewIndex == null) return baseProjects;
    const next = [...baseProjects];
    const boundedIndex = Math.max(0, Math.min(dragPreviewIndex, next.length));
    next.splice(boundedIndex, 0, movingProject);
    return next;
  }, [dragPreviewIndex, draggingProjectPath, orderedProjects]);

  const commitProjectOrder = useCallback((nextOrder: string[]) => {
    onReorderProjects?.(nextOrder);
  }, [onReorderProjects]);

  const clearDragPreview = useCallback(() => {
    setDragPendingProjectPath(null);
    setDraggingProjectPath(null);
    setDragPreviewIndex(null);
    setDragGhostRect(null);
  }, []);

  useEffect(() => {
    if (!dragPendingProjectPath) return;
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || !dragState.active) return;
      if (Math.abs(event.clientX - dragState.startX) <= 4 && Math.abs(event.clientY - dragState.startY) <= 4) return;
      if (dragRafRef.current != null) return;
      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = null;
        const currentDragState = dragStateRef.current;
        if (!currentDragState || !currentDragState.active) return;
        if (Math.abs(event.clientX - currentDragState.startX) > 4 || Math.abs(event.clientY - currentDragState.startY) > 4) {
          currentDragState.moved = true;
          setDraggingProjectPath(currentDragState.path);
        }
        setDragGhostRect({
          x: event.clientX - currentDragState.offsetX,
          y: event.clientY - currentDragState.offsetY,
          width: currentDragState.width,
        });

        const rows = Array.from(scrollBodyRef.current?.querySelectorAll<HTMLElement>('[data-project-path]') ?? []);
        const targetRows = rows.filter((row) => row.dataset.projectPath && row.dataset.projectPath !== currentDragState.path);
        let nextPreviewIndex = targetRows.length;
        if (targetRows.length > 0) {
          for (let index = 0; index < targetRows.length; index += 1) {
            const rect = targetRows[index]!.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (event.clientY < midpoint) {
              nextPreviewIndex = index;
              break;
            }
          }
        }
        setDragPreviewIndex(nextPreviewIndex);
      });
    };
    const handlePointerUp = () => {
      const dragState = dragStateRef.current;
      dragStateRef.current = null;
      if (dragRafRef.current != null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (!dragState) {
        clearDragPreview();
        return;
      }
      if (!dragState.moved) {
        clearDragPreview();
        return;
      }
      suppressProjectSelectRef.current = true;
      const currentOrder = orderedProjects.map((project) => project.path);
      const fromIndex = currentOrder.indexOf(dragState.path);
      if (fromIndex < 0) {
        clearDragPreview();
        return;
      }
      const previewIndex = dragPreviewIndex;
      if (previewIndex == null) {
        clearDragPreview();
        return;
      }
      const nextOrder = currentOrder.filter((path) => path !== dragState.path);
      const boundedIndex = Math.max(0, Math.min(previewIndex, nextOrder.length));
      nextOrder.splice(boundedIndex, 0, dragState.path);
      commitProjectOrder(nextOrder);
      clearDragPreview();
      window.requestAnimationFrame(() => {
        suppressProjectSelectRef.current = false;
        onCloseContextMenu?.();
      });
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    clearDragPreview,
    commitProjectOrder,
    dragPendingProjectPath,
    dragPreviewIndex,
    orderedProjects,
  ]);

  const startProjectDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, path: string) => {
    if (!onReorderProjects || event.button !== 0) return;
    const section = event.currentTarget.closest<HTMLElement>('[data-project-path]');
    const rect = (section ?? event.currentTarget).getBoundingClientRect();
    dragStateRef.current = {
      active: true,
      path,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      moved: false,
    };
    setDragPendingProjectPath(path);
    setDraggingProjectPath(null);
    setDragPreviewIndex(null);
    setDragGhostRect({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
    });
  }, [onReorderProjects]);

  const sortWorktreesForProject = useCallback((project: SidebarProject): WorktreeInfo[] => {
    const order = project.worktreeOrder;
    const displayWorktrees = visibleWorktrees(project.worktrees);
    if (!order || order.length === 0) return displayWorktrees;
    const orderMap = new Map(order.map((path, idx) => [normalizeRepoPathForCompare(path).toLowerCase(), idx]));
    return [...displayWorktrees].sort((left, right) => {
      const leftKey = normalizeRepoPathForCompare(left.path).toLowerCase();
      const rightKey = normalizeRepoPathForCompare(right.path).toLowerCase();
      const leftIdx = orderMap.has(leftKey) ? orderMap.get(leftKey)! : Infinity;
      const rightIdx = orderMap.has(rightKey) ? orderMap.get(rightKey)! : Infinity;
      if (leftIdx !== rightIdx) return leftIdx - rightIdx;
      return leftKey.localeCompare(rightKey);
    });
  }, []);

  const clearDragWorktree = useCallback(() => {
    setDragPendingWorktreePath(null);
    setDraggingWorktreePath(null);
    setDragWorktreePreviewIndex(null);
    setDragWorktreeGhostRect(null);
  }, []);

  const startWorktreeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, projectPath: string, worktreePath: string) => {
    if (!onReorderWorktrees || event.button !== 0) return;
    const row = event.currentTarget.closest<HTMLElement>('[data-worktree-path]');
    const rect = (row ?? event.currentTarget).getBoundingClientRect();
    dragWorktreeStateRef.current = {
      active: true,
      projectPath,
      worktreePath,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      moved: false,
    };
    setDragPendingWorktreePath(worktreePath);
    setDraggingWorktreePath(null);
    setDragWorktreePreviewIndex(null);
    setDragWorktreeGhostRect({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
    });
  }, [onReorderWorktrees]);

  useEffect(() => {
    if (!dragPendingWorktreePath) return;
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragWorktreeStateRef.current;
      if (!dragState || !dragState.active) return;
      if (Math.abs(event.clientX - dragState.startX) <= 4 && Math.abs(event.clientY - dragState.startY) <= 4) return;
      if (dragRafRef.current != null) return;
      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = null;
        const currentDragState = dragWorktreeStateRef.current;
        if (!currentDragState || !currentDragState.active) return;
        if (Math.abs(event.clientX - currentDragState.startX) > 4 || Math.abs(event.clientY - currentDragState.startY) > 4) {
          currentDragState.moved = true;
          setDraggingWorktreePath(currentDragState.worktreePath);
        }
        setDragWorktreeGhostRect({
          x: event.clientX - currentDragState.offsetX,
          y: event.clientY - currentDragState.offsetY,
          width: currentDragState.width,
        });

        const projectContainer = scrollBodyRef.current?.querySelector(`[data-project-path="${currentDragState.projectPath}"]`);
        const rows = Array.from(projectContainer?.querySelectorAll<HTMLElement>('[data-worktree-path]') ?? []);
        const targetRows = rows.filter((row) => row.dataset.worktreePath && row.dataset.worktreePath !== currentDragState.worktreePath);
        let nextPreviewIndex = targetRows.length;
        if (targetRows.length > 0) {
          for (let index = 0; index < targetRows.length; index += 1) {
            const rect = targetRows[index]!.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (event.clientY < midpoint) {
              nextPreviewIndex = index;
              break;
            }
          }
        }
        setDragWorktreePreviewIndex(nextPreviewIndex);
      });
    };
    const handlePointerUp = () => {
      const dragState = dragWorktreeStateRef.current;
      dragWorktreeStateRef.current = null;
      if (dragRafRef.current != null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (!dragState) {
        clearDragWorktree();
        return;
      }
      if (!dragState.moved) {
        clearDragWorktree();
        return;
      }
      suppressProjectSelectRef.current = true;
      const project = projects.find((p) => p.path === dragState.projectPath);
      if (!project) {
        clearDragWorktree();
        return;
      }
      const sortedWts = sortWorktreesForProject(project);
      const currentOrder = sortedWts.map((w) => w.path);
      const fromIndex = currentOrder.indexOf(dragState.worktreePath);
      if (fromIndex < 0) {
        clearDragWorktree();
        return;
      }
      const previewIndex = dragWorktreePreviewIndex;
      if (previewIndex == null) {
        clearDragWorktree();
        return;
      }
      const nextOrder = currentOrder.filter((path) => path !== dragState.worktreePath);
      const boundedIndex = Math.max(0, Math.min(previewIndex, nextOrder.length));
      nextOrder.splice(boundedIndex, 0, dragState.worktreePath);
      onReorderWorktrees?.(dragState.projectPath, nextOrder);
      clearDragWorktree();
      window.requestAnimationFrame(() => {
        suppressProjectSelectRef.current = false;
        onCloseContextMenu?.();
      });
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    clearDragWorktree,
    dragPendingWorktreePath,
    dragWorktreePreviewIndex,
    projects,
    onReorderWorktrees,
    sortWorktreesForProject,
  ]);

  const clearDragTerminal = useCallback(() => {
    setDragPendingTerminalId(null);
    setDraggingTerminalId(null);
    setDragTerminalPreviewIndex(null);
    setDragTerminalGhostRect(null);
  }, []);

  const startTerminalDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, worktreePath: string, terminalId: string) => {
    if (!onReorderTerminals || event.button !== 0) return;
    const row = event.currentTarget.closest<HTMLElement>('[data-terminal-id]');
    const rect = (row ?? event.currentTarget).getBoundingClientRect();
    dragTerminalStateRef.current = {
      active: true,
      worktreePath,
      terminalId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      moved: false,
    };
    setDragPendingTerminalId(terminalId);
    setDraggingTerminalId(null);
    setDragTerminalPreviewIndex(null);
    setDragTerminalGhostRect({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
    });
  }, [onReorderTerminals]);

  useEffect(() => {
    if (!dragPendingTerminalId) return;
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragTerminalStateRef.current;
      if (!dragState || !dragState.active) return;
      if (Math.abs(event.clientX - dragState.startX) <= 4 && Math.abs(event.clientY - dragState.startY) <= 4) return;
      if (dragRafRef.current != null) return;
      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = null;
        const currentDragState = dragTerminalStateRef.current;
        if (!currentDragState || !currentDragState.active) return;
        if (Math.abs(event.clientX - currentDragState.startX) > 4 || Math.abs(event.clientY - currentDragState.startY) > 4) {
          currentDragState.moved = true;
          setDraggingTerminalId(currentDragState.terminalId);
        }
        setDragTerminalGhostRect({
          x: event.clientX - currentDragState.offsetX,
          y: event.clientY - currentDragState.offsetY,
          width: currentDragState.width,
        });

        const terminalsContainer = scrollBodyRef.current?.querySelector(`[data-worktree-terminals="${currentDragState.worktreePath}"]`);
        const rows = Array.from(terminalsContainer?.querySelectorAll<HTMLElement>('[data-terminal-id]') ?? []);
        const targetRows = rows.filter((row) => row.dataset.terminalId && row.dataset.terminalId !== currentDragState.terminalId);
        let nextPreviewIndex = targetRows.length;
        if (targetRows.length > 0) {
          for (let index = 0; index < targetRows.length; index += 1) {
            const rect = targetRows[index]!.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (event.clientY < midpoint) {
              nextPreviewIndex = index;
              break;
            }
          }
        }
        setDragTerminalPreviewIndex(nextPreviewIndex);
      });
    };
    const handlePointerUp = () => {
      const dragState = dragTerminalStateRef.current;
      dragTerminalStateRef.current = null;
      if (dragRafRef.current != null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (!dragState) {
        clearDragTerminal();
        return;
      }
      if (!dragState.moved) {
        clearDragTerminal();
        return;
      }
      suppressProjectSelectRef.current = true;
      
      const project = projects.find((p) => p.worktrees.some((w) => w.path === dragState.worktreePath));
      if (!project) {
        clearDragTerminal();
        return;
      }
      const projectSessions = sessionsByProject.get(normalizeRepoPathForCompare(project.path).toLowerCase()) ?? [];
      const worktreeInfo = project.worktrees.find((w) => w.path === dragState.worktreePath);
      if (!worktreeInfo) {
        clearDragTerminal();
        return;
      }
      const workingTreeId = workingTreeIdForPath(worktreeInfo.path, worktreeInfo.isCurrent);
      const rawSessions = visibleNestedSessions(projectSessions, worktreeInfo.path, workingTreeId);
      
      const currentOrder = rawSessions.map((s) => s.id);
      const fromIndex = currentOrder.indexOf(dragState.terminalId);
      if (fromIndex < 0) {
        clearDragTerminal();
        return;
      }
      const previewIndex = dragTerminalPreviewIndex;
      if (previewIndex == null) {
        clearDragTerminal();
        return;
      }
      const nextOrder = currentOrder.filter((id) => id !== dragState.terminalId);
      const boundedIndex = Math.max(0, Math.min(previewIndex, nextOrder.length));
      nextOrder.splice(boundedIndex, 0, dragState.terminalId);
      
      onReorderTerminals?.(project.path, dragState.worktreePath, nextOrder);
      clearDragTerminal();
      window.requestAnimationFrame(() => {
        suppressProjectSelectRef.current = false;
        onCloseContextMenu?.();
      });
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    clearDragTerminal,
    dragPendingTerminalId,
    dragTerminalPreviewIndex,
    projects,
    sessionsByProject,
    onReorderTerminals,
  ]);

  const draggingProject = draggingProjectPath
    ? projects.find((project) => project.path === draggingProjectPath)
    : null;

  const draggingWorktree = useMemo(() => {
    if (!draggingWorktreePath) return null;
    for (const project of projects) {
      const found = project.worktrees.find((w) => w.path === draggingWorktreePath);
      if (found) return found;
    }
    return null;
  }, [draggingWorktreePath, projects]);

  const draggingWorktreeProject = useMemo(() => {
    if (!draggingWorktreePath) return null;
    return projects.find((project) => project.worktrees.some((w) => w.path === draggingWorktreePath)) ?? null;
  }, [draggingWorktreePath, projects]);

  const draggingTerminal = useMemo(() => {
    if (!draggingTerminalId) return null;
    return terminalSessions.find((s) => s.id === draggingTerminalId) ?? null;
  }, [draggingTerminalId, terminalSessions]);



  const draggingTerminalProject = useMemo(() => {
    if (!draggingTerminal) return null;
    return projects.find((project) => project.path === draggingTerminal.projectPath) ?? null;
  }, [draggingTerminal, projects]);

  const renderWorktreeBlock = (
    project: SidebarProject,
    worktree: WorktreeInfo,
    options: { ghostMode?: boolean; hideLive?: boolean } = {},
  ) => {
    const ghostMode = options.ghostMode ?? false;
    const hideLive = options.hideLive ?? false;
    const isActive = activeProjectPath != null && samePath(project.path, activeProjectPath);
    const projectSessions = sessionsByProject.get(normalizeRepoPathForCompare(project.path).toLowerCase()) ?? [];
    
    const sortedWts = sortWorktreesForProject(project);
    const worktreeAccentByPath = new Map(
      buildWorktreeSessions(sortedWts, project.path, undefined, project.worktreeOrder).map((session) => [
        normalizeRepoPathForCompare(session.path).toLowerCase(),
        accentCssVars(session.accentToken),
      ]),
    );

    const key = worktreeExpansionKey(project.path, worktree.path);
    const expanded = expandedWorktrees.has(key);
    const workingTreeId = workingTreeIdForPath(worktree.path, worktree.isCurrent);
    const rawSessions = visibleNestedSessions(projectSessions, worktree.path, workingTreeId);
    
    const terminalOrder = project.terminalOrderMap?.[worktree.path];
    const sortedSessions = (() => {
      if (!terminalOrder || terminalOrder.length === 0) return rawSessions;
      const orderMap = new Map(terminalOrder.map((id, idx) => [id, idx]));
      return [...rawSessions].sort((left, right) => {
        const leftIdx = orderMap.has(left.id) ? orderMap.get(left.id)! : Infinity;
        const rightIdx = orderMap.has(right.id) ? orderMap.get(right.id)! : Infinity;
        if (leftIdx !== rightIdx) return leftIdx - rightIdx;
        return left.id.localeCompare(right.id);
      });
    })();

    const renderedSessions = (() => {
      if (!draggingTerminalId || ghostMode) return sortedSessions;
      const hasDraggingTerminal = sortedSessions.some((s) => s.id === draggingTerminalId);
      if (!hasDraggingTerminal) return sortedSessions;
      const movingSession = sortedSessions.find((s) => s.id === draggingTerminalId);
      if (!movingSession) return sortedSessions;
      const baseSessions = sortedSessions.filter((s) => s.id !== draggingTerminalId);
      if (dragTerminalPreviewIndex == null) return baseSessions;
      const next = [...baseSessions];
      const boundedIndex = Math.max(0, Math.min(dragTerminalPreviewIndex, next.length));
      next.splice(boundedIndex, 0, movingSession);
      return next;
    })();

    const label = worktree.isCurrent ? 'Primary' : worktreeDisplayName(worktree.path);
    const refLabel = worktreeRefLabel(worktree);
    const accent = worktreeAccentByPath.get(
      normalizeRepoPathForCompare(worktree.path).toLowerCase(),
    );
    const accentColor = accent?.fg;
    const rowAccentStyle = accent ? ({
      color: accent.fg,
      '--worktree-fg': accent.fg,
      '--worktree-muted': accent.muted,
    } as React.CSSProperties) : undefined;
    
    const rowSurfaceClass = cn(
      !ghostMode && (accent ? 'hover:bg-[var(--worktree-muted)]' : 'hover:bg-muted'),
      !accentColor && 'text-muted-foreground',
      !ghostMode && !accentColor && 'hover:text-foreground',
      !isActive && 'opacity-80',
      !ghostMode && !isActive && 'hover:opacity-100',
      hideLive && 'pointer-events-none opacity-0',
    );

    const plusButton = ghostMode ? null : (
      <Tooltip label="New terminal or preview" side="top">
        <button
          type="button"
          disabled={!worktree.pathExists}
          onClick={(event) => {
            event.stopPropagation();
            const hasPreview = rawSessions.some(
              (session) => session.kind === 'preview' && session.status === 'running'
            );
            if (hasPreview) {
              void (async () => {
                await onCreateTerminal(project.path, worktree.path);
                expandWorktree(key);
              })();
            } else {
              showContextMenu(event, 'worktree-plus', project.path, worktree.path, worktree);
            }
          }}
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 transition-all group-hover/row:opacity-100 disabled:cursor-not-allowed disabled:opacity-30",
            accent ? "hover:brightness-75" : "text-muted-foreground hover:text-foreground"
          )}
          aria-label={`Actions in ${label}`}
        >
          <Plus strokeWidth={1.5} className="h-4 w-4 shrink-0" />
        </button>
      </Tooltip>
    );

    return (
      <div
        data-worktree-path={worktree.path}
        onPointerDownCapture={ghostMode ? undefined : (event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-worktree-terminals]')) return;
          if (target?.closest('.window-no-drag, button, input, textarea, select, [contenteditable="true"]')) return;
          startWorktreeDrag(event, project.path, worktree.path);
        }}
        className={cn(!ghostMode && onReorderWorktrees && 'cursor-grab active:cursor-grabbing')}
      >
        {rawSessions.length > 0 ? (
          <div
            className={cn(
              'group/row flex h-7 flex-1 min-w-0 items-center rounded-lg pl-2 pr-0 transition-colors',
              !ghostMode && 'cursor-pointer',
              rowSurfaceClass,
            )}
            style={rowAccentStyle}
            onClick={ghostMode ? undefined : () => void onSelectWorktree(project.path, workingTreeId)}
            onContextMenu={ghostMode ? undefined : (event) => {
              showContextMenu(event, 'worktree', project.path, worktree.path, worktree);
            }}
          >
            <button
              type="button"
              onPointerDown={ghostMode ? undefined : (e) => e.stopPropagation()}
              onClick={ghostMode ? undefined : (event) => {
                event.stopPropagation();
                toggle(key, expandedWorktrees, setExpandedWorktrees, EXPANDED_WORKTREES_KEY);
              }}
              className="inline-flex h-7 w-4 shrink-0 items-center justify-center rounded-lg transition-colors"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
              tabIndex={ghostMode ? -1 : undefined}
            >
              <ChevronRight strokeWidth={1.5} className={cn('h-4 w-4 shrink-0 transition-transform duration-200', expanded && 'rotate-90')} />
            </button>
            <span className="min-w-0 flex-1 truncate text-sm">{label} · {refLabel}</span>
            {plusButton}
          </div>
        ) : (
          <div
            className={cn('flex h-7 min-w-0 flex-1 items-center pl-2 pr-0', !ghostMode && 'cursor-pointer')}
            onClick={ghostMode ? undefined : () => void onSelectWorktree(project.path, workingTreeId)}
          >
            <span className="w-4 shrink-0" aria-hidden="true" />
            <div
              className={cn(
                'group/row -ml-2 flex min-w-0 flex-1 items-center rounded-lg pl-2 pr-0 transition-colors',
                rowSurfaceClass,
              )}
              style={rowAccentStyle}
              onContextMenu={ghostMode ? undefined : (event) => {
                showContextMenu(event, 'worktree', project.path, worktree.path, worktree);
              }}
            >
              <span className="min-w-0 flex-1 truncate text-sm">{label} · {refLabel}</span>
              {plusButton}
            </div>
          </div>
        )}
        {expanded && !hideLive ? (
          <div className="space-y-1 pl-4 mt-1" data-worktree-terminals={worktree.path}>
            {renderedSessions.map((session) => {
              const isDraggingThisTerminal = draggingTerminalId === session.id;
              return (
                <div
                  key={session.id}
                  data-terminal-id={session.id}
                  className={cn(
                    isDraggingThisTerminal && 'pointer-events-none opacity-0',
                    !ghostMode && onReorderTerminals && 'cursor-grab active:cursor-grabbing'
                  )}
                  onPointerDownCapture={ghostMode ? undefined : (event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest('.window-no-drag, button, input, textarea, select, [contenteditable="true"]')) return;
                    event.stopPropagation();
                    startTerminalDrag(event, worktree.path, session.id);
                  }}
                >
                  <TerminalRow
                    session={session}
                    label={session.kind === 'preview' ? previewLabel(session) : session.label}
                    active={activeTerminalId === session.id}
                    onSelect={onSelectTerminal}
                    accent={accent}
                    isActiveProject={isActive}
                    onTerminate={onTerminateTerminal}
                    ghostMode={ghostMode}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderProjectBlock = (
    project: SidebarProject,
    options: { ghostMode?: boolean; hideLive?: boolean } = {},
  ) => {
    const ghostMode = options.ghostMode ?? false;
    const hideLive = options.hideLive ?? false;
    const isActive = activeProjectPath != null && samePath(project.path, activeProjectPath);
    const projectKey = projectExpansionKey(project.path);
    const isExpanded = expandedProjects.has(projectKey);
    const projectSessions = sessionsByProject.get(normalizeRepoPathForCompare(project.path).toLowerCase()) ?? [];
    const commitPreviews = commitPreviewSessions(projectSessions);
    const sortedWts = sortWorktreesForProject(project);
    const loadState = projectLoadStates[projectKey];
    const isLoading = loadState?.status === 'loading';

    return (
      <div className={cn(hideLive && 'pointer-events-none opacity-0')}>
        <div
          className={cn(
            'group relative flex h-7 items-center rounded-lg transition-colors',
            !ghostMode && 'hover:bg-muted',
            !ghostMode && onReorderProjects && 'cursor-grab active:cursor-grabbing',
            isActive && 'text-foreground',
            !isActive && 'text-muted-foreground',
          )}
          onPointerDownCapture={ghostMode ? undefined : (event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('.window-no-drag, button, input, textarea, select, [contenteditable="true"]')) return;
            startProjectDrag(event, project.path);
          }}
          onClick={ghostMode ? undefined : (event) => {
            if (isActive) return;
            if (draggingProjectPath === project.path || suppressProjectSelectRef.current) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest('button, input, textarea, select, [contenteditable="true"]')) return;
            void onSelectProject(project.path);
          }}
          onContextMenu={ghostMode ? undefined : (event) => {
            showContextMenu(event, 'project', project.path);
          }}
        >
          <button
            type="button"
            onPointerDown={ghostMode ? undefined : (event) => event.stopPropagation()}
            onClick={ghostMode ? undefined : (event) => {
              event.stopPropagation();
              toggle(projectKey, expandedProjects, setExpandedProjects, EXPANDED_PROJECTS_KEY);
            }}
            className="window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name}`}
            tabIndex={ghostMode ? -1 : undefined}
          >
            {isExpanded ? (
              <ToolbarSvgIcon icon="project-open" className="text-current" />
            ) : (
              <ToolbarSvgIcon icon="project-closed" className="text-current" />
            )}
          </button>
          <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
          {isLoading ? (
            <span
              className="ml-2 inline-flex shrink-0 items-center gap-1 pr-2 text-xs text-muted-foreground"
              aria-live="polite"
              title={loadState.phase}
            >
              <LoaderCircle strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>{Math.max(1, Math.round(loadState.progress))}%</span>
            </span>
          ) : null}
        </div>
        {isExpanded ? (
          <div className="mt-1 space-y-1">
            {commitPreviews.map((session) => (
              <TerminalRow
                key={session.id}
                session={session}
                label={previewLabel(session)}
                active={activeTerminalId === session.id}
                onSelect={onSelectTerminal}
                isActiveProject={isActive}
                onTerminate={onTerminateTerminal}
                alignWithProjectRow
                ghostMode={ghostMode}
              />
            ))}
            <div className="space-y-1 pl-1">
              {(() => {
                const renderedWorktrees = (() => {
                  if (!draggingWorktreePath || ghostMode) return sortedWts;
                  const belongsToThisProject = sortedWts.some((w) => w.path === draggingWorktreePath);
                  if (!belongsToThisProject) return sortedWts;
                  const movingWorktree = sortedWts.find((w) => w.path === draggingWorktreePath);
                  if (!movingWorktree) return sortedWts;
                  const baseWorktrees = sortedWts.filter((w) => w.path !== draggingWorktreePath);
                  if (dragWorktreePreviewIndex == null) return baseWorktrees;
                  const next = [...baseWorktrees];
                  const boundedIndex = Math.max(0, Math.min(dragWorktreePreviewIndex, next.length));
                  next.splice(boundedIndex, 0, movingWorktree);
                  return next;
                })();

                return (
                  <>
                    {renderedWorktrees.map((worktree) => {
                      const isDraggingThis = draggingWorktreePath === worktree.path;
                      return (
                        <div key={worktree.path}>
                          {renderWorktreeBlock(project, worktree, { hideLive: isDraggingThis })}
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      aria-label="Worktree sidebar"
      className={cn('pointer-events-auto relative h-full select-none overflow-hidden bg-background', className)}
      style={style}
    >
      <header data-tauri-drag-region className="absolute inset-x-0 top-0 h-12" />
      <div className={cn('flex h-full min-h-0 flex-col', collapsed && 'pointer-events-none opacity-0')}>
        {projectError ? (
          <p className="mx-2 mb-2 rounded-xl border border-[var(--destructive-bg)] bg-[var(--destructive-bg)] px-3 py-2 text-xs text-red-600">
            {projectError}
          </p>
        ) : null}
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={onAddProject}
            disabled={projectLoading}
            className="group flex h-7 w-full items-center rounded-lg text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center">
              <CobblePlusIcon />
            </span>
            <span>Add project</span>
          </button>
        </div>
        <div ref={scrollBodyRef} className="sidebar-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-2">
          {renderedProjects.map((project) => (
            <section key={project.path} data-project-path={project.path}>
              {renderProjectBlock(project, { hideLive: draggingProjectPath === project.path })}
            </section>
          ))}
        </div>
      </div>
      {draggingProject && dragGhostRect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[90]"
          style={{
            transform: `translate3d(${dragGhostRect.x}px, ${dragGhostRect.y}px, 0)`,
            width: `${dragGhostRect.width}px`,
          }}
        >
          {renderProjectBlock(draggingProject, { ghostMode: true })}
        </div>
      ) : null}
      {draggingWorktree && dragWorktreeGhostRect && draggingWorktreeProject ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[90]"
          style={{
            transform: `translate3d(${dragWorktreeGhostRect.x}px, ${dragWorktreeGhostRect.y}px, 0)`,
            width: `${dragWorktreeGhostRect.width}px`,
          }}
        >
          {renderWorktreeBlock(draggingWorktreeProject, draggingWorktree, { ghostMode: true })}
        </div>
      ) : null}
      {draggingTerminal && dragTerminalGhostRect && draggingTerminalProject ? (() => {
        const sortedWts = sortWorktreesForProject(draggingTerminalProject);
        const worktreeAccentByPath = new Map(
          buildWorktreeSessions(sortedWts, draggingTerminalProject.path, undefined, draggingTerminalProject.worktreeOrder).map((session) => [
            normalizeRepoPathForCompare(session.path).toLowerCase(),
            accentCssVars(session.accentToken),
          ]),
        );
        const wtPath = draggingTerminal.worktreePath;
        const accent = wtPath
          ? worktreeAccentByPath.get(normalizeRepoPathForCompare(wtPath).toLowerCase())
          : undefined;

        return (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[90]"
            style={{
              transform: `translate3d(${dragTerminalGhostRect.x}px, ${dragTerminalGhostRect.y}px, 0)`,
              width: `${dragTerminalGhostRect.width}px`,
            }}
          >
            <TerminalRow
              session={draggingTerminal}
              label={draggingTerminal.kind === 'preview' ? previewLabel(draggingTerminal) : draggingTerminal.label}
              active={activeTerminalId === draggingTerminal.id}
              onSelect={onSelectTerminal}
              accent={accent}
              isActiveProject={draggingTerminalProject.path === activeProjectPath}
              onTerminate={onTerminateTerminal}
              ghostMode={true}
            />
          </div>
        );
      })() : null}
    </aside>
  );
}

const GENERIC_TERMINAL_LABEL = /^Terminal \d+$/;
const LABEL_STABILIZE_MS = 1200;
const OUTPUT_PULSE_SETTLE_MS = 1200;
/** Hold shimmer through brief output pauses before starting the settle animation. */
const OUTPUT_PULSE_IDLE_MS = 4000;

function TerminalRow({
  session,
  label,
  active,
  onSelect,
  accent,
  isActiveProject,
  onTerminate,
  alignWithProjectRow,
  ghostMode,
}: {
  session: TerminalSession;
  label: string;
  active: boolean;
  onSelect: (session: TerminalSession) => void;
  accent?: { fg: string; muted: string };
  isActiveProject?: boolean;
  onTerminate?: (id: string) => void | Promise<void>;
  alignWithProjectRow?: boolean;
  ghostMode?: boolean;
}) {
  const Icon = session.kind === 'preview' ? PreviewIcon : TerminalIcon;
  const [displayLabel, setDisplayLabel] = useState(label);
  const stableLabelRef = useRef(label);
  const style = accent
    ? ({
        '--worktree-fg': accent.fg,
        '--worktree-muted': accent.muted,
      } as React.CSSProperties)
    : undefined;

  useEffect(() => {
    if (label === stableLabelRef.current) return;
    // Never regress from a process/AI label back to generic "Terminal N".
    if (GENERIC_TERMINAL_LABEL.test(label) && !GENERIC_TERMINAL_LABEL.test(stableLabelRef.current)) {
      return;
    }
    const timeout = window.setTimeout(() => {
      stableLabelRef.current = label;
      setDisplayLabel(label);
    }, LABEL_STABILIZE_MS);
    return () => window.clearTimeout(timeout);
  }, [label]);

  const isRunning = session.status === 'running';
  const outputActive = isRunning && session.outputActive === true;
  const [pulseVisible, setPulseVisible] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const pulseVisibleRef = useRef(false);
  const settlingRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    pulseVisibleRef.current = pulseVisible;
  }, [pulseVisible]);

  useEffect(() => {
    if (idleTimerRef.current != null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (!isRunning) {
      settlingRef.current = false;
      pulseVisibleRef.current = false;
      setPulseVisible(false);
      setIsSettling(false);
      return;
    }

    if (outputActive) {
      settlingRef.current = false;
      pulseVisibleRef.current = true;
      setPulseVisible(true);
      setIsSettling(false);
      return;
    }

    if (!pulseVisibleRef.current || settlingRef.current) return;

    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (!pulseVisibleRef.current || settlingRef.current) return;
      settlingRef.current = true;
      setIsSettling(true);
    }, OUTPUT_PULSE_IDLE_MS);

    return () => {
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isRunning, outputActive]);

  useEffect(() => {
    if (!isSettling) return;

    const timeout = window.setTimeout(() => {
      settlingRef.current = false;
      pulseVisibleRef.current = false;
      setPulseVisible(false);
      setIsSettling(false);
    }, OUTPUT_PULSE_SETTLE_MS);

    return () => window.clearTimeout(timeout);
  }, [isSettling]);

  const rowContentClass = cn(
    'flex h-7 flex-1 items-center rounded-lg text-left text-sm min-w-0',
    ghostMode ? 'pr-2' : 'pr-8',
    alignWithProjectRow ? 'pl-0' : 'gap-1.5 px-2',
    !pulseVisible && accent && 'text-[var(--worktree-fg)]',
    !pulseVisible && !accent && active && 'text-primary',
    !pulseVisible && !accent && !active && 'text-muted-foreground',
    !ghostMode && !pulseVisible && !accent && !active && 'group-hover/terminal:text-foreground',
    pulseVisible && 'terminal-row-shimmer',
    pulseVisible && accent && 'terminal-row-shimmer--accent',
    pulseVisible && !accent && active && 'terminal-row-shimmer--primary',
    pulseVisible && !accent && !active && 'terminal-row-shimmer--default',
  );

  const rowInner = (
    <>
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center',
          !alignWithProjectRow && 'gap-1.5',
          pulseVisible && 'terminal-row-shimmer__content',
          pulseVisible && isSettling && 'terminal-row-shimmer__content--settling',
        )}
      >
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center',
            alignWithProjectRow ? 'h-7 w-7' : 'h-4 w-4',
          )}
        >
          {pulseVisible ? (
            <span
              aria-hidden
              className={cn(
                'terminal-row-shimmer__icon shrink-0',
                session.kind === 'preview'
                  ? 'terminal-row-shimmer__icon--preview'
                  : 'terminal-row-shimmer__icon--terminal',
              )}
            />
          ) : (
            <Icon className="h-4 w-4 shrink-0" />
          )}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', pulseVisible && 'terminal-row-shimmer__text')}>
          {displayLabel}
        </span>
      </span>
      {session.status === 'exited' ? (
        <span className={cn(
          'text-[10px] uppercase tracking-wide shrink-0',
          !ghostMode && 'group-hover/terminal:opacity-0 transition-opacity duration-150',
        )}>Exited</span>
      ) : null}
    </>
  );

  return (
    <div
      style={style}
      className={cn(
        'group/terminal relative flex h-7 items-center w-full rounded-lg transition-colors',
        !ghostMode && accent
          ? active
            ? 'bg-[var(--worktree-muted)]'
            : 'hover:bg-[var(--worktree-muted)]'
          : active
            ? 'bg-primary/10'
            : 'hover:bg-muted',
        !ghostMode && active && !accent && 'hover:bg-muted',
        isActiveProject === false && 'opacity-80',
        !ghostMode && isActiveProject === false && 'hover:opacity-100',
      )}
    >
      {ghostMode ? (
        <div className={rowContentClass}>{rowInner}</div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(session)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(session);
            }
          }}
          aria-busy={pulseVisible || undefined}
          className={cn(rowContentClass, 'cursor-pointer select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-ring')}
        >
          {rowInner}
        </div>
      )}
      {!ghostMode && onTerminate ? (
        <Tooltip label="Terminate session" side="top">
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void onTerminate(session.id);
            }}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity duration-150 group-hover/terminal:opacity-100',
              accent
                ? 'text-[var(--worktree-fg)]'
                : 'text-muted-foreground',
            )}
            aria-label="Terminate session"
          >
            <Trash2 strokeWidth={1} className="h-4 w-4 shrink-0" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

function TerminalIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path
        d="M12.5 3.5H3.5C2.4 3.5 1.5 4.4 1.5 5.5V10.5C1.5 11.6 2.4 12.5 3.5 12.5H12.5C13.6 12.5 14.5 11.6 14.5 10.5V5.5C14.5 4.4 13.6 3.5 12.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 6L6.5 8L4.5 10M8 10H11.5"
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
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path
        d="M5 5.5C5 4.7 5.8 4.2 6.5 4.6L10.5 7.2C11.2 7.6 11.2 8.4 10.5 8.8L6.5 11.4C5.8 11.8 5 11.3 5 10.5V5.5Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
