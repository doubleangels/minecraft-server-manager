# Code Review Findings — Minecraft Server Manager

Date: 2026-09-19 · Branch: `feature/fleet-metrics-history` @ `9148a7b`
Scope: read-only review (`codegraph` + full source read) of 56 templates, `assets/css/input.css`,
all client libs/pages, every service / docker / db / storage / ws module, routes, and migrations.
No changes were made; this file is a findings dump only.

Review axes, in order: **1) visual/layout/mobile-first**, **2) performance**, **3) bugs sorted by severity**.

---

# 1. Visual layout / styling / formatting / mobile-first

**Overall verdict: genuinely good.** Semantic-token discipline (`surface/raised/inset/ink/line/ok/warn/danger/link`),
the `.table-stack` mobile collapse, the `aria-pressed` component contract, the 2.75rem touch-target floor,
reduced-motion handling, and the fixed-literal-class rule for Tailwind's scanner are respected everywhere.
No critical or mobile-breaking issues — layouts survive a 375 px viewport and light/dark theming throughout.
What remains is consistency drift in a handful of hand-rolled colorways.

## High

### H-V1. Player role chips: the same "on" state hand-rolled in three places with drifting shades

- `views/partials/server/players.hbs:81-91` and `views/partials/server/player-detail.hbs:27-33` use raw
  tint triples (`border-grass-700 bg-grass-500/15 text-ok` / `border-diamond-700 bg-diamond-400/15 text-link` /
  `border-danger/40 bg-redstone-500/15 text-danger`) instead of the component contract.
- `public/js/pages/players.js:66-70` and `public/js/pages/player-detail.js:59-61` carry a _third_ copy of the
  same map (`CHIP_ON`), with a different `/15` vs the component's `/10` opacity on `button.chip[aria-pressed]`
  (`bg-grass-600/10`, `assets/css/input.css:584-586`).
- Result: the same pressed state renders two shades depending on whether the row was server-rendered or
  patched in place by JS.
- Fix: consolidate into one component class (e.g. `.chip-ok` / `.chip-info` / `.chip-danger`), used by both
  the templates and the JS patching code.

### H-V2. `storage.hbs` stacked tables render label-less cards on mobile

- `views/storage.hbs:50-62`, `:82-96`, `:104-109`: the three `table-base table-stack` tables have no
  `<thead>` and every cell carries `data-th=""`.
- Below `sm`, `.table-stack` collapses each row into a "Label: value" card (`assets/css/input.css:657-683`),
  but with all labels suppressed, a phone sees a naked meter + byte count + icon with no column heading and
  no accessible name (`content: none` via the `data-th=""` rule).
- Fix: give the cells real `data-th` labels (or add an `sr-only` header row in `<thead>`).

## Medium

### M-V1. Whitelisted dot shade mismatch

`players.hbs:66` and `players.js:96` use `bg-grass-700` for the "Whitelisted" dot while every other grass
meaning (Online, all `status-dot` uses) is `bg-grass-500`. Same-meaning dots in two colors — pick one.

### M-V2. Same pressed-shade drift in chat + select

- `public/js/pages/chat.js:35-38` (`STYLE_BTN_CLASS`: `aria-pressed:border-grass-500 aria-pressed:bg-grass-600/15`).
- `public/js/lib/select.js:110` (`aria-selected:bg-grass-600/15 text-ok`).
- Both re-implement a pressed state the `.seg` / `button.chip` components already own. Reuse the components.

### M-V3. Ad-hoc success box in the wizard

`public/js/pages/wizard.js:1050` builds the selected-modpack box with `border-grass-700 bg-grass-600/10`;
`.notice-ok` (`assets/css/input.css:527`) exists for exactly this.

## Low (nits)

- `view storage.hbs:55` hardcodes `bg-diamond-400` on the category meter instead of routing through the
  `meterColor` map (`src/web/app.js:158-165`).
- `views/partials/server/metrics.hbs:121` — `truncate` on an inline `<span>` is a no-op; needs `block`/`min-w-0`.
- `views/dashboard.hbs:134` mixes token + raw hovers: `hover:border-grass-600` beside `hover:text-ok` → use `hover:border-ok`.
- `views/partials/server/chrome.hbs:61` active-tab underline is raw `border-grass-500` at the call site
  (`.subtab.active` exists as the component).
- `views/partials/server/settings.hbs:40` raw `hover:border-stone-500` on the icon-upload button.
- `views/setup.hbs:8` + `public/js/pages/setup.js:21-22` progress dots toggle raw `bg-grass-500`; fine technique
  (mirrors `STATUS_DOT`) but uncommented.
- `public/js/pages/wizard.js:649-659` — dead 4th argument `['border-grass-500','text-ok']` to a 3-arg `pickGroup()`.
- `public/js/lib/taskTray.js:61-65` — runner count badge toggles raw `bg-grass-600 text-white`; the `.badge-ok`
  family is the sanctioned way to signal count state.
- Icon-only controls across views carry only `data-tip`; `labelTips()` (`public/js/lib/tooltip.js:31-36,94`)
  promotes these to accessible names at load, which works — but an explicit `aria-label` would not depend on
  that module's boot. JS-injected `icon-btn`s (dockerSettings.js:56,75; server-settings.js:157; modal.js:41;
  toast.js:50) already model the right pattern.
- Full-literal maps that must keep the "scanner needs verbatim literals" property but lack the explanatory
  comment (a future cleanup _will_ "fix" these and break the build): `dashboard.hbs:57-63`,
  `public/js/pages/dashboard.js:225-236`, `analytics.js:276-279`, `src/web/routes/index.js:598-619`,
  `public/js/pages/inventory.js:141-143,160,518`.

## Verified clean

`main.hbs`, `bare.hbs`, `page-header`, `empty-state`, `brand-lockup`, `topbar`, `sidebar`, `catalog-field`,
`settings/card`, `settings/toggle-row`, `server-detail`, `server-player`, all of `server/` except noted,
`wizard.hbs`, `login*`, `error.hbs`, plus `modal.js`, `toast.js`, `seg.js`, `dropdown.js`, `confirm.js`,
`chartTheme.js`, `twoFactor.js`, `avatar.js`, `itemBrowser.js`, `zipImport.js`, `progress.js`, `loading.js`,
`errors.js`, and every other client page/lib not named above.

---

# 2. Performance

## High

### H-P1. Metrics tab is the heaviest page in the panel

`src/web/routes/index.js:544-622`:

- ~23 synchronous SQLite queries before render: `serverVM(row)` (6: diskUsed 1, packVM 2, hasPackUpdate 2,
  crashes 1), 7× `countEvents`, `lastCrash`, `recentEvents`/`eventsVM` (2), 6× `indexer.sizeOf`.
- Plus a **live recursive `dirsSize()` walk of every world** on every load via
  `worlds.listServerWorlds()` (`src/services/worlds.js:360-396`, stat walk at `:384`) — tens of thousands of
  `fsp.stat` calls per render against region-file forests.
- The same per-world sizes are then re-read from the storage index (`indexer.sizeOf('servers/<id>/<world>')`,
  `index.js:595-622`) for the breakdown bar — the page computes every world twice, two different ways, for
  two UI elements that can disagree.
- Fix: read `indexer.sizeOf` for both; only touch `level.dat` existence / `readProps` live. Keep `dirsSize()`
  for one-off ops (duplicate/extract/download), not page renders.

### H-P2. Metrics history pulls every row into JS before bucketing

`src/metrics/aggregate.js:184-220`:

- `serverSeries`/`fleetSeries` do `SELECT … WHERE ts >= ? AND ts <= ? ORDER BY ts` with no bucketing in SQL,
  then bucket in JS (`aggregateOne`/`aggregateFleet`) — all on the **synchronous** node:sqlite driver.
- At 1 sample/min/server the 7 d fleet trend materializes ~10,080 rows _per server_; a 20-server fleet
  ≈ 200 k rows parsed, pushed into Maps, and averaged per request, blocking the event loop.
- Fix: bucket in SQL (`GROUP BY` on an integer-division / `strftime` bucket of `ts`), or add hourly/daily
  rollup tables, so ≤120 points cross the driver.

### H-P3. `files.list()` is an N+1

`src/services/files.js:55-99`: every subdirectory entry triggers an individual
`indexer.sizeOf()` `SELECT` plus an `fsp.stat` for mtime. A folder with many subdirs (data root in the global
manager, a world with dimension trees) multiplies sync/async round-trips per listing. The Files tab and the
file-manager routes share it. Fix: one `SELECT rel_path, size_bytes FROM storage_index WHERE rel_path IN (…)`
per listing — the exact pattern `sidebarServerVMs` already uses (`src/web/viewModels.js:34-61`).

## Medium

### M-P1. Per-meter settings reads

`src/web/app.js:158-165` — the `meterColor` Handlebars helper calls `settings.getDefaults()` (1 sync SELECT)
for every meter bar rendered (dashboard card count, overview trio, metrics partial, storage rows). N+1 on top
of the base queries. Fix: memoize `getDefaults()` at module level, invalidate on `setDefaults`/`resetDefaults`.

### M-P2. Page-level duplicate + unbatched reads

- `countOutdated()` (one query with 5 scalar correlated subqueries over update_checks/server_packs/
  server_content/servers) runs in the every-page middleware (`src/web/routes/index.js:130-138`) **and again**
  on the dashboard (`buildDashboardOverview`, `:242`). Memoize `countOutdatedByKind`; invalidate in
  `upsertCheck`/`setUpdateIgnored`.
- `serverVM()` no-ctx path: `packVM()` _and_ `hasPackUpdate()` both re-read `server_packs` + `update_checks`
  (`src/web/viewModels.js:266-295`) — 4 queries for 2 reads. Merge into one of each.
- `libraryWorlds()`: one `db.get('SELECT display_name FROM servers WHERE id = ?')` per extract-source library
  world (`src/services/worlds.js:844-876`). Batch into one `WHERE id IN (…)`.

## Low

### L-P1. `/api/servers/:id/stats` does a ~2 s Docker round trip per request

`src/web/routes/api.js:273-278` calls `statsOnce()`; not client-polled (the UI uses the brokered `/ws/stats`
stream), but any ad-hoc refresh hangs ~2 s. Serve from the in-memory live cache with `statsOnce` as fallback.

### L-P2. `/storage` runs 4 cleanup dry-runs on every load

`src/web/routes/index.js:835-913` — 4 filesystem walks (tmp/orphans/old-logs/old-crashes) + `largestFiles`

- ~15 `indexer.sizeOf` calls per load. Admin-only, but make the previews click-triggered or reuse index-cached
  sizes.

### L-P3. Activity search defeats indexes

`src/web/routes/index.js:917-979` — `summary LIKE '%q%' OR actor LIKE … OR type LIKE …` over a table holding
up to 90 days of events; unfiltered case still uses the PK. FTS5 if it ever matters.

### L-P4. Small per-row N+1s (bounded tables)

`src/services/scheduler.js:266` and `src/updates/checker.js:378-491` — per-row `db.get` for server names on
`/schedules` and `/updates`. Same IN-batch fix; low impact.

## Verified clean — do not "fix"

- Dashboard/server-list rendering: `serverVMs` + `buildServerContext` batch the per-server queries
  (`viewModels.js:168-230`); sidebar sizes use one exact `rel_path IN (…)`.
- No Docker on render paths — everything reads `liveCache`; `docker stats`/RCON stream in background.
- Mojang manifest single-flight + in-memory memo.
- WS layer: one upstream `docker logs --follow`/stats stream per server brokered to all tabs, 256 KB replay
  cap, slow-socket drop, 64 KB maxPayload.
- Background loops: indexer walk is async with debounced re-scan + `cachedEqual` skip; events prune batched;
  metrics sampler transactional and throttled.
- Client: one shared 8 s `/api/servers/live` poll broadcast via `msm:servers-live` CustomEvent — no
  overlapping intervals; charts `animation: false`; the 30 s ticker in `metrics.js:38` is DOM-only and
  `document.hidden`-guarded.

---

# 3. Bugs — sorted by severity

No CRITICAL vulnerabilities found (auth, session + CSRF/CSWSH, zip-slip, upload caps, path guard, client
escaping, at-rest AES-256-GCM secrets, formula-injection-safe CSV export all held up line-by-line).

## HIGH

### H-B1. Restore rejects backups the panel itself created — legit recovery permanently blocked

- Location: `src/services/backups.js:293`; `src/utils/zip.js` (defaults `MAX_EXTRACT_BYTES = 50 GiB`,
  `MAX_EXTRACT_ENTRIES = 200_000`).
- `restoreBackupImpl` calls `extractZip(zipPath, stagingDir)` with **no** cap overrides, so the hard defaults
  apply. The create side (`backupZipWorker`/archiver) imposes **no** caps, and restore, after a valid preflight
  (reading the real `uncompressedBytes` from the zip central directory), stops the server, writes the safety
  backup, and then aborts at extraction with 413 when a self-made backup's uncompressed payload exceeds 50 GiB
  or 200 k entries. The backup is then unrestorable until hand-repackaged.
- Impact: data-recovery path, blocked, only on the biggest, most valuable backups.
- Fix: pass `maxBytes`/`maxEntries` derived from the archive's own preflight totals
  (at minimum `max(defaults, archive actuals)`); the preflight already reserves exactly that disk.

### H-B2. `recreate` and `delete` stop without recording `stop-requested` → phantom crash history + status clobber

- Location: `src/services/servers.js:565-573` (recreate), `:756-759` (delete); `src/docker/watcher.js:152-208`.
- `recreateServerImpl` and `deleteServerImpl` call `stopContainer`/`removeContainer` directly and never emit
  the `stop-requested` event that `stopServerImpl` records (`:505`). When the old container's `die` exits 137
  (docker stop escalated to SIGKILL on a slow-saving world), the watcher sees no `stopRequested` window and
  records a **false crash** + flips status to `crashed`.
- Worst case in a recreate: the old container's `die` lands _after_ the new container's `start` event and
  clobbers its status to `crashed`/`stopped` until the next health event or the 60 s `refreshStatuses` poll.
- Data impact: none — `armedRestart` is `!killedBySignal`, so no spurious auto-restart — but crash history is
  polluted and the fleet view flickers on every slow rebuild.
- Fix: emit `stop-requested` before stopping in both impls (and skip `deleted_at` rows — see M5).

## MEDIUM

### M-B1. Non-atomic world replace-install sized at compressed×2 — ENOSPC can leave the active world partially missing

- Location: `src/services/worlds.js:445,480,491`; `src/services/library.js:306-311`.
- Replace mode: `assertUnderQuota(server, lib.size_bytes * 2)` and `reserveDiskSpace(lib.size_bytes * 2)` use
  the **compressed** library zip size × 2. A world whose zip compresses more than 2:1 (typical for sparse /
  empty-chunk terrain) gets no real disk protection; ENOSPC after `fsp.rm(dim)` (`:491`) leaves the previous
  active world partially missing.
- `library.js` replace-install does `fsp.rm(target)` then `fsp.link` (copy fallback) — a crash or EPERM
  between the two loses the installed file outright (harmless to the DB row, which is written after, but the
  file is gone).
- Fix: reserve the _uncompressed_ size for world installs; install to a temp name and atomically `rename()`
  over the target.

### M-B2. Four world mutators run unguarded against the restore swap

- Location: `src/services/worlds.js:290,544,573,803`.
- `extractFromServer`, `copyBetweenServers`, `duplicateWorld`, `prepareWorldDownload` are not under
  `guardOp`, while restore's two-rename swap runs under `guardOp('restore')` with `withPausedSaves`
  (`src/services/backups.js:310-316,333`). A concurrent `duplicateWorld` mid-restore can ENOENT mid-copy or
  copy a half-swapped tree, leaving an orphaned DB-less `-copy` dir. `duplicateWorld`'s name picker is also
  unlocked — two concurrent duplicates can pick the same name and `fsp.cp` merge.
- Fix: wrap the four in `guardOp` (keyed on `serverId`).

### M-B3. Restore rollback failure swallowed + boot recovery can delete the only complete copy after a partial EXDEV copy

- Location: `src/services/backups.js:320,578`; `src/storage/dataRoot.js:48-60`.
- The swap rollback at `backups.js:320` is `.catch(() => {})` — a rollback failure leaves the server dir
  missing until next boot (boot recovery then fixes it). Worse: `renameDir`'s EXDEV fallback uses `fsp.cp`;
  if `data/tmp` is on another device and the process/host dies mid-copy, a **partial** `serverDir` exists and
  `dataRoot.js:56-57` sees it and `rmSync`s the complete displaced world.
- Fix: only delete the displaced copy when the server dir validates (non-empty / contains `level.dat` or a
  manifest); log rollback failures instead of swallowing.

### M-B4. Quota is advisory-by-design, but `mods.js` checks it _after_ the bytes land

- Location: `src/services/mods.js:777,1215`; `src/services/library.js:34`.
- `assertUnderQuota` runs after `downloadToLibrary` has already written up to 8 GiB into the library — a
  quota-0 server can still consume 8 GiB before the 409. The cache-based quota is documented as advisory
  (strict enforcement only every 15 min via `enforceStrictQuotas`), but this ordering gives the check no
  teeth even for its stated purpose.

### M-B5. Watcher mutates soft-deleted servers

- Location: `src/docker/watcher.js:92`.
- `handleEvent` runs `SELECT * FROM servers WHERE id = ?` with no `deleted_at` filter, so `die`/`start`
  events landing after a delete still update status / record history on the tombstoned row.
- Fix: skip rows where `deleted_at IS NOT NULL`.

## LOW

### L-B1. `bootWillStart` ignores crash-loop backoff

- Location: `src/services/servers.js:978`.
- `bootWillStart = auto_start || (auto_restart && status === 'crashed')` doesn't check `inCrashLoopBackoff`,
  so the offline-after-restart alert is suppressed for a server that will genuinely stay down.

### L-B2. Graceful-stop false crash when the save outlives the 3-minute request window

- Location: `src/docker/watcher.js:117-118,155-158`.
- The watcher's `stopRequested` lookback is 3 minutes. A world that takes >3 min to save during a graceful
  stop and then gets SIGKILLed (exit 137) reads as an unrequested crash. Edge, but events can also be
  processed late, widening the window.

### L-B3. Client escaping inconsistency (defense-in-depth)

- Location: `public/js/pages/players.js:838-847` vs `public/js/pages/commands.js`.
- Biome/dimension IDs are interpolated into `<option>`/`innerHTML` unescaped in `players.js` while
  `commands.js` escapes the same source. Currently safe (server constrains IDs to `[a-z0-9_.-]+:[a-z0-9_/.-]+`
  and the fallback list is static), but unify with `esc()`.

### L-B4. Unescaped interpolation in `analytics.js`

- Location: `public/js/pages/analytics.js:105`.
- `row.rank` flows into `innerHTML` unescaped next to escaped neighbors; always numeric from `ROW_NUMBER()`,
  cosmetic only.

---

# Recommended fix order (overall)

1. **H-B1** restore extraction caps — one-line, unblocks the most valuable recovery path; then **M-B3**
   rollback/recovery data-loss edge.
2. **H-B2** `stop-requested` before recreate/delete stops (with **M-B5**) — kills phantom-crash noise.
3. **M-B1** atomic world install + uncompressed reserving — data integrity.
4. **H-P1/H-P2/H-P3** metrics tab render path + SQL-bucketed series + batched `files.list` — the
   user-visible-latency items.
5. **H-V1/H-V2** role-chip consolidation + `storage.hbs` mobile labels — daily-visible visual consistency.

---

# 4. IMPLEMENTATION PLAN — Settings save confirmation with a summary of all changes

Date: 2026-09-19 · Handoff doc: another agent implements this end-to-end. Everything below is the
researched plan, with the two reviewed refinements already folded in.

## 4.1 Goal and out-of-scope

**Goal.** On the Server → **Settings** tab (`views/partials/server/settings.hbs`), clicking **Save Changes**
(`#st-save`) opens a confirmation modal that summarizes **every field that will change** (friendly label +
before → after) before anything is sent. Confirming applies the save exactly as today; cancelling changes
nothing.

**Out of scope — do NOT touch:** "quick toggles" that act immediately without this form's Save button:
player whitelist/op/ban chips (`public/js/pages/players.js`), World Controls chips
(`public/js/pages/world-controls.js`), and any toggles outside the Settings tab. The confirmation applies
**only** to the `#st-save` handler in `public/js/pages/server-settings.js`.

## 4.2 Design decision (agreed, do not reopen)

The summary is computed **server-side** by a new preview endpoint that reuses the exact diff logic in
`updateServer` (`src/services/servers.js:649`), **not** re-derived in browser JS.

Why:

- The summary then shows precisely what the `PATCH` will apply — same env-merge semantics, "blank clears a
  key", quota/Zod/pin checks. No drift between what the modal says and what lands.
- Friendly labels come from the field catalog (`getField('env', key)` in
  `src/config/field-catalog/index.js:73` — this also covers `MOTD` → "Server list message (MOTD)" at
  `src/config/field-catalog/gameplay.js:43-46`). No client-side duplicate label map.
- `needsRecreate` is computed by the same code path that sets `pending_recreate`, so the "needs a rebuild"
  hint is always truthful.

**Refinement already folded in (important):** the refactor must be a **pure extraction** — `updateServer`'s
recorded `details.diff` in the event log (`src/services/servers.js:744-746`) must keep its current shape,
including the collapsed env `['(changed)','(changed)']` entry (`:688`). Do **not** expand env per-key inside
`updateServer`; that would silently change persisted history format. Per-key env comparison happens only in
the new summarize function (cheap object compare of `before.env` vs `changes.env`). `test/servers-core.test.js`
must pass unchanged.

## 4.3 Server changes

### Step 1 — `src/services/servers.js`: extract the diff computation

1. Extract the diff-building body of `updateServer` (lines 651–735: the `columns` map, the column loop, the
   `tags` / `env` / `containerName` / `networkName` / `extraPorts` / `extraBinds` / `diskQuotaGb` / boolean-flag
   blocks, and the `RECREATE_FIELDS` set) into a module-private helper:
   `function computeServerDiff(id, changes)` → `{ diff, sets, params, needsRecreate }`.
   - It must have **identical output** to today for every input (byte-for-byte the same `sets`/`params`/`diff`/
     `needsRecreate`), including the collapsed env entry and `assertPinnedPackEnv` throwing (`:687`).
   - `updateServer` becomes: call `computeServerDiff`, then the existing `if (!sets.length) return`, the
     `pending_recreate` push (`:738`), the `UPDATE` (`:739`), and the `recordEvent` (`:740-746`) — nothing else
     changes.
2. New exported function:
   `function summarizeServerChanges(id, changes)` → `{ changes: [{ label, before, after, requiresRebuild }], needsRecreate }`.
   - Calls `computeServerDiff` (so pin checks and the no-op detection still run) plus its own **per-key env
     diff**: compare `before.env[key]` vs `changes.env[key]` for every key in either object; deleted keys
     report `before: <value>, after: null`.
   - Presentation mapping (label map lives here):
     - Direct columns → panel copy (sentence case, per house style):
       `name` → "Display name", `description` → "Description", `notes` → "Private notes", `icon` → "Icon",
       `accent` → "Accent color", `heapMb` → "Java heap", `containerMemoryMb` → "Container memory limit",
       `cpus` → "CPU limit", `updatePolicy` → "Update policy", `javaTag` → "Java version",
       `containerName` → "Container name", `networkName` → "Docker network", `diskQuotaGb` → "Disk quota",
       `autoStart` → "Start on panel boot", `autoRestart` → "Auto-restart on crash".
     - `tags` → label "Tags": `before`/`after` are the arrays (client renders additions/removals).
     - `extraPorts` → label "Extra port mappings", values presented as ordered summaries or counts; same for
       `extraBinds` → "Extra volume binds". (Keep it readable: "2 mappings changed" style is acceptable.)
     - env keys → `getField('env', key)?.label ?? key`; `MOTD` resolves via the catalog as noted above.
   - `requiresRebuild` = whether that key is in the recreate set: `mcVersion`, `javaTag`, `heapMb`,
     `containerMemoryMb`, `cpus`, plus the env/container/network/ports/binds blocks (all of which set
     `needsRecreate` in `computeServerDiff`).

### Step 2 — `src/web/routes/api.js`: hoist the PATCH schema and add the preview route

1. Hoist the PATCH zod schema (currently inline at `api.js:132-159`) into a shared `serverPatchSchema`
   constant module scope, and use it in the PATCH route. This is the single biggest touch and it is what
   prevents the two routes from drifting.
2. New additive route, next to the PATCH (`api.js:129-181`):

   `router.post('/servers/:id/changes-preview', asyncHandler(async (req, res, next) => { … }))`

   - Parse the body with the same `serverPatchSchema`.
   - Mirror PATCH auth exactly: `requireAdminForOverrides(req, changes)` (`:160`) and, when any of the four
     Docker override fields is present, the same `dockerSpec.validateOverrides` block (`:161-177`).
   - Call `servers.summarizeServerChanges(req.params.id, changes)`.
   - Respond `{ ok: true, changes, needsRecreate }`.
   - Any would-be rejection (zod 400, quota, `assertPinnedPackEnv` pin conflict) returns through the same error
     handler the PATCH uses, so the client's existing error-toast path handles it identically.
   - **Never mutates anything.** Viewers are automatically excluded: the route is a `POST`, so the method-based
     `requireWrite` middleware in `src/web/app.js` blocks them exactly like the PATCH.

Leave the `PATCH /servers/:id` route semantics 100% unchanged.

## 4.4 Client change — `public/js/pages/server-settings.js` (single file)

In the existing `#st-save` click handler (`server-settings.js:374-484`), insert the confirmation between
building `body` (line 459) and the current `setBusy`/`PATCH`/toast/reload block (`:460-483`):

1. Build `body` exactly as today (no change to collection logic).
2. `setBusy(saveBtn, 'Checking…')`, then `fetch('/api/servers/' + serverId + '/changes-preview',
{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })`.
   - On failure → existing `friendlyError` toast path (`:469`) and return. Same UX as a failed save today.
3. **No changes** (`changes.length === 0`) → short-circuit with `toast('No changes to save.')` and return.
   (Today an empty save still reports "Saved." — this replaces that noise. This branch is the agreed behavior.)
4. Otherwise open the modal with the shared `openModal` (`public/js/lib/modal.js`):
   - Heading (Title Case): **Save Changes**.
   - Body intro (sentence case): "Review the changes before they are saved."
   - One row per entry: `label` bold, then a mono `before → after` for scalar values; booleans printed as
     `On`/`Off`; tags as "Added: … / Removed: …"; long values (notes/description/env) wrap or truncate — do
     not blow the `max-w-lg` modal.
   - Build rows with DOM nodes + `escapeHtml` (`public/js/lib/format.js`) — **no innerHTML with untrusted
     values** (same discipline as `public/js/lib/confirm.js:34-41`).
   - When `needsRecreate`, append a `notice notice-warn` line: "Some of these changes need a container
     rebuild to take effect." (sentence case, ends with a period).
   - Actions: `Cancel` (kind `ghost`) and `Save Changes` (kind `primary`, `busyLabel: 'Saving…'`).
5. Confirm → run the **existing** PATCH + toast + reload block untouched (`:460-483`). Cancelling → nothing
   else happens (page stays exactly as edited; `dirty` state unchanged).

Follow house copy rules (`CLAUDE.md` → user-facing copy): Title Case modal title, sentence-case body lines,
no `" - "` dashes, straight quotes outside the field catalog, `…` only for in-progress actions.

## 4.5 Tests (all five CI gates must pass: lint, format, typecheck, build, test)

- **Unit — `summarizeServerChanges`/`computeServerDiff`** (extend `test/server-settings-advanced.test.js` or
  add `test/server-settings-diff.test.js`):
  - A mixed change set produces the expected labeled rows and `needsRecreate: true` (e.g. `heapMb` +
    `name`).
  - Cosmetic-only changes produce `needsRecreate: false`.
  - Empty/identical changes produce `changes: []`.
  - Per-key env expansion: changed env var, added env var, deleted env var each produce their own row with
    correct before/after; `MOTD` gets the catalog label.
  - A pack-pinning conflict still throws (same error the PATCH would produce).
  - **Regression guard:** `updateServer`'s approach — no `sets` → unchanged row returned; behavior identical
    to today (existing `test/servers-core.test.js` assertions must keep passing untouched).
- **Route — `POST /api/servers/:id/changes-preview`** (style of `test/server-settings-advanced.test.js`:
  `test/helpers/app.js` `start`/`req`/`adminCookie`/`seedServer`):
  - Returns `{ ok, changes, needsRecreate }` for a change set.
  - **Does not mutate the row** — assert the stored server is byte-identical before vs after the preview call.
  - Reviewer/admin allowed; viewer blocked (POST → `requireWrite`).
  - Docker-overrides present → the `validateOverrides` path runs (same 403/400 behavior as PATCH).

## 4.6 Verification

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

Manual smoke (worth noting in the PR): edit several fields incl. an env var + a tag, Save → modal lists every
change individually; a resource change shows the "rebuild" notice; no changes → "No changes to save." toast;
quick toggles elsewhere (players/world-controls) are unaffected.

## 4.7 Do-not list (explicit guardrails)

- Do not change `updateServer`'s persisted event-log diff shape.
- Do not add confirmation to any quick-toggle surface.
- Do not duplicate label maps on the client; labels come from the catalog via the preview endpoint.
- Do not reimplement the env-merge/blank-clears-key semantics in JS.

---

# 5. IMPLEMENTATION PLAN — Auto-create a missing Docker network

Date: 2026-09-19 · Handoff doc: another agent implements this end-to-end. All file/line anchors below were
verified against the current tree.

## 5.1 Goal and out-of-scope

**Goal.** When a server's configured Docker network does not exist on the host, the panel creates it
automatically (bridge driver) instead of rejecting it. The network field becomes free-text with autocomplete
(datalist), so a brand-new name can be typed directly in the wizard and the Settings tab.

**Out of scope — do NOT touch:** the default-bridge path (`networkName` unset — no network is ever created),
network **driver** selection (always `bridge`) , the Docker network discovery endpoint
(`GET /api/docker/networks`), `src/web/routes/mapProxy.js` (peer-container routing — unaffected by creation),
`src/blueprints/`, and `apiV1.js`.

## 5.2 Design decisions (agreed, do not reopen)

1. **Ensure happens at container attach, not validation.** `containers.createContainer()` is the single
   chokepoint every attach funnels through: fresh create (`src/services/servers.js:382`), recreate
   (`servers.js:592`), and the recreate orphan-retry (`servers.js:609`). A new `ensureNetwork()` call goes
   there, so all entry points (wizard, from-pack/from-mods/from-zip, blueprint import, Settings PATCH →
   recreate, image upgrade) get the behavior with no duplication at the service layer.
2. **`validateOverrides` stops erroring on a missing network** (`src/services/dockerSpec.js:85-88`) — that
   check is the reason the feature is unreachable today. It keeps a format guard instead (reuse the module's
   existing `NAME_RE`) so a bare typo can't create junk networks, and it rejects the reserved pseudo-networks
   `host` and `none` (see 5.3 schema note). This also makes networkName validation Docker-free and testable.
3. **Driver is fixed to `bridge`** — matches the "Default (bridge)" option and the reverse-proxy use case this
   originally shipped for (CHANGELOG 598-599). No driver picker.
4. **Concurrency is safe by construction.** In-panel creates are serialized by `createChain`
   (`servers.js:265-274`); recreates are per-server op-locked. The only cross-server race (two different
   servers naming the same new network) is covered by `CheckDuplicate: true` + swallowing Docker's 409
   "already exists" as success.
5. **No history/event entry for network creation.** It's infrastructure self-healing; a `logger.info` at the
   infra layer is enough (house style: state-change start/finish, ids not bodies).

## 5.3 Server changes

### Step 1 — `src/docker/networks.js`: add `ensureNetwork`

Append (and export) alongside the existing `listNetworks`/`networkExists`:

```js
async function ensureNetwork(name) {
  if (!name) return false;
  if (await networkExists(name)) return false;
  try {
    await getDocker().createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true });
    return true;
  } catch (err) {
    if (err.statusCode === 409) return false; // concurrent create won the race
    throw err;
  }
}
```

- `networkExists` already filters `HIDDEN_NETWORKS` (`none`, `host`), so a real next-to-default name like
  `bridge` correctly reports existing and is never re-created. `host`/`none` never reach `ensureNetwork`
  anyway once Step 3 rejects them.
- A non-409 failure (no permission, daemon down) must **abort** container creation — a declared network that
  can't be created must not silently drop the container onto the default bridge. Only 409 is treated as done.

### Step 2 — `src/docker/containers.js`: ensure before create

In `createContainer` (`containers.js:34-89`), before `docker.createContainer` (`:77`), replace the current
one-liner (`:75`):

```js
if (spec.networkName) {
  const created = await ensureNetwork(spec.networkName);
  if (created) logger.info('Created a Docker network.', { networkName: spec.networkName, serverId: spec.serverId });
}
```

- Add `const { ensureNetwork } = require('./networks');` at the top (no cycle: `networks.js` only requires
  `./connect`) and the standard module logger
  `const logger = require('../logger')(require('node:path').basename(__filename));`.
- Update the `@param {string} [spec.networkName]` JSDoc: "host Docker network to attach to; created if it does
  not exist; default bridge".

### Step 3 — `src/services/dockerSpec.js`: relax + harden networkName validation

- Remove the existence-probe block (`:85-88`, its `errors.push` for "does not exist") and replace with:

```js
if (networkName) {
  if (!NAME_RE.test(networkName)) {
    errors.push(
      `Docker network "${networkName}" is invalid - use letters, digits, "_", ".", "-", starting with a letter or digit, up to 63 characters.`
    );
  }
  if (HIDDEN_NETWORKS.has(networkName)) {
    errors.push(`Docker network "${networkName}" is reserved and cannot be attached or created.`);
  }
}
```

(`NAME_RE` already exists at `dockerSpec.js:53`. `HIDDEN_NETWORKS` is currently private in
`src/docker/networks.js:12` — export it: `module.exports = { listNetworks, networkExists, ensureNetwork, HIDDEN_NETWORKS };`.)

- **Keep** `const networks = require('../docker/networks');` (`:12`) — it is now used for `HIDDEN_NETWORKS`.
  Do not delete it as "unused".
- **Consistency:** tighten the shared zod cap to match: `dockerOverridesSchema.networkName` in
  `src/web/routes/dockerOverridesSchema.js:25` → `z.string().trim().max(63).optional()`. (128 and 63 disagreed
  before; validation now rejects >63 anyway, so make the schema agree.)
- Rationale for rejecting `host`/`none`: they are filtered out of `listNetworks` (they are not real attach
  targets), so `networkExists` reports them missing and `createNetwork('host'|'none')` fails with a
  409-shaped "already exists" that Step 1 would swallow as success — silently attaching the container to the
  host network. Rejecting them at validation closes that.

### Step 4 — verification of layers (nothing to change, confirm during review)

- `createServerImpl` (`servers.js:371-394`), `recreateServerImpl` (`:578-611`) need no edits — they already
  pass `networkName` into `createContainer`. The recreate orphan-retry (`:609`) gets the same ensure for free.
- `removeDataDir`/`chownDataDir` (`containers.js:379+`) create containers with `NetworkMode: 'none'` and pass
  no `networkName` — unaffected.

## 5.4 Client changes — network field becomes free-text with autocomplete

### Step 1 — Templates (2 files)

**`views/wizard.hbs:340-345`** and **`views/partials/server/settings.hbs:148-153`** — replace the `<select>`
(which the shared `select.js` would otherwise wrap into a picker that can never express a new name) with an
input + datalist. The datalist id is the input id + `-list`:

```html
<label class="label" for="wz-docker-network"
  >Docker network <span class="text-xs font-normal text-ink-faint">(optional)</span></label
>
<input
  class="input font-mono"
  id="wz-docker-network"
  list="wz-docker-networks"
  placeholder="Default (bridge)"
  autocomplete="off"
/>
<datalist id="wz-docker-networks"></datalist>
```

- Drop the `data-label="Docker network"` attribute (no longer enhanced — it was the picker title).
- Wizard help text (`wizard.hbs:344`, sentence case, ends with a period): "Attach to an existing Docker
  network, or type a new name and the panel will create it for you. Leave blank for the default bridge."
- Settings tab: same markup with `st-docker-network` / `st-docker-networks` ids; no help line currently exists
  there, none needed. The seeded `data-settings-docker-network` attribute (`settings.hbs:1`) is unchanged —
  `server-settings.js:24` reads it and `seed()` still sets `.value`.

### Step 2 — `public/js/lib/dockerSettings.js`

- `initDockerSettings` (`:20+`): after `networkSel` (`:22`), grab the datalist the same way
  (`const networkData = document.getElementById(ids.network + '-list');`) and populate **it** in the fetch
  (`:31-44`) instead of appending options to the select:
  ```js
  for (const net of data.networks) {
    const opt = document.createElement('option');
    opt.value = net.name;
    networkData.appendChild(opt);
  }
  ```
  Datalist suggestions show plain names (driver info is lost — native popup, accepted tradeoff; value = name
  is what must fill the input, which is why no `label` attribute is set).
- Remove the network-field enhancement calls now that it is an input: the `syncSelectTrigger(networkSel)` at
  `:42` and `:115`. (Selects elsewhere keep theirs: `:63`, `:81`.) `enhanceAll` in `select.js` only touches
  `<select>`s, so the input stays native by itself.
- `seed()` (`:110-125`) and `collectOverrides()` (`:134-145`) already read/write `.value` and need no change.
  An input also fixes a latent edge: a server whose network was deleted on the host now round-trips its name
  on save instead of the select silently offering "Default (bridge)".

## 5.5 Tests (run the full CI gate suite)

### New `test/networks.test.js` — stub `getDocker` before load (pattern: `test/docker-exec-deadline.test.js:12-23`)

```
require('./helpers/env');
require('../src/db/migrate').migrate();        // containers.js reads the servers table via db
const connect = require('../src/docker/connect');
let created = []; let list = []; let fail = null;
connect.getDocker = () => ({
  listNetworks: async () => list,
  createNetwork: async (spec) => { if (fail) throw fail; created.push(spec); },
  createContainer: async (spec) => ({ id: 'abc' }),
});
```

- `ensureNetwork` on a **missing** network → `createNetwork` called once with
  `{ Name, Driver: 'bridge', CheckDuplicate: true }`, resolves `true`.
- `ensureNetwork` on an **existing** network → `createNetwork` **not** called, resolves `false`.
- `createNetwork` throws a **409** (race) → resolves `false`, no throw.
- `createNetwork` throws another error → rejects with that error.
- **Integration:** `containers.createContainer({…, networkName: 'fresh-net'})` → `createNetwork` runs before
  `createContainer`, and the created container's `HostConfig.NetworkMode === 'fresh-net'`; with a pre-existing
  name in `list`, `createNetwork` is not called and `NetworkMode` is still set.

### Extend `test/dockerAdvanced.test.js`

- `validateOverrides({ networkName: 'fresh-net' })` does **not** reject (no Docker call after Step 3 — this
  was impossible to test hermetically before).
- `validateOverrides({ networkName: '../bad' })` rejects with the format error.
- `validateOverrides({ networkName: 'host' })` and `'none'` reject with the reserved-network error.

## 5.6 Verification

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

Manual smoke (worth noting in the PR): in the wizard type a brand-new network name → `docker network ls`
shows it after creation and the server comes up on it; in Settings, clear the field back to blank → recreates
onto the default bridge; set a network that was deleted on the host → recreate recreates it instead of
failing; the `GET /api/docker/networks` dropdown suggestions still list real networks.

## 5.7 Do-not list (explicit guardrails)

- Do not remove the `validateOverrides` network-format check entirely — the feature needs a sane-name guard.
- Do not create networks from `dockerSpec.validateOverrides` (a validate function must stay side-effect-free);
  ensure lives in `containers.createContainer`.
- Do not add a driver picker or per-network driver config surface.
- Do not let a network-creation failure (non-409) be swallowed — it must fail the create/recreate like any
  other Docker error.
- Do not delete the `networks` import in `dockerSpec.js`; the reserved-name guard now uses it.
- Do not add `label` attributes to datalist `<option>`s — that corrupts the value filled into the input.

---

# 6. IMPLEMENTATION PLAN — Visual design deep-dive: semantic tag vocabulary + mobile-first/consistency sweep

Date: 2026-09-19 · Handoff doc: another agent implements this end-to-end. All file/line anchors below were
re-verified against the current tree on top of the §1 visual findings (H-V1 / H-V2 / M-V1 / M-V2 / M-V3 and the
Low list); each step references the finding ID it resolves. Two review agents re-audited every template and every
client lib/page for this pass. Everything here is a class/helper swap — no behavior changes, no new features.

## 6.1 Goal and out-of-scope

**Goal.** Close the residual visual drift into one register:

1. **Tag/bubble vocabulary (the product change).** Event/activity _types_ render as the same semantic badge on
   **every** surface (dashboard, activity, server history, analytics timeline), and player _roles_ get semantic
   chip colorways — instead of neutral badges on four pages and a separate color map only inside `analytics.js`
   (finds: §1 "event-type tags in two vocabularies", H-V1).
2. **Fix the last real mobile-first gap:** the Analytics scoreboard, the only data table in the app that does not
   stack below `sm`.
3. **Token hygiene sweep.** Remove every remaining hand-rolled raw-palette colorway at call sites and point them at
   the fixed component classes (finds: H-V1, M-V1, M-V2, M-V3, and the §1 Low list).
4. **De-duplicate drift-prone literal class maps** with comments or helper reuse (dashboard status dots, `analytics.js`
   BADGE, `dashboard.js`/`analytics.js` full-literal maps).

**Out of scope — do NOT touch (documented, deliberate raw-palette exceptions):**

- Status-dot colors (`STATUS_DOT` / `{{statusDot}}`), meter fills (`bg-grass-500`, `bg-gold-500`, `bg-redstone-500`,
  `bg-diamond-400/500`, `bg-stone-500`), always-dark console/chat/MOTD/BlueMap-letterbox surfaces (`stone-*`,
  `text-gold-300`, `text-redstone-400`), the `bg-diamond-700` avatar identity chips (`topbar.hbs:33`,
  `settings.hbs:133`), and the setup/wizard progress-dot technique.
- `views/partials/brand-lockup.hbs:4` grass `#3fa62b` brand tile with bevel. It is the deliberate pixel-brand mark
  (grass-block motif), not a component; **keep as-is** — do not fold it into the semantic register.
- The `postJSON` / `postJson` / `post` / `api` fetch-wrapper consolidation into a shared `public/js/lib/request.js`
  (worlds.js:24-41, storage.js:76-85, backups.js, server-backups.js, mods.js:822-842, commands.js, players.js,
  player-detail.js, inventory.js). Separate refactor PR.
- Backend files: the **only** server-side change is the `eventBadge` helper added to `src/web/app.js`. No routes,
  services, or DB code change.
- Static-look parity on the dashboard "Servers by Status" strip: the dots are replaced with the `statusDot` helper
  **without** adding `pulse` (the dashboard currently renders static dots; keep them static — see 6.5.8).

## 6.2 Design decisions (agreed, do not reopen)

1. **Event-type tags have one source of truth:** a presentation-only `eventBadge` Handlebars helper in
   `src/web/app.js` (map in 6.4). Unmapped types fall back to the neutral badge (`''`). The `analytics.js` timeline
   `BADGE` map is **aligned** to it, not replaced with a new mechanism (the timeline is JS-rendered, so it keeps a
   client map that matches the helper value-for-value).
2. **New component classes** in `assets/css/input.css` only: `.chip-ok / .chip-warn / .chip-danger / .chip-info`
   (semantic chip colorways, mirroring the badge/notice variant construction exactly) and `.badge-note` (sentence-case
   badge modifier). No other new components; the existing "one colorway per component" contract is extended, not
   diluted.
3. **Player role chips become static variant classes** — `chip chip-ok` (whitelist) / `chip chip-info` (op) /
   `chip chip-danger` (ban) — in **both** the templates and the JS patch code; the `CHIP_ON` class-triple maps are
   deleted. **Do NOT add `aria-pressed` to these chips** (see 6.9): the role color _is_ the state (the label text also
   flips Whitelist/Banned/Op), and the `button.chip[aria-pressed='true']` pressed rule would override the per-role
   colorway with its universal grass treatment. The `:hover`/focus from `button.chip` still applies.
4. **State columns converge on the badge vocabulary** (worlds `active` is the reference,
   `views/partials/server/worlds.hbs:27-31`): enabled/healthy → `badge-ok`, missing/crash → `badge-danger`,
   warn-able → `badge-warn`, neutral → plain `badge`.
5. **Stat-strip captions unify on `.eyebrow`** (`input.css:625`, `text-[11px] uppercase tracking-wider text-ink-faint`,
   the metrics.hbs reference). Dashboard + combined-graphs captions change from sentence-case `text-xs` to all-caps
   eyebrows — accepted appearance change for cross-surface consistency.
6. **Empty-state reuse is limited to what the partial can express.** `{{> empty-state}}`
   (`views/partials/empty-state.hbs`) supports `iconName` `title` `message` `ctaHref`/`ctaId`+`ctaLabel` only.
   Convert only where safe; **keep** map.hbs disabled-state and inventory.hbs empty/loading (they carry
   `data-map-enable`/`data-server-id`/`id` hooks, a spinner, and a notice branch the partial cannot render).
7. **Full-literal class maps stay full-literal** (Tailwind scanner requirement, `src/web/app.js:45-48`) and get an
   explanatory comment where they lack one, so a future cleanup does not "simplify" them and break the build.

## 6.3 Step 1 — CSS: new component classes (`assets/css/input.css`)

### 6.3.1 Add `.chip-ok / -warn / -danger / -info` immediately after the `.chip` block (after line 519)

Borders mirror the `.notice-*` variants; tints mirror `.badge-*`/`.notice-*`. Pure tokens:

```css
/* Semantic chip colorways - state-shaped chips (roles, compatibility, status).
   Same construction as the notice/badge variants: never raw palette at call
   sites. These express a persistent state color; button.chip[aria-pressed]
   still expresses selection. */
.chip-ok {
  @apply border-ok/40 bg-grass-500/10 text-ok;
}
.chip-warn {
  @apply border-warn/40 bg-gold-500/10 text-warn;
}
.chip-danger {
  @apply border-danger/40 bg-redstone-500/10 text-danger;
}
.chip-info {
  @apply border-link/40 bg-diamond-500/10 text-link;
}
```

### 6.3.2 Add `.badge-note` after `.badge-info` (after line 514)

Collapses the repeated `font-normal normal-case tracking-normal` force-overrides in `catalog-field.hbs`
(6.5.12). A composable modifier: `badge badge-note badge-warn`:

```css
/* Sentence-case badge for note/caution chips in the settings catalog - the
   badge base uppercases; this is the only sanctioned way to keep it lowercase. */
.badge-note {
  @apply normal-case tracking-normal font-normal;
}
```

## 6.4 Step 2 — Server: `eventBadge` helper (`src/web/app.js`)

Add a module-scope map next to `STATUS_TEXT`/`STATUS_DOT` (after line 55) and register the helper in the
`helpers:` block (lines 134-191):

```js
// Presentation-only: semantic badge variant for an event/activity type in the
// history log. Unmapped types fall back to the neutral .badge (''). Mirror the
// client map in public/js/pages/analytics.js (BADGE) - keep the two in lockstep.
const EVENT_BADGE = {
  chat: 'badge-info',
  join: 'badge-ok',
  death: 'badge-danger',
  pvp: 'badge-danger',
  advancement: 'badge-warn',
  started: 'badge-ok',
  restarted: 'badge-ok',
  'backup-created': 'badge-ok',
  'backup-restored': 'badge-ok',
  crashed: 'badge-danger',
  killed: 'badge-danger',
  stopped: 'badge-warn',
};
```

```js
eventBadge: (t) => EVENT_BADGE[t] || '',
```

Constraints for the implementer:

- Key the map **only** on `type:` literals that `recordEvent({...})` actually emits (grep `type: '` under `src/`).
  The seeded core above is the verified set (watcher.js, servers.js, backups.js, routes/analytics.js); the analytics
  types come from `src/web/routes/analytics.js:19`. Anything absent stays neutral — a partial map is fine.
- The helper must be a pure function with no I/O: it runs per event row on the dashboard, activity page, and history
  tab (several hundred rows worst case). No settings/DB reads.
- Do not touch `analytics.hbs`'s filter chips — the `<label class="chip">…` rows stay as-is.

## 6.5 Step 3 — Template changes (file:line, old → new)

### 6.5.1 Event-type badges on the three server-rendered surfaces [core]

- `views/activity.hbs:25`:
  `<span class="badge shrink-0">{{type}}</span>` → `<span class="badge shrink-0 {{eventBadge type}}">{{type}}</span>`
- `views/dashboard.hbs:135`:
  `<span class="badge shrink-0">{{type}}</span>` → `<span class="badge shrink-0 {{eventBadge type}}">{{type}}</span>`
- `views/partials/server/history.hbs:54`:
  `<span class="badge">{{type}}</span>` → `<span class="badge {{eventBadge type}}">{{type}}</span>`
- `views/updates.hbs:27` (`{{kind}}`): **leave neutral** — `kind` is a noun label (update source), not a state.

### 6.5.2 Analytics scoreboard: stack below `sm` — the last non-stacking table

- `views/partials/server/analytics.hbs:26-29`:
  - `<table class="table-base">` → `<table class="table-base table-stack">`
  - Give each `<th>` a `data-th` so `.table-stack` uses Column → label:
    `<th class="w-10">#</th>` → `<th class="w-10" data-th="#">#</th>`,
    `<th>Player</th>` → `<th data-th="Player">Player</th>`,
    `<th class="text-right">Value</th>` → `<th class="text-right" data-th="Value">Value</th>`
  - The loading row at `:29` keeps `colspan="3"` (it is a tbody scaffold; the `empty-state` partial is a card and
    cannot live inside a `<tr>` — leave it).
- `public/js/pages/analytics.js:105-108` (JS-built rows) add the same `data-th` attributes so labels survive the
  collapse (mirror `investigation.js:35-46`):
  - `<td class="text-ink-faint">${row.rank}</td>` → `<td data-th="#" class="text-ink-faint">${row.rank}</td>`
  - `<td><span class="inline-flex items-center gap-1.5">…</span></td>` → `<td data-th="Player">…</td>`
  - `<td class="text-right" data-value></td>` → `<td data-th="Value" class="text-right" data-value></td>`

### 6.5.3 Player role chips → semantic variants [H-V1]

Both templates drop the raw triples for the new variants inside the same `{{#if …}}`:

- `views/partials/server/players.hbs:81,86,91`:
  - `class="chip {{#if whitelisted}}border-grass-700 bg-grass-500/15 text-ok{{/if}}"` → `class="chip {{#if whitelisted}}chip-ok{{/if}}"`
  - `class="chip {{#if op}}border-diamond-700 bg-diamond-400/15 text-link{{/if}}"` → `class="chip {{#if op}}chip-info{{/if}}"`
  - `class="chip {{#if banned}}border-danger/40 bg-redstone-500/15 text-danger{{/if}}"` → `class="chip {{#if banned}}chip-danger{{/if}}"`
- `views/partials/server/player-detail.hbs:27,30,33`: identical substitution with the `player.*` guards.

Off-state stays a plain `.chip` at full opacity (matches the file's own comment at players.hbs:77-78).
The JS patch code is handled in 6.6.1.

### 6.5.4 Tag upgrades where plain text should be a chip/badge [core]

- **Dimensions** — `views/partials/server/worlds.hbs:21`:
  `<td data-th="Dimensions" class="text-xs text-ink-faint">{{#each dims}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}</td>`
  →
  `<td data-th="Dimensions"><div class="flex flex-wrap gap-1.5">{{#each dims}}<span class="chip">{{this}}</span>{{/each}}</div></td>`
  (matches the global Worlds page chip treatment; closes the "Dim text vs compatibility chip" split).
- **Library metadata** — `views/partials/server/worlds.hbs:67`:
  `<div class="text-xs text-ink-faint">{{source}}{{#if flavor}} · {{flavor}}{{/if}}{{#if mcVersion}} {{mcVersion}}{{/if}} · <span data-ts="{{created}}">{{created}}</span></div>`
  →
  `<div class="flex flex-wrap items-center gap-1.5 text-xs"><span class="chip">{{source}}</span>{{#if flavor}}{{#if mcVersion}}<span class="chip">{{flavor}} {{mcVersion}}</span>{{/if}}{{/if}}<span class="text-ink-faint">· <span data-ts="{{created}}">{{created}}</span></span></div>`
- **Mod status column** — `views/partials/server/mods.hbs:74-80` (currently bare `text-xs font-medium text-*`):
  - Missing → `<span class="badge badge-danger" data-tip="File missing on disk. Reinstall it from the library.">Missing</span>`
  - Enabled → `<span class="badge badge-ok">Enabled</span>`
  - Disabled → `<span class="badge">Disabled</span>`
    Also `mods.hbs:70`: `class="badge ml-1 text-ink-faint"` → `class="badge ml-1"` (the sibling update badge at
    `:69` keeps the default `text-ink-soft`; drop the override that made two adjacent badges differ).
- **"Experimental"** — `views/partials/server/integrations.hbs:101`:
  `<h4 class="font-semibold">Chatbot powers <span class="text-xs font-normal text-warn">Experimental</span></h4>` →
  `<h4 class="font-semibold">Chatbot powers <span class="badge badge-warn">Experimental</span></h4>`
- **Transcript speaker** — `views/wizard-transcripts.hbs:11`:
  `<span>·</span><span>{{speaker}}</span>` → `<span>{{#if speaker}}<span class="chip">{{speaker}}</span>{{/if}}</span>`
  and `views/wizard-transcripts.hbs:19` (the bare `<div class="p-10 text-center text-sm text-ink-faint">…</div>`
  empty state) → `{{> empty-state iconName='bot' title='No Transcripts Being Kept' message='Set a retention policy on a server's Chatbot tab to start recording conversations.'}}`
- **Optional (drop-in, not required): container health** — `views/partials/server/metrics.hbs:84`. Key the dd to the
  health value only with explicit keys, e.g. add `badge-ok` for `healthy` and `badge-danger` for `unhealthy`, keep
  the plain muted `dd` for everything else. Aggressively optional — plain text is defensible.

### 6.5.5 Integration sub-cards: one nested-panel recipe + icon/divider tokens

`views/partials/server/integrations.hbs` (all verified against the current file):

- **Remove the inert `lg:col-span-2`** at lines 5, 150, 157, 200, 229. The parent is `div.space-y-4` (L1), not a
  grid — the class does nothing (leftover from an earlier grid layout).
- **Unify the nested inset panels** on `rounded-md border border-line bg-inset` + `p-4` for section boxes; the
  dense list/collapse rows keep `p-3` but switch surface to bg-inset:
- chatbot outreach `:62`, powers `:98`: currently `bg-inset p-4`; keep the `p-4`, they are section boxes.
  - transcript/audit lists `:146-147`: already `bg-inset p-3` — unchanged.
  - invites "What friends need" `:259`, `:270` and the port-forwarding `<details>` `:278`: `bg-raised` → `bg-inset`.
    This is the drift the deep-dive flagged — two surfaces for the same "nested info panel" concept in one file.
- **Header icons** `:8` (text-link), `:159` (text-link), `:202` (text-ok), `:230` (text-warn): the icon is decorative
  identity per sub-card, not a status signal — align all four to `text-link` (`:202` globe and `:230` send switch).
  If you judge the status-page globe and invites send as meaningful, leave them; the plan's default is `text-link`
  everywhere for a consistent header register.

### 6.5.6 Stat-strip captions → `.eyebrow` (decision 5)

Replace only the caption line above the big number in each stat card; keep the secondary `text-xs text-ink-faint`
sub-lines as-is:

- `views/dashboard.hbs:5,10,14,18` (first strip) and `:28,34,40,46` (second strip):
  `<div class="text-xs text-ink-faint">…</div>` → `<div class="eyebrow">…</div>` (icon-first rows like
  `{{{icon 'memory-stick' 'size-3.5'}}} Memory allotted` keep their icon inside the eyebrow line).
- `views/partials/combined-graphs.hbs:4,9,14,19`: same substitution (labels "Total memory", "Total CPU",
  "Players online", "Running").
- `views/partials/server/metrics.hbs:17,25,29,33,46,51` already use `.eyebrow` — the reference, unchanged.

### 6.5.7 Dashboard "Servers by Status" strip → `statusDot` helper [Low: literal map at dashboard.hbs:57-63]

`views/dashboard.hbs:57-63` hardcodes the dot classes a second time (the `src/web/app.js:49-55` `STATUS_DOT` map is
already exposed through the `statusDot` helper at `app.js:152`). Replace each hardcoded `bg-*` with the helper keyed
on the verbatim status string — output is byte-identical, and the drift source dies:

```hbs
<span class='status-dot bg-grass-500'></span>
→
<span class='status-dot {{statusDot "running"}}'></span>
<span class='status-dot bg-gold-500'></span>
→
<span class='status-dot {{statusDot "starting"}}'></span>
(unhealthy too)
<span class='status-dot bg-redstone-500'></span>
→
<span class='status-dot {{statusDot "stalled"}}'></span>
(crashed too)
<span class='status-dot bg-diamond-500'></span>
→
<span class='status-dot {{statusDot "updating"}}'></span>
<span class='status-dot bg-stone-500'></span>
→
<span class='status-dot {{statusDot "stopped"}}'></span>
```

Do **not** add `{{statusPulse …}}` here — the strip is currently static; keep the look byte-for-byte identical
except for the helper substitution. (If you judge pulsing Starting/Updating worth it, that is a separate appearance
decision — flag it in the PR, don't bundle it silently.)

Also `views/dashboard.hbs:134` (from the §1 Low list): a row hover `hover:border-grass-600` mixed next to
`hover:text-ok` → `hover:border-ok`.

### 6.5.8 Tab/underline + icon-upload nits (from the §1 Low list — corrected against the source)

- `views/partials/server/chrome.hbs:59-61`: the top nav active state is
  `border-b-2 {{#if active}}border-grass-500 text-ink{{else}}border-transparent text-ink-faint hover:text-ink{{/if}}`.
  Keep the underline affordance (it is a top tab bar, **not** a `.subtab` pill — do NOT convert it to `.subtab`,
  that would change the whole chrome); swap the raw underline to the token:
  `border-grass-500` → `border-ok` (nothing else about the element changes).
- `views/partials/server/settings.hbs:40` (icon-upload button): `hover:border-stone-500` → `hover:border-line-strong`
  (matches every other hover affordance; `.swatch:hover` uses `--color-stone-500` inside the CSS layer, which is fine
  there).

### 6.5.9 `storage.hbs` mobile labels + category meter [H-V2 (labels), Low (meter)]

The three stacked tables carry `data-th=""` on every cell, so below `sm` `.table-stack` renders label-less cards
(`views/storage.hbs:50-62` By Category, `:82-96` Quota Status, `:104-109` Largest Files). Give each cell a real
`data-th` (no `<thead>` needed — `data-th` drives the label):

- **By Category** `:54-57`: `data-th="Category"` (first cell), `data-th="Size"` (meter cell), `data-th="Total"` or
  `data-th="Bytes"` (bytes cell — keep it distinct from the meter label), `data-th=""` (folder-open action: give it
  `data-th="Open"`, it collapses into a labeled action row instead of a naked icon card).
- **Quota Status** `:86-88`: `data-th="Server"`, `data-th="Disk"` (meter), `data-th="Used"` (bytes), and the
  empty-state row `:91` can keep `data-th=""` (it is a single full-width message; harmless).
- **Largest Files** `:108-110`: `data-th="Path"`, `data-th="Size"`, `data-th="Open"`.
- **Category meter** `:55` `<div class="bg-diamond-400" style="width: {{pct size ../storage.totalUsed}}%"></div>`:
  `bg-diamond-400` → `{{meterColor size ../storage.totalUsed}}` (routes through the configured warn/critical
  thresholds like the headline bar `:18` and the quota meters do — a category dominating the data folder now reads
  gold/red instead of staying decoratively diamond).
- `views/storage.hbs:56,109` remain `text-ink-faint` byte counts; no other change.

### 6.5.10 Divider + empty-state nits

- Vertical divider token: `views/partials/server/chat.hbs:50` uses `bg-line-strong`, `views/partials/server/map.hbs:11`
  uses `bg-line`. Pick `bg-line` for both (line-strong is reserved for hover/focus emphasis).
- **Leave map.hbs:29-45 and inventory.hbs:32-41 as-is** (decision 6): map's disabled-state CTA needs
  `data-map-enable` + `data-server-id` and has an unsupported-branch `notice`, inventory's `#inv-empty`/`#inv-loading`
  are `id` targets that `inventory.js` swaps in (the loading one carries a spinner). Converting them to the
  `empty-state` partial would either lose those hooks or need partial extensions. They are cosmetically aligned with
  the partial already (icon tile + h3 + faint paragraph + centered). Document in the PR, do not convert.
- `views/partials/server/inventory.hbs:6` picker `<div class="w-72 max-w-full…">`: change to
  `w-full sm:w-72 sm:max-w-xs` so the Player picker takes the full line on a phone instead of squeezing the
  action-row buttons into an awkward wrap (no overflow today — this is polish, `:14-22` `ml-auto` keeps the actions
  right-aligned at `sm+`).

### 6.5.11 `truncate` on an inline span (from §1 Low list)

`views/partials/server/metrics.hbs:112` — `<span class="truncate">{{summary}}</span>` sits inside a `min-w-0`
flex parent but is itself inline, so `truncate` is a no-op. Make it `block truncate` (the parent already min-w-0s).

### 6.5.12 `catalog-field.hbs` note badges → `.badge-note` [6.3.2]

`views/partials/catalog-field.hbs:13-14` and `:29-30` currently repeat `badge badge-warn font-normal normal-case
tracking-normal` / `badge badge-danger font-normal normal-case tracking-normal`. Replace the overrides with the
modifier:

- `<span class="badge badge-warn font-normal normal-case tracking-normal">{{note}}</span>` → `<span class="badge badge-note badge-warn">{{note}}</span>`
- `<span class="badge badge-danger font-normal normal-case tracking-normal">Caution</span>` → `<span class="badge badge-note badge-danger">Caution</span>`

### 6.5.13 `views/partials/server/analytics.hbs:65` (minor)

The investigation-card description `<span class="text-xs text-ink-faint">…</span>` sits between the h3 and the
button with no `flex-1`, so it wraps awkwardly under the h3 on narrow widths. Add `flex-1` (keeps the button on the
right of the header row on desktop, allows the text to take the gutter).

## 6.6 Step 4 — Client JS changes (file:line, old → new)

### 6.6.1 Role-chip patch code → variant classes [H-V1]

Both files keep their toggle mechanism (class add/remove on the chip) but swap the raw triples for the single
variant class and stop carrying the arrays:

- `public/js/pages/players.js:66-70` and `public/js/pages/player-detail.js:58-62`:
  ```js
  const CHIP_ON = {
    whitelist: ['border-grass-700', 'bg-grass-500/15', 'text-ok'],
    op: ['border-diamond-700', 'bg-diamond-400/15', 'text-link'],
    ban: ['border-danger/40', 'bg-redstone-500/15', 'text-danger'],
  };
  ```
  →
  ```js
  const CHIP_ON = { whitelist: 'chip-ok', op: 'chip-info', ban: 'chip-danger' };
  ```
- The two call sites (players.js:128-129, player-detail.js:67-68):
  ```js
  chip.classList.remove(...Object.values(CHIP_ON).flat());
  if (on) chip.classList.add(...CHIP_ON[role]);
  ```
  →
  ```js
  chip.classList.remove('chip-ok', 'chip-info', 'chip-danger');
  if (on) chip.classList.add(CHIP_ON[role]);
  ```
  (`Object.values(CHIP_ON).flat()` over the new scalar map flatly removes `chip-ok`/etc. too — either form is fine;
  the literal list is clearer. Do **not** touch `aria-pressed` — see 6.9.)
- `public/js/pages/players.js:96`: the Whitelisted status dot uses `bg-grass-700` (odd step, mismatches every other
  grass dot) → `bg-grass-500` [M-V1].

### 6.6.2 Chat format toggles → `button.chip` pressed contract [M-V2]

`public/js/pages/chat.js:35-38` — `STYLE_BTN_CLASS` hand-rolls a pressed state with raw `aria-pressed:` classes.
The `button.chip[aria-pressed='true']` rule (input.css:584-586) already owns that. Replace the constant and keep the
existing `aria-pressed` toggling (chat.js:76,186,212 all unchanged):

```js
// chip base + a square 28px cell; pressed/selection lives in aria-pressed
// (button.chip[aria-pressed='true'] in input.css owns the grass state).
const STYLE_BTN_CLASS = 'chip size-7 justify-center rounded-sm px-0 text-xs transition';
```

The `.chip` base already supplies `border border-line bg-inset text-ink-soft`, and `button.chip` supplies hover,
focus outline, and the disabled treatment the old string carried manually.

### 6.6.3 Enhanced-select selected row → semantic tint [M-V2]

`public/js/lib/select.js:110` — `aria-selected:bg-grass-600/15 text-ok` → `aria-selected:bg-ok/15 text-ok`
(`ok` is a theme token; same visual family, no raw step at the call site).

### 6.6.4 Headroom live box → `notice` component (three states)

`public/js/pages/server-settings.js:186-196` builds the headroom hint by hand from
`border-danger/40 bg-redstone-500/10 text-danger` / `border-warn/40 bg-gold-500/10 text-warn` /
`border-ok/40 bg-grass-500/10 text-ok` — character-for-character the `.notice-danger/-warn/-ok` marker classes.
Replace with:

```js
const HEADROOM = {
  danger: 'notice notice-danger',
  warn: 'notice notice-warn',
  ok: 'notice notice-ok',
};
```

…and use `HEADROOM[level]` at `:186-196`; keep the current `hidden`/text-content logic, only the className
construction changes. (`notice` adds `flex items-start gap-2 px-3 py-2` — if the box's current paddings matter,
verify by eye at 375px; small layout shift is acceptable.)

### 6.6.5 Gold warning callouts → `notice notice-warn` (two files, identical strings)

- `public/js/pages/inventory.js:518`: `rounded-md border border-gold-500/40 bg-gold-400/5 p-2.5 text-xs text-warn`
  → `notice notice-warn text-xs` (drop the hand-rolled border/bg; keep size/content).
- `public/js/pages/blueprints.js:102`: `rounded-md border border-gold-400/40 bg-gold-400/10 p-2.5 text-xs` →
  `notice notice-warn text-xs`.
- Also dedup the repeated inventory info-card string `rounded-md border border-line bg-inset/50 p-3` (inventory.js
  :271, :385, :843, :884) into a module-scope `const INFO_CARD = 'rounded-md border border-line bg-inset/50 p-3';`
  referenced at all four sites (worlds-tab.js:242 uses `/40` for a different nuance — leave that one).

### 6.6.6 Inventory slot-state colors → semantic tokens

`public/js/pages/inventory.js:140-144`:

- `border-gold-500 bg-gold-400/10 text-warn` → `border-warn/40 bg-warn/10 text-warn`
- `border-diamond-700 bg-diamond-400/10 text-link` → `border-link/40 bg-link/10 text-link`
  (`border-diamond-700` is the light-theme `link` value; the raw step instead of the token defeats theming.)
- `:160` nested-contents marker `bg-grass-400` → `bg-ok` (400-step is outside the documented status-dot picture;
  `ok` is the token and reads as "has contents").

### 6.6.7 Wizard cleanups [M-V3 + Low dead-arg + chip reuse]

- `public/js/pages/wizard.js:1050` selected-modpack box `rounded-md border border-grass-700 bg-grass-600/10 p-3` →
  `notice notice-ok` (keep the icon + text nodes it currently wraps).
- `public/js/pages/wizard.js:1539-1544` solver "picked mod" chips hand-roll the chip component
  (`inline-flex items-center gap-1.5 rounded-md border border-line bg-inset py-1 pl-1.5 pr-1 text-xs`) → the `.chip`
  class (drop the layout re-declaration; keep the conditional variant class if the picked state needs one).
- `public/js/pages/wizard.js:658` — dead 4th argument `['border-grass-500', 'text-ok']` to the 3-arg `pickGroup()`
  (signature at `:1703`): delete the extra arg (the tiles style via `.tile[aria-pressed='true']` CSS already).

### 6.6.8 Task-tray live count → `bg-ok`

`public/js/lib/taskTray.js:61-65` toggles `bg-grass-600` + `text-white` / `bg-inset` on the running-count badge →
`bg-ok` + `text-white` / `bg-inset` (semantic token, same solid-fill look).

### 6.6.9 MOTD preset row hover → `hover:border-line-strong`

`public/js/lib/motd.js:209` — `console … hover:border-grass-600` on the selectable preset rows. The console
stone-surface exception does not cover border accents; `hover:border-grass-600` → `hover:border-line-strong` (the
universal hover affordance).

### 6.6.10 `analytics.js` BADGE alignment + dedupe [decision 1]

- `public/js/pages/analytics.js:13-21`: `command: 'bg-inset text-ink-soft'` → `command: ''` — that is the `.badge`
  default verbatim, so the entry and the fallback were dead duplication. `leave` already `''`.
- `:157` `badge.className = 'badge shrink-0 ' + (BADGE[evt.type] || 'bg-inset text-ink-soft')` →
  `(BADGE[evt.type] || '')`.
- `:170` the pvp chip hardcodes `'badge badge-danger ml-1.5'` → `'badge ml-1.5 ' + (BADGE.pvp || '')`.
- Keep the resolved key→variant values matching the server `EVENT_BADGE` map (6.4) for the shared types
  (chat/join/death/pvp/advancement); the two maps now agree for every key they both hold.
- Add the scanner-literal comment above `BADGE` (the whole map must stay full literals — see 6.2 point 7).

### 6.6.11 Scanner-literal map comments (from §1 Low list — future-cleanup guard)

Add the explanatory "keep verbatim, Tailwind scanner" comment above the existing full-literal maps that lack one:
`public/js/pages/dashboard.js:225-236`, `public/js/pages/analytics.js:276-279`. Do not restyle their contents;
`src/web/routes/index.js:598-619` already carries an equivalent comment pattern to copy.

## 6.7 Step 5 — Tests

Run with the existing harness; nothing here needs a test fixture unless a regression surfaces:

- `pnpm run lint` — the new `EVENT_BADGE`/`eventBadge` and the JS class-string changes must be clean (errors only).
- `pnpm run typecheck` — `EVENT_BADGE` is a plain `Record<string, string>`-shaped object literal; the helper
  `(t) => EVENT_BADGE[t] || ''` may need a `/** @type {Record<string, string>} */` or a fallback key access that
  survives `tsc --checkJs` (`EVENT_BADGE[t] ?? ''` on a `Record<string, string | undefined>`). Declare the map with
  `/** @type {Record<string, string>} */` if strict mode complains.
- `pnpm test` — full node:test suite green; the helper is not covered by unit tests (pure presentation), so a
  regression test is optional. If you add one, put it in `test/` with the other helper tests and keep it tiny.
- `pnpm run build` — the esbuild client bundling must succeed (any class-string splice that broke a template
  literal surfaces here).

## 6.8 Step 6 — Verify (browser sweep)

Boot `pnpm run dev` (or `pnpm start` + `pnpm run build:css` for the CSS) against a live server and eyeball:

1. **Event badges render on all three surfaces** — Dashboard recent activity, Activity page, and a server's History
   tab: started/stopped/crashed/chats now carry their semantic color; unknown types still show a neutral badge.
2. **Player role chips** — flip a whitelist/ban from the Players page and from a player detail page: the chip color
   tracks the role, and the chip is still pressable-readable (`hover`, focus outline) without blowing out to grass.
3. **Analytics scoreboard** — narrow below 416px: rows collapse into `# / Player / Value` cards; JS-built rows show
   the same labels; the page never overflows horizontally. At `sm+` the table looks unchanged.
4. **`.eyebrow` stat captions** on the dashboard and the overview graphs read as small caps and fit one line at
   375px.
5. **Scroll the whole sweep**: dashboard status strip, worlds dims/library chips, mods status badges, integrations
   sub-cards (all `bg-inset` now + icons `text-link`), storage (labels + category meter), wizard transcript speaker
   chip + `empty-state` reuse, chatbot Experimental badge, inventory picker full-width on a phone, chat format
   toggles, task-tray count, headroom/MOTD/inventory/blueprint notices.
6. **Both themes**: toggle `<html data-theme="light">` and re-check the chip/badge variant colors and the
   `border-link/40`/`bg-ok/15` token swaps (the reason we use tokens, not `diamond-700`/`grass-600` steps).
7. **Reduced motion** (`prefers-reduced-motion`) on the status dots: nothing blinks or pulses beyond the existing
   breathing states.

## 6.9 Do-not list (absolute constraints when implementing)

1. **No new raw palette at call sites.** Every color change routes through `ok / warn / danger / link / ink* / line*`
   tokens or the documented full-literal component classes. If a swap reads visually off, tune the component class
   inside `assets/css/input.css`, never the call site.
2. **Do NOT style the `--color-stone-500` swatch row** (`settings.hbs:133`) or the `bg-diamond-700` avatar chips
   (topbar/settings). They are palette-canvas controls, not register violations.
3. **Do NOT add `aria-pressed` to the role chips** (players/player-detail). The role color _is_ the state; the
   `button.chip[aria-pressed='true']` pressed rule would paint over the per-role variant with the universal grass
   state and make every banned op look selected. Toggle the label text (as today) and the variant class only.
4. **Do NOT convert `chrome.hbs:59-61` to `.subtab`** — it is a top tab underline, not a pill toggle. Only the
   `border-grass-500` → `border-ok` swap.
5. **Do NOT touch `STATUS_DOT`/`statusDot`/`statusPulse` colors**, the meter fill colors (`.meter`/`bg-ok`-family
   filled-by-value), the console/chat/MOTD letterbox `stone-*` surfaces, or `analytics.hbs`'s filter chips. All are
   documented exceptions; the fulfillers are already semantic.
6. **Do NOT convert map.hbs:29-45 or inventory.hbs:32-41 to `empty-state`** (hooks the partial can't carry) and do
   **NOT** expand the `empty-state` partial for them.
7. **Do NOT generalize/fetch-wrap the form submission helpers** (`postJSON` et al.) — separate refactor PR.
8. **Do NOT restyle `updates.hbs:27`** (`{{kind}}` badge stays neutral).
9. **Do NOT rewrite any full-literal Tailwind class maps into dynamic strings** — comments only (6.6.11).
10. **Do NOT add third-party deps or new components beyond the four `.chip-*` variants + `.badge-note`.**
11. **UI copy house rules apply** to any new string: sentence case, ending period, no " - ", proper nouns
    capitalized (CONTRIBUTING.md § copy).

## 6.10 Suggested PR sequence (small commits, each independently reviewable)

1. `feat: add eventBadge helper + semantic chip/badge-note classes` — 6.3 + 6.4 (CSS + server; no visible change yet).
2. `feat: colorize event-type badges across dashboard/activity/history` — 6.5.1, 6.5.4 (badge-related row), 6.6.10.
3. `feat: semantic player-role chips` — 6.5.3 + 6.6.1.
4. `fix(ui): stack the analytics scoreboard below 416px` — 6.5.2.
5. `fix(ui): eyebrow captions + statusDot helper swap` — 6.5.6, 6.5.7.
6. `refactor(ui): component/token hygiene` — the remaining 6.5.x template items and 6.6.2-6.6.11, grouped by file so
   each commit is a single-surface change.
7. Verify: `pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test && pnpm run build` then the
   6.8 browser sweep.

---

# 7. IMPLEMENTATION PLAN — Copy conventions deep-dive

Date: 2026-09-19 · Handoff doc: another agent implements this end-to-end. A read-only audit swept every user-facing
string in the panel against the copy conventions in `CONTRIBUTING.md` ("User-facing copy", lines 122-163) and in
`CLAUDE.md` ("User-facing copy"). All file:line anchors were verified at audit time and are itemized below. This
plan only changes text strings (and any unit test that asserts them) — no behavior, no layout, no CSS.

## 7.1 Scope

Audited surfaces (everything a person reads):

1. **Templates** — every `.hbs` under `views/` (root, `partials/`, `partials/server/`).
2. **Client JS** — every `.js` under `public/js/pages/` and `public/js/lib/`: `openModal`/`confirmDialog`/`toast`
   strings, `runTask` titles, `task.step`-style labels, `data-tip`/`title` tooltip copy, JS-built labels and th.
3. **Server** — `recordEvent({ summary })` histories, `httpError(...)` messages, server-pushed progress/step
   labels, zod/schema messages that reach the client, JSON error bodies, `src/config/field-catalog/*` labels/help.
4. **Docs** — every `docs/*.md`, plus `README.md` and `CHANGELOG.md`. (`CONTRIBUTING.md`, `CLAUDE.md`,
   `REVIEW-FINDINGS.md` are process/meta files — excluded.)
5. Verified before the pass in **7.6**: field-catalog copy (correct), the `jsonErrorHandler` friendly mapping,
   `friendlyError()` in `public/js/lib/errors.js`, every table `<th>`, placeholder, `aria-label`, and
   `page-header heading=`.

## 7.2 The author's rulings (folded into the itemized fixes — do not reopen)

1. **Docs + README + CHANGELOG are in scope.** Their mechanics are already clean (zero `–`/`—`, zero curly
   apostrophes in `docs/**` and `README.md` — verified by grep); the remaining work is a prose pass (7.5).
2. **Toggle/checkbox labels: Title Case for short labels, sentence case for descriptive ones.**
   The convention names "radio and checkbox labels" as Title Case short choices. The repo deliberately writes
   descriptive toggles as sentences. Resolution: a short label (a noun/adjective/verb phrase, up to ~5 words) is
   Title Case; a label that reads as an instruction or sentence stays sentence case. The items that CHANGE are
   listed in 7.3.B; the items that are KEPT sentence case are listed in 7.3.C so a later reviewer does not
   flip-flop.
3. **All info/affordance tooltips become full punctuated sentences.** Every `data-tip=` string and client-side
   tooltip copy gets a terminal period (terse imperative fragments are reworded into sentences, e.g. "Download the
   archive."). Exceptions that stay short labels: swatch color names ("Grass", "Diamond", …), status captions
   ("Update available"), and pure pagination captions.
4. **Raw RCON/server/err output is stripped from user-facing errors** and replaced with friendly text ("Check the
   console for details."). The one exception the author accepts: deliberate manifest-summary passthrough inside
   contentZip/CurseForge flow messages (7.4.I "kept").

## 7.3 Step 1 — Templates + client JS fixes (file:line, old → new)

### 7.3.A Curly apostrophes → straight (rule 6)

- `views/setup.hbs:61` — "printed to the panel's console/log" (was `panel’s`).
- `public/js/pages/settings.js:109` — "Outside apps can now read your servers' status." (was `servers’`).
- `public/js/pages/settings.js:110` — "Outside apps can no longer read your servers' status." (was `servers’`).
- `public/js/pages/settings.js:211` — "You'll only see this key once, so copy it somewhere safe now. …" (was
  `You’ll`; scan the whole paragraph for any other curly apostrophes).
- `public/js/pages/settings.js:272` — "…You can't bring the same key back, so you'd need to make a new one." (was
  `can’t` / `you’d`).

### 7.3.B Title Case fixes (rule 1) — strings that CHANGE

Templates:

- `views/setup.hbs:118` — h2 "You're all set!" → "You're All Set!"
- `views/login.hbs:18` — "Remember me" → "Remember Me"
- `views/partials/server/players.hbs:7` — "All players" → "All Players" (matches "All servers"/"All types").
- `views/partials/server/players.hbs:16` — "Whitelist enforced" → "Whitelist Enforced"
- `views/wizard.hbs:144` — "Include beta releases" → "Include Beta Releases"

Client JS:

- `public/js/pages/inventory.js:298` "Change count" → "Change Count"; `:299` "Replace item" → "Replace Item";
  `:300` "Move to another slot" → "Move to Another Slot"; `:394` "Replace item" / "Put item here" →
  "Replace Item" / "Put Item Here".
- `public/js/pages/players.js:352` "Add to whitelist" → "Add to Whitelist"; `:353` "Make operator (level 4)" →
  "Make Operator (Level 4)"; `:616` "To player" → "To Player"; `:676` "Surprise me (random one, not nearest)" →
  "Surprise Me (Random One, Not Nearest)".
- `public/js/pages/commands.js:161` — same "Surprise me …" string as players.js:676; apply the same Title Case.
- `public/js/pages/player-detail.js:359` — "To player" → "To Player".
- `public/js/lib/select.js:49` **and** `:179` — fallback "Select an option" → "Select an Option".

Casing inconsistencies (rule 1 / house consistency):

- `src/services/servers.js:521` vs `:523` — same feature spelled "Try Force stop" in one place and "Try Force
  Stop" in the other. Pick Title Case: "Try Force Stop" everywhere.
- Loader names rendered as raw lowercase in option text — capitalise through proper-noun casing (rule 6), not the
  generic lowercase branch:
  - `public/js/pages/wizard.js:1136` — `` `${l === 'paper' ? 'Paper (plugins)' : l}` `` renders `fabric`/`forge`/
    `neoforge`/`quilt` verbatim. Map them: Fabric, Forge, NeoForge, Quilt.
  - `public/js/pages/mods.js:470` — the same mapping in the mod-library filter; align with the wizard map.

### 7.3.C Toggle/checkbox labels KEPT sentence case (ruling 2 — do not "fix")

These are descriptive toggles, deliberately sentence case. Leave them:

- `views/partials/server/integrations.hbs:42` "Remove stored key on save", `:68` "Greet players on join", `:104`
  "Enable powers" (all three were flagged short-list candidates; ruling keeps them sentence case).
- `views/partials/server/backups.hbs:10` "Also shrink the world afterwards."
- `views/partials/server/integrations.hbs:123` "Dry run (audit only; change nothing)"
- `views/partials/server/settings.hbs:192` "Let outside apps read status"
- `views/partials/server/settings.hbs:69` "Start on panel boot", `:73` "Auto-restart on crash"
- `public/js/lib/dockerSettings.js` mirrors of the above where they are rebuilt in JS — keep in step.

### 7.3.D Tooltip terminal periods (ruling 3) — templates, itemized sentence-shaped misses

Each `data-tip=` below is already a sentence shape; append a period:

- `views/activity.hbs:16` "Export the filtered events as CSV." (`:17` same for JSON).
- `views/partials/server/players.hbs:46` "Open {{name}}'s page: roles, teleport, and inventory."
- `views/partials/server/players.hbs:75` "The last time this name was seen in the server's cache."
- `views/partials/server/backups.hbs:31` "Stops the server, restores this archive, then starts it again."
- `views/partials/server/mods.hbs:11` "Apply every available update, then restart the server once."
- `views/partials/server/mods.hbs:70` "This update is ignored and won't be applied."
- `views/partials/server/mods.hbs:85` "Update to {{updateAvailable}}, then restart the server."
- `views/partials/server/worlds.hbs:38` "Make a copy of this world on this server."
- `views/partials/server/worlds.hbs:70` "Install into this server, replacing the current world or alongside it."
- `views/partials/server/inventory.hbs:20` "Start the server to clear items in bulk, or delete slots one by one
  below."
- `views/partials/server/commands.hbs:75` "Run now as a named player (permission and cooldown checks are skipped)."
- `views/partials/server/settings.hbs:133` "Auto-Update (applies pack updates after the daily check: pre-update
  backup, health check, automatic rollback on failure, but never across Minecraft versions)." (the sibling radio
  helpers at `:131-:132` already end in a period; this one does not).
- `views/partials/server/settings.hbs:187` "Applies pending settings and resource changes."

### 7.3.E Full tooltip sweep (ruling 3) — reword terse fragments into sentences

Work through EVERY remaining `data-tip=` (grep: `data-tip="` under `views/`) and every client-side tooltip string
(grep `data-tip` and `title:` under `public/js/`). The sentence-shaped ones already carrying a period are done;
the terse imperative ones get reworded and punctuated, following the table's own phrasing so each is one plain
sentence (sentence case, ends in `.`), e.g.:

- "Download archive" → "Download the archive." (`views/backups.hbs:33`, `views/partials/server/backups.hbs:32`,
  `views/worlds.hbs:31`)
- "Rename archive" → "Rename the archive." (`views/backups.hbs:34`, `views/partials/server/backups.hbs:33`)
- "Delete ({{bytes size}} freed)" → "Delete this archive ({{bytes size}} freed)." (`views/backups.hbs:35`,
  `views/partials/server/backups.hbs:34`) — keep the dynamic `(bytes …)` parenthetical.
- "Edit schedule" / "Delete schedule" → "Edit this schedule." / "Delete this schedule." (`views/schedules.hbs:25,26`)
- "More actions" → "More actions." (`views/partials/server/players.hbs:117`, `settings.hbs:159`,
  `files-global.hbs:60`, `views/partials/server/files.hbs:61`)
- "Kick with a message" → "Kick with a message." (`views/partials/server/players.hbs:110`,
  `views/partials/server/player-detail.hbs:36`)
- "Edit command" / "Delete command" → "Edit this command." / "Delete this command."
  (`views/partials/server/commands.hbs:76,77`)
- "Download", "Edit as text (≤ 8 MB)", "Delete ({{bytes size}})", "Grid view", "List view",
  "Rename, move, copy…", "Open in the global file manager", "Open containing folder in the file manager" — same
  treatment on `files-global.hbs`, `views/partials/server/files.hbs`, `views/dashboard.hbs:101-102`,
  `views/partials/server/overview.hbs`, `views/storage.hbs:57,110`.
- Dynamic/placeholder-safe: keep `{{...}}` interpolations as-is and add the period after them.

Exceptions (short labels — leave): swatch names "Grass"/"Diamond"/"Redstone"/"Gold"/"Amethyst"
(`views/wizard.hbs:200-205`, `views/partials/server/settings.hbs:48-50`, `views/partials/server/server-settings.hbs`
swatches if present), the "Update available"/"ignored → {{updateAvailable}}" status captions
(`views/partials/server/mods.hbs:69-70`, `views/updates.hbs:32`), and topbar `data-tip`s that duplicate their
`aria-label` ("Create a Server", "Background tasks", "Switch theme").

### 7.3.F Client JS punctuation and hygiene

- `public/js/pages/mods.js:631` and `:803`, `public/js/lib/zipImport.js:82` — `'Upload failed'` → `'Upload failed.'`
- `public/js/pages/players.js:113` — tooltip "The last time this name was seen in the server's cache" → add `.`
  (same string as `players.hbs:75`; keep the two in sync).
- Tooltip strings per ruling 3: `public/js/lib/motd.js:170`, `public/js/pages/mods.js:231,236,298`,
  `public/js/pages/inventory.js:135` ("Empty ${label} slot"), plus any `title:`/`data-tip` in `lib/*` — add the
  period and reword fragments to sentences.
- Bare HTTP status codes in client throws → drop the code, friendly phrase:
  - `public/js/pages/wizard.js:1008` — ``throw new Error(data.error || `Could not read the zip (${res.status})`)`` →
    `` `Could not read the zip. ${data.error}` `` style; no status code.
  - `public/js/pages/mods.js:218` — ``throw new Error(data.error || `Preview failed (${res.status})`)`` → no code.
- Jargon (rule 7): `public/js/pages/mods.js:725` "…Changes apply on the next recreate." → "…on the next rebuild.";
  `public/js/pages/mods.js:733` "All resolved. Recreate the server to apply." → "All resolved. Rebuild the server to
  apply." Do NOT touch the internal `data-server-action="recreate"` attributes or the already-correct "Rebuild
  Container" button labels.

## 7.4 Step 2 — Server fixes (`src/**`) — file:line, old → new

### 7.4.G In-progress label missing `…` (rule 3, in-progress)

- `src/web/routes/api.js:1789` — `t.step('Restarting server')` → `t.step('Restarting server…')`.

Verified correct, do not touch: `src/updates/upgrade.js:48-56` STEP_LABELS (all end in `…`), `src/services/backups.js`
steps (`:60,:77,:177,:241,:256,:286` end in `…`; `:173` "Shrink skipped because the server was running." is an
outcome sentence and correctly takes a period), and every server-pushed `onProgress`/`onStep` label in
`api.js`, `contentZip.js`, `blueprints/index.js`, `items.js` (all end in `…`).

### 7.4.H `" - "` sentence dash → split into two sentences (rule 4)

Every `" - "` below is being used as a sentence dash; replace with `. ` or `,` per context:

- `src/services/worlds.js:70-71` — `"…after a world operation - check the server console and run save-on."` →
  `"…after a world operation. Check the server console and run save-on."` (this is a `recordEvent` summary).
- `src/services/worlds.js:194` — "Upload not found - try again" → "Upload not found. Try again."
- `src/services/worlds.js:295` — "World \"X\" has no level.dat yet - start the server once so it generates the
  world" → "…yet. Start the server once so it generates the world."
- `src/services/worlds.js:470` — "…already exists on this server - pick another name" → ". Pick another name."
- `src/services/worlds.js:552` — "Source and target are the same server - use Duplicate instead" → ". Use Duplicate
  instead."
- `src/services/worlds.js:642` — summary parenthetical " (active world - level-name updated)" → " (active world,
  level-name updated)".
- `src/services/worlds.js:693` — "World \"X\" does not exist yet - nothing to reset" → ". Nothing to reset."
- `src/services/worlds.js:773` — "This is the active world - activate another world first, or use Reset to
  regenerate it" → ". Activate another world first, or use Reset to regenerate it."
- `src/services/chat.js:48` — "Invalid recipient - pick Everyone or a valid player name" → ". Pick Everyone or a
  valid player name."
- `src/services/files.js:116` — "This looks like a binary file - download it instead of editing" → ". Download it
  instead of editing."
- `src/services/library.js:380` — "Still installed on ${used} server(s) - remove it there first" → "…first.
  Remove it there first." (recordEvent summary — period required either way).
- `src/services/inventory.js:134` and `:1075` — "No saved data for this player yet - they need to have joined the
  server at least once" → ". They need to have joined the server at least once."
- `src/services/inventory.js:378` — "Snapshot not found - it may have been pruned" → ". It may have been pruned."
- `src/services/inventory.js:772` — "X is empty - nothing to re-count" → ". Nothing to re-count."
- `src/services/inventory.js:787` and `:940` — "X is empty - nothing to move" → ". Nothing to move."
- `src/services/inventory.js:925` — "X is empty - nothing to ${op === 'delete' ? 'delete' : 're-count'}" → ".
  Nothing to ${…}." (keep the interpolation).
- `src/services/inventory.js:971`, `:975`, `:979` — "That nested inventory no longer exists - reload" → ". Reload."
- `src/services/inventory.js:989` — "X is empty - the backpack is gone. Reload." → ". The backpack is gone. Reload."
- `src/services/inventory.js:996` — "That nested slot no longer exists - reload" → ". Reload."
- `src/services/inventory.js:1234` — "Their inventory is full - no free slot to add into" → ". No free slot to add
  into."
- `src/services/players.js:40` — "…max 16 characters - a leading . or * for Bedrock players is fine" → ". A leading
  `.` or `*` for Bedrock players is fine."

Casing polish (house consistency): `src/services/inventory.js:1199` uses ASCII `->` ("…moved 9 -> 10 …") where every
other summary uses `→` — align to `→`.

### 7.4.I Raw internals / err output → friendly text (rule 8 + ruling 4)

Strip the raw output and keep the friendly framing; where the server actually has the detail, point at the console:

- `src/integrations/mclogs.js:32` — `` `mclo.gs rejected the upload${data.error ? `: ${data.error}` : ''}` `` →
  "mclo.gs rejected the upload. Check that the log is valid and try again." (`:52` same shape for the "could not
  analyze" case).
- `src/services/chat.js:96` — "The server rejected the message: ${out…}" → "The server rejected the message. Check
  the console for details."
- `src/services/players.js:736` — "Teleport command rejected by the server: ${out}" → "The server rejected the
  teleport command. Check the console for details."
- `src/services/inventory.js:555` — `httpError(404, out || …)` → drop the raw RCON output; use "That slot is no
  longer there. Reload the page and try again."
- `src/services/inventory.js:561` — "The server rejected the command: ${out}" → same friendly pattern.
- `src/services/wizardPowers.js:346` — "The server rejected the power: ${out…}" → "The server rejected that power.
  Check the console for details." (`:363` "Could not read world spawn: ${err.message}" → "Could not read the world
  spawn point. Check the console for details.").
- `src/services/wizard.js:269` — "Could not reach the LLM server: ${err.message}" → "Could not reach the AI server.
  Check its configuration and try again." (`:274` rejected request similarly, drop `String(detail)`).
- `src/services/backups.js:138` — drop `${err.message}` from the discarded-due-to-quota message; keep the friendly
  "not enough free space" framing.
- `src/services/scheduler.js:129` — recordEvent summary `Scheduled ${job.task_type} failed: ${err.message}.` → drop
  the err.message tail (still ends in `.`).
- `src/services/panelUpdate.js:88` — "Could not reach GitHub: ${err.message || 'unknown error'}" →
  "Could not reach GitHub. Check the connection and try again." (if the err.message is a network meaning, keep a
  short friendly reason, never the raw Error text).
- `src/services/dockerSpec.js:31` — "Invalid YAML: ${err.message}" → "That isn't valid YAML. Fix the syntax and try
  again."
- `src/blueprints/index.js:292` — "The blueprint manifest is not valid: ${detail}" (raw zod text) → "The blueprint
  manifest is not valid. It may be from a different app." (drop the raw zod detail).
- Client-side bare-status-code throws are handled in 7.3.F.

Kept (deliberate, flag in the PR if you disagree): `src/utils/zip.js:24` truncated `(… err.message …)` inside the
malformed-archive message; the manifest-summary passthrough in `src/services/contentZip.js:220,441,522` and
`curseforgeApi.js:227`.

### 7.4.J Infra jargon (rule 7)

- `public/js/pages/server-settings.js:189` — "…killed for running out of memory" → "…stopped for running out of
  memory". (The `docker/` layer may keep "OOM-killed" in logs; only user text changes.)

### 7.4.K recordEvent summary missing terminal period (rule 2/history)

- `src/services/servers.js:744` — `Configuration changed: ${Object.keys(diff).join(', ')}${needsRecreate ? '
(rebuild required)' : ''}` → append `.` after the interpolated tail (verify the final string reads
  "…(rebuild required)." or "…name1, name2."). Note the in-code text already uses "rebuild" — convention-correct.
  All other ~120 recordEvent summaries were verified to end in a period.

### 7.4.L httpError messages missing terminal period — sweep list (rule 2, sentence case)

Append a period to each sentence-shaped string below; keep the fragments in the 7.8 keep-list untouched. These are
grouped per file with the line numbers from the audit pass — re-verify each against the keep-list when editing
(some adjacent lines are fragments and must stay bare):

- `src/updates/upgrade.js:42`, `:269` ("An upgrade or rollback is already running for this server."), `:46`
  ("This server has no managed modpack."), `:271` ("No previous pack version recorded.").
- `src/updates/checker.js:267` ("Use the per-mod ignore for overlay content.").
- `src/services/files.js` — sentence-shaped misses at `:51,:125,:127,:134,:174,:175,:191,:198,:215,:220,:239,:245,
:252,:270,:328` (not every line — only those that form a sentence; keep e.g. "File not found" bare).
- `src/services/playerNotes.js:25` ("Note cannot be empty."; `:49` "Note not found" stays bare).
- `src/services/chat.js:54,:70,:71` (verb-phrase sentences).
- `src/services/solver.js:106`.
- `src/services/library.js:54,:67,:84` (library/overlay status lines; check each against keep-list).
- `src/services/worlds.js` — sentence misses at `:199,:301,:448,:577,:586,:623,:625,:627,:654,:656,:690,:776,:807,
:812,:1099,:1192` ("World name cannot be empty.", "Stop the server before renaming worlds.", "Stop the server
  before resetting the world.", etc.).
- `src/services/players.js:125,:209,:701` ("Server must be running to …", "X is not online", "Coordinates must be
  numbers.").
- `src/services/chatCommands.js:67,:75,:76,:99,:102,:104,:228,:293`.
- `src/services/inventory.js:373,:384,:642,:759,:847,:852,:992,:1002,:1186` (the `:555` fallback handled in 7.4.I).
- `src/services/mods.js:696,:980,:1195` plus interpolated tail misses at `:680,:706,:734,:1000`.
- `src/services/wizard.js` — validation sentences at `:121,:123,:124,:125,:132,:147,:157,:160,:168,:170,:248,:301,
:344,:349,:369`.
- `src/services/wizardPowers.js` — validator sentences at `:40,:42,:49,:51,:58,:60,:81,:83,:234,:239,:247,:250,
:253,:256,:260,:273,:279,:295,:338,:369,:384`.
- `src/services/contentZip.js:148,:151,:154,:196,:199,:202,:340,:608,:610`.
- `src/services/packs.js:44,:65,:83,:84,:106`.
- `src/services/dockerSpec.js:34`.
- `src/services/servers.js:315,:419,:605`.
- `src/services/opLock.js:35`.
- `src/services/backups.js:45,:232,:238,:385`.
- `src/utils/zip.js:52,:96,:108,:201,:207,:211,:282` (the "Not a valid zip archive" and "Archive entry escapes…"
  sentences).
- `src/utils/urlGuard.js:136,:143,:149,:178` (the `${u.protocol}`/`${host}` interpolations are data, not ids — fine
  to keep, but the sentence ends in a period; `:133` "Invalid URL" stays bare).
- `src/blueprints/index.js:164,:278,:284,:297` (`:284` "Blueprint manifest is not valid JSON." etc.).
- Hard-rule fragment keep-list (do NOT punctuate): "Server not found", "File not found", "Folder not found",
  "Not found", "Not a folder", "Invalid name", "Invalid URL", "Invalid player name", "Invalid biome id",
  "Unknown dimension", "Note not found".

Client-side equivalents: the `'Upload failed.'` trio and tooltip strings are in 7.3.D/7.3.E/7.3.F. The
`src/web/routes/blueprints.js` zod nit `'Provide exactly one of blueprintId or uploadToken'` (internal identifiers

- no period) → "Choose exactly one blueprint or upload to install." (rule 8).

## 7.5 Step 3 — Docs + README prose pass (docs are in scope per ruling 1)

Mechanics verified clean at audit time (grep, no matches): en/em dashes `–`/`—` and curly apostrophes `’` appear
nowhere in `docs/**` or `README.md`. The remaining pass is a prose read per file:

- Files: `README.md`, `docs/*.md` (README, getting-started, servers, dashboard, worlds-and-files, storage,
  world-shrink, backups, console-and-chat, activity, users-and-roles, two-factor-authentication, modpacks, updates,
  scheduler, integrations, chatbot, blueprints, public-api, architecture), `CHANGELOG.md`. Skip the process/meta
  files (`CONTRIBUTING.md`, `CLAUDE.md`, `REVIEW-FINDINGS.md`).
- Rules to check while reading: heading casing (Markdown `##`/`###` headings are section headings → Title Case
  except code/command literals that must stay lowercase); every sentence-shaped string ends in `.`; no `" - "`
  sentence dash (grep `-` in prose and split into two sentences or swap to a colon); no infrastructure jargon
  (`OOM`, `./data` in prose, "recreate"); proper nouns capitalized (Minecraft, Mojang, Docker, RCON, Modrinth,
  CurseForge, BlueMap, Fabric/Forge/NeoForge/Quilt/Paper/Purpur); straight quotes.
- Keep any literal code/command/path tokens (`pnpm start`, `./data`, `mc.example.com`) as-is — the rules police
  prose around them, not the tokens themselves.
- This pass is lower-risk than the panel strings: most docs were written to the house style already — budget for
  a handful of heading-casing and dash cleanups per file, not rewrites.

## 7.6 What the audit verified CLEAN (do not touch)

- `src/config/field-catalog/*`: curly `’` apostrophes are the sanctioned exception and the help/label text is
  punctuated and Title Case per its own rules.
- `src/web/middleware/jsonErrorHandler.js`: friendly Docker/port/image error mapping.
- `public/js/lib/errors.js`: `friendlyError(res | err, { action })` fallback copy.
- Every table `<th>` (15 `<thead>` blocks), every placeholder, every `aria-label`, every `title=` attribute, and
  every `page-header heading=`.
- Search-placeholder `…` house style ("Search events…", "Search mods…") — fragments, keep.
- Lowercase status chips/badges (`update`, `new`, `you`, `starter`, `custom`, `pack`, `file`, `datapack`,
  `ignored`, `active`/`inactive`, `admin only`, `panel-enforced`, `ops only`/`whitelisted`/`everyone`,
  `on restart`, `optional`) — status markers, not selectable choices, keep.
- `data-label` attributes consumed by the enhanced-select JS — internal, not rendered as copy.
- The "LATEST (1.21)" ALL-CAPS dropdown option and `pinned @ {{version}}` chips — deliberate version-tag
  presentation, keep.
- Arrow glyphs `→` in dashboard/metrics/integrations tabs and "…" ellipsis buttons ("Move To…", "Install to…")
  — intentional UI affordances, keep.

## 7.7 Step 4 — Tests and gates

- `pnpm run lint` — all edited JS must stay clean (ESLint enforces the no-console/underscore rules, not copy;
  the string edits are safe).
- `pnpm run typecheck` — template literals and string const changes are type-neutral.
- `pnpm test` — unit tests may assert exact `httpError`/validation strings. Expect failures on the 7.4.L message
  edits and any 7.3/7.4 string a test asserts; update the assertions in the same PR (test files under `test/`).
- `pnpm run build` — client JS bundling + Tailwind must succeed (pure string changes).
- `pnpm run format:check` (+ `format`) to keep Prettier happy after the edits.

## 7.8 Do-not / keep list (absolute)

1. **Field-catalog curly apostrophes stay curly.** Only edit `src/config/field-catalog/*` if a fix is listed here;
   none are — help text there is compliant.
2. **Fragments stay bare.** Do not punctuate the keep-list fragments (7.4.L): "Server not found", "File not
   found", "Folder not found", "Not found", "Not a folder", "Invalid name", "Invalid URL", "Invalid player name",
   "Invalid biome id", "Unknown dimension", "Note not found".
3. **Descriptive toggles stay sentence case** (7.3.C); do not "correct" them later.
4. **Do not touch `data-server-action="recreate"` / `data-server-recreate` attributes** or the "Rebuild
   Container"/"Apply Changes" button labels — the visible verb is already "rebuild"; only the client `mods.js`
   prose strings change.
5. **Do not touch logger strings / code comments** — the logging style is a separate convention; the `–`/`—`
   occurrences in `src/**` comments are not user-facing.
6. **Step/outcome labels already correct stay** (upgrade STEP_LABELS, backups.js steps, contentZip/blueprints/api
   onStep labels).
7. **No new behavior, no layout, no CSS.** Every change is a string literal (plus matching test assertions).
8. **Copy house style applies to any rewritten sentence** (sentence case, terminal period, no `-` dash, proper
   nouns, straight quotes).

## 7.9 Suggested PR sequence (small commits, each independently reviewable)

1. `fix(copy): straight apostrophes + Title Case labels` — 7.3.A, 7.3.B, 7.3.C (documents the keep-list too).
2. `fix(copy): punctuate tooltips across templates and client JS` — 7.3.D, 7.3.E, 7.3.F (tooltip items).
3. `fix(copy): server message punctuation sweep` — 7.4.G, 7.4.K, 7.4.L + test-assertion updates.
4. `fix(copy): split " - " sentence dashes in server messages` — 7.4.H (+ `inventory.js:1199` arrow polish).
5. `fix(copy): drop raw internals from error messages` — 7.4.I, 7.4.J, 7.3.F throw strings, zip/zipquery odes.
6. `docs: copy conventions prose pass` — 7.5 (README + docs/* + CHANGELOG).
7. Verify with the 7.7 gates, then a UI spot-check of tooltips, toasts, and error toasts in both themes.

---

# Addendum — 2026-09-21 · Upstream merge review

Scope: re-review of the above findings against the **merged upstream tree** (34 upstream commits: releases
0.13.2 / 0.14.0 / 0.14.1, per-server permissions #45, mod version-compat #52/#53/#54, installer #50). Baseline
for this review: HEAD `485de3f` (fast-forward merge of `upstream/main` into `fix/39-world-settings-revert`;
the pre-merge HEAD `f90365f` was an ancestor, so the merge is a clean ff). Line anchors below were verified
against `485de3f`; the rest of this document's anchors are from `9148a7b` and may drift by a few lines but the
code they describe is unchanged.

Note: the fork's `feature/fleet-metrics-history` work (metrics tab, `src/metrics/`, analytics pages) was
**never merged upstream**. Upstream deleted `src/metrics/` and replaced the fork's `027_metrics_samples.js`
with `027_version_compat.js`. Any finding below that is metrics-only is inapplicable to the merged tree.

## Re-verification of the existing findings

- **H-V1 — still present.** Raw tint triples at `players.hbs:81/86/91` and `player-detail.hbs:27/30/33`
  unchanged; the JS copies (`players.js:66-70`, `player-detail.js:59-61`) unchanged. (Templates were untouched
  by the ff merge; diff of both partials vs. baseline is empty.)
- **M-V1 — still present.** `players.hbs:66` uses `bg-grass-700` for the whitened dot vs. the `bg-grass-500`
  everywhere else.
- **H-B2 — still present, and now also covers the version-upgrade rebuild path.** `recreateServerImpl`
  (`servers.js:559`) and `deleteServerImpl` (`servers.js:757`) still call `stopContainer`/`removeContainer`
  directly with no `stop-requested` event; only `stopServerImpl:506` emits it. MC-version upgrade
  (`applyMinecraftVersion`) routes through `recreateServerImpl`, so an upgrade with an OT-less save window or a
  slow stop still surfaces as a phantom crash in history.
- **M-B5 — still present.** `watcher.js:92` selects servers with no `deleted_at` filter.
- **M-P2 — still present.** The dashboard still runs the five-scalar `countOutdated` twice per render:
  once in the always-on middleware (`index.js:153`) and once in `buildDashboardOverview` (`index.js:264` via
  `countOutdatedByKind`). Non-admins also pass a `visibleServerIds` set to it (`index.js:154`), which is the
  improved shape, but the double-count on the dashboard remains. (The per-request middleware variant now only
  scopes when `hidesAnyServer` says so — a real improvement, not a regression.)
- **H-P1, H-P2 — inapplicable.** `src/metrics/aggregate.js`, `src/metrics/sampler.js`, the metrics tab route
  block and `analytics.*` are fork-only and were removed upstream. Any §6 (Step 4-6) item that touches
  `analytics.js` / the meters metric settings is fork-only too.
- Everything else (P1-P2 visual, L-P1…L-P4, H-P3, M-P1/M-P3, H-B1, M-B1…M-B4, L-B1…L-B4, §4, §5) — presumed
  still applicable; sources unchanged in the merged delta. Not individually re-verified.

## New findings (from the merged upstream code)

### Performance

### L-P5. Non-admin users recompute their full visibility set three times per page view

`index.js:148-154`: `visibleServerIds(req.user)` is run once for `res.locals`, run _again_ inside
`filterVisible(...)` on the next line (`permissions.js:346-350` rebuilds it), and `hidesAnyServer` at `:154`
adds a `SELECT COUNT(*) FROM servers` (the set itself is reused). Cost per page for a non-admin: 2×
`SELECT id FROM servers` + 2× `user_server_permissions` reads + 1 COUNT; admins short-circuit to one id-listing

- the COUNT. Cheap per row but the same query fired back-to-back on the hot path of every page.
  Fix: thread the already-built set through `filterVisible` (optional arg) and into `hidesAnyServer` (already
  accepted).

### L-P6. Version-compat walks the mod folder 2-3 times per check/render and buffers up to 25 jars whole

- `inventory()` (`compat.js:169-192`) reads every unrecognized jar fully into memory and retains **25 Buffers**
  through the registry round-trip; `MAX_JAR_BYTES` is 512 MiB, so worst-case ≈ 12.8 GiB, realistic large packs
  ≈ 0.5-1.5 GiB transient on the panel process. Confirm whether `identifyJars` needs the bytes after hashing —
  if not, drop each Buffer right after the sha1/sha256/fingerprint pass.
- `checkStandaloneVersion` (`checker.js:302-303`) runs `modCount()` (a full `readdir` + per-jar `stat`) then
  `compatCeiling()` → `getReport()` → `modsSignature()` (a _second_ full `readdir` + stat pass) per modded
  server per check cycle, and the Updates tab adds a third (`index.js:556` `compat.modCount`).
  Fix: one helper returning `[{name,size}]` reused for both count and signature, memoized per serverId with a
  cheap folder-mtime check.

### L-P7. Updates page reparses the full report on every render (and upgrades re-walk)

`getReport()` (`compat.js:655-699`) JSON.parses `payload_json` (up to ~1 MB on a large pack) synchronously on
every Updates-tab render (`index.js:542`); the `/mcversion` upgrade attempt (`api.js:1195`) calls
`modCount()` + `compatCeiling()` + `getReport()` in one go (three disk passes + a parse). Manual actions, so
Low — but one parse shared between the report getter and the verdict would remove the duplicate work.

### Bugs

### L-B5. A failed or interrupted scan is reported as "never been checked"

`compatCeiling` (`compat.js:711`) collapses status `'failed'` (and, by extension, `'interrupted'`) into
reason `'no-scan'`, and `HOLD_REASON` (`compat.js:736-743`) has no `failed`/`interrupted` entries. After a
failed scan (registry down, jar unreadable) the upgrade gate and the Updates tab tell the user "versions have
never been checked. Run a version check first", silently discarding the real reason already stored in
`state.error`. Safe (nothing is offered — that part is correct), but the copy is wrong.
Fix: map `'failed'` → its own reason + HOLD_REASON entry ("The last version check failed. Run it again."), and
`'interrupted'` → reason `'incomplete'`. Surface `state.error` in the tab near the Resume button.

### H-B3. Phantom "invited upgrade" for plugin-family servers: the panel treats Mojang's newest Minecraft as the latest a Paper/Purpur server can run

Symptom (reported 2026-09-21): a Paper 26.2 server is told Minecraft 26.3 is available, although Paper has no
default-channel build for 26.3. Verified live against the registries: `fill.papermc.io` lists 26.2 with
STABLE/RECOMMENDED builds (latest id 127) but 26.3 with **ALPHA only** (id 32); Purpur's API, by contrast, already
has a 26.3 build list. The bug is Paper-channel- and flavor-specific, not universal — so the fix must be
channel-aware and per-flavor, not a blanket "Paper lags Mojang" assumption.

Root cause: every "what is the latest version" derivation resolves straight off the Mojang manifest's
`latest.release`, which Mojang publishes ahead of downstream server implementations. The #52/#53 modded gate only
covers mod servers (`checker-version-gate.test.js`); plugin-family servers are deliberately exempted
(`compat.appliesTo` returns false for plugins, `compat.js:266-272`, "Plugin servers keep the plain newest-release
behaviour"), and the unmodded standalone path then offers the raw Mojang release with no loader-support check.

Four surfaces, all verified on the merged tree (`485de3f`):

1. **Update offer.** `checkStandaloneVersion` (`src/updates/checker.js:290-344`) sends an unmodded standalone
   server (which includes every plugin-family server) at `manifest.latest.release` (`:293`, `:304`), writes an
   `update_checks` row plus a finding, and `listOutdated` (`:476-492`) then surfaces "Minecraft 26.2 → 26.3" on
   the Updates page and in the sidebar badge.
2. **Apply path.** `POST /api/servers/:id/mcversion/upgrade` (`src/web/routes/api.js:1164-1240`) lets it through
   because `upgradeVerdict` answers `allowed` for plugin servers (`compat.js:753`). Clicking Update Now pins
   `mc_version=26.3` and recreates the container onto a build that does not exist, leaving the server down mid-task
   (pull fails) while history records the attempted upgrade. The Settings PATCH accepts `mcVersion` through a
   second, ungated path (`api.js:152`).
3. **Wizard.** `/servers/new` (`src/web/routes/index.js:355-396`) seeds the default `LATEST ({{latestRelease}})`
   (`views/wizard.hbs:222-225`) and `wizard.js:634-647` defaults the concrete picker to the newest release, so
   creating a Paper/Purpur server steers users at 26.3 (or a LATEST pin the panel will label 26.3) before Paper
   has shipped it.
4. **Display.** `displayVersion` (`src/web/viewModels.js:12-21`) renders a LATEST pin as Mojang's latest release,
   so a LATEST-pinned Paper server displays "LATEST (26.3)" even though the installed Paper jar is 26.2. Shared by
   the status page (`status.js:36`) and the invite .mrpack generator (`invites.js:148-156`).

Impact: daily-visible wrong version numbers, a promoted-but-broken upgrade action on a working server, and the
wizard steering into unreleased versions. Not auto-applied (`runAutoUpgrades` only handles packs, so the phantom
offer cannot run unattended), but the whole class is user-facing poplin in exactly the way this report hit.

Fix: the loader-aware gate in section 8 (channel-aware Paper probe via the existing Fill client, a Purpur existence
probe, and shared loader-aware "latest" resolution for the display and wizard surfaces).

## Notes for the implementing agent

- The **three new event types** (`version-check`, `permissions-changed`, `mod-reverted`) are covered by
  `knownTypes()` (a live DISTINCT query, so the Activity filter shows them automatically) but are **missing
  from the §6 EVENT_BADGE map** (fork-only `analytics.js` aside, map the server-side `EVENT_BADGE` at
  `src/web/routes/index.js`). Decide deliberately: color them or leave neutral; the dashboard/activity rows
  fall back to the neutral badge today, which is acceptable but undocumented.
- **H-B2 interacts with the new upgrade path**: when §3 H-B2 is fixed, make sure the version-upgrade rebuild
  (not just the Settings-page recreate) gains the `stop-requested` event too.
- `yieldServerRuntime` gate on the `/api/mcversion` routes (`api.js:1189-1210`) is the only place an
  `upgradeVerdict` result is consumed; keep L-P7 in mind if that route grows.
- The fork DB's `schema_migrations` will contain a stale `027_metrics_samples` row after this merge
  (migrations are keyed by full `NNN_name`, so `027_version_compat` still applies; the orphan row is harmless).
  Do not delete it manually; only a future renumber needs the §migrate.js LEGACY_ALIASES treatment.

## Gate note (CI healthcare, not a finding)

- `pnpm run lint`, `format:check`, `typecheck`, `build` and the Docker-free majority of `pnpm test` (993/999)
  are green on `485de3f`. The **six** failures are all in `test/permissions-authz.test.js` and are
  **environmental, not code**: this host's user is not in the `docker` group (`/var/run/docker.sock` is
  `srw-rw---- root:docker`), so every request that reaches dockerode 500s or throws `EACCES`. Specifically:
  `GET /api/servers/:id/logs` asserts 200 four times (`fetchLogs` at `src/docker/logs.js:20-35` only swallows
  Docker 404, rethrowing socket `EACCES` → 500), and test `:505` dies on `deleteServer` → container removal
  (`connect EACCES /var/run/docker.sock`). Upstream CI runs these with a reachable daemon. Re-verify on a
  Docker-capable host before treating `pnpm test` as failing. Borders: `NOT_GATED` deliberately includes 500,
  so only the explicitly-asserted-200 cases trip in a socket-less env.

---

# 8. IMPLEMENTATION PLAN — Loader-aware version targeting (phantom "Paper 26.3")

Date: 2026-09-21 · Handoff doc: another agent implements this end-to-end. Resolves **H-B3**. All file/line anchors
were verified against the merged tree (`485de3f`). Registries verified live this date: Fill v3 lists **Paper 26.2**
with STABLE/recommended builds and **26.3 with ALPHA only**; Purpur's API already lists 26.3 builds. The fix is
channel-aware and per-flavor, and must never regress the existing #52/#53 modded gate.

## 8.1 Goal and out-of-scope

**Goal.** The panel must never offer, display, or steer towards a Minecraft version that the server's own
implementation has not published a compatible build for. Concretely:

- A default-channel Paper (and Paper-family) server at 26.2 gets **no** "26.3 available" offer, badge, or event
  until Paper publishes a default-channel (STABLE/RECOMMENDED) 26.3 build.
- An **experimental-channel** Paper server keeps tracking the pre-release channel, so 26.3 (ALPHA) is still a
  legitimate offer there.
- A LATEST pin on a plugin-family server displays the **newest Minecraft version the loader actually ships**
  ("LATEST (26.2)" today), not Mojang's latest.
- The wizard's default and "LATEST (…)" annotation are flavor-aware per the same rule.
- The upgrade apply paths refuse a loader-unsupported target unless the user explicitly forces it.

**Out of scope — do NOT touch:** the modded path (`compat` ceiling and `#52/#53` are the designed loader gate for
mods and stay exactly as-is); the `loader_build` channel (Paper build pin) check (`checker.js:349-368`), which is
already scoped to a single MC version; the sub-version display rule that "SNAPSHOT/LATEST is never shown bare"
(`viewModels.js:9-10`); Bedrock servers (no Mojang manifest); the itzg "No build found" escape hatch in the
field-catalog help text (`general.js:119-130`), which remains the manual override; and any work on registry clients
for Pufferfish/Leaf/Folia/Spigot/Bukkit/Canyon beyond using Paper's Fill list as a documented bellwether.

## 8.2 Design decisions (agreed, do not reopen)

1. **The gate is only for the plugin family.** `loaderOf` collapses every `PLUGIN_TYPES` flavor to `'paper'`
   (`mods.js:174-183`), so the gate keys on the **`server.type`** (for the flavor-specific probe) plus
   `loader === 'paper'` (as the family guard). Vanilla and the mod loaders (Fabric/Quilt/Forge/NeoForge) keep the
   current Mojang-`latest.release` behaviour — their metas track Mojang releases and there is no reported lag
   class like Paper's. This keeps the existing `checker-version-gate.test.js` "an unmodded server still gets the
   newest release" assertion green.
2. **The probe is channel-aware for Paper, existence-based for Purpur, bellwether for the rest.**
   - `PAPER`: reuse `paperBuilds(mc, { channel })` (`loaderVersions.js:126-138`). Non-empty on the server's
     `PAPER_CHANNEL` (default → STABLE/RECOMMENDED; experimental → ALPHA/BETA) means "supported". Verified: 26.2
     default → non-empty, 26.3 default → empty, 26.3 experimental → non-empty.
   - `PURPUR`: probe `https://api.purpurmc.org/v2/purpur/<mc>` through the existing `cachedJson` for a non-empty
     `builds.all` array (HTTP 200 with an empty list = unsupported). Purpur's build list already includes 26.3,
     so Purpur servers keep a 26.3 offer even while Paper holds — a blanket "Paper is the truth" would wrongly
     hold Purpur back.
   - `PUFFERFISH`/`LEAF`/`FOLIA`/`SPIGOT`/`BUKKIT`/`CANYON`: no cheap public per-MC registry; use Paper's Fill
     probe as an upper bound (these forks cannot ship a Minecraft version Paper has not built). Documented in a
     comment so nobody "fixes" it later.
   - **Registry-down rule:** a probe that throws or yields no data at all must be treated as `supported: true`
     (never invent a hold because PaperMC is unreachable). A **stale but present** cache entry is authoritative —
     that is exactly what `cachedJson` already returns.
3. **One shared resolver for "latest", used by display and wizard.** `newestMcSupportedByServerType(type,
{ channel })` iterates the (cached) Mojang manifest newest-release-first and returns the first version the
   loader probe reports supported, capped at 8 probes. Single-flight + in-memory memo (mirror `mojang.js:35-41`
   and its `memo` pattern) so a dashboard render of N LATEST-pinned plugin servers performs one flight, and every
   per-version probe after the first is a hot 6-hour cache read. Registry-down → `null`, and callers fall back to
   Mojang's `latest.release` (current behaviour).
4. **SNAPSHOT on a plugin-family server renders bare "SNAPSHOT".** Paper ships only releases, so there is no
   honest snapshot number to resolve to; the pin still stores `SNAPSHOT` and the image resolves whatever it can
   pull. Display-only change. The field-catalog `general.js:98` help text already implies the release channel; add
   a sentence noting plugin servers build releases only.
5. **No DB migration.** The `update_checks` row shape and the `upsertCheck` contract (`checker.js:377-391`,
   `latest_version IS NOT NULL` means "update available") are unchanged. An unsupported target is written exactly
   like a held-back/current one: `isNew:false`, nulls for `latest_*`, which clears any stale badge in the same
   pass (the existing "retired offer" test at `checker-version-gate.test.js:157-171` covers this shape).

## 8.3 Step 1 — `src/services/loaderVersions.js`: the probe + shared latest resolver

Add to the existing exports (`paperBuilds`, `cachedJson`, `getBuilds` are already in this module; no new
dependencies — `mojang` is already requireable and `cachedJson` is module-local).

```js
// Per-MC-version support probe for the plugin family. 'paper' covers PAPER via
// loaderOf, but the FLAVOR ships the build: probe Paper's Fill list channel-wise,
// Purpur's own registry by existence, and the other Paper forks by the Paper
// bellwether (they cannot ship a Minecraft version Paper has not built). A probe
// that yields NO data at all means "unsupported" only from a present cache check;
// a thrown probe (registry down) is treated as supported so a PaperMC outage never
// invents a false hold.
const PAPER_MC_CHANNELS = { default: 'default', experimental: 'experimental' };
const BELLWETHER_TYPES = new Set(['PUFFERFISH', 'LEAF', 'FOLIA', 'SPIGOT', 'BUKKIT', 'CANYON']);

/** @returns {Promise<{supported: boolean, heard: boolean}>} */
async function mcAvailableOnServerType(type, mc, { channel = 'default' } = {}) {
  try {
    if (type === 'PAPER' || BELLWETHER_TYPES.has(type)) {
      const builds = await paperBuilds(mc, { channel });
      return { supported: builds.length > 0, heard: true };
    }
    if (type === 'PURPUR') {
      const data = await cachedJson(
        `loader:purpur:${mc}`,
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mc)}`
      );
      return {
        supported: Boolean(data && Array.isArray(data.builds && data.builds.all) && data.builds.all.length),
        heard: true,
      };
    }
  } catch {
    // registry down: never gate on a guess
  }
  return { supported: true, heard: false };
}
```

Notes for the implementer:

- `paperBuilds` already filters by `PAPER_CHANNEL_MAP` and returns the `[LATEST, …]` shape from `getBuilds`, but
  `paperBuilds` itself returns the raw `[{version,…}]` list (no sentinel) — the plan reads `.length` off
  `paperBuilds` directly (`loaderVersions.js:126-138`), not `getBuilds`.
- The Purpur key uses the existing `cachedJson` cache-key convention (`loader:<name>:<mc>`, matching `loader:paper3:*`).
- Export a single-flight + memoized newest resolver:

```js
let latestMcMemo = null; // { type, channel, mc, atMs }
let latestMcInFlight = null;
async function newestMcSupportedByServerType(type, { channel = 'default', maxProbes = 8 } = {}) {
  if (
    latestMcMemo &&
    latestMcMemo.type === type &&
    latestMcMemo.channel === channel &&
    Date.now() - latestMcMemo.atMs < TTL_MS
  ) {
    return latestMcMemo.mc;
  }
  if (latestMcInFlight) return latestMcInFlight;
  latestMcInFlight = (async () => {
    const manifest = await mojang.getVersionManifest();
    let mc = null;
    let probed = 0;
    for (const v of manifest.versions) {
      if (v.type !== 'release') continue;
      if (probed++ >= maxProbes) break;
      const ok = await mcAvailableOnServerType(type, v.id, { channel });
      if (ok.supported) {
        mc = v.id;
        break;
      }
    }
    latestMcMemo = { type, channel, mc, atMs: Date.now() };
    return mc;
  })().finally(() => {
    latestMcInFlight = null;
  });
  return latestMcInFlight;
}
```

- `maxProbes` cap keeps the loop bounded even on a manifest with only old releases. Return `null` when nothing is
  supported so callers fall back to Mojang's latest.
- Export `{ mcAvailableOnServerType, newestMcSupportedByServerType }`.

## 8.4 Step 2 — `src/updates/checker.js`: gate the unmodded standalone offer

In `checkStandaloneVersion` (`checker.js:290-344`), the `loader` is currently computed only after the mc-version
block (`:346`). Move `const loader = modsService.loaderOf(server);` above the mc-version block and add the gate on
the **unmodded** path only (the `modded` branch keeps `ceiling.ceiling` untouched):

- When `modded` is false **and** `loader === 'paper'` **and** `target !== server.mc_version`:
  - `const gate = await loaderVersions.mcAvailableOnServerType(server.type, target, { channel: server.env.PAPER_CHANNEL || 'default' });`
  - If `!gate.supported`: do **not** offer. Write the row exactly like the held-back branch (`:330-335`:
    `isNew:false`, `latestId:null`, `latestName:null`), so a previously cached phantom 26.3 offer is cleared and
    the badge cannot go stale. Add one `logger.debug` per house style:
    `'Holding back a Minecraft version offer; the loader has no build for it on this channel.', { serverId, target, channel, type: server.type }`.
  - If `supported` or `!gate.heard` (registry down): offer as today.
- Keep `loader` in scope for the existing loader-build block below.

No change to `listOutdated` or `countOutdatedByKind` — an unsupported target never reaches them because no
`latest_version` row is written.

## 8.5 Step 3 — `src/web/routes/api.js`: gate the apply paths

**`POST /servers/:id/mcversion/upgrade`** (`api.js:1164-1240`): after the existing `force`/compat block (`:1194-1211`),
add, before the task starts (`:1212`):

```js
if (
  targetVersion &&
  targetVersion !== server.mc_version &&
  !force &&
  require('../../services/mods').loaderOf(server) === 'paper'
) {
  const gate = await require('../../services/loaderVersions').mcAvailableOnServerType(server.type, targetVersion, {
    channel: server.env.PAPER_CHANNEL || 'default',
  });
  if (!gate.supported) {
    return res.status(409).json({
      ok: false,
      error: `${server.type.charAt(0) + server.type.slice(1).toLowerCase()} has not published a build for Minecraft ${targetVersion} on the default channel yet. Switch this server to the experimental channel to track pre-releases, or pick a released version.`,
    });
  }
}
```

- The friendly message follows the HOLD_REASON copy pattern (`compat.js:736-743`) and names the actual flavor's
  display name (Paper/Purpur/Pufferfish/Leaf), not the `PAPER` enum; reuse a small label map or the existing
  `flavorLabel` helper.
- `force: true` is the deliberate override exactly like the compat one. No client change is strictly required:
  `runMcUpgrade` (`updates.js:224-248`) already falls through to `toast(err.message)` when a 409 carries no
  `compat` shape, so the friendly message renders as an error toast automatically. Consider a small copy pass so
  the loader-held refusal offers the one useful action (switch to experimental) instead of a dead end.

**Settings PATCH** (`api.js:137-190`): `mcVersion` (`:152`) is a second ungated writer even though no current UI
sends it. Add the same gate keyed on "changing mc_version on a plugin-family server" (cheap when untouched: the
probe only runs when `changes.mcVersion && changes.mcVersion !== before.mc_version`). Registry-down → pass through
(`heard:false`). Do not slow down cosmetic-`settings` saves.

## 8.6 Step 4 — `src/web/viewModels.js` + `src/integrations/invites.js`: loader-aware display and .mrpack resolution

**`viewModels.js:12-21`** — change `displayVersion(server)` to take the **whole server row** (callers: `:107`
`await displayVersion(s)` and `invites.js:81` `await displayVersion(server)` are both already in scope of the row):

- `mc_version` concrete → return it unchanged.
- `LATEST`:
  - Plugin-family (`mods.loaderOf(server) === 'paper'`): `const mc = await newestMcSupportedByServerType(server.type, { channel: server.env.PAPER_CHANNEL || 'default' });`
    → `mc ? \`LATEST (${mc})\` : \`LATEST (${manifest.latest.release})\`` (fallback keeps the old label when the
    registry is down).
  - Otherwise: current behaviour (`:16`).
- `SNAPSHOT`:
  - Plugin-family: return the bare string `SNAPSHOT` (no fabricated snapshot number; Paper builds releases only).
  - Otherwise: current behaviour.

Mind the comment at `viewModels.js:9-10` ("never shown bare") — this change is the deliberate exception for the
plugin family and the comment must be updated to say so, or the next reviewer will "fix" it.

**`invites.js:148-156`** — `resolvedMcVersion` mirrors the same rule using the server row it already holds: for a
plugin-family LATEST pin, resolve via `newestMcSupportedByServerType` before falling back to Mojang. This keeps the
generated `.mrpack` `version` field honest about what the server is actually on.

## 8.7 Step 5 — `src/web/routes/index.js` + `views/wizard.hbs` + `public/js/pages/wizard.js`: flavor-aware wizard defaults

Server (`index.js:355-396`) — replace the single `latestRelease` with both values:

```js
latestRelease = (await mojang.getVersionManifest()).latest.release;
paperLatestRelease = await loaderVersions.newestMcSupportedByServerType('PAPER'); // null → fall back below
```

Pass both into the render (`:385-395`). Purpur's is the same helper with `'PURPUR'` if the implementer wants it;
the tiles expose only VANILLA/PAPER/PURPUR (`wizard.hbs:215-218`), and Purpur's list already includes 26.3, so the
PAPER value is the one that matters today.

Template (`wizard.hbs:222-225`) — keep the default option for the initial Vanilla tab as `LATEST ({{latestRelease}})`.
Mark the flavor tiles with the per-flavor latest so the client can substitute: add `data-mc-latest="{{#if paperLatestRelease}}{{paperLatestRelease}}{{else}}{{latestRelease}}{{/if}}"` to the PAPER tile (VANILLA keeps
`{{latestRelease}}`; PURPUR gets its own value or the shared one).

Client (`wizard.js`) — in the flavor-tile click handler (`wizard.js:649-659` region), when the chosen flavor's
`data-mc-latest` differs from the current `wz-version` option text:

- Rewrite the `LATEST (X)` option label to `LATEST ({{chosenLatest}})`.
- If `wz-version.value` is `LATEST` or equals the _previous_ flavor's latest, reseed it to the chosen latest
  (concrete value; keep `seedMcOptions` untouched for manual picks).

Keep this swap minimal and DOM-only; `getState` (`wizard.js:251`, `:530`) already reads `wz-version.value`, so the
reseed flows into every create tab (from-mods/from-zip included) with no further change.

## 8.8 Tests (all five CI gates must pass: lint, format, typecheck, build, test)

- **Extend `test/checker-version-gate.test.js`** (it already seeds the Mojang manifest and stubs no network; the
  Paper probe reads `api_cache`, so seed `loader:paper3:26.3` and `loader:paper3:26.2` with the same V3 shape from
  `test/loaderVersions-paper.test.js`):
  - Seed a `type: 'PAPER'` server at `mc_version: '26.2'` (`update_policy: 'notify'`, no mods). Seed 26.3's build
    cache as **empty** (no stable builds). `checkAll` → **no** mc_version finding, `update_checks.latest_version`
    is null. This is the reported bug as a regression test.
  - Same server with `env_json` `{"PAPER_CHANNEL":"experimental"}` and a 26.3 build cache carrying ALPHA entries
    → the offer IS produced (latest `26.3`).
  - Same server with a non-empty 26.3 default-channel cache → the offer IS produced (Paper has shipped it).
  - The existing VANILLA assertion (`:131-138`, still 26.3) and the modded assertions stay untouched and green.
- **New `test/loaderVersions-mc.test.js`** (fetch-stub pattern of `test/loaderVersions-paper.test.js`):
  - `mcAvailableOnServerType('PAPER', mc, { channel: 'default' })` false on an empty/ALPHA-only list, true on
    STABLE; channel 'experimental' true on ALPHA.
  - `mcAvailableOnServerType('PURPUR', mc)` true on a populated `builds.all`, false on an empty one.
  - A thrown fetch (registry outage) → `{ supported: true, heard: false }`.
  - `newestMcSupportedByServerType('PAPER')` returns the newest supported MC (26.2 above a hold at 26.3) and null
    when nothing matches; the memo returns without a second flight.
- **Route — `/api/servers/:id/mcversion/upgrade` gate** (style of `checker-version-gate.test.js` + `helpers/app`):
  default-channel Paper server, unsupported target → 409 with the friendly message, `mc_version` unchanged, no
  task started; `force: true` → 202; `PAPER_CHANNEL=experimental` with ALPHA available → 202. The PATCH `mcVersion`
  path gated the same way and pass-through when registry is down.
- **`displayVersion` unit** — a plugin-family LATEST server renders `LATEST (26.2)` with the seeded Paper caches,
  `LATEST (26.3)` when 26.3 has stable builds, and the Mojang fallback when the probe returns null; a VANILLA
  server is unchanged; plugin-family SNAPSHOT returns bare `SNAPSHOT`.

## 8.9 Verification

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

Manual smoke (worth noting in the PR): a default-channel Paper 26.2 server shows no "26.3 available" anywhere after
a check; a LATEST-pinned Paper server shows `LATEST (26.2)` on the card, chrome, and status page; creating via the
wizard with the Paper tile lands the default on 26.2 (not 26.3); switching a server to the experimental channel
brings the 26.3 offer back; clicking through the confirmed upgrade gate on a held version surfaces the friendly
409 message; a `PAPER_CHANNEL=experimental` server can still upgrade.

## 8.10 Do-not list (explicit guardrails)

- Do not gate modded servers or change the compat ceiling handling — #52/#53 is the modded gate, and this plan only
  fills the unmodded plugin-family hole.
- Do not gate VANILLA, Fabric/Quilt/Forge/NeoForge, or Bedrock servers on any loader probe (they keep Mojang latest).
- Do not invent a hold when a registry is unreachable (`heard: false` → supported). Never block a display render on
  a registry call; the in-memory memo + cache are the only load-bearing network paths, and both degrade to current
  behaviour on failure.
- Do not add a DB migration or change the `update_checks` contract (`latest_version IS NOT NULL` = offer stands).
- Do not silently upgrade a plugin-family server across an unsupported version on `force: false`; that 409 must be
  surfaced to the client exactly like the compat 409 is.
- Do not touch the `loader_build` (Paper build pin) check or the `mcversion` auto-upgrade path (`runAutoUpgrades`
  already skips standalone servers; leave it).
- Do not change the `displayVersion` "never bare" rule for non-plugin servers; the plugin-family SNAPSHOT exception
  must be documented in the code comment that this plan marks for update.

## 8.11 Suggested PR sequence (small commits, each independently reviewable)

1. `feat(loaderVersions): per-MC support probe + newest-supported resolver` — §8.3 + `test/loaderVersions-mc.test.js`.
2. `fix(updates): gate the unmodded plugin-family offer` — §8.4 + checker test additions.
3. `fix(api): refuse loader-unsupported version upgrades` — §8.5 (+ PATCH guard) + route tests.
4. `fix(view): loader-aware LATEST/SNAPSHOT display and .mrpack resolution` — §8.6 + display unit tests.
5. `fix(wizard): flavor-aware default and LATEST annotation` — §8.7 + smoke.
6. Verify with the §8.9 gates and the manual smoke list; note the 26.2/26.3 live-registry state in the PR.
