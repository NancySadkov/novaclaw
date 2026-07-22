import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fsTrash, fsTrashList, fsTrashRestore } from "@/utils/fs-api"

// The Files app (B7 + the B8 Trash surface — plan.md M3/M4). Browses the SERVER host's filesystem
// via the same V1 /file endpoints the directory picker uses (sdk.client.file.list / .read,
// directory = any absolute host path); navigate folders, preview text files, "Ask AI" (opens a
// pre-filled chat draft — the OS spawn/chat seam). Deletion is SAFE-delete only: rows trash via
// POST /file/trash (dated store, ~2-day TTL) and the Trash panel restores — no destructive path.
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

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })

  const [dir, setDir] = createSignal("")
  const [selected, setSelected] = createSignal<Entry | undefined>(undefined)
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
  const shape = (p: PathLike | undefined) =>
    p?.virtual && p.virtualRoot
      ? { start: p.virtualRoot, roots: [] as readonly string[], home: "", places: [] as readonly { name: string; path: string }[] }
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
  createEffect(() => {
    const s = pathInfo()?.start
    if (s && !dir()) setDir(s)
  })
  const roots = createMemo(() => pathInfo()?.roots ?? [])
  // The root the current dir lives under (case-insensitive — Windows drive letters), "" if unknown.
  const currentRoot = createMemo(() => {
    const d = dir().toLowerCase()
    return roots().find((r) => d.startsWith(r.toLowerCase())) ?? ""
  })

  // Places + Bookmarks rail (owner 2026-07-22) — the same sources the folder picker uses: the
  // instance host's existing well-known dirs (/path `places`) and the user's `folder_bookmarks`
  // config pins (instance-wide, agent-editable). One canonical slash-normalized key for compares.
  const pinKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const places = createMemo(() => pathInfo()?.places ?? [])
  const homeDir = createMemo(() => pathInfo()?.home ?? "")
  const bookmarks = createMemo(
    () => ((ctx()?.sync.data.config as { folder_bookmarks?: readonly string[] } | undefined)?.folder_bookmarks ?? []) as string[],
  )
  const isPinned = (target: string) => bookmarks().some((entry) => pinKey(entry) === pinKey(target))
  const writeBookmarks = (next: string[]) =>
    void (ctx()?.sync.updateConfig({ folder_bookmarks: next } as never) as Promise<unknown> | undefined)?.catch(
      () => undefined,
    )
  const toggleCurrentPin = () => {
    const target = pinKey(dir())
    if (!target) return
    writeBookmarks(isPinned(target) ? bookmarks().filter((entry) => pinKey(entry) !== target) : [...bookmarks(), target])
  }
  const baseName = (value: string) => {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? value
  }
  const goTo = (target: string) => {
    setSelected(undefined)
    setDir(target)
  }

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
      return [...rows].sort((a, b) =>
        a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name),
      )
    },
  )

  const isHiddenName = (name: string) =>
    name.startsWith(".") ||
    /^ntuser\./i.test(name) ||
    /^(desktop\.ini|thumbs\.db|\$recycle\.bin|pagefile\.sys|hiberfil\.sys|swapfile\.sys|system volume information)$/i.test(
      name,
    )
  const visibleEntries = createMemo(() => {
    const list = entries()
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

  // The Trash panel's data — global store (entries from any root), newest first; the directory
  // param is only for request routing.
  const [trashEntries] = createResource(
    () => {
      const cn = conn()
      const d = dir()
      return cn && d && showTrash() ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => fsTrashList(cn.http, { directory: d }).catch(() => undefined),
  )

  async function doTrash(entry: Entry) {
    const cn = conn()
    if (!cn || !dir()) return
    try {
      await fsTrash(cn.http, { directory: dir(), path: entry.name })
    } catch (error) {
      // Don't fail silently — a delete that didn't happen must say so (SP5).
      showToast({ variant: "error", title: language.t("files.trashFailed"), description: String(error) })
      return
    }
    if (selected()?.absolute === entry.absolute) setSelected(undefined)
    setTick((t) => t + 1)
  }

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
    if (entry.type === "directory") {
      setSelected(undefined)
      setDir(entry.absolute)
    } else {
      setSelected(entry)
    }
  }
  function up() {
    const p = parentDir(dir())
    if (!p) return
    setSelected(undefined)
    setDir(p)
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
    <div class="flex min-h-0 flex-1 flex-col self-stretch m-2 rounded-[10px] overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="folder-add-left" size="normal" class="shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">{language.t("files.title")}</span>
        <button type="button" class={btn} onClick={up} disabled={!parentDir(dir())}>
          {language.t("files.up")}
        </button>
        <Show when={roots().length > 1}>
          <select
            class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-1.5 py-1 text-xs text-v2-text-text-muted outline-none"
            title={language.t("files.drives")}
            value={currentRoot()}
            onChange={(e) => {
              setSelected(undefined)
              setDir(e.currentTarget.value)
            }}
          >
            <For each={roots()}>{(root) => <option value={root}>{root}</option>}</For>
          </select>
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
        >
          {language.t("files.trash")}
        </button>
        <button type="button" class={btn} onClick={() => askAI(dir())} disabled={!ctx() || !dir()}>
          {language.t("files.askAiFolder")}
        </button>
      </div>

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
                    <Icon name="folder" size="small" class="shrink-0" />
                    <span class="truncate">{baseName(pin)}</span>
                  </button>
                  <button
                    type="button"
                    class="hidden shrink-0 px-1 text-v2-text-text-faint hover:text-v2-text-text-base group-hover/pin:block"
                    aria-label={language.t("dialog.directory.unpin")}
                    onClick={() => writeBookmarks(bookmarks().filter((entry) => pinKey(entry) !== pinKey(pin)))}
                  >
                    <Icon name="close-small" size="small" />
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
              <Icon name="folder" size="small" class="shrink-0" />
              <span class="truncate">{language.t("dialog.directory.homePlace")}</span>
            </button>
          </Show>
          <For each={places()}>
            {(place) => (
              <button
                type="button"
                class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-01"
                classList={{ "bg-v2-background-bg-layer-01 text-v2-text-text-base": pinKey(dir()) === pinKey(place.path) }}
                title={place.path}
                onClick={() => goTo(place.path)}
              >
                <Icon name="folder" size="small" class="shrink-0" />
                <span class="truncate">{place.name}</span>
              </button>
            )}
          </For>
        </div>
        <div class="w-1/2 min-w-0 overflow-auto border-r border-v2-border-border-base py-1">
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
                    class="group flex w-full items-center hover:bg-v2-background-bg-layer-02"
                    classList={{
                      "opacity-50": entry.ignored,
                      "bg-v2-background-bg-layer-02": selected()?.absolute === entry.absolute,
                    }}
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-left text-sm"
                      onClick={() => open(entry)}
                    >
                      <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                        <Icon name="folder" size="small" class="shrink-0 text-v2-text-text-muted" />
                      </Show>
                      <span class="truncate">{entry.name}</span>
                    </button>
                    {/* Hover-revealed SAFE delete — moves into the restorable Trash, never destroys. */}
                    <button
                      type="button"
                      class="mr-2 hidden shrink-0 rounded p-1 text-v2-text-text-faint transition-colors hover:text-v2-state-fg-danger group-hover:block"
                      title={language.t("files.delete")}
                      aria-label={`${language.t("files.delete")} ${entry.name}`}
                      onClick={() => void doTrash(entry)}
                    >
                      <Icon name="trash" size="small" />
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
              <Icon name="trash" size="small" class="shrink-0 text-v2-text-text-muted" />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{language.t("files.trash")}</span>
              <span class="text-xs text-v2-text-text-faint">{language.t("files.trashHint")}</span>
            </div>
            <div class="min-h-0 flex-1 overflow-auto py-1">
              <Show
                when={trashEntries()}
                fallback={
                  <div class="px-4 py-3 text-sm text-v2-text-text-faint">
                    {trashEntries.loading ? language.t("files.loading") : language.t("files.trashEmpty")}
                  </div>
                }
              >
                <Show
                  when={trashEntries()!.length}
                  fallback={
                    <div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.trashEmpty")}</div>
                  }
                >
                  <For each={trashEntries()}>
                    {(entry) => (
                      <div class="flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-v2-background-bg-layer-02">
                        <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                          <Icon name="folder" size="small" class="shrink-0 text-v2-text-text-muted" />
                        </Show>
                        <span class="min-w-0 flex-1 truncate" title={entry.originalPath}>
                          {entry.originalPath}
                        </span>
                        <span class="shrink-0 text-xs text-v2-text-text-faint">
                          {new Date(entry.trashedAt).toLocaleString()}
                        </span>
                        <button type="button" class={btn} onClick={() => void doRestore(entry.id)}>
                          {language.t("files.restore")}
                        </button>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
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
                when={preview()}
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
    </div>
  )
}
