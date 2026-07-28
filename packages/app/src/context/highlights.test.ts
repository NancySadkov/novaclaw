import { beforeAll, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { dict as en } from "@/i18n/en"
import type { HighlightsStatus } from "./highlights"

// The release-notes fetch used to have exactly two outcomes a caller could see: a dialog, or silence.
// `novaclaw.app/changelog.json` has 404'd for the life of the product, and the 404 was collapsed —
// first by `response.ok ? response.json() : undefined`, then by `.catch(() => undefined)` — into the
// same `undefined` that a successful, EMPTY changelog produces. So the feature was dead on every
// install, nothing named the unavailable subsystem, and the stored "seen" version could never advance,
// which re-armed the fetch on every launch forever. All of that compiled green and rendered perfectly.
//
// These tests are the mechanical check for it (todo.md standing decision 2). They are hermetic: no
// network, no timers, no DOM — a fabricated fetcher feeds `readChangelog` each way the world can
// answer, and a source scan pins the two shapes that made the fault invisible in the first place.

const SRC = path.resolve(import.meta.dir, "..")
const HIGHLIGHTS = path.join(SRC, "context/highlights.tsx")

type Mod = typeof import("./highlights")
let mod: Mod

beforeAll(async () => {
  // highlights.tsx is a context module; everything below is pulled in only so `init` can run inside a
  // real app, and `init` is never called here. Mocked so the test imports one file, not the shell.
  mock.module("@novaclaw/ui/context", () => ({
    createSimpleContext: () => ({ use: () => undefined, provider: () => undefined }),
  }))
  mock.module("@novaclaw/ui/context/dialog", () => ({ useDialog: () => undefined }))
  mock.module("@/context/language", () => ({ useLanguage: () => undefined }))
  mock.module("@/context/platform", () => ({ usePlatform: () => undefined }))
  mock.module("@/context/settings", () => ({ useSettings: () => undefined }))
  mock.module("@/utils/persist", () => ({ persisted: () => [] }))
  mock.module("@/components/dialog-release-notes", () => ({ DialogReleaseNotes: () => undefined }))
  mod = await import("./highlights")
})

/** A Response as far as `readChangelog` is concerned: ok/status/statusText/json(). */
function response(init: { status: number; statusText?: string; json?: () => Promise<unknown> }): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: init.statusText ?? "",
    json: init.json ?? (async () => ({ releases: [] })),
  } as unknown as Response
}

function fetcher(result: Response | Error): typeof fetch {
  return (async () => {
    if (result instanceof Error) throw result
    return result
  }) as unknown as typeof fetch
}

const CHANGELOG_WITH_ONE_RELEASE = {
  releases: [
    {
      tag: "9.9.9",
      highlights: [
        {
          source: "desktop",
          items: [{ title: "Sessions", description: "Sessions are the one kernel entity." }],
        },
      ],
    },
  ],
}

function read(result: Response | Error, opts?: { aborted?: boolean; current?: string; previous?: string }) {
  const controller = new AbortController()
  if (opts?.aborted) controller.abort()
  return mod.readChangelog({
    fetcher: fetcher(result),
    signal: controller.signal,
    current: opts?.current ?? "9.9.9",
    // ⚠️ Synthetic versions on purpose. These are arbitrary fixture data — the fetch only
    // needs current != previous — but a literal equal to the REAL product version trips
    // core/test/version-single-source.test.ts, which string-scans for it and cannot know
    // this is a fixture. Keep them impossible.
    previous: opts?.previous ?? "9.9.8",
  })
}

const NOT_FOUND = response({ status: 404, statusText: "Not Found" })
const SERVER_ERROR = response({ status: 503, statusText: "Service Unavailable" })
const OFFLINE = new TypeError("Failed to fetch")
const NOT_JSON = response({
  status: 200,
  json: async () => {
    throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")
  },
})
const EMPTY = response({ status: 200, json: async () => ({ releases: [] }) })
const HAS_NEWS = response({ status: 200, json: async () => CHANGELOG_WITH_ONE_RELEASE })

describe("the changelog fetch reports which fact it found", () => {
  test("a 404 and an empty changelog are no longer the same outcome", async () => {
    const missing = await read(NOT_FOUND)
    const empty = await read(EMPTY)

    // This is the whole defect in one assertion: both of these used to arrive as `undefined`.
    expect(missing).not.toEqual(empty)
    expect(missing).toEqual({ kind: "unavailable", failure: "http", httpStatus: 404, detail: "404 Not Found" })
    expect(empty).toEqual({ kind: "empty" })
  })

  test("no answer at all is not the same fault as a bad answer", async () => {
    expect(await read(OFFLINE)).toEqual({
      kind: "unavailable",
      failure: "network",
      detail: "TypeError: Failed to fetch",
    })
    expect((await read(SERVER_ERROR)) as { failure?: string }).toMatchObject({ failure: "http", httpStatus: 503 })
  })

  test("a 200 carrying an error page is a fault, not an empty changelog", async () => {
    const outcome = (await read(NOT_JSON)) as { kind: string; failure?: string }
    expect(outcome.kind).toBe("unavailable")
    expect(outcome.failure).toBe("malformed")
  })

  test("real highlights still come through", async () => {
    expect(await read(HAS_NEWS)).toEqual({
      kind: "highlights",
      highlights: [{ title: "Sessions", description: "Sessions are the one kernel entity.", media: undefined }],
    })
  })

  test("an aborted check is not a fault — the window closed, nothing broke", async () => {
    const outcome = await read(OFFLINE, { aborted: true })
    expect(outcome).toEqual({ kind: "aborted" })
    expect(mod.describeUnavailable(outcome)).toBeUndefined()
    expect(mod.advancesSeenVersion(outcome)).toBe(false)
  })

  test("readChangelog never rejects, whatever the world does", async () => {
    for (const result of [NOT_FOUND, SERVER_ERROR, OFFLINE, NOT_JSON, EMPTY, HAS_NEWS]) {
      await expect(read(result)).resolves.toBeDefined()
    }
  })
})

describe("no failure is silent", () => {
  test("every unavailable outcome names the subsystem, the URL and what happens next", async () => {
    for (const result of [NOT_FOUND, SERVER_ERROR, OFFLINE, NOT_JSON]) {
      const line = mod.describeUnavailable(await read(result))
      expect(line, `${String(result)} must produce a log line`).toBeTruthy()
      expect(line).toContain("Release notes unavailable")
      expect(line).toContain("https://novaclaw.app/changelog.json")
      expect(line!.length).toBeGreaterThan(60)
    }
  })

  test("a working changelog says nothing — the log is for faults only", async () => {
    expect(mod.describeUnavailable(await read(EMPTY))).toBeUndefined()
    expect(mod.describeUnavailable(await read(HAS_NEWS))).toBeUndefined()
  })

  test("the 404 line does not claim there was nothing new", async () => {
    const line = mod.describeUnavailable(await read(NOT_FOUND))!
    expect(line).toContain("404")
    expect(line.toLowerCase()).not.toContain("no new")
    expect(line.toLowerCase()).not.toContain("up to date")
  })

  test("the status a Settings/About row would render distinguishes the same facts", async () => {
    expect(mod.statusOf(await read(EMPTY))).toEqual({ state: "none" })
    expect(mod.statusOf(await read(NOT_FOUND))).toMatchObject({ state: "unavailable", retrying: false })
    expect(mod.statusOf(await read(OFFLINE))).toMatchObject({ state: "unavailable", retrying: true })
    expect(mod.statusOf(await read(HAS_NEWS))).toEqual({ state: "new", count: 1 })
  })
})

describe("the seen-version advances exactly when the question is settled", () => {
  // Before this, NOTHING that failed advanced it — so `store.version` stayed pinned at the user's first
  // install and the effect re-armed on every launch, forever, against a URL known to 404.
  test("a settled outcome advances it", async () => {
    for (const result of [HAS_NEWS, EMPTY, NOT_FOUND]) {
      expect(mod.advancesSeenVersion(await read(result)), String(result)).toBe(true)
    }
  })

  test("an unknown outcome leaves it alone so the next launch retries", async () => {
    for (const result of [OFFLINE, SERVER_ERROR, NOT_JSON]) {
      const outcome = await read(result)
      expect(mod.advancesSeenVersion(outcome), String(result)).toBe(false)
      expect(mod.willRetry(outcome)).toBe(true)
    }
  })

  test("410 Gone is as final as 404 — the file is not coming back", async () => {
    const outcome = await read(response({ status: 410, statusText: "Gone" }))
    expect(mod.willRetry(outcome)).toBe(false)
    expect(mod.advancesSeenVersion(outcome)).toBe(true)
  })
})

// ── The Settings row ──────────────────────────────────────────────────────────────────────────────
//
// The status above was computed and discarded until 2026-07-28: nothing in the product read it, so for
// anyone who does not open the Debug app the subsystem still rendered empty. These pin what the row is
// now allowed to say. The wording lives in en.ts, so the assertions resolve real English, not keys.

const STATUSES: Record<string, HighlightsStatus> = {
  idle: { state: "idle" },
  checking: { state: "checking" },
  new: { state: "new", count: 3 },
  none: { state: "none" },
  missing: { state: "unavailable", failure: "http", httpStatus: 404, detail: "404 Not Found", retrying: false },
  offline: { state: "unavailable", failure: "network", detail: "TypeError: Failed to fetch", retrying: true },
}

/** Resolve a row the way the component does: look its key up in the shipped English dictionary. */
function english(status: HighlightsStatus): string {
  const row = mod.releaseNotesRow(status)
  const template = (en as Record<string, string>)[row.key]
  if (template === undefined) return ""
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(row.params[name] ?? `{{${name}}}`))
}

describe("the Settings row says which fact it found", () => {
  test("every state resolves to a real sentence — the row never renders blank", () => {
    for (const [name, status] of Object.entries(STATUSES)) {
      const text = english(status)
      expect(text, `${name} must resolve to shipped English`).not.toBe("")
      expect(text.length, `${name} is too short to be a sentence`).toBeGreaterThan(20)
      expect(text, `${name} left a placeholder unfilled`).not.toContain("{{")
    }
  })

  test("every declared key exists in en.ts", () => {
    for (const key of Object.values(mod.RELEASE_NOTES_STATUS_KEY)) {
      expect((en as Record<string, string>)[key], `${key} is missing from i18n/en.ts`).toBeTruthy()
    }
  })

  test("negative control — a key that is not in en.ts is caught", () => {
    expect((en as Record<string, string>)["settings.general.row.releaseNotes.status.doesNotExist"]).toBeUndefined()
  })

  test("an unreachable list is never described as up to date", () => {
    for (const name of ["missing", "offline"] as const) {
      const text = english(STATUSES[name]!).toLowerCase()
      expect(text, name).not.toContain("up to date")
      expect(text, name).not.toContain("nothing new")
      expect(mod.releaseNotesRow(STATUSES[name]!).tone, name).toBe("attention")
    }
    // …and the state that IS up to date says so, so the two can never be confused.
    expect(english(STATUSES.none!).toLowerCase()).toContain("up to date")
    expect(mod.releaseNotesRow(STATUSES.none!).tone).toBe("neutral")
  })

  test("a final answer and a retry are different sentences", () => {
    // A 404 means the file is not published — asking again cannot change it, so the row must not
    // promise a retry it will never make.
    expect(mod.releaseNotesRow(STATUSES.missing!).key).not.toBe(mod.releaseNotesRow(STATUSES.offline!).key)
    expect(english(STATUSES.missing!).toLowerCase()).not.toContain("try again")
    expect(english(STATUSES.offline!).toLowerCase()).toContain("try again")
  })

  test("the visible sentence carries no status codes, URLs or jargon", () => {
    for (const [name, status] of Object.entries(STATUSES)) {
      const text = english(status)
      for (const jargon of ["404", "410", "http", "json", "cdn", "://", "fetch"]) {
        expect(text.toLowerCase(), `${name} leaks "${jargon}" into a lay surface`).not.toContain(jargon)
      }
    }
  })

  test("the technical detail is still one hover away, worded once", async () => {
    // The row's `title` and the Debug app's log line are the SAME string by construction — two
    // renderings of one fault must never be able to disagree about it.
    for (const result of [NOT_FOUND, SERVER_ERROR, OFFLINE, NOT_JSON]) {
      const outcome = await read(result)
      expect(mod.describeStatus(mod.statusOf(outcome))).toBe(mod.describeUnavailable(outcome)!)
    }
    expect(mod.describeStatus({ state: "none" })).toBeUndefined()
    expect(mod.describeStatus({ state: "checking" })).toBeUndefined()
  })
})

describe("the highlights context exposes only what something reads", () => {
  // Six members were returned and NONE were read. Five are gone; `status` is the Settings row's source.
  // A member re-added without a consumer is dead code by definition — this is the ratchet.
  test("useHighlights returns exactly one member", () => {
    const source = fs.readFileSync(HIGHLIGHTS, "utf8")
    const returned = source.slice(source.lastIndexOf("    return {"))
    expect(returned).toContain("status,")
    for (const gone of ["      ready,", "      markSeen,", "from: () =>", "to: () =>", "get last()"]) {
      expect(returned, `${gone} came back with no consumer`).not.toContain(gone)
    }
  })
})

// ── The static half ───────────────────────────────────────────────────────────────────────────────
//
// The behaviour above can be correct while the wiring quietly re-swallows it: one `.catch(() => undefined)`
// put back for tidiness and every outcome collapses again with the suite still green. These two rules
// scan the source instead, and each is negative-controlled — the SAME predicate is run over a fixture
// holding the code that actually shipped, and asserted to flag it. A rule that cannot fail is not a rule.

type Rule = { name: string; violated: (source: string) => boolean; control: string }

const RULES: Rule[] = [
  {
    name: "no catch that discards the error",
    violated: (source) => /\.catch\(\s*\([^)]*\)\s*=>\s*(?:undefined|null|void 0|\{\s*\})\s*\)/.test(source),
    control: `fetcher(CHANGELOG_URL).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)`,
  },
  {
    // Was `console.warn(` until 2026-07-28. The hand-off still has to REACH the error log — that is the
    // invariant — but it now goes through the `notice` level, because a warn is a claim about the user's
    // machine and a changelog missing from our own CDN is not that (utils/error-log.ts).
    name: "the failure path reaches the error log",
    violated: (source) => !source.includes("noticeErrorLog("),
    control: `const line = describeUnavailable(outcome)\nif (line) return`,
  },
  {
    // The whole point of the `notice` level: a fault only we can fix must not present as a warning
    // about the user's install. A `console.warn` back in this file silently undoes that.
    name: "the changelog fault is not logged as a warning about the user's machine",
    violated: (source) => /console\.warn\(/.test(source),
    control: `const line = describeUnavailable(outcome)\nif (line) console.warn(line)`,
  },
  {
    name: "a non-2xx is classified by status, not thrown away",
    violated: (source) => !source.includes("response.status"),
    control: `.then((response) => (response.ok ? response.json() : undefined))`,
  },
]

describe("the swallow cannot come back", () => {
  const source = fs.readFileSync(HIGHLIGHTS, "utf8")

  for (const rule of RULES) {
    test(`highlights.tsx: ${rule.name}`, () => {
      expect(rule.violated(source), `context/highlights.tsx violates: ${rule.name}`).toBe(false)
    })

    test(`negative control — "${rule.name}" bites`, () => {
      expect(rule.violated(rule.control), "this rule would not have caught the code that shipped").toBe(true)
    })
  }
})
