import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * 🔴 A SESSION IDENTITY MUST NOT BE READ OUT OF THE RAW ROUTE.
 *
 * A route addresses a colleague as often as a chat — `/server/<key>/agent/<agentID>` has no `id`
 * param at all, and the chat is a component reached THROUGH the agent (`context/session-scope.ts`).
 * So `useParams().id` is not "the session": it is "the session, when this particular URL names one",
 * and everywhere else it is `undefined` in total silence.
 *
 * Measured live in the packaged desktop app, 2026-09-26, on the composer's Stop control: the button
 * read Stop, the click ran `abort()`, `abort()` read `params.id`, got `undefined`, and returned. No
 * request, no spinner, no toast, while the agent streamed. The button's "is it working" came from
 * `controls.session.id` — right — and its "which session to stop" from the route — absent. One
 * fact, two sources, free to disagree.
 *
 * The seam that answers correctly is `useResolvedSessionID()` (`pages/session/session-layout.ts`).
 * This file is the ratchet: the next module that reaches for the raw param is named here and fails
 * the suite, instead of shipping a control that silently does nothing.
 *
 * ⚠️ **THE INVENTORY BELOW IS A CEILING, NOT A PERMISSION SLIP.** Each entry is a KNOWN instance
 * of this class, found by this test, still to be closed — its own product question is where a
 * component outside the session scope should learn the active session from (the tab store, its own
 * props, the resolved scope), and that is not a mechanical conversion. The test fails when the list
 * GROWS (a new instance shipped) and when an entry STOPS matching (it was fixed, so retire it) —
 * so the number can only come down, and down to zero the blanket rule below takes over.
 */

/** The seam itself reads the route — that is its job — and the session page proxies it. */
const ALLOWED = new Set([join("pages", "session", "session-layout.ts"), join("pages", "session.tsx")])

/**
 * Known instances, as `file:line` — the line a reviewer should look at. Regenerate the list by
 * reading the failure message; never add an entry to silence it.
 */
const KNOWN = new Set([
  "app.tsx:115",
  join("components", "dialog-fork.tsx") + ":43",
  join("context", "comments.tsx") + ":234",
  join("context", "file.tsx") + ":64",
  // ⚠️ `:107` → `:108` when the agent list below it gained the posture filter and the governing
  // officer (owner, 2026-09-27, the `build` ghost). This ledger is a CEILING, not a permission slip —
  // the inventory is read off line numbers, so an edit ABOVE a known instance is expected churn and
  // the honest fix is to re-point the entry, never to widen the set.
  join("context", "local.tsx") + ":108",
  join("context", "notification.tsx") + ":169",
  join("context", "prompt.tsx") + ":278",
  join("context", "tabs.tsx") + ":585",
  join("context", "terminal.tsx") + ":780",
  join("pages", "directory-layout.tsx") + ":43",
])

const ROOT = join(import.meta.dir, "..")

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** A file names a session id from the route only if it took the params from the route too. */
function sessionIDFromRoute(text: string): string | undefined {
  if (!/useParams[(<]/.test(text)) return undefined
  const line = text.split("\n").findIndex((l) => /\bparams\.id\b/.test(l) && !l.trimStart().startsWith("//"))
  return line < 0 ? undefined : String(line + 1)
}

const offenders = () =>
  sources(ROOT)
    .filter((file) => !ALLOWED.has(relative(ROOT, file)))
    .map((file) => {
      const line = sessionIDFromRoute(readFileSync(file, "utf8"))
      return line === undefined ? undefined : `${relative(ROOT, file)}:${line}`
    })
    .filter((hit): hit is string => hit !== undefined)

describe("session identity", () => {
  test("🔴 no module adds a NEW instance of reading a session id from the raw route", () => {
    const found = offenders()
    expect(
      found.filter((hit) => !KNOWN.has(hit)),
      `new instances — use useResolvedSessionID() (pages/session/session-layout.ts), or name the ` +
        `known one in KNOWN above if it is genuinely the same site moved:\n` +
        found.map((h) => `  ${h}${KNOWN.has(h) ? "" : "   ← NEW"}`).join("\n"),
    ).toEqual([])
  })

  test("🔴 the known inventory only ever shrinks", () => {
    const found = new Set(offenders())
    const stale = [...KNOWN].filter((hit) => !found.has(hit))
    expect(
      stale,
      `these are fixed or moved — delete them from KNOWN so the blanket rule can take over:\n` +
        stale.map((h) => `  ${h}`).join("\n"),
    ).toEqual([])
  })

  test("the composer's stop and send act on the session the composer renders", () => {
    const submit = readFileSync(join(ROOT, "components", "prompt-input", "submit.ts"), "utf8")
    // The import, not the prose: this file's own docblock names the mistake it no longer makes.
    expect(submit).not.toMatch(/import \{[^}]*useParams[^}]*\} from "@solidjs\/router"/)
    expect(submit).toContain("const sessionID = input.sessionID")
    const prompt = readFileSync(join(ROOT, "components", "prompt-input.tsx"), "utf8")
    expect(prompt).toContain("sessionID: () => props.controls.session.id")
  })
})
