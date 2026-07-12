import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStrict } from "./strict"
import { SessionInput } from "../input"
import type { SessionMessage } from "../message"
import type { JhLog } from "../../jh/log"

// P14-minimal (jh-improve8 P3) — the session-independent half of the Strict route. The engine
// integration itself is gated by the LIVE smoke (tests/jh-strict-session-smoke.ts, plan P4).

describe("SessionStrict.flagsFor", () => {
  test("all groups default → every flag undefined (engine defaults ON)", () => {
    const flags = SessionStrict.flagsFor({})
    expect(Object.values(flags).every((v) => v === undefined)).toBe(true)
  })
  test("a group set to false disables exactly its family", () => {
    const flags = SessionStrict.flagsFor({ editingAids: false, recovery: true })
    expect(flags.numberedWorkspace).toBe(false)
    expect(flags.fullFiles).toBe(false)
    expect(flags.txEdits).toBe(false)
    expect(flags.coordMode).toBe(false)
    expect(flags.keepBest).toBeUndefined() // true = engine default, not an explicit true
    expect(flags.staleness).toBeUndefined()
    expect(flags.budgetAware).toBeUndefined()
  })
})

describe("SessionStrict.milestone", () => {
  const seq = (entry: JhLog.Entry): JhLog.Sequenced => ({ ...entry, seq: 1 }) as JhLog.Sequenced
  test("phase-level structure events surface; leaf-level ones stay quiet", () => {
    expect(SessionStrict.milestone(seq({ type: "committed", step: "root.2" }))).toContain("committed root.2")
    expect(SessionStrict.milestone(seq({ type: "committed", step: "root.2.3" }))).toBeUndefined()
    expect(SessionStrict.milestone(seq({ type: "expanded", step: "root", children: 3 }))).toContain("3 children")
  })
  test("safety events always surface, at any depth", () => {
    expect(SessionStrict.milestone(seq({ type: "restored_best", step: "root.2.3.4", score: 0.8, reason: "drop" }))).toContain("restored_best")
    expect(SessionStrict.milestone(seq({ type: "coord_mode", step: "root.9.9", file: "a.c" }))).toContain("coord_mode")
    expect(SessionStrict.milestone(seq({ type: "task_blocked", reason: "wall_exhausted" }))).toContain("wall_exhausted")
  })
  test("leaf noise (action/observation/verification) never surfaces", () => {
    expect(SessionStrict.milestone(seq({ type: "action", step: "root.1", tool: "run" }))).toBeUndefined()
    expect(SessionStrict.milestone(seq({ type: "verification", step: "root", ok: false, detail: "x" }))).toBeUndefined()
  })
})

describe("SessionStrict.lastUserText", () => {
  const user = (text: string) => ({ type: "user", text }) as unknown as SessionMessage.Message
  const assistant = () => ({ type: "assistant", content: [] }) as unknown as SessionMessage.Message
  test("returns the NEWEST real user text", () => {
    expect(SessionStrict.lastUserText([user("first"), assistant(), user("second")])).toBe("second")
  })
  test("skips harness-provenance steers and blank messages", () => {
    expect(SessionStrict.lastUserText([user("real task"), user(`${SessionInput.STEER_PROVENANCE_PREFIX}nudge`), user("   ")])).toBe("real task")
    expect(SessionStrict.lastUserText([assistant()])).toBeUndefined()
  })
})

describe("SessionStrict.listFilesFor", () => {
  test("binary placeholders, dotfile skip, and a NAMED cap (no silent truncation)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-strictls-"))
    fs.writeFileSync(path.join(dir, "a.c"), "int main(){}")
    fs.writeFileSync(path.join(dir, "a.exe"), Buffer.from([1, 2, 3]))
    fs.writeFileSync(path.join(dir, ".gitignore"), "x")
    for (let i = 0; i < SessionStrict.FILE_LIST_CAP + 3; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i))
    const files = SessionStrict.listFilesFor(dir)
    expect(files.some((f) => f.name === ".gitignore")).toBe(false)
    expect(files.length).toBe(SessionStrict.FILE_LIST_CAP + 1) // cap + the omission note
    expect(files.at(-1)!.name).toContain("more files not shown")
    const exe = files.find((f) => f.name === "a.exe")
    // the exe may fall outside the mtime-sorted cap window on a fast filesystem — when shown, it must
    // be a placeholder, never raw bytes
    if (exe) expect(exe.content).toContain("<compiled binary")
  })
})
