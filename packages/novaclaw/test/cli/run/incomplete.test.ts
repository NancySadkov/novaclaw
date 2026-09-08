import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { incompleteMessage } from "@/cli/cmd/run/incomplete"

/**
 * A run that ends without settling must say WHICH way it failed.
 *
 * The 2026-08-24 root cause of the `attach mode` flake was a server disposing this instance
 * mid-turn after somebody wrote config. The CLI received `server.instance.disposed`, discarded it as
 * "not mine" because the disposal carries no `sessionID`, and reported the generic "lost the event
 * stream" — so the cause had to be re-derived from scratch with a file probe.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const runSource = readFileSync(path.resolve(here, "../../../src/cli/cmd/run.ts"), "utf8")

describe("an incomplete run says which way it ended", () => {
  test("the two reasons do not share a message", () => {
    // A refactor that collapses them puts us back where we started: an unattributable exit 1.
    expect(incompleteMessage("disposed")).not.toBe(incompleteMessage("stream-ended"))
  })

  test("the disposed message names what actually causes it", () => {
    // The actionable half. "Something ended your stream" sends nobody anywhere; "a config change
    // disposes running instances" names the thing to go look at.
    expect(incompleteMessage("disposed")).toMatch(/config change/i)
    expect(incompleteMessage("disposed")).toMatch(/disposed this instance/i)
  })

  test("neither message reports a turn that did not happen", () => {
    for (const reason of ["disposed", "stream-ended"] as const)
      expect(incompleteMessage(reason)).toMatch(/did not complete/)
  })

  test("run.ts checks for the disposal BEFORE the session filter", () => {
    // 🔴 Invisible to any behavioural test here, and load-bearing: the disposal carries only
    // `{ directory }`, so `properties.sessionID` is undefined. If the filter runs first it
    // `continue`s past the disposal and `incomplete` never leaves "stream-ended" — the message
    // silently regresses to the generic one while every assertion above still passes.
    const check = runSource.indexOf('event.type === "server.instance.disposed"')
    const filter = runSource.indexOf("if (scoped?.sessionID !== sessionID) continue")
    expect(check).toBeGreaterThan(-1)
    expect(filter).toBeGreaterThan(-1)
    expect(check).toBeLessThan(filter)
  })
})
