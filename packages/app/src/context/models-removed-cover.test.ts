import { describe, expect, test } from "bun:test"
import { pruneCovers } from "./models-covers"

/**
 * DELETING A MODEL MUST NOT MAKE IT UNADDABLE.
 *
 * 🔴 The defect, reported by the owner 2026-08-24: delete a model, add the same one back, and it
 * never reappears — not in the Models tab, not in an agent's Tune dialog. `remove()` only ever
 * APPENDED to a `removed` list, that list is `Persist.global`, and nothing on any path ever cleared
 * a key from it. So the delete wrote a permanent tombstone under `providerID:modelID`, and every
 * later model wearing that key was hidden on arrival. The only escape was resetting UI preferences.
 *
 * ⚠️ The cover is still worth having, which is why this is a prune and not a deletion of the feature:
 * the server delete is the real one, and the local hide covers the gap until the re-materialised
 * catalog reaches an open tab. What was wrong is that a cover outlived the thing it covered.
 */

describe("a removed-model cover expires when the server agrees", () => {
  test("kept while the server still lists the model — the sync gap", () => {
    // The delete has been confirmed by the server but this tab has not received the new catalog yet.
    // Dropping the cover here would flash the row back for a tick, which is what it exists to prevent.
    // Nothing changes, so the answer is "no write" rather than an empty list.
    expect(pruneCovers({ removed: ["openai:gpt-4"], listed: ["openai:gpt-4", "openai:gpt-3"] })).toBeUndefined()
  })

  test("🔴 dropped once the catalog no longer carries it — so a re-add is VISIBLE", () => {
    // The load-bearing one. After this the key is gone, so the same model added back later arrives
    // with no tombstone waiting for it.
    expect(pruneCovers({ removed: ["openai:gpt-4"], listed: ["openai:gpt-3"] })).toEqual([])
  })

  test("only the confirmed one is dropped — a second pending delete keeps its cover", () => {
    expect(pruneCovers({ removed: ["a:1", "b:2"], listed: ["b:2", "c:3"] })).toEqual(["b:2"])
  })

  test("no change returns undefined, so the effect does not write its own dependency", () => {
    // An effect that writes every run is a loop. "Nothing to do" has to be expressible.
    expect(pruneCovers({ removed: ["a:1"], listed: ["a:1"] })).toBeUndefined()
    expect(pruneCovers({ removed: [], listed: ["a:1"] })).toBeUndefined()
  })

  test("⚠️ an EMPTY catalog changes nothing — providers have not loaded yet", () => {
    // At boot `availableAll()` is empty. Pruning against nothing would clear every cover on every
    // start, which would make this rule a liar about what it does even where it does no visible harm.
    expect(pruneCovers({ removed: ["a:1", "b:2"], listed: [] })).toBeUndefined()
  })

  test("NEGATIVE CONTROL: the reader would notice if pruning stopped happening", () => {
    // Without this, a `pruneCovers` that always returned undefined would pass every test above that
    // asserts undefined, and the original defect would be back.
    const pruned = pruneCovers({ removed: ["gone:1"], listed: ["still:1"] })
    expect(pruned).toBeDefined()
    expect(pruned).not.toContain("gone:1")
  })
})
