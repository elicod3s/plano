# PLANO Files Panel: Instant IDE-Style Folder and File Opening Plan

## Status and purpose

This is an implementation plan only. It is based on a read-only audit of the current PLANO source, the old pre-glass renderer bundle at `C:\Users\Administrator\AppData\Local\Temp\old-plano-index.js`, and Deska's TypeScript source inside `C:\Users\Administrator\AppData\Local\Programs\deska\resources\app.asar`.

The goal is to make opening a folder and switching normal source files feel immediate on a large Windows project, including while AI agents are writing files. The Files panel must paint its shell immediately, show root entries after one shallow directory read, never block the entire panel behind `Loading…`, and keep the editor instance stable between file switches.

The earlier watcher regression has already been addressed in the current source. This plan deliberately does not repeat that fix. It targets the latency that remains after the watcher correction.

## Evidence-based diagnosis

### Primary remaining cause: PLANO blocks the first tree paint on an eager depth-five walk

The current initial path is:

1. `EditorPanel.tsx` detects a new `folderPath`, calls `setRoot(null)`, and displays `Loading…`.
2. It invokes `readTree({ dir: folderPath, depth: 5 })`.
3. `FileSystemService.buildNode()` recursively enumerates all directories through five levels.
4. Each directory is awaited sequentially inside a `for` loop.
5. No partial result crosses IPC; the renderer receives one complete snapshot only after the entire walk finishes.
6. `FileTree.tsx` then recursively mounts the supplied tree.

This is the direct reason a real project behaves differently from a four-file probe. First paint scales with the breadth and depth of the repository, even though the user can initially see only the root and a small number of rows.

The comment in `EditorPanel.tsx` says nested folders open lazily, but the current data path is not lazy: the descendants have already been read by `buildNode()` before the first render. `TreeNode` only hides or reveals children already present in the snapshot.

### The Deska behavior that matters

Deska's `src/main/ipc/filesystem/lib.ts` implements `readDir(dirPath)` as a single-level read. Directory nodes are returned with empty `children`. Its `FileTreeNode` calls `fsReadDir(node.path)` only when that directory is expanded. Therefore a large deep project does not make the initial tree wait for the deep project graph.

Deska can still briefly display `Loading…` for a first-ever cold root, and its implementation performs more per-entry metadata work than PLANO needs. The architecture to copy is shallow root loading and lazy expansion, not Deska's Git overlay or its exact filesystem loop.

### File opening has four synchronous amplifiers on the click path

The current `openFile()` interaction combines:

- `updateProps()` of `panel.props.filePath`, which schedules the subscribed workspace autosave;
- a first-open resize from the compact panel to `880 x 600`;
- propagation of a new `activePath` through every mounted recursive `TreeNode`;
- a new file read followed by a newly mounted `EditorMount`, because `key={activePath}` destroys and recreates CodeMirror for every file.

`useCodeMirror()` is written as a persistent-view hook, but the key in `EditorPanel.tsx` defeats that benefit. The hook also captures language and editor extensions only at mount, which is why removing the key alone is not sufficient: language configuration must become reconfigurable.

The first-open resize changes the terminal-sized canvas panel and the editor viewport at the same time CodeMirror performs its initial layout. That produces a second measurement/fit and makes the delay look like a panel-wide visual bug rather than a file read.

### Large visible trees make every file click more expensive

`activePath` is passed from `FileTree` into every recursive `TreeNode`. When it changes, `React.memo` cannot bail out because every mounted node receives a changed prop. All visible expanded rows render again merely to determine that two rows changed active state.

The current tree is also not virtualized. Lazy loading will drastically reduce the initial node count, but a user can still expand enough directories to create thousands of mounted rows. A fixed-row virtual list is therefore a second-stage requirement.

### Items that are not the first target

- `FileWatcherService.ts` now uses native recursive `fs.watch` on Windows, uses chokidar only as fallback, preserves content versus structural event kinds, and no longer uses `awaitWriteFinish`. Do not revert this.
- `EditorPanel.tsx` now avoids tree reads for content-only changes and applies single-flight backpressure. Keep those protections.
- `FileSystemService.ts` deduplicates identical in-flight tree reads. Keep the concept, but move deduplication to shallow per-directory requests.
- `.plano` is ignored by both tree and watcher logic. The project mirror is not a watcher feedback loop.
- Autosave waits 800 ms, so it does not explain the initial blank editor. It can cause a delayed hitch after navigation and should be separated later, but it is not P0.
- `PanelFrame` has no resting transform and only applies `will-change: transform` during a drag. It is not the folder-loading cause.
- Ordinary small files are not slow because CodeMirror cannot render text. Large-file behavior needs a separate guard, but normal file switching is currently paying avoidable remount and layout costs.

## Target behavior and performance budgets

The following budgets should be measured from pointer action to the first painted frame, not merely until an IPC promise resolves:

| Scenario | Target |
|---|---:|
| Files panel shell after selecting a folder | next frame, <= 16.7 ms at 60 Hz |
| First root rows, warm cache | <= 50 ms p95 |
| First root rows, first cold open on local SSD | <= 150 ms p95 |
| Expand a normal directory, warm | <= 50 ms p95 |
| Expand a normal directory, cold | <= 120 ms p95 |
| Click normal text file to editor content painted | <= 100 ms p95 |
| Switch between recently opened files | <= 50 ms p95 |
| Long task caused by folder/file opening | none above 50 ms |
| Duplicate directory reads for the same path | zero while a request is in flight |
| Full-tree refresh caused by a content edit | zero |

The actual file names cannot be displayed before a first-ever cold disk read returns. “Instant” here means immediate UI feedback and one shallow operation on the critical path, with no deep traversal and no full-panel loading gate. Warm roots and recently opened files should be genuinely immediate from cache.

## Confirmation plan before implementation

Add development-only measurements first, behind one performance-debug flag, and remove or disable noisy logging after validation.

### Main-process timings

Instrument `FileSystemService.readTree/buildNode` and the replacement shallow API with:

- normalized root/path;
- elapsed time;
- directories visited;
- entries returned;
- maximum depth reached;
- approximate serialized payload size;
- whether the result was cold, cached, or joined to an in-flight request.

Run one real-scale fixture with thousands of files and deep folders. The decisive A/B experiment is current depth five versus a one-level root read. If first rows become fast while the rest of the app remains responsive, the primary diagnosis is confirmed.

### Renderer timings

Place User Timing marks around:

- folder selected;
- Files shell committed;
- root IPC resolved;
- first root row committed and painted;
- file row pointer-down/click;
- file IPC resolved;
- CodeMirror constructor start/end;
- language extension completion;
- first editor paint;
- first usable keyboard focus.

Use the React Profiler on a file switch and count `TreeNode` renders. The expected current result on a large expanded tree is that most visible rows render when `activePath` changes.

### Cheap isolation experiments

Perform these as temporary development experiments, one at a time:

1. Request depth one instead of five. This isolates deep tree enumeration.
2. Keep the Files panel at a stable size before the first file click. This isolates resize plus CodeMirror measure.
3. Hold one CodeMirror `EditorView` while switching two files. This isolates editor construction and language loading.
4. Replace the tree's active path propagation with a constant during one trace. This isolates the recursive rerender cascade.
5. Disable workspace persistence only in an isolated development run. If a hitch remains at 800+ ms, autosave is an amplifier; if initial paint is unchanged, it is not the primary cause.

Do not use the user's installed PLANO process for any experiment.

## Implementation plan

### P0: put only one shallow directory read on the folder-open critical path

#### 1. Introduce a shallow directory IPC contract

Files:

- `src/shared/ipc/contracts.ts`
- `src/shared/ipc/channels.ts`
- `src/preload/index.ts`
- `src/main/ipc/registerIpc.ts`
- `src/main/services/FileSystemService.ts`

Add a `readDirectory({ dir })` operation that returns only the immediate children. Use `fs.readdir(dir, { withFileTypes: true })`, the existing ignore rules, directory-first sorting, path validation, and no recursive call. Do not call `stat` for every normal entry when `Dirent` already provides the needed type. Treat symlinks according to the existing security policy and never recursively follow them.

Keep a single-flight map keyed by normalized directory path. The result should distinguish:

- successfully loaded empty directory;
- not yet loaded directory;
- inaccessible/error directory.

Deprecate `readTree(depth)` for the Files UI after migration; do not keep both code paths active in the panel.

#### 2. Replace the snapshot tree with a shared per-root directory cache

Add a focused renderer data store, for example `src/renderer/stores/useFileTreeStore.ts`. Its data identity should be the normalized absolute directory path, not the panel ID.

The store should contain:

- `entriesByDirectory`;
- `statusByDirectory: idle | loading | ready | error`;
- a generation/version per directory;
- in-flight promises or request IDs;
- bounded last-access metadata for eviction.

Multiple Files panels on the same root must share data and in-flight work. Expansion state, selection, scroll position, drafts, and rename state remain per panel so one panel does not unexpectedly open folders in another.

When a root is selected:

- render the Files chrome immediately;
- serve cached root entries synchronously if present;
- revalidate in the background without clearing them;
- if it is a first-ever root, keep the tree surface stable and populate rows when the one shallow read resolves;
- never call `setRoot(null)` solely to show a blocking `Loading…` screen.

Use a small inline progress affordance in the header or root row only when the cold read exceeds roughly 100 ms. Do not replace the entire tree with loading text.

#### 3. Load directory children only on expansion

Files:

- `src/renderer/panels/editor/EditorPanel.tsx`
- `src/renderer/panels/editor/FileTree.tsx`

On directory click:

1. update expansion state immediately;
2. render cached children if available;
3. otherwise call the shared `loadDirectory(path)` once;
4. show a local ellipsis/spinner on that directory row, not a panel-wide loader;
5. ignore stale completions using the directory generation;
6. retain loaded children when collapsed.

Do not preload five levels. At most, prefetch one directory on pointer hover or during idle time after the root is already interactive. Cap prefetch concurrency and disable it while filesystem activity is high.

#### 4. Patch only the affected parent on structural watcher events

The current watcher payload already includes paths and change kinds. For `structural` events, compute the parent directory and invalidate/re-read that one shallow listing. Coalesce paths by parent and share the request across panels.

For an `unknown` Windows rename event, refresh the nearest known parent and root only if the parent cannot be derived. Never rebuild a depth-five snapshot. Content changes continue to bypass tree data entirely.

Tree mutations initiated by `FileTree` should optimistically patch the relevant cached directory, then revalidate it. This makes create/rename/delete visible immediately without a global `treeNonce` refresh.

### P0: keep the editor surface and panel geometry stable

#### 5. Stop remounting CodeMirror on every file

Files:

- `src/renderer/panels/editor/EditorPanel.tsx`
- `src/renderer/panels/editor/useCodeMirror.ts`
- `src/renderer/panels/editor/languages.ts` if language loading changes are required

Remove the file-path key from `EditorMount`, but only after `useCodeMirror` can reconfigure file-dependent extensions. Use CodeMirror `Compartment`s for language, line wrapping, Markdown styling, and other path-dependent configuration. Replace the document with one transaction and restore a per-file `EditorState` or at minimum selection and scroll position.

Keep one `EditorView` per Files panel until the panel is closed. Maintain a bounded recent-document cache keyed by path plus revision/mtime so returning to a recent file restores instantly without losing undo history. Dirty buffers must never be evicted silently.

The active tab/title should change on the click frame. While a cold file read is pending, preserve a stable editor surface and use a subtle non-blocking progress mark; do not center `Loading…` over the entire editor.

#### 6. Remove resize from the file-click transaction

Change Files panel sizing so opening a file does not mutate the outer panel rect on the same click.

Preferred behavior:

- create or restore the Files panel at a size capable of showing its editor;
- keep the outer rect unchanged while files open and close;
- treat compact tree-only mode as an explicit user layout choice, not an automatic file-open side effect.

If automatic growth must remain for compatibility, perform it before editor construction, disable any size animation for that transaction, wait for the final layout frame, and create/measure CodeMirror once. Do not collapse automatically when the file closes, because repeated open/close cycles otherwise force repeated layout and canvas-store writes.

#### 7. Make a file switch rerender only the old and new active rows

Do not pass the complete `activePath` through every recursive node. Each rendered row should receive an `isActive` boolean, or subscribe to a narrow active-row selector keyed by its path. With stable node data and callbacks, all rows except the previous and next active rows must bail out.

Measure this with the React Profiler; the acceptance condition is two active-state row updates plus any newly exposed rows, not the whole visible tree.

### P1: keep very large expanded trees and files responsive

#### 8. Flatten and virtualize visible rows

Convert the expanded tree into a flat list of visible row descriptors containing path, depth, type, load status, and active state. Render only the viewport plus a small overscan using a fixed row height. Preserve keyboard navigation, context menus, rename inputs, reveal-active-file, and scroll restoration.

Virtualization is not required for the first shallow root paint if root counts are modest, but it is required for the “thousands of expanded rows” acceptance test.

#### 9. Decouple filtering from the fully materialized React tree

The current `filteredRoot` recursively walks all loaded descendants and force-expands matches. Under lazy loading, filtering must not trigger thousands of uncontrolled directory reads or mount every matching branch.

Use a debounced main-process search endpoint with cancellation and bounded results, or a background index built after the UI is interactive. Render search results as a flat virtual list. Selecting a result should lazily load only its ancestor chain before revealing it.

#### 10. Add a large-file mode

Before reading or parsing, obtain file size from the main process. Establish measured thresholds rather than one unconditional editor configuration. A suggested starting policy is:

- normal mode below 2 MB;
- reduced syntax/folding and no expensive wrapping between 2 MB and 10 MB;
- explicit large-file mode or confirmation above 10 MB;
- reject binary data from the text editor path.

CodeMirror remains viewport-virtualized, but parsing, whole-document string conversion, diffing in `useCodeMirror`, and `onChange`'s `doc.toString()` can still become expensive for large buffers.

### P1: remove delayed navigation persistence hitches

`App.tsx` subscribes every `usePanelStore` mutation to `scheduleAutosave()`. Therefore a file selection and the current automatic resize mark the entire workspace dirty and eventually serialize it to both userData and `.plano/workspace.json`.

After P0 is measured, classify mutations:

- structural canvas/document changes: normal workspace autosave;
- transient navigation such as active file, sidebar visibility, focus, and scroll: lightweight session persistence or idle-only save;
- editor file content: existing explicit file save path, never workspace autosave.

Do not put the directory cache into the workspace document. If cross-restart warm roots are desired, store a bounded root-level cache separately under the isolated userData cache area, validate it asynchronously, and never mirror it into the project.

## Verification plan

### Safety boundary

- Never close, update, overwrite, attach automation to, or publish the installed `%LOCALAPPDATA%\Programs\PLANO\PLANO.exe`.
- Launch only development Electron with a unique `PLANO_USER_DATA_DIR` under a disposable test directory.
- Use a unique CDP port for every automated run.
- Identify cleanup targets by the exact development/release path or that CDP port. Never kill `PLANO.exe` by process name.
- Do not write test metadata into the user's active project. Use a generated large fixture or an explicitly approved disposable copy.

### Test matrix

Use at least these fixtures:

1. small folder, approximately 10 files;
2. broad root, at least 5,000 immediate entries;
3. deep project, at least 50,000 files across many directories;
4. active-agent simulation with content writes to many existing files;
5. structural churn with create/rename/delete bursts;
6. normal files from 1 KB to 1 MB;
7. large text files at the selected thresholds;
8. ten or more mixed panels on a 240 Hz display profile and integrated-GPU machine where available.

### Automated assertions

Extend the existing dev E2E harness rather than launching the installed app. Record performance entries and assert:

- the Files shell appears before filesystem completion;
- initial open issues exactly one shallow root request and no recursive walk;
- expanding one directory reads only that directory;
- two panels on the same root share one in-flight request;
- content-only watcher events issue no directory request;
- a structural event rereads only affected parent directories;
- opening a file does not resize the panel;
- the same CodeMirror DOM/view identity survives file switches;
- switching files rerenders only old/new active rows;
- no centered `Loading…` gate appears for folder or normal-file navigation;
- editor input, selection, undo, scroll, save, Markdown mode, image preview, external-change warning, and dirty guards still work.

### Manual acceptance

On the integrated-GPU Windows machine, capture a renderer performance trace while:

- opening the large project cold;
- reopening it warm;
- expanding several large directories;
- switching files rapidly for 30 seconds;
- letting agents write content for several minutes;
- dragging and zooming the canvas while the Files panel remains open.

The fix is accepted only if there are no repeated main-process directory crawls, no renderer long-task train, no visible tree blanking/flicker, no CodeMirror remount on normal switches, and no regression in the rest of the canvas.

## Recommended delivery order

1. Add measurements and record the current large-fixture baseline.
2. Add shallow `readDirectory` IPC and shared single-flight cache.
3. Convert root and directory expansion to lazy loading; eliminate full-panel loading gates.
4. Route structural events and tree mutations to parent-directory patches.
5. Keep panel geometry stable and make CodeMirror persistent/reconfigurable.
6. Isolate active-row updates.
7. Re-measure; add tree virtualization only where the expanded-tree trace proves it necessary.
8. Add large-file mode and transient navigation persistence separation.
9. Run the isolated E2E and manual integrated-GPU matrix.

## Definition of done

The work is complete when a first-ever folder open is bounded by one shallow read, warm roots and recent files appear from cache, no folder or normal file blocks behind a panel-wide loader, CodeMirror survives file switches, watcher churn cannot trigger a full-tree scan, and all performance targets pass in isolated development without interacting with the user's installed application.
