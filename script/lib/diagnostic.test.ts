/**
 * The one property this module owes: **the whole refusal reaches the reader even though the process
 * dies in the next statement.** Asserted end to end against a real child, because the thing at risk
 * is the handoff between a stream and a hard exit, and nothing inside this process can stand in for
 * that.
 *
 * ⚠️ **Read the control honestly.** Measured 2026-09-02 under `bun` on Windows, the buffered stream
 * does NOT lose these bytes either — so on this runtime the two arms are indistinguishable and these
 * tests cannot discriminate between them. What they do pin is that `writeDiagnostic` never drops,
 * never throws and never short-writes on the runtime the gate actually runs on, and the `stream` arm
 * is kept beside it so that the day the two differ, the pair says so instead of one green line
 * saying nothing. The module header records what is and is not claimed.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { writeDiagnostic } from "./diagnostic"

/** A child that writes N lines the chosen way and then exits hard, exactly as a refusal does. */
const CHILD = [
  `const { writeDiagnostic } = await import(process.argv[2])`,
  `const lines = Number(process.argv[3])`,
  `let text = ""`,
  `for (let i = 0; i < lines; i++) text += "line " + String(i).padStart(6, "0") + " " + "z".repeat(180) + "\\n"`,
  `if (process.argv[4] === "sync") writeDiagnostic(text)`,
  `else process.stderr.write(text)`,
  `process.exit(2)`,
].join("\n")

const MODULE_URL = new URL("./diagnostic.ts", import.meta.url).href
const LINE_BYTES = "line 000000 ".length + 180 + 1

/** Run the child, count what actually came out of its stderr PIPE, and report its exit code. */
const run = (lines: number, how: "sync" | "stream") =>
  new Promise<{ code: number | null; bytes: number }>((resolve) => {
    const dir = mkdtempSync(join(os.tmpdir(), "novaclaw-diag-"))
    const script = join(dir, "child.ts")
    writeFileSync(script, CHILD, "utf8")
    const child = spawn(process.execPath, [script, MODULE_URL, String(lines), how], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    let bytes = 0
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length
    })
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true })
      resolve({ code, bytes })
    })
  })

describe("writeDiagnostic", () => {
  it("🔴 delivers every byte although the process exits in the next statement", async () => {
    const { code, bytes } = await run(2_000, "sync")
    // The exit code survives too — a refusal that arrived as exit 0 would be worse than a lost one.
    expect(code).toBe(2)
    expect(bytes).toBe(2_000 * LINE_BYTES)
  }, 30_000)

  it("the buffered stream is the COMPARISON arm, not a second assertion", async () => {
    // On this runtime it also delivers in full, and saying so is the point: the change is insurance
    // against a target we cannot measure from here, not a repair of an observed loss. If this ever
    // comes back short while the arm above does not, that is the day the rule earns its reason.
    const { code, bytes } = await run(2_000, "stream")
    expect(code).toBe(2)
    expect(bytes).toBe(2_000 * LINE_BYTES)
  }, 30_000)

  it("8 MB is not short-written — the partial-write cursor, exercised", async () => {
    // Far past any pipe buffer, so this only passes if each `writeSync` return value is used as a
    // cursor. Ignoring it is the classic way to lose the tail of exactly this kind of message.
    const lines = Math.ceil((8 * 1024 * 1024) / LINE_BYTES)
    const { bytes } = await run(lines, "sync")
    expect(bytes).toBe(lines * LINE_BYTES)
  }, 60_000)

  it("never throws — it is the last thing a refusal does", () => {
    // An exception here would replace a legible refusal with an unhandled error, which is the exact
    // outcome the module exists to prevent.
    expect(() => writeDiagnostic("")).not.toThrow()
  })
})
