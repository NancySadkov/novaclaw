import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"

// The Files app (B7 v1 — plan.md M3). Browses the SERVER host's filesystem via the same V1 /file
// endpoints the directory picker uses (sdk.client.file.list / .read, directory = any absolute host
// path). Read-only for now: navigate folders, preview text files, and "Ask AI" which opens a
// pre-filled chat draft (the OS spawn/chat seam). Write/delete arrive with M4 (Trash).
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

  // Resolve a starting directory: the server's known home/cwd, else ask /path (authoritative).
  const [startDir] = createResource(ctx, async (c) => {
    const p = c.sync.data.path
    if (p && (p.home || p.directory)) return p.home || p.directory
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data)
      .catch(() => undefined)
    return got?.home || got?.directory || ""
  })
  createEffect(() => {
    const s = startDir()
    if (s && !dir()) setDir(s)
  })

  const [entries] = createResource(
    () => {
      const c = ctx()
      const d = dir()
      return c && d ? { c, d } : undefined
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
    <div class="flex h-full flex-col bg-v2-background-bg-deep text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="folder-add-left" class="size-5 shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">{language.t("files.title")}</span>
        <button type="button" class={btn} onClick={up} disabled={!parentDir(dir())}>
          {language.t("files.up")}
        </button>
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-v2-text-text-faint">{dir() || "…"}</span>
        <button type="button" class={btn} onClick={() => askAI(dir())} disabled={!ctx() || !dir()}>
          {language.t("files.askAiFolder")}
        </button>
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="w-1/2 min-w-0 overflow-auto border-r border-v2-border-border-base py-1">
          <Show
            when={entries()}
            fallback={
              <div class="px-4 py-3 text-sm text-v2-text-text-faint">
                {entries.loading ? language.t("files.loading") : language.t("files.cantRead")}
              </div>
            }
          >
            <Show
              when={entries()!.length}
              fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.empty")}</div>}
            >
              <For each={entries()}>
                {(entry) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-v2-background-bg-layer-02"
                    classList={{
                      "opacity-50": entry.ignored,
                      "bg-v2-background-bg-layer-02": selected()?.absolute === entry.absolute,
                    }}
                    onClick={() => open(entry)}
                  >
                    <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                      <Icon name="folder" class="size-4 shrink-0 text-v2-text-text-muted" />
                    </Show>
                    <span class="truncate">{entry.name}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="flex w-1/2 min-w-0 flex-col">
          <Show
            when={selected()}
            fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("files.selectHint")}</div>}
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
