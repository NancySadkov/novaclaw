import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")

/**
 * A process restart wakes a working agent with ONE nudge, not two.
 *
 * The branch used to publish a folded Synthetic notice ("Recovery resumed this work…") AND a
 * durable steer ("A process loss interrupted your previous reply…"), so a recovered agent read the
 * same event twice and the second sentence warned about in-flight tools that might never have
 * existed. The single steer now carries the `session-restarted` nudge (`Recover and proceed.`); the only
 * call-specific fact — which tool has an unknown outcome — lives on that tool's own failure row
 * (`interruptedToolMessage`). This test pins the branch to that single, simple nudge.
 */
test("routine provider recovery is ONE folded nudge, not a synthetic notice plus a steer", () => {
  const start = source.indexOf("if (providerRecovery)")
  const end = source.indexOf("yield* maintenance.markChangesIncomplete", start)
  expect(start, "the provider-recovery branch moved; this ratchet needs re-pointing").toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const recovery = source.slice(start, end)

  // ⚠️ Re-pinned 2026-10-03. The restart notice is no longer a raw `SessionInput.steer`: since the
  // editable-nudge seam (`10b5c3a80`) the branch delivers EXACTLY ONE `session-restarted` nudge and
  // the wording lives in `nudge-definition.ts`. Assert the seam, not the old call — and collapse
  // whitespace, because an exact-line match is a second way this ratchet goes red over nothing.
  const collapsed = recovery.replace(/\s+/g, " ")
  expect(collapsed).toContain('type: "session-restarted"')
  expect(recovery.match(/deliverNudges\(/g) ?? [], "exactly one nudge is delivered").toHaveLength(1)
  // One nudge means no second, transcript-shaped copy of the same event.
  expect(recovery).not.toContain("SessionEvent.Synthetic")
  expect(recovery).not.toContain("Recovery resumed this work")
  // And no generic warning that a tool *might* have been in flight; the failing call names itself.
  expect(recovery).not.toContain("Any in-flight tool")
  expect(recovery).not.toContain("Tool outcome unknown after process restart")
})
