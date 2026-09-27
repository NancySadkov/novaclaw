import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MemorySetting } from "./memory-setting"

// The lay Memory on/off gate reads `runtime_setting` key `memory` directly (the same sync store read
// server-token.ts uses). It is now OPT-IN — off until the user turns it on — and the two "we don't
// know" cases are deliberately different answers. Build a real sqlite file with the production table
// shape and inject it via `dbFile` (which also bypasses the TTL cache).

const makeDb = (value?: string): string => {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mem-setting-")), "novaclaw.db")
  const db = new Database(file)
  db.run("CREATE TABLE runtime_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  if (value !== undefined) db.run("INSERT INTO runtime_setting (key, value) VALUES ('memory', ?)", [value])
  db.close()
  return file
}

describe("MemorySetting.memoryEnabled", () => {
  // 🔴 WHY OPT-IN (owner, 2026-09-27). `WasmMemory.open` costs ~1.3 GB resident for a store holding
  // ZERO memories — 871 MB external, 433 MB ArrayBuffer, JS heap under 15 MB. A FIXED arena allocated
  // at open, inside Wasm, which has no shrink, so `close()` releases none of it. A live instance sat at
  // 2.8 GB idle and reached 15.6 GB after work, holding enough commit to take a 32 GB box to 100 % and
  // get the user's browser and editor reaped. Nobody should opt into 1.3 GB by accident.
  test("🔴 OFF when the setting was never written — nobody opts in by accident", () => {
    expect(MemorySetting.memoryEnabled(makeDb())).toBe(false)
  })

  test("only an explicit {enabled:true} turns it on, and that is what a fresh instance needs", () => {
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ enabled: true })))).toBe(true)
    // A row that exists but says nothing is still an ABSENT answer, which under opt-in means off.
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({})))).toBe(false)
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ rerank: true })))).toBe(false)
  })

  test("an explicit OFF is still honoured — the switch is a real two-way control", () => {
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ enabled: false })))).toBe(false)
  })

  test("🔴 fail-OPEN is preserved where it must be, and it is NOT the same as absent", () => {
    // A malformed value is the clear case: the user DID store something here and we cannot read it, so
    // memory stays on. Only an answer we can read and that does not say `true` opts out.
    expect(MemorySetting.memoryEnabled(makeDb("not json"))).toBe(true)

    // ⚠️ A MISSING FILE is NOT that case, and the old expectation here was simply carried over from
    // the opt-out era. `readRowsSync` on an absent path does not throw — it returns no rows — so a
    // missing settings file is an ABSENT answer, which under opt-in means off. That is right: a store
    // that has never been written is a user who never chose, and a running instance cannot reach this
    // with no database at all. The fail-open arm is for a database we cannot READ, not one that is not
    // there.
    expect(MemorySetting.memoryEnabled(path.join(os.tmpdir(), "definitely-missing-xyz", "no.db"))).toBe(false)
  })

  test("the per-officer stance is a SEPARATE axis and is not consulted here", () => {
    // The global gate answers "may RAG run at all". `config-resolve.ts` keeps the per-officer
    // `memory: own | none` stance on `fallback: { kind: "stance", value: true }` and the readers AND the
    // two together, so turning the global switch back on does not have to rewrite anybody's stance.
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ enabled: true })))).toBe(true)
  })
})
