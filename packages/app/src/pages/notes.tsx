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
  // Keep Unicode letters/digits (Cyrillic, CJK, accents) — only strip characters a filesystem can't
  // hold. The old `[^a-z0-9-_ ]` filter silently discarded any non-ASCII name (SP6).
  const base = raw
    .trim()
    .replace(/\.md$/i, "")
    // eslint-disable-next-line no-control-regex -- intentionally strip control chars from filenames
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
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
  const [saveFailed, setSaveFailed] = createSignal(false)
  const [naming, setNaming] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  // True while a note's content is loading; the textarea is read-only during it so keystrokes
  // can never land in a half-switched binding (the "New note overwrites the open note" data loss).
  const [noteLoading, setNoteLoading] = createSignal(false)

  // Resolve the notes dir: the server data root (PathInfo.data — read via cast, the generated SDK
  // type predates the field) + "/notes", created idempotently on first visit. FS-3 (T7): under
  // virtual mode, notes live in the app-private virtual root's own notes subdir instead.
  const [notesDir] = createResource(ctx, async (c) => {
    const info = await c.sdk.client.path
      .get()
      .then((r) => r.data as { data?: string; home?: string; virtual?: boolean; virtualRoot?: string } | undefined)
      .catch(() => undefined)
    const data = info?.virtual && info.virtualRoot ? info.virtualRoot : info?.data
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
      .then(() => {
        setDirty(false)
        setSaveFailed(false)
      })
      // Surface the failure instead of leaving the indicator stuck at "Saving…" forever (SP5).
      .catch(() => setSaveFailed(true))
  }
  function scheduleSave() {
    const name = current()
    if (!name) return
    setDirty(true)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      // The closure pairs the note NAME captured at schedule time with text() read at fire
      // time — if the bound note changed in between, that pairing would smear one note's
      // text into another's file. A switch always flushes synchronously first (openNote),
      // so a stale-name fire is safe to drop.
      if (current() !== name) return
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
    // Flush the outgoing note's pending edit BEFORE any binding changes, while name+text are
    // still a consistent pair; then rebind immediately so nothing typed during the load can
    // ever be attributed to the previous note (the editor is read-only until the load lands).
    flushSave()
    const c = ctx()
    const d = notesDir()
    if (!c || !d) return
    setNoteLoading(true)
    setCurrent(name)
    setText("")
    setDirty(false)
    const res = await c.sdk.client.file
      .read({ directory: d, path: name })
      .then((r) => r.data as { type?: string; content?: string } | undefined)
      .catch(() => undefined)
    // Only lay the content in if this note is still the bound one (a faster later switch wins).
    if (current() === name) {
      setText(res?.type === "text" ? (res.content ?? "") : "")
      setNoteLoading(false)
    }
    localStorage.setItem(LAST_KEY, name)
  }

  async function createNote(raw: string) {
    const name = sanitizeName(raw)
    const c = ctx()
    const cn = conn()
    const d = notesDir()
    if (!name || !c || !cn || !d) return
    setNaming(false)
    // Existence check against a FRESH server listing — not the entries() cache (undefined while
    // the resource (re)loads; trusting it here used to truncate an existing note with ""), and
    // not /file/content (it answers {type:"text",content:""} for MISSING files — file.ts:99 —
    // so a read can never distinguish absent from empty).
    const listing = await c.sdk.client.file
      .list({ directory: d, path: "" })
      .then((r) => r.data as Entry[] | undefined)
      .catch(() => undefined)
    if (!listing) {
      // Can't tell whether the name exists — creating blind could truncate a real note.
      setSaveFailed(true)
      return
    }
    if (!listing.some((e) => e.type === "file" && e.name === name)) {
      const created = await fsWrite(cn.http, { directory: d, path: name, content: "" }).then(
        () => true,
        () => false,
      )
      if (!created) {
        // Creating failed — surface it and keep the previous note bound rather than pointing
        // the editor at a file that doesn't exist (typed text would have nowhere real to go).
        setSaveFailed(true)
        return
      }
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
    <div class="flex min-h-0 flex-1 flex-col self-stretch m-2 rounded-[10px] overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="edit" size="normal" class="shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">{language.t("notes.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{language.t("notes.hint")}</span>
        <Show when={current()}>
          <span
            class="shrink-0 text-xs"
            classList={{
              "text-v2-state-fg-danger": saveFailed(),
              "text-v2-text-text-faint": !saveFailed(),
            }}
          >
            {saveFailed()
              ? language.t("notes.saveFailed")
              : dirty()
                ? language.t("notes.saving")
                : language.t("notes.saved")}
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
                // The autofocus ATTRIBUTE only applies during document parse — on a
                // conditionally-rendered element it silently does nothing (focus stays on
                // body, the typed name goes nowhere and the user's next keystrokes land in
                // the editor, still bound to the previous note). Focus explicitly instead.
                ref={(el) => setTimeout(() => el.focus())}
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
              placeholder={noteLoading() ? language.t("notes.loading") : language.t("notes.placeholder")}
              value={text()}
              readOnly={noteLoading()}
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
