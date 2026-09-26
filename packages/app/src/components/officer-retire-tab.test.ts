import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 🔴 RETIRING A COLLEAGUE CLOSES THEIR TAB BY THE COLLEAGUE.
 *
 * The retire path used to re-derive the chat with `chatFor(await listSessions(client), id)` and close
 * the tab by session id. It could not work, and the reason was in the file: `chatFor` excludes
 * ARCHIVED sessions on purpose, and retiring ARCHIVES the chat. The lookup therefore ran after the row
 * it was looking for had become invisible to it, answered `undefined`, and the orphaned tab survived
 * every retirement — while the comment above it claimed to be preventing precisely that.
 *
 * Two further reasons the derivation had to go, both structural rather than incidental: the list is a
 * PAGE (`listSessions` sends no limit; the instance returns the newest 50), and the colleague no longer
 * exists by that point, so the agent-addressed route answers `agent_not_found` — correctly. Neither
 * matters to the question, which is "which tab was showing this colleague", and the tab store answers
 * that by the agent.
 *
 * The component needs the full app context to mount, so this reads the source. That is a weaker kind of
 * evidence than a rendered click, and it is used here because the alternative is no coverage at all —
 * which is how the archived-exclusion bug survived in the first place.
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "officer-settings-screen.tsx"), "utf8")

/**
 * The retire gesture's own block, from the success toast to the dismiss — with COMMENTS STRIPPED.
 *
 * ⚠️ Stripping is not tidiness, it is correctness. The first version of this file failed on its own
 * docblock: the block quotes `chatFor(await listSessions(client), id)` to explain why that derivation
 * is gone, and the ratchet matched the explanation. A guard that must be silenced by rewording its own
 * rationale is a guard that will be silenced the next time someone edits a comment — which is the
 * outcome this whole exercise exists to prevent.
 */
const retireBlock = () => {
  const start = source.indexOf('agentConfig.retiredTitle')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf("props.onDismiss?.()", start)
  return source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
}

describe("retiring a colleague", () => {
  test("closes the tab by the AGENT, which is the identity an officer tab has", () => {
    expect(retireBlock()).toContain("tabs.closeAgentTab(retiredKey, id)")
  })

  test("never re-derives a session id to close by", () => {
    // The archived-exclusion trap, pinned where it can be seen: a lookup that runs AFTER the chat is
    // archived cannot find it, and the tab it was meant to close stays open.
    const block = retireBlock()
    expect(block).not.toContain("chatFor(")
    expect(block).not.toContain("listSessions(")
    expect(block).not.toContain("closeSessionTab(")
  })

  test("the guard can still fail — a comment must not be able to satisfy it", () => {
    // Positive control. If stripping ever regressed into reading the whole block, the assertion above
    // would pass on this file's own docblock and stop guarding anything.
    const withProse = source.slice(source.indexOf('agentConfig.retiredTitle'), source.indexOf("props.onDismiss?.()"))
    expect(withProse).toContain("chatFor(")
    expect(retireBlock()).not.toContain("chatFor(")
  })
})
