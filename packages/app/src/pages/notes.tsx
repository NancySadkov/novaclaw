import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { fsMkdir, fsWrite } from "@/utils/fs-api"

// The Notes app (B6 v1 — plan.md M5). One shared server-side `notes/` folder under the server's
// data root (Global.Path.data/notes) that agents can also read/append (the B3 base prompt states
// it's shared). Lists *.md notes, opens the last-used one (localStorage), edits in a textarea with
// debounced autosave. No delete UI — deletion is the Trash tool's concern (B8).
type Entry = { name: string; path: string; absolute: string; type: "file" | "directory"; ignored: boolean }

const LAST_KEY = "novaclaw.notes.last"
const AUTOSAVE_MS = 800

function sanitizeName(raw: string): string | undefined {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9-_ ]/g, "")
    .trim()
  return base ? `${base}.md` : undefined
}

export function NotesPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })

  const [current, setCurrent] = createSignal<string | undefined>(undefined)
  const [text, setText] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  const [naming, setNaming] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  // Resolve the notes dir: the server data root (PathInfo.data — read via cast, the generated SDK
  // type predates the field) + "/notes", created idempotently on first visit.
  const [notesDir] = createResource(ctx, async (c) => {
    const info = await c.sdk.client.path
      .get()
      .then((r) => r.data as { data?: string; home?: string } | undefined)
      .catch(() => undefined)
    const data = info?.data
    if (!data) return undefined
    const cn = conn()
    if (!cn) return undefined
    await fsMkdir(cn.http, { directory: data, path: "notes" }).catch(() => undefined)
    return `${data.replace(/[\\/]+$/, "")}/notes`
  })

  const [entries, { refetch: refetchEntries }] = createResource(
    () => {
      const c = ctx()
      const d = notesDir()
      return c && d ? { c, d, t: tick() } : undefined
    },
    async ({ c, d }) => {
      const rows = await c.sdk.client.file
        .list({ directory: d, path: "" })
        .then((r) => r.data as Entry[] | undefined)
        .catch(() => undefined)
      return (rows ?? [])
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  )

  // Serialized autosave: one promise chain per page so two writes to the same file never overlap
  // (a last-write-wins race truncates); the debounce timer flushes on unmount/navigation.
  let saveChain: Promise<unknown> = Promise.resolve()
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  function enqueueSave(name: string, content: string) {
    const cn = conn()
    const d = notesDir()
    if (!cn || !d) return
    saveChain = saveChain
      .then(() => fsWrite(cn.http, { directory: d, path: name, content }))
      .then(() => setDirty(false))
      .catch(() => undefined)
  }
  function scheduleSave() {
    const name = current()
    if (!name) return
    setDirty(true)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      enqueueSave(name, text())
    }, AUTOSAVE_MS)
  }
  function flushSave() {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = undefined
    const name = current()
    if (name && dirty()) enqueueSave(name, text())
  }
  onCleanup(flushSave)

  async function openNote(name: string) {
    flushSave()
    const c = ctx()
    const d = notesDir()
    if (!c || !d) return
    const res = await c.sdk.client.file
      .read({ directory: d, path: name })
      .then((r) => r.data as { type?: string; content?: string } | undefined)
      .catch(() => undefined)
    setCurrent(name)
    setText(res?.type === "text" ? (res.content ?? "") : "")
    setDirty(false)
    localStorage.setItem(LAST_KEY, name)
  }

  async function createNote(raw: string) {
    const name = sanitizeName(raw)
    const cn = conn()
    const d = notesDir()
    if (!name || !cn || !d) return
    setNaming(false)
    if (!entries()?.some((e) => e.name === name)) {
      await fsWrite(cn.http, { directory: d, path: name, content: "" }).catch(() => undefined)
      setTick((t) => t + 1)
      await refetchEntries()
    }
    await openNote(name)
  }

  // First load: open last-used when it still exists, else the first note, else create notes.md.
  let booted = false
  createEffect(() => {
    const list = entries()
    if (booted || !list || entries.loading) return
    booted = true
    const last = localStorage.getItem(LAST_KEY)
    if (last && list.some((e) => e.name === last)) void openNote(last)
    else if (list.length) void openNote(list[0].name)
    else void createNote("notes")
  })

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <div class="flex h-full flex-col bg-v2-background-bg-deep text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="edit" class="size-5 shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">{language.t("notes.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{language.t("notes.hint")}</span>
        <Show when={current()}>
          <span class="shrink-0 text-xs text-v2-text-text-faint">
            {dirty() ? language.t("notes.saving") : language.t("notes.saved")}
          </span>
        </Show>
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="flex w-56 shrink-0 flex-col border-r border-v2-border-border-base">
          <div class="px-2 py-2">
            <Show
              when={naming()}
              fallback={
                <button type="button" class={btn} onClick={() => setNaming(true)} disabled={!notesDir()}>
                  {language.t("notes.new")}
                </button>
              }
            >
              <input
                type="text"
                autofocus
                placeholder={language.t("notes.namePlaceholder")}
                class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-sm outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createNote(e.currentTarget.value)
                  if (e.key === "Escape") setNaming(false)
                }}
                onBlur={() => setNaming(false)}
              />
            </Show>
          </div>
          <div class="min-h-0 flex-1 overflow-auto py-1">
            <Show
              when={entries()?.length}
              fallback={
                <div class="px-4 py-2 text-sm text-v2-text-text-faint">
                  {entries.loading ? language.t("notes.loading") : language.t("notes.empty")}
                </div>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <button
                    type="button"
                    class="block w-full truncate px-4 py-1.5 text-left text-sm hover:bg-v2-background-bg-layer-02"
                    classList={{ "bg-v2-background-bg-layer-02": current() === entry.name }}
                    onClick={() => void openNote(entry.name)}
                  >
                    {entry.name.replace(/\.md$/, "")}
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={current()}
            fallback={
              <div class="px-4 py-3 text-sm text-v2-text-text-faint">
                {notesDir.loading || entries.loading ? language.t("notes.loading") : language.t("notes.empty")}
              </div>
            }
          >
            <textarea
              class="h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed outline-none"
              placeholder={language.t("notes.placeholder")}
              value={text()}
              onInput={(e) => {
                setText(e.currentTarget.value)
                scheduleSave()
              }}
            />
          </Show>
        </div>
      </div>
    </div>
  )
}
