import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * 🔴 **A GATE THAT RENDERS NOTHING IS A DEAD END, AND THIS IS THE OWNER'S 0.1.81, MEASURED.**
 *
 * 2026-09-29. Clicking an officer in the roster left the desktop client a permanently blank window:
 * the tab strip drawn above an empty void, no conversation, no composer, 0% CPU, nothing written to
 * any log for 25+ minutes, and the window still answering Windows messages. It eventually filled in
 * — not because the client recovered, but because the SSE stream happened to reconnect and
 * `reconcileAll` re-read the transcript by luck.
 *
 * Three defects had to be true together, and the gate is the one that made the other two permanent:
 *
 *  1. `nativeMessages.load` rejected. Its only handler was a `console.error` of an OBJECT, which the
 *     renderer log flattened to `[object Object]` — so the one line naming the cause was unreadable.
 *  2. `timeline.ready` was `messages(id) !== undefined`, so "failed" and "not started" were the same
 *     value. A failure was indistinguishable from an empty conversation, forever.
 *  3. `session.tsx` gated the transcript on that flag with a `<Show>` that had NO fallback, and the
 *     `ErrorBoundary` sat INSIDE the gate — so the blank state could not be caught, reported, or
 *     recovered. The composer reads the same flag, so the entire conversation went with it.
 *
 * The class: *a readiness flag derived from the absence of data, with no failure term, gating a view
 * that renders nothing while it is false.* Absence of a value is not a state — but the UI rendered
 * absence of UI, which is indistinguishable from a dead app.
 *
 * The sibling sweep over `packages/app/src` found exactly ONE other readiness memo of this shape,
 * and it already carries the failure term — `pages/session/review-source.ts`:
 * `recorded() !== undefined || !!input.recordedError()`. The codebase had solved this once; the
 * transcript was the instance that omitted it. The sweep is what proves the class is real and narrow.
 */
describe("the transcript gate has a state for every value it can hold", () => {
  const SESSION = readFileSync(path.resolve(import.meta.dir, "..", "session.tsx"), "utf8")
  const MODEL_RAW = readFileSync(path.resolve(import.meta.dir, "timeline", "model.ts"), "utf8")
  /**
   * Prose quotes the defect it describes, so a structural assertion over raw source matches the
   * COMMENT that explains the old shape and fails on a file that is already correct. Strip
   * comments, then assert on code.
   */
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  const MODEL = code(MODEL_RAW)

  test("🔴 the readiness gate renders a fallback — this is the blank screen", () => {
    // Anchored on the gate itself, not a fragment of it: `<Show when={messagesReady() ...}>` with no
    // `fallback` renders nothing at all while false, and the boundary inside cannot catch what was
    // never mounted.
    const anchor = "when={messagesReady() ? params.id : undefined}"
    const at = SESSION.indexOf(anchor)
    expect(at, "the readiness gate has moved — re-derive this anchor").toBeGreaterThan(0)
    const head = SESSION.slice(at, SESSION.indexOf(">", at))
    expect(head, "the transcript gate must offer a fallback for the not-ready state").toContain("fallback=")
  })

  test("🔴 readiness is not derived from the absence of data alone", () => {
    // `messages(id) !== undefined` cannot say "failed". The model must carry a recorded outcome, so
    // a view can tell a failed read from an empty conversation.
    expect(MODEL, "readiness must consult a failure, not only the presence of data").toMatch(
      /failed:\s*createMemo\(\(\)\s*=>\s*outcome\(\)\.error\s*!==\s*undefined\)/,
    )
  })

  test("🔴 a failed read is logged AS the error, not wrapped in an object", () => {
    // `console.error("…", { sessionID, error })` writes `[object Object]` to a log that is one string
    // per line, so the single line naming the cause of a frozen client was unreadable. This is why
    // the 0.1.81 hang had to be diagnosed from the code and the screen instead of from its log.
    expect(MODEL).not.toMatch(/console\.error\([^)]*\{[^}]*error[^}]*\}\s*\)/)
    expect(MODEL, "the load failure must be logged so the next occurrence names its cause").toContain(
      'console.error("timeline message load failed", error)',
    )
  })

  test("🔴 a failed read can be retried, because the effect alone never re-runs", () => {
    // The effect keys on `sessionID`, which does not change — so one rejection was permanent for the
    // life of the view. Recovery existed, but it belonged to the NETWORK: only a stream reconnect made
    // `reconcileAll` re-read the transcript. The view needs its own way back.
    expect(MODEL, "the model must expose a retry the view can offer").toMatch(/\bretry\b/)
    expect(SESSION, "the failure state must offer the retry to the user").toContain("timeline.retry")
  })

  test("a failure is visible, not merely absent — the invariant this restores", () => {
    // AGENTS.md: "it degrades and recovers, with a calm 'connection lost - reconnecting', never a
    // stack trace or a white screen, while the instance heals itself." A blank region IS the white
    // screen. Both new states are marked, so a test can find them and a human can see them.
    expect(SESSION).toContain('data-slot="transcript-unavailable"')
    expect(SESSION).toContain('data-slot="transcript-pending"')
  })
})
