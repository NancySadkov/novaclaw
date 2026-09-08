import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createAutosave } from "./notes-autosave"
import { GoldGlyph } from "@/components/gold-glyph"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { fsMkdir, fsWrite } from "@/utils/fs-api"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"

// The Notes app (B6 v1 — plan.md M5). One shared server-side `notes/` folder under the server's
// data root (Global.Path.data/notes) that agents can also read/append (the B3 base prompt states
// it's shared). Lists *.md notes, opens the last-used one (localStorage), edits in a textarea with
// debounced autosave. No delete UI — deletion is the Trash tool's concern (B8).
type Entry = { name: string; type: "file" | "directory" }

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
  // Editing requires a successful read. Loading and failure must never masquerade as an empty
  // note that autosave could write over the original file.
  const [noteState, setNoteState] = createSignal<"loading" | "ready" | "failed">("loading")

  // Resolve the notes dir: the server data root (PathInfo.data — read via cast, the generated SDK
  // type predates the field) + "/notes", created idempotently on first visit. FS-3 (T7): under
  // virtual mode, notes live in the app-private virtual root's own notes subdir instead.
  // ⚠️ The `GET /path` read no longer swallows its own rejection. It used to fold a transport
  // failure into `undefined`, which is also what "this instance has no data root" looks like, so the
  // listing below could never tell the two apart and neither could the screen.
  const [notesDir] = createSettledResource(ctx, async (c) => {
    const info = await c.sdk.client.path
      .get()
      .then((r) => r.data as { data?: string; home?: string; virtual?: boolean; virtualRoot?: string } | undefined)
    const data = info?.virtual && info.virtualRoot ? info.virtualRoot : info?.data
    if (!data) return undefined
    const cn = conn()
    if (!cn) return undefined
    await fsMkdir(cn.http, { directory: data, path: "notes" }).catch(() => undefined)
    return `${data.replace(/[\\/]+$/, "")}/notes`
  })
  /** The folder could not be resolved — either the read rejected, or it answered with nothing. */
  const notesDirUnavailable = () => notesDir.failed || answeredNothing(notesDir)

  /**
   * 🔴 A failed listing used to become `[]` — *"No notes yet"* over notes that exist. It was worse
   * than a wrong sentence: the boot effect below reads `list.length === 0` as *"this user has no
   * notes"* and CREATES `notes.md`, so a server that could not answer produced a new file and an
   * empty editor over the user's real notes.
   */
  const [entries, { refetch: refetchEntries }] = createSettledResource(
    () => {
      const c = ctx()
      const d = notesDir()
      return c && d ? { c, d, t: tick() } : undefined
    },
    async ({ c, d }) => {
      const rows = await c.sdk.client.v2.directory.browse({ directory: d }).then((r) => r.data as Entry[] | undefined)
      if (!rows) throw new Error("the notes folder could not be listed")
      return rows
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  )
  const listing = createListState<Entry>(entries, { failedWhen: notesDirUnavailable })
  const loaded = createMemo(() => {
    const state = listing()
    return state.kind === "loaded" ? state.items : undefined
  })

  // Serialized autosave: one promise chain per page so two writes to the same file never overlap
  // (a last-write-wins race truncates); the debounce timer flushes on unmount/navigation.
  let saveChain: Promise<unknown> = Promise.resolve()
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 🔴 NC-REL-038: a write may only clear the dirty flag if the editor has not moved on since it
   * began. This used to clear unconditionally, so typing WHILE a save was in flight ended with
   * `dirty === false` over text that had never been written — and navigation, which flushes only when
   * dirty, discarded it. `notes-autosave.ts` carries the reasoning and the tests.
   */
  const autosave = createAutosave()
  function enqueueSave(name: string, content: string) {
    const cn = conn()
    const d = notesDir()
    if (!cn || !d) return
    autosave.begin()
    saveChain = saveChain
      .then(() => fsWrite(cn.http, { directory: d, path: name, content }))
      .then(() => {
        // The write succeeded either way; what it may not do is speak for an editor that has changed
        // underneath it. Leaving the flag set makes the next debounce carry the newer text.
        if (autosave.settles()) setDirty(false)
        setSaveFailed(false)
      })
      // Surface the failure instead of leaving the indicator stuck at "Saving…" forever (SP5).
      .catch(() => setSaveFailed(true))
  }
  function scheduleSave() {
    const name = current()
    if (!name) return
    autosave.edited()
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
    setNoteState("loading")
    setCurrent(name)
    setText("")
    setDirty(false)
    const res = await c.sdk.client.file
      .read({ directory: d, path: name })
      .then((r) => r.data as { type?: string; content?: string } | undefined)
      .catch(() => undefined)
    // Only lay the content in if this note is still the bound one (a faster later switch wins).
    if (current() === name) {
      if (res?.type !== "text" || typeof res.content !== "string") {
        setNoteState("failed")
      } else {
        setText(res.content)
        setNoteState("ready")
      }
    }
    try {
      localStorage.setItem(LAST_KEY, name)
    } catch {
      // ⚠️ Browser storage throws on ACCESS, not only when full — a private window or blocked site
      // data rejects the read as well as the write. Every other raw storage site in the app is
      // guarded; these two were not, so the Notes app died on open and on boot. The note is still
      // open, it just is not remembered across a reload.
    }
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
    const listing = await c.sdk.client.v2.directory
      .browse({ directory: d })
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
    const last = (() => {
      try {
        return localStorage.getItem(LAST_KEY)
      } catch {
        return null
      }
    })()
    if (last && list.some((e) => e.name === last)) void openNote(last)
    else if (list.length) void openNote(list[0].name)
    else void createNote("notes")
  })

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader glyph="notes" title={language.t("notes.title")} hint={language.t("notes.hint")}>
        <Show when={current() && noteState() === "ready"}>
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
      </AppPageHeader>

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
                aria-label={language.t("notes.namePlaceholder")}
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
            <Switch
              fallback={<div class="px-4 py-2 text-sm text-v2-text-text-faint">{language.t("notes.loading")}</div>}
            >
              <Match when={listing().kind === "failed"}>
                <div class="px-4 py-2 text-sm text-v2-state-fg-danger" data-slot="notes-failed">
                  {language.t("notes.loadFailed")}
                </div>
              </Match>
              <Match when={listing().kind === "empty"}>
                <div class="px-4 py-2 text-sm text-v2-text-text-faint" data-slot="notes-empty">
                  {language.t("notes.empty")}
                </div>
              </Match>
              <Match when={loaded()}>
                {(rows) => (
                  <For each={rows()}>
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
                )}
              </Match>
            </Switch>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={current()}
            fallback={
              <div class="flex h-full flex-col items-center justify-center gap-3 px-4 py-3 text-sm text-v2-text-text-faint">
                <GoldGlyph name="notes" class="size-12 opacity-60" />
                {/* The editor pane says what the LIST says: an unreadable folder is not an empty one,
                    and the big centred word in the middle of the page is where a person looks first. */}
                {listing().kind === "failed"
                  ? language.t("notes.loadFailed")
                  : listing().kind === "empty"
                    ? language.t("notes.empty")
                    : language.t("notes.loading")}
              </div>
            }
          >
            <Show
              when={noteState() !== "failed"}
              fallback={
                <div class="flex flex-col items-start gap-3 p-4" role="alert">
                  <p>{language.t("notes.readFailed")}</p>
                  <button
                    type="button"
                    class={btn}
                    onClick={() => {
                      const name = current()
                      if (name) void openNote(name)
                    }}
                  >
                    {language.t("error.page.action.retry")}
                  </button>
                </div>
              }
            >
              <textarea
                aria-label={language.t("notes.title") + ": " + current()}
                class="h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed outline-none"
                placeholder={noteState() === "loading" ? language.t("notes.loading") : language.t("notes.placeholder")}
                value={text()}
                readOnly={noteState() !== "ready"}
                onInput={(e) => {
                  if (noteState() !== "ready") return
                  setText(e.currentTarget.value)
                  scheduleSave()
                }}
              />
            </Show>
          </Show>
        </div>
      </div>
    </AppPage>
  )
}
