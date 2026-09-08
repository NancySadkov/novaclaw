import { useSearchParams } from "@solidjs/router"
import { rowsForDirectory } from "./files-rows"
import { downloadHostPath } from "@/apps/agent-file-link"
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { fsTrashList, fsTrashRestore, type TrashEntry } from "@/utils/fs-api"
import { createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import { useFilesystemOperations, type FilesystemTarget } from "@/components/filesystem-operations"
import { filesystemShortcut, isEditableFilesystemTarget } from "@/components/filesystem-domain"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { ProjectChip, ProjectDetail, useProjectSummary } from "@/components/project-indicator"
import * as Timestamp from "@novaclaw/schema/time"

// The Files app (B7 + the B8 Trash surface — plan.md M3/M4). Browses the SERVER host's filesystem
// via the same V1 /file endpoints the directory picker uses (sdk.client.file.list / .read,
// directory = any absolute host path); navigate folders, preview text files, "Ask AI" (opens a
// pre-filled chat draft — the OS spawn/chat seam). Deletion is SAFE-delete only: rows trash via
// POST /file/trash (dated store, runtime-configured TTL) and the Trash panel restores — no destructive path.
type Entry = { name: string; path: string; absolute: string; type: "file" | "directory"; ignored: boolean }

// Parent of an absolute host path. Handles Windows (C:\a\b -> C:\a, C:\ stays) and POSIX (/a/b -> /a,
// / stays); returns undefined at a drive/filesystem root so the "Up" control disables there.
function parentDir(abs: string): string | undefined {
  const norm = abs.replace(/[\\/]+$/, "")
  const cut = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"))
  if (cut < 0) return undefined
  const head = norm.slice(0, cut)
  if (/^[A-Za-z]:$/.test(head)) return head + "\\" // C: -> C:\
  if (head === "") return norm.startsWith("/") ? "/" : undefined // /foo -> /
  return head
}

export function FilesPage() {
  const global = useGlobal()
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const sync = useServerSync()
  const trashRetentionDays = createMemo(() => {
    const trash = (sync().data.config as { trash?: { retention_days?: number } } | undefined)?.trash
    return trash?.retention_days ?? 30
  })

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })

  const [dir, setDir] = createSignal("")
  const [selected, setSelected] = createSignal<Entry | undefined>(undefined)
  const [active, setActive] = createSignal<Entry | undefined>(undefined)
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; entry?: Entry } | undefined>()
  // Bumped after every mutation (trash/restore) to refetch the listing + trash panel.
  const [tick, setTick] = createSignal(0)
  const [showTrash, setShowTrash] = createSignal(false)
  // A friendly Files app hides dotfiles and Windows system litter (NTUSER.DAT{…}, desktop.ini, …)
  // unless the user flips the header toggle — first thing a lay user sees must not be registry noise.
  const [showHidden, setShowHidden] = createSignal(false)

  // Resolve a starting directory + the host's filesystem roots (drives on Windows, "/" on POSIX);
  // /path is authoritative — `roots`/`data` postdate the generated SDK type, hence the cast.
  // FS-3: `virtual`/`virtualRoot` postdate the SDK type too; in virtual mode the app-private
  // root is the start dir and there are no host drives to jump to.
  type PathLike = {
    home?: string
    directory?: string
    roots?: readonly string[]
    virtual?: boolean
    virtualRoot?: string
    places?: readonly { name: string; path: string }[]
  }
  // ⚠️ Every resource below is read through `.latest`, never by calling it. Calling a Solid resource
  // SUSPENDS while it refetches, so a Files page that was already showing a directory would blank
  // itself on every navigation within it — and now that the shell has a Suspense fallback
  // (`layout-new.tsx`), blanking is visible rather than silent. `.latest` keeps the last good value
  // on screen while the next one loads; `.loading` still drives the explicit spinners.
  // Ported from outside contribution #11 by @DassaultFalconKing.
  const shape = (p: PathLike | undefined) =>
    p?.virtual && p.virtualRoot
      ? {
          start: p.virtualRoot,
          roots: [] as readonly string[],
          home: "",
          places: [] as readonly { name: string; path: string }[],
        }
      : {
          start: p?.home || p?.directory || "",
          roots: p?.roots ?? [],
          home: p?.home ?? "",
          places: p?.places ?? [],
        }
  const [pathInfo] = createResource(ctx, async (c) => {
    const p = c.sync.data.path as PathLike | undefined
    if (p && (p.virtual ? p.virtualRoot : (p.home || p.directory) && p.roots?.length)) return shape(p)
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data as PathLike | undefined)
      .catch(() => undefined)
    return shape(got)
  })
  /**
   * A caller may say WHERE to open (`/files?path=…`).
   *
   * 🔴 This is how a colleague's workspace becomes browsable (owner, 2026-08-22: *"please ensure user
   * can browse the agent's Scratch folder"*). The scratch directory is a real host path the app
   * manages, so it needs no new browser — only a way to say "start here". Contacts links to it from
   * the colleague's own config, which is the only place the user knows whose workspace it is.
   *
   * ⚠️ It seeds ONCE, like the default start does, rather than tracking the param: the user navigates
   * away from here by clicking folders, and a reactive param would yank them back to the workspace
   * every time the route re-rendered.
   */
  const [params] = useSearchParams()
  createEffect(() => {
    const requested = typeof params.path === "string" ? params.path.trim() : ""
    const s = requested || pathInfo.latest?.start
    if (s && !dir()) setDir(s)
  })
  const roots = createMemo(() => pathInfo.latest?.roots ?? [])
  // The root the current dir lives under (case-insensitive — Windows drive letters), "" if unknown.
  const currentRoot = createMemo(() => {
    const d = dir().toLowerCase()
    return roots().find((r) => d.startsWith(r.toLowerCase())) ?? ""
  })

  // Places + Bookmarks rail (owner 2026-07-22) — the same sources the folder picker uses: the
  // instance host's existing well-known dirs (/path `places`) and the user's `folder_bookmarks`
  // config pins (instance-wide, agent-editable). One canonical slash-normalized key for compares.
  const pinKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const places = createMemo(() => pathInfo.latest?.places ?? [])
  const homeDir = createMemo(() => pathInfo.latest?.home ?? "")
  const bookmarks = createMemo(
    () =>
      ((ctx()?.sync.data.config as { folder_bookmarks?: readonly string[] } | undefined)?.folder_bookmarks ??
        []) as string[],
  )
  const isPinned = (target: string) => bookmarks().some((entry) => pinKey(entry) === pinKey(target))
  const writeBookmarks = (next: string[]) =>
    void (ctx()?.sync.updateConfig({ folder_bookmarks: next } as never) as Promise<unknown> | undefined)?.catch(
      () => undefined,
    )
  const toggleCurrentPin = () => {
    const target = pinKey(dir())
    if (!target) return
    writeBookmarks(
      isPinned(target) ? bookmarks().filter((entry) => pinKey(entry) !== target) : [...bookmarks(), target],
    )
  }
  const baseName = (value: string) => {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? value
  }
  const goTo = (target: string) => {
    setSelected(undefined)
    setActive(undefined)
    setDir(target)
  }

  // Whether the folder on screen is a Project. Files browses folders, so this is
  // the one surface where a person can SEE which of their folders carry a `novaclaw.json` without
  // turning on hidden files and reading it — and, when one is broken, that it is being ignored.
  const projectSource = createMemo(() => {
    const http = conn()?.http
    const directory = dir()
    return http && directory ? { http, directory } : undefined
  })
  const project = useProjectSummary(projectSource, "files")
  // `undefined` = the user has not decided, so the state decides. An unusable file opens itself:
  // it is the only state that needs acting on, and putting the remedy behind a click would make it
  // something to discover rather than something to fix. A click still closes it.
  const [projectOpen, setProjectOpen] = createSignal<boolean | undefined>(undefined)
  const projectExpanded = createMemo(() => projectOpen() ?? project()?.kind === "invalid")
  createEffect(() => {
    dir()
    setProjectOpen(undefined)
  })

  const operations = useFilesystemOperations({
    server: () => conn()?.http,
    changed: () => {
      setSelected(undefined)
      setActive(undefined)
      setContextMenu(undefined)
      setTick((value) => value + 1)
    },
  })

  const [entries] = createResource(
    () => {
      const c = ctx()
      const d = dir()
      return c && d ? { c, d, t: tick() } : undefined
    },
    async ({ c, d }) => {
      const rows = await c.sdk.client.file
        .list({ directory: d, path: "" })
        .then((r) => r.data as Entry[] | undefined)
        .catch(() => undefined)
      if (!rows) return undefined
      // 🔴 NC-REL-041: the value carries the directory it came from. Without it, `.latest` renders
      // one folder's rows under another folder's path during navigation — and those rows are LIVE:
      // open, rename and delete act on what you click. See `files-rows.ts`.
      return {
        directory: d,
        rows: [...rows].sort((a, b) =>
          a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name),
        ),
      }
    },
  )

  const isHiddenName = (name: string) =>
    name.startsWith(".") ||
    /^ntuser\./i.test(name) ||
    /^(desktop\.ini|thumbs\.db|\$recycle\.bin|pagefile\.sys|hiberfil\.sys|swapfile\.sys|system volume information)$/i.test(
      name,
    )
  const visibleEntries = createMemo(() => {
    // Stale-directory rows are dropped rather than shown: `.latest` is worth keeping WITHIN a
    // directory (no blank flash on refetch) and is never worth it across one.
    const list = rowsForDirectory(entries.latest, dir())
    if (!list || showHidden()) return list
    return list.filter((e) => !isHiddenName(e.name))
  })

  const [preview] = createResource(
    () => {
      const c = ctx()
      const e = selected()
      const d = dir()
      return c && d && e && e.type === "file" ? { c, d, e } : undefined
    },
    async ({ c, d, e }) => {
      const res = await c.sdk.client.file
        .read({ directory: d, path: e.name })
        .then((r) => r.data as { type?: string; content?: string; mimeType?: string } | undefined)
        .catch(() => undefined)
      if (!res) return { kind: "error" as const }
      // The file vanished between listing and click (deleted/renamed outside) — an honest
      // "can't read" beats rendering a phantom empty document.
      if (res.type === "missing") return { kind: "error" as const }
      if (res.type === "binary") return { kind: "binary" as const, mime: res.mimeType ?? "" }
      const text = res.content ?? ""
      const MAX = 100_000
      return {
        kind: "text" as const,
        text: text.length > MAX ? text.slice(0, MAX) : text,
        truncated: text.length > MAX,
      }
    },
  )

  /**
   * The Trash panel's data — global store (entries from any root), newest first; the directory
   * param is only for request routing.
   *
   * 🔴 It printed `"Trash is empty."` for a listing that FAILED, and the correct treatment was
   * already in this same file: the folder listing forty lines up distinguishes `files.cantRead` from
   * `files.empty`. The fix was made where the bug was reported and not where the class lives — which
   * is why the guard exists one site over so often that it has a name.
   *
   * ⚠️ No `.catch` in the fetcher: `createSettledResource` owns the rejection, and a fetcher that
   * swallows it hides the failure from `failed` and puts the same lie back.
   */
  const [trashEntries] = createSettledResource(
    () => {
      const cn = conn()
      const d = dir()
      return cn && d && showTrash() ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => fsTrashList(cn.http, { directory: d }),
  )
  const trashListing = createListState<TrashEntry>(trashEntries)
  const trashLoaded = createMemo(() => {
    const state = trashListing()
    return state.kind === "loaded" ? state.items : undefined
  })

  async function doRestore(id: string) {
    const cn = conn()
    if (!cn || !dir()) return
    try {
      await fsTrashRestore(cn.http, { directory: dir(), id })
    } catch (error) {
      showToast({ variant: "error", title: language.t("files.restoreFailed"), description: String(error) })
      return
    }
    setTick((t) => t + 1)
  }

  function open(entry: Entry) {
    setActive(entry)
    if (entry.type === "directory") {
      setSelected(undefined)
      setActive(undefined)
      setDir(entry.absolute)
    } else {
      setSelected(entry)
    }
  }
  function up() {
    const p = parentDir(dir())
    if (!p) return
    setSelected(undefined)
    setActive(undefined)
    setDir(p)
  }

  const operationTarget = (entry: Entry): FilesystemTarget => ({ path: entry.absolute, type: entry.type })
  const openContextMenu = (event: MouseEvent, entry: Entry) => {
    event.preventDefault()
    setActive(entry)
    if (entry.type === "file") setSelected(entry)
    setContextMenu({ x: event.clientX, y: event.clientY, entry })
  }
  const handleShortcut = (event: KeyboardEvent) => {
    if (event.key === "Escape" && contextMenu()) {
      event.preventDefault()
      setContextMenu(undefined)
      return
    }
    const action = filesystemShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      editable: isEditableFilesystemTarget(event.target),
    })
    if (!action) return
    if (action !== "new-folder" && !active()) return
    event.preventDefault()
    if (action === "new-folder") void operations.createFolder(dir())
    if (action === "rename") void operations.rename(operationTarget(active()!))
    if (action === "delete") void operations.trash(operationTarget(active()!))
  }
  // Open a pre-filled chat draft asking the agent to look at the target. Opens the current directory
  // as a project (a chat needs a working dir), then hands newDraft the seed prompt (adds ?prompt=).
  function askAI(target: string) {
    const c = ctx()
    const cn = conn()
    if (!c || !cn) return
    c.projects.open(dir())
    c.projects.touch(dir())
    tabs.newDraft(
      { server: ServerConnection.key(cn), directory: dir() },
      `Look at ${target} and tell me what it is and anything noteworthy about it.`,
    )
  }

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <AppPage
      class="flex flex-col overflow-hidden"
      tabIndex={0}
      onKeyDown={handleShortcut}
      onPointerDown={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-files-context-menu]"))
          setContextMenu(undefined)
      }}
    >
      <AppPageHeader glyph="files" title={language.t("files.title")}>
        <button type="button" class={btn} onClick={up} disabled={!parentDir(dir())}>
          {language.t("files.up")}
        </button>
        <button
          type="button"
          class={btn}
          onClick={() => void operations.createFolder(dir())}
          disabled={!conn() || !dir()}
        >
          {language.t("files.newFolder")}
        </button>
        <Show when={roots().length > 1}>
          <SelectV2
            appearance="inline"
            class="max-w-[9rem]"
            valueClass="font-mono text-xs text-v2-text-text-muted"
            title={language.t("files.drives")}
            aria-label={language.t("files.drives")}
            options={roots()}
            current={currentRoot()}
            onSelect={(root) => {
              if (!root) return
              setSelected(undefined)
              setDir(root)
            }}
          />
        </Show>
        <button
          type="button"
          class={btn}
          classList={{ "bg-v2-background-bg-layer-02": isPinned(dir()) }}
          aria-pressed={isPinned(dir())}
          title={language.t(isPinned(dir()) ? "dialog.directory.unpin" : "dialog.directory.pin")}
          onClick={toggleCurrentPin}
          disabled={!ctx() || !dir()}
        >
          {language.t(isPinned(dir()) ? "dialog.directory.pinnedShort" : "dialog.directory.pinShort")}
        </button>
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-v2-text-text-faint">{dir() || "…"}</span>
        <Show when={project()}>
          {(summary) => (
            <button
              type="button"
              data-action="files-project"
              class="flex shrink-0 items-center rounded-md transition-opacity hover:opacity-80"
              aria-expanded={projectExpanded()}
              aria-label={language.t("files.project.details")}
              title={language.t("files.project.details")}
              onClick={() => setProjectOpen(!projectExpanded())}
            >
              <ProjectChip summary={summary()} />
            </button>
          )}
        </Show>
        <button
          type="button"
          class={btn}
          classList={{ "bg-v2-background-bg-layer-02": showHidden() }}
          aria-pressed={showHidden()}
          onClick={() => setShowHidden((v) => !v)}
        >
          {language.t("files.showHidden")}
        </button>
        <button
          type="button"
          class={btn}
          classList={{ "bg-v2-background-bg-layer-02": showTrash() }}
          onClick={() => setShowTrash((v) => !v)}
          disabled={!conn() || !dir()}
          data-slot="files-trash-toggle"
        >
          {language.t("files.trash")}
        </button>
        <button type="button" class={btn} onClick={() => askAI(dir())} disabled={!ctx() || !dir()}>
          {language.t("files.askAiFolder")}
        </button>
      </AppPageHeader>

      <Show when={projectExpanded() && project()}>
        {(summary) => (
          <div
            data-component="files-project-detail"
            class="border-b border-v2-border-border-base px-4 py-2.5"
            classList={{ "bg-v2-state-bg-warning/10": summary().kind === "invalid" }}
          >
            <ProjectDetail summary={summary()} showChip={false} />
          </div>
        )}
      </Show>

      <div class="flex min-h-0 flex-1">
        <div class="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-v2-border-border-base p-2">
          <Show when={bookmarks().length > 0}>
            <div class="px-1.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
              {language.t("dialog.directory.bookmarks")}
            </div>
            <For each={bookmarks()}>
              {(pin) => (
                <div
                  class="group/pin flex min-w-0 items-center rounded-md text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-01"
                  classList={{ "bg-v2-background-bg-layer-01 text-v2-text-text-base": pinKey(dir()) === pinKey(pin) }}
                  title={pin}
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-1.5 py-1 text-left"
                    onClick={() => goTo(pin)}
                  >
                    <Icon name="folder" size="normal" class="shrink-0" />
                    <span class="truncate">{baseName(pin)}</span>
                  </button>
                  <button
                    type="button"
                    class="hidden shrink-0 px-1 text-v2-text-text-faint hover:text-v2-text-text-base group-hover/pin:block"
                    aria-label={language.t("dialog.directory.unpin")}
                    onClick={() => writeBookmarks(bookmarks().filter((entry) => pinKey(entry) !== pinKey(pin)))}
                  >
                    <Icon name="close-small" size="normal" />
                  </button>
                </div>
              )}
            </For>
          </Show>
          <div class="px-1.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
            {language.t("dialog.directory.places")}
          </div>
          <Show when={homeDir()}>
            <button
              type="button"
              class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-01"
              classList={{ "bg-v2-background-bg-layer-01 text-v2-text-text-base": pinKey(dir()) === pinKey(homeDir()) }}
              title={homeDir()}
              onClick={() => goTo(homeDir())}
            >
              <Icon name="folder" size="normal" class="shrink-0" />
              <span class="truncate">{language.t("dialog.directory.homePlace")}</span>
            </button>
          </Show>
          <For each={places()}>
            {(place) => (
              <button
                type="button"
                class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-01"
                classList={{
                  "bg-v2-background-bg-layer-01 text-v2-text-text-base": pinKey(dir()) === pinKey(place.path),
                }}
                title={place.path}
                onClick={() => goTo(place.path)}
              >
                <Icon name="folder" size="normal" class="shrink-0" />
                <span class="truncate">{place.name}</span>
              </button>
            )}
          </For>
        </div>
        <div
          class="w-1/2 min-w-0 overflow-auto border-r border-v2-border-border-base py-1"
          onContextMenu={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-files-entry]")) return
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <Show
            when={visibleEntries()}
            fallback={
              <div class="px-4 py-3 text-sm text-v2-text-text-faint">
                {entries.loading ? language.t("files.loading") : language.t("files.cantRead")}
              </div>
            }
          >
            <Show
              when={visibleEntries()!.length}
              fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.empty")}</div>}
            >
              <For each={visibleEntries()}>
                {(entry) => (
                  <div
                    data-files-entry
                    class="group flex w-full items-center hover:bg-v2-background-bg-layer-02"
                    classList={{
                      "opacity-50": entry.ignored,
                      "bg-v2-background-bg-layer-02": active()?.absolute === entry.absolute,
                    }}
                    onContextMenu={(event) => openContextMenu(event, entry)}
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-left text-sm"
                      onClick={() => open(entry)}
                      onFocus={() => setActive(entry)}
                    >
                      <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                        <Icon name="folder" size="normal" class="shrink-0 text-v2-text-text-muted" />
                      </Show>
                      <span class="truncate">{entry.name}</span>
                    </button>
                    {/* Hover-revealed SAFE delete — moves into the restorable Trash, never destroys. */}
                    <button
                      type="button"
                      class="mr-2 hidden shrink-0 rounded p-1 text-v2-text-text-faint transition-colors hover:text-v2-state-fg-danger group-hover:block"
                      title={language.t("files.delete")}
                      aria-label={`${language.t("files.delete")} ${entry.name}`}
                      onClick={() => void operations.trash(operationTarget(entry))}
                    >
                      <Icon name="trash" size="normal" />
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="flex w-1/2 min-w-0 flex-col">
          <Show when={showTrash()}>
            <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-2">
              <Icon name="trash" size="normal" class="shrink-0 text-v2-text-text-muted" />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{language.t("files.trash")}</span>
              <span class="text-xs text-v2-text-text-faint">
                {language.t("files.trashHint", { days: trashRetentionDays() })}
              </span>
            </div>
            <div class="min-h-0 flex-1 overflow-auto py-1">
              <Switch
                fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.loading")}</div>}
              >
                <Match when={trashListing().kind === "failed"}>
                  <div class="px-4 py-3 text-sm text-v2-state-fg-danger" data-slot="files-trash-failed">
                    {language.t("files.trashLoadFailed")}
                  </div>
                </Match>
                <Match when={trashListing().kind === "empty"}>
                  <div class="px-4 py-3 text-sm text-v2-text-text-faint" data-slot="files-trash-empty">
                    {language.t("files.trashEmpty")}
                  </div>
                </Match>
                <Match when={trashLoaded()}>
                  {(rows) => (
                    <For each={rows()}>
                      {(entry) => (
                        <div class="flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-v2-background-bg-layer-02">
                          <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                            <Icon name="folder" size="normal" class="shrink-0 text-v2-text-text-muted" />
                          </Show>
                          <span class="min-w-0 flex-1 truncate" title={entry.originalPath}>
                            {entry.originalPath}
                          </span>
                          <span class="shrink-0 text-xs text-v2-text-text-faint">
                            {Timestamp.toDate(entry.trashedAt)?.toLocaleString() ?? "—"}
                          </span>
                          <button type="button" class={btn} onClick={() => void doRestore(entry.id)}>
                            {language.t("files.restore")}
                          </button>
                        </div>
                      )}
                    </For>
                  )}
                </Match>
              </Switch>
            </div>
          </Show>
          <Show
            when={!showTrash() && selected()}
            fallback={
              <Show when={!showTrash()}>
                <div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.selectHint")}</div>
              </Show>
            }
          >
            <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-2">
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{selected()!.name}</span>
              <button type="button" class={btn} onClick={() => askAI(selected()!.absolute)}>
                {language.t("files.askAiFile")}
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-auto">
              <Show
                when={preview.latest}
                fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.loading")}</div>}
              >
                {(pv) => (
                  <Switch>
                    <Match when={pv().kind === "text"}>
                      <pre class="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed">
                        {(pv() as { text: string }).text}
                        <Show when={(pv() as { truncated?: boolean }).truncated}>
                          {"\n\n"}
                          <span class="text-v2-text-text-faint">… ({language.t("files.truncated")})</span>
                        </Show>
                      </pre>
                    </Match>
                    <Match when={pv().kind === "binary"}>
                      <div class="px-4 py-3 text-sm text-v2-text-text-muted">
                        {language.t("files.binary")} {(pv() as { mime?: string }).mime}
                      </div>
                    </Match>
                    <Match when={pv().kind === "error"}>
                      <div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.cantRead")}</div>
                    </Match>
                  </Switch>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            data-files-context-menu
            role="menu"
            class="fixed z-60 flex min-w-48 flex-col rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02 p-1 shadow-[var(--v2-elevation-overlay)]"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
          >
            <div class="truncate px-2 py-1 text-[11px] text-v2-text-text-faint" title={menu().entry?.absolute ?? dir()}>
              {menu().entry?.name ?? dir()}
            </div>
            <button
              type="button"
              role="menuitem"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => {
                setContextMenu(undefined)
                void operations.createFolder(dir())
              }}
            >
              {language.t("files.newFolder")} <span class="ml-auto text-v2-text-text-faint">Ctrl+Shift+N</span>
            </button>
            <Show when={menu().entry}>
              {(entry) => (
                <>
                  {/* 🔴 DOWNLOAD — the point of browsing a colleague's workspace when it is on
                      another machine (owner, 2026-08-22: *"any reports and results the agent has
                      prepared, when the user and the agent are on different machines"*). Until this
                      existed the browser could SHOW a text file and nothing else: a PDF, a rendered
                      chart or an archive was visible and unobtainable.

                      ⚠️ **Still a browser download, and still streaming** — `downloadHostPath` mints
                      a ticket and hands the browser a URL with the file's own name on it. A
                      fetch-and-save was never an option here: a report, an archive or a video must
                      not have to fit in a JS string, which is exactly why this half could not take
                      the `data:` answer the chat's IMAGES did.

                      🔴 **A button, because the href was the bug.** It was an `<a href download>`,
                      and a `download` href is fetched by the BROWSER — which sends no
                      `Authorization`, so on any instance with a server password this saved the 401
                      body under the file's own name. There is nothing left to put an unauthorized
                      URL into. Directories are excluded — there is nothing to stream. */}
                  <Show when={entry().type === "file"}>
                    <button
                      type="button"
                      role="menuitem"
                      data-action="download-file"
                      class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-v2-overlay-simple-overlay-hover"
                      onClick={() => {
                        setContextMenu(undefined)
                        downloadHostPath(entry().absolute)
                      }}
                    >
                      {language.t("files.download")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    role="menuitem"
                    class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-v2-overlay-simple-overlay-hover"
                    onClick={() => {
                      setContextMenu(undefined)
                      void operations.rename(operationTarget(entry()))
                    }}
                  >
                    {language.t("files.rename")} <span class="ml-auto text-v2-text-text-faint">F2</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-v2-state-fg-danger hover:bg-v2-overlay-simple-overlay-hover"
                    onClick={() => {
                      setContextMenu(undefined)
                      void operations.trash(operationTarget(entry()))
                    }}
                  >
                    {language.t("files.delete")} <span class="ml-auto text-v2-text-text-faint">Del</span>
                  </button>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    </AppPage>
  )
}
