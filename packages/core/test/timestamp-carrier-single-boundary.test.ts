import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * A decoded Effect timestamp used to leak its object shape into each consumer that happened to hit
 * one. Four private coercers accumulated, while other call sites still handed the object to native
 * Date APIs or subtracted it directly. Each local fix taught one more module a transport detail and
 * left the next consumer exposed.
 *
 * The field name below is therefore confined to `@novaclaw/schema/time`: transports, UI cards,
 * exporters, stores, and future consumers know only `Timestamp.toEpochMillis` / `toDate` /
 * `toISOString` / `elapsedMillis`. If Effect or the wire representation changes again, there is one
 * containment wall to update and this ledger catches any second breach.
 */

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const BOUNDARY = "packages/schema/src/time.ts"

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(file, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|smoke)\.(ts|tsx)$/.test(entry.name)) out.push(file)
  }
  return out
}

const relative = (file: string): string => path.relative(ROOT, file).replaceAll(path.sep, "/")
const files = walk(path.join(ROOT, "packages"))
const mentions = files.flatMap((file) => {
  const source = stripComments(fs.readFileSync(file, "utf8"), file)
  return /\bepochMillis\b/.test(source) ? [relative(file)] : []
})

describe("decoded timestamp carriers stay behind one boundary", () => {
  test("only the shared time module knows the carrier's field name", () => {
    expect(
      mentions,
      "A production module learned the decoded timestamp carrier's private shape. Normalize through\n" +
        "@novaclaw/schema/time instead; adding another local converter breaks the containment wall.",
    ).toEqual([BOUNDARY])
  })

  test("the production sweep is not vacuous", () => {
    expect(files.length).toBeGreaterThan(2_000)
    expect(mentions).toContain(BOUNDARY)
  })
})
