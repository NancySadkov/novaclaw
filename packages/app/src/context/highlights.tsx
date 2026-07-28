import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@novaclaw/ui/context"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { noticeErrorLog } from "@/utils/error-log"
import { persisted } from "@/utils/persist"
import { DialogReleaseNotes, type Highlight } from "@/components/dialog-release-notes"

const CHANGELOG_URL = "https://novaclaw.app/changelog.json"

// ── The What's-new subsystem's failure model ──────────────────────────────────────────────────────
//
// Until 2026-07-28 this fetch had exactly two visible states: the dialog, or nothing at all. A 404, an
// offline laptop, and an HTML error page served in place of JSON all went through a
// "response.ok ? parse it : undefined" ternary and then a catch that discarded its argument, and came
// out the far side as the same `undefined` a SUCCESSFUL, empty changelog produces. Two different facts,
// one silent outcome — and `novaclaw.app/changelog.json` has 404'd for the life of the product, so the
// dialog was unreachable and nothing in the tree said so. (todo.md standing decision 3: an unavailable
// subsystem names itself instead of rendering empty, and a fault is never described falsely.)
//
// ⚠️ The rules in `highlights.test.ts` scan this file's raw text, comments included — so do not paste
// the discarding-catch shape back into a comment here; describe it in prose, as above.
//
// The outcomes are now distinct and each has a declared consequence:
//
//   outcome                        dialog   marks the version seen        named in the error log
//   highlights                     yes      yes (with the dialog)         no
//   empty      read fine, nothing  no       yes                           no
//   aborted    window closed       no       no                            no  — not a fault
//   unavailable, http 404/410      no       YES — the answer is final     yes
//   unavailable, http other        no       no — retry on next launch     yes
//   unavailable, network           no       no — retry on next launch     yes
//   unavailable, malformed body    no       no — retry on next launch     yes
//
// Why a 404 marks the version seen while a network error does not: a 404 is an ANSWER. The host is up
// and it says the file does not exist, and asking again next launch cannot change that — so the version
// advances, the effect stops re-arming, and we stop re-requesting a URL the server has told us is not
// there. Everything else is genuinely UNKNOWN (offline, a 5xx, a truncated body), so the version stays
// unseen and the next launch tries again — which is what a user who was offline during an update wants.
// Before this, EVERY failure left the version unseen, so `store.version` could never advance past the
// user's first install and the fetch re-ran on every single launch, forever, with nothing to show for it.

/** Why the changelog could not be read. Three different faults that used to be indistinguishable. */
export type ChangelogFailure =
  /** The host answered with a non-2xx. `httpStatus` says which. */
  | "http"
  /** No answer at all — offline, DNS, TLS, CORS, host down. */
  | "network"
  /** Answered 2xx, but the body is not the JSON we asked for. */
  | "malformed"

export type ChangelogOutcome =
  | { kind: "highlights"; highlights: Highlight[] }
  | { kind: "empty" }
  | { kind: "aborted" }
  | { kind: "unavailable"; failure: ChangelogFailure; httpStatus?: number; detail: string }

/**
 * What any surface can ask about the What's-new subsystem without re-fetching anything. Exposed so a
 * Settings/About row can render "What's new — unavailable" honestly; the fault is NOT invented by the
 * renderer, it is reported by the one place that knows.
 */
export type HighlightsStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "new"; count: number }
  | { state: "none" }
  | { state: "unavailable"; failure: ChangelogFailure; httpStatus?: number; detail: string; retrying: boolean }

type Store = {
  version?: string
}

type ParsedRelease = {
  tag?: string
  highlights: Highlight[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text.length > 0 ? text : undefined
  }

  if (typeof value === "number") return String(value)
  return
}

function normalizeVersion(value: string | undefined) {
  const text = value?.trim()
  if (!text) return
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function parseMedia(value: unknown, alt: string): Highlight["media"] | undefined {
  if (!isRecord(value)) return
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return
  if (type !== "image" && type !== "video") return

  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return

  const title = getText(value.title)
  if (!title) return

  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return

  const media = parseMedia(value.media, title)
  return { title, description, media }
}

function parseRelease(value: unknown): ParsedRelease | undefined {
  if (!isRecord(value)) return
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)

  if (!Array.isArray(value.highlights)) {
    return { tag, highlights: [] }
  }

  const highlights = value.highlights.flatMap((group) => {
    if (!isRecord(group)) return []

    const source = getText(group.source)
    if (!source) return []
    if (!source.toLowerCase().includes("desktop")) return []

    if (Array.isArray(group.items)) {
      return group.items.map((item) => parseHighlight(item)).filter((item): item is Highlight => item !== undefined)
    }

    const item = parseHighlight(group)
    if (!item) return []
    return [item]
  })

  return { tag, highlights }
}

function parseChangelog(value: unknown): ParsedRelease[] | undefined {
  if (Array.isArray(value)) {
    return value.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
  }

  if (!isRecord(value)) return
  if (!Array.isArray(value.releases)) return

  return value.releases.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
}

function sliceHighlights(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = (() => {
    if (!current) return 0
    const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
    return index === -1 ? 0 : index
  })()

  const end = (() => {
    if (!previous) return releases.length
    const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
    return index === -1 ? releases.length : index
  })()

  const highlights = releases.slice(start, end).flatMap((release) => release.highlights)
  const seen = new Set<string>()
  const unique = highlights.filter((highlight) => {
    const key = dedupeKey(highlight)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.slice(0, 5)
}

function dedupeKey(highlight: Highlight) {
  return [highlight.title, highlight.description, highlight.media?.type ?? "", highlight.media?.src ?? ""].join("\n")
}

function loadReleaseHighlights(value: unknown, current?: string, previous?: string) {
  const releases = parseChangelog(value)
  if (!releases?.length) return []
  return sliceHighlights({ releases, current, previous })
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Turn whatever the network did into exactly ONE of the outcomes in the table above. Never throws and
 * never returns a bare `undefined` — every path back out of here is a named fact.
 */
export async function readChangelog(input: {
  fetcher: typeof fetch
  signal: AbortSignal
  current?: string
  previous?: string
}): Promise<ChangelogOutcome> {
  let response: Response
  try {
    response = await input.fetcher(CHANGELOG_URL, {
      signal: input.signal,
      headers: { Accept: "application/json" },
    })
  } catch (error) {
    // An abort is the app tearing down, not a fault — do not report it as one.
    if (input.signal.aborted) return { kind: "aborted" }
    return { kind: "unavailable", failure: "network", detail: describeError(error) }
  }

  if (!response.ok) {
    return {
      kind: "unavailable",
      failure: "http",
      httpStatus: response.status,
      detail: `${response.status} ${response.statusText || "(no status text)"}`,
    }
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    if (input.signal.aborted) return { kind: "aborted" }
    return { kind: "unavailable", failure: "malformed", detail: describeError(error) }
  }

  if (input.signal.aborted) return { kind: "aborted" }
  const highlights = loadReleaseHighlights(json, input.current, input.previous)
  return highlights.length > 0 ? { kind: "highlights", highlights } : { kind: "empty" }
}

/** A failure we will ask about again on the next launch, rather than treating as settled. */
export function willRetry(outcome: ChangelogOutcome): boolean {
  if (outcome.kind !== "unavailable") return false
  if (outcome.failure !== "http") return true
  return outcome.httpStatus !== 404 && outcome.httpStatus !== 410
}

/**
 * Does this outcome settle the question for the version we are running? `true` means the stored
 * "already seen" version advances to the running one — the effect stops re-arming on every launch.
 * (For `highlights` the advance happens alongside the dialog, so the user is never marked as having
 * seen notes that were never put in front of them.)
 */
export function advancesSeenVersion(outcome: ChangelogOutcome): boolean {
  switch (outcome.kind) {
    case "highlights":
    case "empty":
      return true
    case "aborted":
      return false
    case "unavailable":
      return !willRetry(outcome)
  }
}

/** Everything the wording below needs, in the shape BOTH an outcome and a status can supply. */
type Fault = { failure: ChangelogFailure; httpStatus?: number; detail: string; retrying: boolean }

/**
 * The one place the technical line is worded. Two callers reach it — the error-log hand-off (from an
 * outcome) and the Settings row's hover detail (from a status) — and they must never be able to say
 * two different things about one fault, so neither writes its own copy.
 */
function describeFault(fault: Fault): string {
  const cause = (() => {
    switch (fault.failure) {
      case "http":
        return `${CHANGELOG_URL} returned ${fault.detail}`
      case "network":
        return `could not reach ${CHANGELOG_URL} (${fault.detail})`
      case "malformed":
        return `${CHANGELOG_URL} did not return valid JSON (${fault.detail})`
    }
  })()
  const next = fault.retrying
    ? "NovaClaw will try again on the next launch."
    : "No changelog is published there, so this version is marked seen and NovaClaw will stop asking."
  return `Release notes unavailable: ${cause}. ${next}`
}

/**
 * The line the Debug app's Error-log panel shows, or `undefined` when there is genuinely nothing to
 * report. It names the subsystem, the URL, the actual fault and what happens next — no euphemism, and
 * no claim that the changelog was empty when it was in fact unreachable.
 */
export function describeUnavailable(outcome: ChangelogOutcome): string | undefined {
  if (outcome.kind !== "unavailable") return
  return describeFault({ ...outcome, retrying: willRetry(outcome) })
}

/**
 * The same line, reached from the projected status instead of the raw outcome — this is what the
 * Settings row hangs off its `title`, so a developer can hover and read the real fault while the
 * visible text stays in plain English. `undefined` whenever nothing is wrong.
 */
export function describeStatus(status: HighlightsStatus): string | undefined {
  if (status.state !== "unavailable") return
  return describeFault(status)
}

/** Project an outcome onto the state a Settings/About row can render. */
export function statusOf(outcome: ChangelogOutcome): HighlightsStatus {
  switch (outcome.kind) {
    case "highlights":
      return { state: "new", count: outcome.highlights.length }
    case "empty":
      return { state: "none" }
    case "aborted":
      return { state: "idle" }
    case "unavailable":
      return {
        state: "unavailable",
        failure: outcome.failure,
        httpStatus: outcome.httpStatus,
        detail: outcome.detail,
        retrying: willRetry(outcome),
      }
  }
}

// ── The Settings row ──────────────────────────────────────────────────────────────────────────────
//
// Until 2026-07-28 the status above was computed and then thrown away: the provider was mounted, the
// effect ran, nothing read the result. So the product's own answer to "did the release notes work?" was
// visible only in the Debug app, which a normal person never opens — i.e. for that person the subsystem
// still rendered empty, which is exactly what todo.md ruling 2 forbids.
//
// ⚠️ The row lives in TWO Settings panels (the v1 `settings-general.tsx` and the v2
// `settings-v2/general.tsx`), because the release-notes toggle it sits under does. Two panels
// hand-copying one sentence is a drift generator, so neither writes the sentence: both render
// `ReleaseNotesStatusLine` below, and the wording is one i18n key chosen by one pure function.
// `components/settings-release-notes-row.test.ts` fails if either panel stops doing that.
//
// The register is LAY, deliberately. The Debug line says "https://…/changelog.json returned 404 Not
// Found"; this row says "No release notes are published for this version." Same fact, two audiences —
// and the technical line is still one hover away via `describeStatus`, so nothing is hidden.

/** The complete set of things this row can say. Data, so a test can prove each one exists in en.ts. */
export const RELEASE_NOTES_STATUS_KEY = {
  idle: "settings.general.row.releaseNotes.status.idle",
  checking: "settings.general.row.releaseNotes.status.checking",
  new: "settings.general.row.releaseNotes.status.new",
  none: "settings.general.row.releaseNotes.status.none",
  unavailableRetry: "settings.general.row.releaseNotes.status.unavailableRetry",
  unavailableFinal: "settings.general.row.releaseNotes.status.unavailableFinal",
} as const

export type ReleaseNotesStatusKey = (typeof RELEASE_NOTES_STATUS_KEY)[keyof typeof RELEASE_NOTES_STATUS_KEY]

export type ReleaseNotesRow = {
  /** The i18n key of the sentence shown to the user. Never absent — the row never renders blank. */
  key: ReleaseNotesStatusKey
  /** Values for the `{{…}}` placeholders. Harmless for the keys that have none. */
  params: Record<string, string | number>
  /** `attention` only when the subsystem is unavailable — that is the state ruling 2 says must show. */
  tone: "neutral" | "attention"
  /** Mirrored onto `data-state` so a DOM probe can assert WHICH fact is on screen, not just that text is. */
  state: HighlightsStatus["state"]
}

/** Project the status onto the one sentence the Settings row shows. Pure — the tests drive it directly. */
export function releaseNotesRow(status: HighlightsStatus): ReleaseNotesRow {
  switch (status.state) {
    case "idle":
      return { key: RELEASE_NOTES_STATUS_KEY.idle, params: {}, tone: "neutral", state: status.state }
    case "checking":
      return { key: RELEASE_NOTES_STATUS_KEY.checking, params: {}, tone: "neutral", state: status.state }
    case "new":
      return {
        key: RELEASE_NOTES_STATUS_KEY.new,
        params: { count: status.count },
        tone: "neutral",
        state: status.state,
      }
    case "none":
      return { key: RELEASE_NOTES_STATUS_KEY.none, params: {}, tone: "neutral", state: status.state }
    case "unavailable":
      return {
        // A 404/410 is an ANSWER — the file is not published — so it is stated as a settled fact, not as
        // a transient failure the user might wait out. Anything else is genuinely unknown and retries.
        key: status.retrying ? RELEASE_NOTES_STATUS_KEY.unavailableRetry : RELEASE_NOTES_STATUS_KEY.unavailableFinal,
        params: {},
        tone: "attention",
        state: status.state,
      }
  }
}

/**
 * The release-notes status, as both Settings panels render it. One component, one sentence, one source
 * of truth — a panel cannot say something the other panel does not.
 */
export function ReleaseNotesStatusLine() {
  const highlights = useHighlights()
  const language = useLanguage()
  const row = () => releaseNotesRow(highlights.status())
  // The raw fault hangs off `title`, for whoever is debugging. The visible sentence never carries a
  // status code — the two registers are the whole point, and `describeStatus` is the only wording source.
  const detail = () => describeStatus(highlights.status())

  return (
    <span
      data-status="release-notes"
      data-state={row().state}
      data-tone={row().tone}
      title={detail()}
      class="block pt-0.5"
      classList={{ "text-v2-state-fg-warning": row().tone === "attention" }}
    >
      {language.t(row().key, row().params)}
    </span>
  )
}

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const state = { started: false }
    const [status, setStatus] = createSignal<HighlightsStatus>({ state: "idle" })
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    const start = (previous: string) => {
      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        clearTimer()
      })

      setStatus({ state: "checking" })

      void readChangelog({
        fetcher,
        signal: controller.signal,
        current: platform.version,
        previous,
      }).then((outcome) => {
        if (controller.signal.aborted) return
        setStatus(statusOf(outcome))

        // The register is deliberate. A modal on every launch because OUR CDN is missing a file would
        // page a normal person about our infrastructure, and the vision is that a common user is
        // HELPED, not handed a pager (AGENTS.md, Identity & mission). So the fault is named where
        // faults belong: `noticeErrorLog` feeds the Debug app's Error-log panel and the dev stdout —
        // and `status` above is what the Settings row renders instead of showing a blank where
        // release notes should be.
        //
        // ⚠️ It used to be `console.warn`, which lands at level `warn` — an accusation about the
        // user's machine for something only WE can fix. Level `notice` exists for exactly this
        // (utils/error-log.ts, 2026-07-28); do not put the warn back.
        const line = describeUnavailable(outcome)
        if (line) noticeErrorLog(line)

        if (outcome.kind === "highlights") {
          const highlights = outcome.highlights
          timer = setTimeout(() => {
            timer = undefined
            markSeen()
            dialog.show(() => <DialogReleaseNotes highlights={highlights} />)
          }, 500)
          return
        }

        if (advancesSeenVersion(outcome)) markSeen()
      })
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      start(previous)
    })

    // ⚠️ ONE member, on purpose (2026-07-28). This object used to carry six — `ready`, `status`, `from`,
    // `to`, `last` and `markSeen` — and NOTHING in the tree called `useHighlights` at all, so all six
    // were dead. Five were deleted rather than left as an open invitation, each for a reason:
    //
    //   ready     — the provider is declared `gate: false`, so createSimpleContext never consults it and
    //               no consumer could act on it; the effect below closes over the local binding.
    //   from/to   — a `range` store populated solely to feed a UI nobody built. `to` is always
    //               `platform.version`; `from` is the same value `previous` already carries here.
    //   last      — the persisted seen-version. It advances on a 404, i.e. for a version whose notes the
    //               user was never shown, so rendering it as "last seen" would be a false description
    //               (todo.md ruling 2). It stays internal bookkeeping, not a product fact.
    //   markSeen  — letting an outside caller declare a version seen without ever putting the notes in
    //               front of the user is the same false report, one step earlier.
    //
    // Add a member back when a surface reads it in the same commit, not before.
    return {
      status,
    }
  },
})
