import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MemorySetting } from "./memory-setting"

// The lay Memory on/off gate reads `runtime_setting` key `memory` directly (the same sync store read
// server-token.ts uses), default ON, fail-open. Build a real sqlite file with the production table
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
  test("default ON when the setting was never written", () => {
    expect(MemorySetting.memoryEnabled(makeDb())).toBe(true)
  })

  test("explicit {enabled:false} turns it OFF", () => {
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ enabled: false })))).toBe(false)
  })

  test("{enabled:true} and {} are both ON (opt-out semantics)", () => {
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({ enabled: true })))).toBe(true)
    expect(MemorySetting.memoryEnabled(makeDb(JSON.stringify({})))).toBe(true)
  })

  test("fail-open: a malformed value or missing db defaults to ON, never silently off", () => {
    expect(MemorySetting.memoryEnabled(makeDb("not json"))).toBe(true)
    expect(MemorySetting.memoryEnabled(path.join(os.tmpdir(), "definitely-missing-xyz", "no.db"))).toBe(true)
  })
})
