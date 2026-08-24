# Cobble

## Making local Git work visible

Cobble is a native macOS app for exploring local Git repositories as a spatial branch map. It brings branches, commits, worktrees, stashes, dirty state, and repository activity into one canvas.

I made Cobble because the shape of a repository often disappears inside lists, terminal output, and separate tools. Git can tell me exactly what happened, but it takes work to understand how active branches relate to each other, which worktree holds a change, or where I should go next.

I started to treat the repository as a place someone could move through.

![Cobble branch map](assets/lane-order-screenshot.png)

## Starting with the map

The branch map is the main interface. Each branch gets a lane. Commits form readable groups along that lane, while connectors show where work split and came back together. Worktrees live in the same space because they are part of the repository's current shape.

This made the layout model the core product decision. The map had to show history while staying useful for active work. It also needed to remain stable as commits, branches, and worktrees changed. A technically correct graph could still feel wrong if nodes moved without a clear reason or related commits appeared far apart.

I kept refining the layout around the relationships that matter in Git. Parent chains guide commit grouping. Branch ancestry controls lane continuity. Worktree positions remain tied to their branch context. Squash commits create useful visual boundaries. These rules let the map explain the repository through structure instead of decoration.

## Designing Git actions in context

Reading the graph was one part of the experience. I also wanted common Git work to happen where its context was already visible.

From the map, someone can create or check out a branch, make a worktree, commit changes, stash work, push updates, delete a branch, or open a preview. Search supports keyboard navigation across a large graph. A terminal can stay connected to its worktree, which keeps command-line work close to the branch it affects.

Cobble runs Git through a Rust backend and the local `git` CLI. GitHub features use an existing authenticated `gh` session. Optional commit, stash, and branch-name suggestions use OpenCode. This keeps the repository local and lets the app fit around tools a developer may already use.

## Working through scale

The first versions could draw a repository. Larger repositories exposed the harder product problem. A detailed spatial interface stops being useful when switching projects blocks the app or when the map shifts while its layout is still resolving.

I moved expensive Git work and layout computation into background processes. Cobble stores repository snapshots and saved layouts, then checks whether that data is still current before doing more work. The canvas only renders the visible area, while layout work can expand as needed. Loading progress belongs to the repository that is doing the work, so the rest of the app can stay available.

Freshness needed the same care as speed. A fast cached map is misleading when it shows an old repository state. Cobble compares lightweight repository fingerprints, applies safe local updates after mutations, and requests a fresh snapshot when the graph has changed. This became a balance between immediate feedback and Git as the source of truth.

## A calm desktop tool

The visual system stays quiet so the repository can carry the complexity. The map uses a restrained palette, compact cards, clear branch accents, and subtle motion. Controls appear near the object they affect. The sidebar supports project switching and active sessions while leaving most of the window to the graph.

Building Cobble as a Tauri app also let the product behave like a Mac utility. It can open local folders, restore its window state, host terminal sessions, watch repositories in the background, and update through signed release bundles for Apple Silicon and Intel Macs.

## Where it landed

The graph experiment grew into a working public macOS app. The current release supports local repository exploration, worktree-aware Git actions, GitHub context, optional AI-assisted labels, saved layouts, background sync, and large-repository rendering.

The project changed how I think about developer tools. Correct data is the starting point. The interface also needs a stable spatial model that helps someone build intuition over time. Cobble uses the map to show Git and give the work a place to happen.
