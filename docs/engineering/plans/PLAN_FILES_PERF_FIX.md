# PLANO Files Panel Performance Fix Plan

## Purpose

Restore the Files panel's pre-glass behavior on large, actively changing Windows projects: fast initial tree display, immediate normal-file opening, no flicker, and no whole-app slowdown while AI agents write files.

This is a code-audited plan. It is based on the current source, the old pre-glass renderer bundle at `C:\Users\Administrator\AppData\Local\Temp\old-plano-index.js`, and the old watcher implementation preserved in the repository's committed baseline. No Electron instance or application code was run during the audit.

## Executive diagnosis

### Primary root cause — high confidence

The largest real regression is the replacement of the old Windows-native recursive watcher with chokidar, combined with an unchanged “any event means rebuild the whole tree” renderer policy.

The old implementation used:

```ts
fs.watch(root, { recursive: true, persistent: false })
```

On Windows this maps to one recursive `ReadDirectoryChangesW` watch. It does not need to crawl and individually establish watches across the project before becoming useful.

The current implementation in `src/main/services/FileWatcherService.ts` uses:

```ts
chokidar.watch(root, {
  ignoreInitial: true,
  persistent: true,
  atomic: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
})
```

`ignoreInitial: true` suppresses initial `add` notifications; it does not eliminate chokidar's recursive discovery work. On a large repository, chokidar still traverses the non-ignored directory graph and establishes its watch state. That work begins at the same time as the Files panel's own eager depth-five `readTree`. The result is two competing project walks at panel startup: the visible tree walk and chokidar's deeper watcher initialization.

With agents writing many files, `awaitWriteFinish` adds repeated stability polling at 25 ms intervals for every unstable path. Chokidar then emits all event types through one `.on('all')` handler, but the code discards the event type and sends only paths. The renderer consequently cannot distinguish a content edit from an add/delete/rename and performs a complete tree read for both.

This matches every important fact in the report:

- A four-file folder is fine because watcher discovery and tree reconstruction are tiny.
- Ten static panels are fine because panel count alone is not the trigger.
- A large project is slow because watcher initialization scales with the project directory graph.
- Active agents make the whole app heavy because stability polling and event bursts continually compete with tree/file I/O.
- The old build remains fast because it uses the lightweight native recursive watcher.
- Restoring the renderer's 120 ms debounce and active-file event gate does not remove chokidar discovery, stability polling, or full-tree refreshes for content-only events.

### Amplifier 1 — every filesystem event still causes a complete tree pipeline

The exact current path is:

1. `FileWatcherService` receives any chokidar event at `FileWatcherService.ts:94-98`.
2. It throws away `_event`, retains only the absolute path, and emits one global `FsChangedEvent` after a quiet-period debounce.
3. `EditorPanel.tsx:247-250` refreshes the tree unconditionally for every matching-root event.
4. `FileSystemService.readTree` recursively rebuilds a depth-five snapshot.
5. `buildNode` walks directories sequentially (`FileSystemService.ts:187-205`).
6. Electron structured-clones the entire result across IPC.
7. `reconcileFsTree` recursively walks both old and new snapshots and creates a `Map` for each directory (`EditorPanel.tsx:48-69`).
8. React reconciles the recursive `FileTree`.

The renderer's `treeReadRef` prevents an old result from being committed, but it does not cancel or coalesce the main-process work. If another batch arrives while a tree scan is running, another scan can start. The obsolete scan still consumes filesystem, main-process, IPC, allocation, and garbage-collection resources.

The main watcher is correctly shared and ref-counted by normalized root, so duplicate chokidar instances are not the defect. However, every Files panel registers its own renderer listener and independently calls `readTree`. Several Files panels on the same root therefore share one watcher but can still launch several identical full-tree scans per event batch.

### Amplifier 2 — the tree is eagerly materialized far beyond what is visible

`TREE_DEPTH = 5` matches the old build, but it remains inherently expensive for broad projects. `FileSystemService.buildNode` eagerly enumerates every descendant through that depth even when its directory is collapsed.

`FileTree.tsx` is recursive and not virtualized. Every top-level directory starts open because each root child is rendered with `depth=0` and `useState(depth < 1)`. Initial DOM work therefore includes all root entries plus the immediate children of every top-level directory. A broad monorepo can mount thousands of rows even though only a small viewport is visible.

The old build had the same broad structure, so eager tree loading is not the main regression by itself. It becomes a serious multiplier when the new watcher causes more initialization work and repeated refreshes. The current `reconcileFsTree` adds another full JavaScript traversal not present in the old build; it preserves references and can reduce React work, but it cannot make a huge snapshot cheap.

### Amplifier 3 — opening a file invalidates the whole visible tree

Opening a file changes `panel.props.filePath`. `EditorPanel` then passes the new `activePath` through `FileTree` to every recursive `TreeNode`. Because `activePath` is part of every node's props, `React.memo` cannot bail out: every mounted/expanded node receives a changed prop and re-renders merely to discover whether it is the newly active row.

On a small tree this is invisible. On a large, broad, expanded tree it places substantial React work directly in the file-click path, at the same time the new file is read and CodeMirror is mounted. This is a real opening-latency cause, although it existed in a simpler form in the old build and is secondary to the watcher regression.

## Findings that are not the primary regression

These items should be measured, but they must not lead the first fix because the old fast build used the same behavior or the current code already excludes the suspected feedback.

### Autosave is not feeding back into the watcher

- Both `FileSystemService` and `FileWatcherService` ignore `.plano` and all hidden directory segments.
- Therefore, writing `.plano/workspace.json` cannot currently trigger `fsChanged` or a tree refresh.
- Autosave waits 800 ms; it is not synchronous in the click-to-first-paint path.
- The old bundle uses the same 800 ms panel-store subscription, whole-workspace save, user-data write, and project mirror.

Autosave can still cause a later CPU/disk spike because the current app may hold more workspaces, panels, terminal tabs, and agent metadata than the old one. It is a secondary optimization, not the explanation for slow initial tree loading.

### CodeMirror remounting is real but not a newly introduced regression

The current renderer uses `key={activePath}`, so every file switch destroys and recreates the CodeMirror view. The old bundle also remounted it, using `key={`${activePath}:${reloadNonce}`}`. The current hook is heavier because it adds zoom subscriptions, scroll guards, markdown styling, and external-document reconciliation, so persistent-view optimization remains worthwhile, especially for large files. It does not explain why the tree itself loads slowly.

### First-open panel resize is unchanged

Both old and current `openFile` update `filePath` and grow the panel to `880 × 600` only on the first open. The current `PanelFrame` animates width/height only while `settling` or `arranging`; an ordinary file open does not enter those modes. This should not be treated as the main cause.

### The permanent shell transition does not permanently promote a layer

`PanelFrame` carries a transform/opacity transition declaration at rest, but its shell transform is `undefined` and `willChange` is set only while dragging. The current structural surfaces are opaque and do not use `backdrop-filter`. The front panel has a larger shadow, which may increase paint cost on the integrated GPU, but the code does not support a “permanent will-change layer on every panel” diagnosis.

### Store-wide work exists but is bounded on a file click

`PanelLayer` subscribes to the full panels record and recomputes `Object.values`, category filters, and window z-order whenever one panel changes. `PanelFrame` and `PanelBody` memoization preserve other expensive panel bodies. This is unnecessary O(panel-count) work, and the first open causes both a props update and a resize update, but it is not proportional to project file count and cannot explain the slow tree startup.

## Confirmation plan

All instrumentation must be development-only behind `PLANO_PERF_TRACE=1`. Use correlation IDs and monotonic timestamps; never log file contents.

### 1. Prove or reject the watcher regression with one cheap A/B

Add a development-only backend switch:

- `PLANO_WATCH_BACKEND=chokidar` — current behavior.
- `PLANO_WATCH_BACKEND=native` — old Windows behavior with current path normalization and lifecycle safety.
- `PLANO_WATCH_BACKEND=off` — diagnostic control only.

For chokidar, record watch call time, `ready` time, `getWatched()` directory count, tracked entry count, raw events by type, emitted batches, unique paths, and process CPU/resource deltas. Record the number of paths simultaneously waiting for write stability if it can be exposed without patching chokidar internals; otherwise compare `awaitWriteFinish` on/off and observe CPU/event latency.

Expected confirming result: on the large fixture, `off` and `native` make the initial tree and small-file opens responsive while chokidar has a long ready interval, many watched directories, or materially higher CPU/I/O. The difference should disappear or become negligible on the four-file control.

### 2. Trace the full tree pipeline

Instrument:

- `FileSystemService.readTree/buildNode`: root, depth, start/end, directories visited, nodes emitted, result size estimate, concurrent reads, and whether the caller later discarded the result.
- `FileWatcherService`: backend, raw event type/path, batch size, debounce delay, and active watcher/ref counts.
- `EditorPanel`: tree refresh reason, timer scheduled, read started/resolved, reconcile duration, result committed/discarded, and number of in-flight reads.
- `FileTree`: React Profiler commit duration, mounted row count, rendered row count, expanded row count, and renders caused only by `activePath`.

Expected confirming result: a content-only agent write produces one or more full `readTree` operations, and bursts can overlap scans or duplicate them across Files panels.

### 3. Trace one file click end to end

Add marks for:

- row click;
- `updateProps` and optional first-open `resizePanel`;
- file IPC request start/end and bytes;
- Files panel and `FileTree` commit(s);
- CodeMirror `EditorView` create/destroy;
- first and second animation frames after the new document appears;
- autosave scheduled, fired, serialization duration/bytes, and both disk writes.

Use a normal small source file, a markdown file, and a near-limit large file. The normal-file result determines the main interactive target; the large-file result determines whether a separate large-file mode is needed.

### 4. Use a representative, disposable workload

Create a temporary fixture outside the live repository with:

- the real project's approximate directory count, breadth, depth, and file-size distribution;
- ignored directories such as `node_modules`, `.git`, `dist`, and hidden folders;
- one, several, and ten mixed panels;
- one and several Files panels sharing the same root;
- a controlled writer producing content changes, atomic temp-file renames, creates, deletes, and directory changes at the observed agent rate.

Run these comparisons with identical fixture and write schedule:

| Case | Watcher | Event handling | Tree UI | Question answered |
|---|---|---|---|---|
| Baseline | Current chokidar | All events rebuild | Current | Reproduce failure |
| A | Off | None | Current | Cost of tree alone |
| B | Native recursive | Current rebuild policy | Current | Cost of watcher backend |
| C | Chokidar, no `awaitWriteFinish` | Current rebuild policy | Current | Cost of stability polling |
| D | Native/chokidar | Structural events rebuild; content does not | Current | Cost of event misclassification |
| E | Fixed backend | Structural only | Tree replaced by a row-count placeholder | Cost of React tree mount/reconcile |
| F | Fixed backend | Structural only | Current, active highlight held constant | Cost of active-path render fan-out |
| G | Fixed backend | Structural only | Current, CodeMirror held constant | Cost of editor creation/parsing |

## Fix plan, prioritized

### P0 — restore the cheap Windows watch path

#### 1. Use native recursive `fs.watch` on Windows

In `src/main/services/FileWatcherService.ts`:

- Restore `node:fs.watch({ recursive: true, persistent: false })` as the Windows backend.
- Preserve the current normalized, case-insensitive watch key and ref counting.
- Preserve allowed-root validation and error-driven cleanup.
- Filter ignored/hidden path segments before queuing an event.
- Keep chokidar only as a platform fallback where native recursive watching is unavailable or proven unreliable.
- Do not use global `awaitWriteFinish` on Windows. Stability handling, if necessary, belongs only on the active file and only after measurement.

This is the lowest-risk, highest-impact change because it restores the principal behavior of the known-fast build without reverting unrelated functionality.

#### 2. Preserve filesystem event type across IPC

Update `FsChangedEvent` in `src/shared/ipc/contracts.ts`, the preload bridge, and `FileWatcherService` to carry normalized typed changes. A suitable shape is:

```ts
type FsChangeKind = 'content' | 'structural' | 'unknown'
interface FsPathChange { path: string; kind: FsChangeKind }
```

Classification rules:

- Native `change` and chokidar `change` are content changes.
- Chokidar `add`, `unlink`, `addDir`, and `unlinkDir` are structural.
- Native `rename` is conservatively structural because Windows uses it for add/delete/rename and atomic replacement.
- Missing filenames are `unknown` and may trigger one conservative structural refresh.

Deduplicate by normalized case-insensitive Windows path, with structural taking precedence if the same path has several event kinds.

#### 3. Stop rebuilding the tree for content-only events

In `EditorPanel.tsx`:

- Refresh the tree only when a batch contains structural or unknown changes.
- Re-read the active file only when a content/structural event names that exact active path, keeping the already-restored gate.
- For atomic replacement, allow a named structural event to reload the active file as well as invalidate its parent directory.
- Normalize both event paths and persisted active paths before comparison; do not rely on exact casing or slash spelling.

This change removes full-tree work from the dominant AI-agent workload: editing existing files.

#### 4. Add single-flight backpressure to tree refreshes

In `EditorPanel.tsx`, replace “timer starts another `readTree`” with a small refresh state machine:

- At most one tree read is in flight per root.
- Structural events arriving during a scan set one dirty flag.
- When the scan finishes, run at most one follow-up if dirty.
- Root changes invalidate the generation; stale results are discarded.
- A quiet-period timer coalesces bursts, but a maximum-latency bound ensures sustained structural changes eventually appear.
- Unmount/root change clears timers and prevents follow-up work.

In `FileSystemService.ts`, add a single-flight map keyed by normalized `{root, depth}` so simultaneous identical calls from several Files panels share the same in-flight promise. Remove the entry in `finally`; do not cache stale completed snapshots indefinitely.

### P1 — make tree work proportional to the visible tree

#### 5. Replace eager `readTree(depth=5)` with lazy directory reads

Add a `readDirectory` IPC operation in `FileSystemService`, contracts, preload, and IPC registration that returns immediate children only. Directories do not need their entire descendants to display an expansion arrow.

Refactor `EditorPanel`/`FileTree` so that:

- initial load reads only the root's immediate children;
- expanding a directory loads that directory once;
- loaded children are cached by normalized path;
- a structural event invalidates/refreshes only the affected parent directory;
- creates, deletes, and renames patch the relevant parent immediately;
- requests have generation IDs so collapsed, removed, or stale directories cannot commit old data;
- filesystem concurrency is bounded.

This eliminates depth as the scalability control. A project containing 100,000 files should not transfer or allocate 100,000 nodes when the user can see a few dozen rows.

#### 6. Share root tree state among Files panels

Create a renderer-side root tree coordinator/store keyed by normalized root:

- one main watcher subscription/ref per root;
- one lazy directory cache per root;
- one structural refresh per affected directory;
- multiple Files panels subscribe to the same data while retaining independent expansion, filter, selection, and scroll state;
- release the shared root resource when its last panel unmounts.

This removes identical scans and IPC payloads when several Files panels view the same project.

#### 7. Virtualize the visible flattened row list

Refactor `FileTree.tsx` from recursive mounted components to a flattened list of expanded rows:

- do not include collapsed descendants;
- virtualize above a measured threshold;
- key by normalized path;
- keep expansion, draft/rename, selection, and scroll state stable across directory patches;
- use stable callbacks and primitive row props;
- make only the previous and next active file rows change on selection, rather than passing the raw `activePath` through every node.

Lazy loading provides the largest win; virtualization then caps DOM/layout cost when the user intentionally expands a very large tree or filters across many loaded directories.

### P1 — remove avoidable file-open work

#### 8. Keep one CodeMirror view per mounted Files panel

In `useCodeMirror.ts` and `EditorPanel.tsx`:

- Remove the per-path React key after adding CodeMirror `Compartment`s for language, markdown styling, wrapping, and other file-dependent extensions.
- Reuse one `EditorView` and dispatch one latest-request-wins document switch.
- Reset or store history, selection, and scroll per path so undo never crosses files.
- Do not clear the old editor while an async file read is pending; use a non-layout-shifting loading overlay and commit only the latest request.
- Retain one zoom subscription and one set of scroll-guard listeners for the panel lifetime.
- Run one bounded measurement after a successful switch; ignore identical size observations.

This is an improvement over both old and current builds. Land it after watcher/tree fixes so its contribution can be measured independently.

#### 9. Add measured large-file degradation

Use observed byte and line-count breakpoints to disable or defer expensive parsing, folding, bracket analysis, wrapping, and markdown decoration for unusually large or minified files. Keep the normal editor path unchanged below the threshold. Do not use large-file mode to hide tree/watcher regressions.

### P2 — reduce delayed workspace and canvas work

#### 10. Make autosave semantic and single-latest

In `App.tsx`, `autosave.ts`, and `workspaceActions.ts`:

- distinguish durable workspace changes from transient focus/selection and per-frame drag/resize updates;
- persist final geometry at gesture end rather than treating every frame as a durable edit;
- skip an unchanged serialized durable snapshot;
- keep one save in flight and one latest pending snapshot, not a queue of obsolete saves;
- measure user-data and mirror serialization/write separately.

Because `.plano` is already ignored, this is about eliminating delayed jank and disk churn, not breaking a watcher feedback loop.

#### 11. Narrow canvas subscriptions only where profiling proves value

Avoid recomputing full panel categorization/z-order for props-only changes if panel membership and z-order did not change. Preserve `PanelBody` reference stability. Do not undertake a broad store rewrite unless the trace shows material click-path or drag-path time here.

#### 12. Treat compositor changes as evidence-driven

Keep the current rule that `will-change` exists only during actual motion. If traces still show raster/compositor stalls after CPU/I/O fixes, test smaller front-panel shadow bounds and removal of the unused resting shell transition. Do not remove the opaque surface design or blame glass without a GPU trace.

## Regression coverage

Add tests for:

- Windows case/slash path normalization;
- native watcher root ref counting and cleanup;
- ignored directories and `.plano/**` never entering emitted batches;
- `change` classified as content and never causing a tree refresh;
- add/delete/rename classified as structural;
- missing-filename native events causing one conservative refresh;
- atomic replace of the active file reloading content and refreshing only its parent;
- one in-flight tree read plus at most one dirty follow-up;
- identical simultaneous `{root, depth}` reads sharing one main-process operation;
- several Files panels on one root sharing tree data;
- stale root/directory/file responses never committing;
- collapsed directories never being read or mounted;
- only old/new active rows rerendering on file selection;
- one CodeMirror `EditorView` surviving normal file switches;
- large-file mode retaining save/read/error semantics.

## Safe verification without touching the installed app

### Isolation rules

- Leave `%LOCALAPPDATA%\Programs\PLANO\PLANO.exe` open and untouched.
- Run only the development checkout with a unique temporary `PLANO_USER_DATA_DIR` created for each run. `src/main/index.ts:35-38` applies this before the single-instance lock.
- Use a unique CDP port per run.
- Use only disposable fixture projects under a unique temporary directory; never use the live project for write-storm testing.
- Do not package, publish, auto-update, or write under `%LOCALAPPDATA%\Programs\PLANO`.
- Identify test processes by the exact dev/release executable path, the assigned CDP port, or the exact temporary user-data argument. Never terminate by the image name `PLANO.exe`.
- Follow the safer process-scoping pattern in `scripts/plano-motion-e2e.mjs`; do not introduce a broad `taskkill /IM PLANO.exe` or `Stop-Process -Name PLANO`.
- Resolve and inspect all temporary paths before cleanup. Never recursively delete the repository, installed directory, live project, or an unresolved environment-variable path.

### New performance E2E

Add `scripts/plano-files-perf-e2e.mjs` using the existing dev Electron/CDP harness conventions. It should:

1. Create a unique user-data directory and representative project fixture.
2. Seed one Files panel and a mixed multi-panel workspace.
3. Launch dev Electron with the isolated user-data path and unique CDP port.
4. Measure cold tree readiness, warm small-file switches, large-file switch, structural burst, content-only storm, and several Files panels on the same root.
5. Collect renderer performance marks plus main-process trace counters.
6. Close only the CDP/user-data-scoped test process tree.
7. Retain machine-readable JSON results for before/after comparison.

An optional old-build comparison is allowed only if that executable is first proven to honor an isolated user-data directory and disposable fixture. The installed current app is never part of the test.

### Functional verification

Confirm:

- initial root load, expansion, collapse, filtering, selection, and scroll preservation;
- external content updates reload only the matching clean editor;
- dirty editors show the external-change warning and are not overwritten;
- create, delete, rename, directory rename, and atomic replace update the correct parent rows;
- ignored/hidden folders remain hidden and unwatched;
- several Files panels on the same/different roots subscribe and release correctly;
- latest file click wins over slower earlier reads;
- CodeMirror language, undo, selection, scroll, save, and markdown preview remain correct;
- final panel geometry and desired active file still restore after restart;
- continuous agents do not starve structural updates indefinitely.

### Performance acceptance criteria

Use repeated runs and report p50/p95, never the best sample. Initial targets on the user's class of Windows 11 integrated-GPU machine are:

- Native watcher registration does not recursively crawl the fixture and returns promptly regardless of project file count.
- Opening a normal file causes zero full-tree reads and zero watcher work attributable to `.plano`.
- A content-only write storm causes zero tree reads.
- A structural burst produces one affected-directory refresh, or at worst one in-flight full refresh plus one dirty follow-up during the transitional implementation.
- Several Files panels on one root use one watcher and one shared directory/tree read per invalidation.
- No stale scan or stale file read commits to the UI.
- Warm normal-file click to second stable paint: p50 ≤ 50 ms and p95 ≤ 100 ms.
- Root rows interactive: p95 ≤ 200 ms with warm OS cache; deeper content loads only on expansion.
- No renderer long task over 50 ms during a normal file switch.
- During the controlled agent write storm, p95 input delay remains below 50 ms and tree/file queues stay bounded.
- Watcher count, directory-cache size, memory, CPU, and event-loop delay return to a stable baseline after the stress period.

## Rollout sequence

1. Add trace counters and the watcher backend A/B switch.
2. Reproduce on the representative disposable fixture and confirm native vs chokidar attribution.
3. Restore native recursive watching on Windows.
4. Carry event type through IPC and stop content events from refreshing the tree.
5. Add tree single-flight/backpressure and cross-panel request deduplication.
6. Replace eager depth-five snapshots with lazy affected-directory reads.
7. Flatten/virtualize visible rows and isolate active-row rerenders.
8. Stabilize CodeMirror and add measured large-file handling.
9. Optimize autosave/store/compositor work only if post-fix traces still show meaningful secondary stalls.
10. Run functional and performance gates after every step; do not declare success from the four-file probe.

The decisive success condition is not merely a lower average switching time. A normal file open and a content-only agent write must be proven, by counters, to perform no project-tree reconstruction at all.
