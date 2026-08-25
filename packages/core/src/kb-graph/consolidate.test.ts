import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "./wasm-engine"

/**
 * CONSOLIDATION AND THE LEGACY DISCARD WERE DELETING EACH OTHER'S WORK.
 *
 * 🔴 Measured against this engine on 2026-08-25. `consolidate()` promotes a still-valid
 * `session:`-scoped `auto-extract` memory to a GLOBAL twin and then invalidates the original, on the
 * assumption the twin now represents it. `discardLegacyGlobalExtracts()` — which runs at every
 * startup — deletes every `global` + `auto-extract` row, and its comment asserted that predicate
 * "names exactly the legacy set and nothing current".
 *
 * It did not. The twin copied its `source` from the original, so it matched. Consolidate, restart, and
 * the fact is GONE: twin deleted, original already invalidated. An auto-extracted fact from a chat
 * with no colleague vanished silently at the next boot.
 *
 * ⚠️ **Neither pass could see it.** Consolidation reported a promotion; the discard reported a legacy
 * cleanup; both were telling the truth about themselves. Only running them in sequence shows it — and
 * nothing did, because they live in different files and different phases of the process.
 *
 * ⚠️ This does NOT re-open the recorded decision that `global` is where an ownerless durable fact
 * belongs (`session/runner/recall.test.ts`). It makes that decision TRUE: the fact now survives, which
 * is what the decision assumed all along.
 */

const DIM = 8
let dir: string | undefined
let mem: WasmMemory | undefined

afterEach(async () => {
  await mem?.close()
  mem = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const open = async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-consolidate-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
  return mem
}

describe("consolidation survives the startup discard", () => {
  test("🔴 an ownerless fact is still there after the next boot", async () => {
    const engine = await open()
    await engine.addMemory({
      id: "m_auto",
      kind: "entity",
      text: "an ownerless fact",
      scope: "session:s1",
      source: "auto-extract",
    })

    expect(await engine.consolidate()).toBe(1)
    // …the next startup runs the legacy discard.
    await engine.discardLegacyGlobalExtracts()

    const found = await engine.search({ query: "ownerless", scopes: ["global"] })
    expect(found.map((h) => h.text)).toEqual(["an ownerless fact"])
  }, 60_000)

  test("the twin carries its OWN source, which is what keeps the two passes apart", async () => {
    const engine = await open()
    await engine.addMemory({ id: "m", kind: "entity", text: "x", scope: "session:s1", source: "auto-extract" })
    await engine.consolidate()
    const rows = await engine.list({ limit: 50, includeInvalid: true })
    const twin = rows.find((r) => r.scope === "global")
    expect(twin?.source).toBe("consolidated")
  }, 60_000)

  test("⚠️ a GENUINE legacy row is still discarded — the fix must not disarm the cleanup", async () => {
    // The owner's 2026-08-22 ruling: pre-roster auto-extracts in the household pile are discarded, not
    // migrated. A change that saved the twin by weakening the predicate would have quietly kept those.
    const engine = await open()
    await engine.addMemory({
      id: "m_legacy",
      kind: "entity",
      text: "a pre-roster leak",
      scope: "global",
      source: "auto-extract",
    })
    expect(await engine.discardLegacyGlobalExtracts()).toBe(1)
    expect(await engine.search({ query: "roster", scopes: ["global"] })).toEqual([])
  }, 60_000)

  test("a deliberate `remember` scoped to one chat is never promoted", async () => {
    // Only AUTO-EXTRACTED session memories flow up; a note the user chose to keep to one chat stays.
    const engine = await open()
    await engine.addMemory({ id: "m_mine", kind: "entity", text: "just this chat", scope: "session:s1" })
    expect(await engine.consolidate()).toBe(0)
    expect(await engine.search({ query: "chat", scopes: ["global"] })).toEqual([])
  }, 60_000)

  test("consolidating twice promotes once — the pass runs every few minutes", async () => {
    const engine = await open()
    await engine.addMemory({ id: "m", kind: "entity", text: "y", scope: "session:s1", source: "auto-extract" })
    expect(await engine.consolidate()).toBe(1)
    expect(await engine.consolidate()).toBe(0)
  }, 60_000)
})
