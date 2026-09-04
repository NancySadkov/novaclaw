import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { reportedWrite } from "./config-write"
import { stripComments } from "./strip-comments"

/**
 * **THE HELPER, AND THE SHRINK-ONLY LEDGER FOR THE TWO WAYS A WRITE FAILS IN SILENCE.**
 *
 * Ruling 2's first half is *a failed mutation never reports success*, and the whole-tree review
 * found three surfaces breaking it in the same week without sharing a line of code. Both shapes
 * below were written by people who HAD thought about failure — that is what makes them a class
 * rather than an oversight:
 *
 * **A — a failure reported only to the browser console.** `.catch((e) => console.error(…))`. A
 * normal person has no console open, so the control simply appears to refuse its own input. This is
 * the same rule as the settled-resource ledger's form B one layer up: the fault happened, and
 * nothing a user can see is different afterwards.
 *
 * **B — a config write whose rejection is discarded outright.** `.catch(() => undefined)` on an
 * `updateConfig` chain. `undefined` is the honest value for *no answer* when a state check reads it
 * next door (which is why the settled-resource ledger deliberately does NOT count it) — but on a
 * MUTATION there is no state to check: the promise is the entire report, and dropping it is the
 * whole event.
 *
 * ⚠️ **What is not counted, so the ledger measures the tree rather than itself.** Comments are
 * stripped (this tree documents its own defects in prose beside the code) and `*.test.*` is out of
 * scope. Form B is anchored by {@link chainedCatch} to a handler on the write's OWN promise chain,
 * so an unrelated `.catch(() => undefined)` guarding a READ is not a mutation and is not counted.
 *
 * **When you convert one, lower its line — and delete the line at zero.**
 */

const APP_SRC = resolve(import.meta.dir, "..")

/** `.catch(e => console.error(…))` — the handler's whole body is the console call. */
const CONSOLE_ONLY = /\.catch\s*\(\s*(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*=>\s*console\.[a-z]+\s*\(/g

/** A config mutation. Member access included: every real call is `sync().updateConfig(`. */
const WRITE = /updateConfig\s*\(/g

/** `.catch(() => undefined)`, `.catch(() => {})`, `.catch(() => ({}))` — a discarded rejection. */
const DISCARDED =
  /^\.catch\s*\(\s*(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*=>\s*(?:undefined|\{\s*\}|\(\s*\{\s*\}\s*\))\s*,?\s*\)/

/** The links a promise chain may pass through between the call and its handler. */
const CHAIN_LINK = /^[\s)?]*(?:as\s+[A-Za-z0-9_$<>,.|[\]\s]*)?[\s)?]*/

/** The index just past the balanced `(…)` whose `(` sits at `open`. */
function afterCall(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]
    if (c === "(") depth += 1
    else if (c === ")") {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * The rejection handler on THIS call's own chain, or `undefined`.
 *
 * ⚠️ Walking the chain rather than scanning a character window is the difference between a detector
 * and a coin flip. A window blamed one write for the NEXT statement's handler, and it counted a
 * `.catch(() => undefined)` guarding an unrelated READ that merely sat nearby — both measured, both
 * on this file's own controls.
 */
function chainedCatch(text: string, from: number): { index: number; handler: string } | undefined {
  let i = from
  for (;;) {
    i += CHAIN_LINK.exec(text.slice(i))?.[0].length ?? 0
    if (text.startsWith(".catch(", i)) return { index: i, handler: text.slice(i, i + 200) }
    const link = [".then(", ".finally("].find((name) => text.startsWith(name, i))
    if (link === undefined) return undefined
    const end = afterCall(text, i + link.length - 1)
    if (end < 0) return undefined
    i = end
  }
}

/**
 * Measured against `packages/app/src` on 2026-09-02, after the Tools, Instances and Policies panels
 * were moved onto `reportedWrite`. Every number may only DECREASE.
 */
const LEDGER: { console: Record<string, number>; discarded: Record<string, number> } = {
  console: {
    "context/terminal.tsx": 1,
    "pages/session/timeline/model.ts": 1,
  },
  discarded: {
    "components/dialog-select-directory-v2.tsx": 1,
    "components/expertise-mirror.tsx": 1,
    "pages/files.tsx": 1,
  },
}

interface Site {
  readonly line: number
  readonly source: string
}

export function scanText(raw: string): { console: Site[]; discarded: Site[] } {
  const text = stripComments(raw)
  const lines = text.split("\n")
  const lineAt = (index: number) => text.slice(0, index).split("\n").length
  const site = (index: number): Site => ({ line: lineAt(index), source: lines[lineAt(index) - 1]?.trim() ?? "" })

  const consoleOnly: Site[] = []
  const discarded: Site[] = []
  for (const match of text.matchAll(CONSOLE_ONLY)) consoleOnly.push(site(match.index))
  for (const match of text.matchAll(WRITE)) {
    const end = afterCall(text, match.index + match[0].length - 1)
    if (end < 0) continue
    const found = chainedCatch(text, end)
    if (found === undefined || !DISCARDED.test(found.handler)) continue
    discarded.push(site(found.index))
  }
  return { console: consoleOnly, discarded }
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
    if (entry.includes(".test.")) continue
    acc.push(full)
  }
  return acc
}

function scan() {
  const consoleOnly: Record<string, Site[]> = {}
  const discarded: Record<string, Site[]> = {}
  for (const file of sourceFiles(APP_SRC)) {
    const rel = relative(APP_SRC, file).replaceAll("\\", "/")
    const found = scanText(readFileSync(file, "utf8"))
    if (found.console.length) consoleOnly[rel] = found.console
    if (found.discarded.length) discarded[rel] = found.discarded
  }
  return { console: consoleOnly, discarded }
}

/** Every disagreement between a ledger line and the tree, naming the LINES, not just a total. */
function drift(found: Record<string, Site[]>, allowed: Record<string, number>, form: string): string[] {
  const out: string[] = []
  for (const file of new Set([...Object.keys(found), ...Object.keys(allowed)]).values()) {
    const sites = found[file] ?? []
    const cap = allowed[file] ?? 0
    if (sites.length === cap) continue
    const where = sites.map((s) => `\n      ${file}:${s.line}  ${s.source}`).join("")
    out.push(
      sites.length > cap
        ? `${file}: ${sites.length} ${form}, ledger allows ${cap}.${where}`
        : `${file}: ${sites.length} ${form}, ledger still says ${cap}. Lower it to ${sites.length}${cap && !sites.length ? " (delete the line)" : ""}.${where}`,
    )
  }
  return out
}

describe("reportedWrite hands back a verdict instead of swallowing one", () => {
  test("a landed write is ok, and the report is never called", async () => {
    let reports = 0
    const result = await reportedWrite(
      async () => ({ done: true }),
      () => reports++,
    )
    expect(result).toEqual({ ok: true })
    expect(reports).toBe(0)
  })

  test("🔴 a rejected write is NOT ok — the caller cannot mistake it for a save", async () => {
    const said: string[] = []
    const result = await reportedWrite(async () => {
      throw new Error("instance is restarting")
    }, said.push.bind(said))
    // The verdict AND the sentence: a report with `{ ok: true }` would still close an editor.
    expect(result).toEqual({ ok: false, error: "instance is restarting" })
    expect(said).toEqual(["instance is restarting"])
  })

  test("the report fires exactly once, and a non-Error rejection still says something", async () => {
    let reports = 0
    const result = await reportedWrite(
      () => Promise.reject("403"),
      () => reports++,
    )
    expect(reports).toBe(1)
    expect(result.ok === false && result.error).toBe("403")
  })

  test("NEGATIVE CONTROL — a write that resolves with `undefined` is a SAVE, not a failure", async () => {
    // The mirror of the class: folding "no return value" into "no answer" would make every
    // void-returning mutation report failure, and the panels would refuse to close on success.
    let reports = 0
    const result = await reportedWrite(
      async () => undefined,
      () => reports++,
    )
    expect(result.ok).toBe(true)
    expect(reports).toBe(0)
  })
})

describe("the silent-write ledger", () => {
  test("General's four immediate controls and Recovery's resume control all use the reported door", () => {
    const general = stripComments(readFileSync(resolve(APP_SRC, "components/settings-v2/general.tsx"), "utf8"))
    const recovery = stripComments(readFileSync(resolve(APP_SRC, "components/settings-v2/recovery.tsx"), "utf8"))
    expect(general.match(/writeConfig\s*\(/g)).toHaveLength(4)
    expect(recovery.match(/writeConfig\s*\(/g)).toHaveLength(1)
    expect(general).not.toMatch(/updateConfig\s*\(/)
    expect(recovery).not.toMatch(/updateConfig\s*\(/)
  })

  test("no new failure is reported only to the console, and no ledger line is stale", () => {
    expect(drift(scan().console, LEDGER.console, "console-only failure report(s)")).toEqual([])
  })

  test("no new config write discards its own rejection, and no ledger line is stale", () => {
    expect(drift(scan().discarded, LEDGER.discarded, "discarded write rejection(s)")).toEqual([])
  })

  test("POSITIVE CONTROL — the detectors flag a module that does the thing", () => {
    // A guard that reports zero because it matches NOTHING is indistinguishable from a clean tree,
    // so it is aimed at a module written to be caught: every shape claimed, and nothing else.
    const bad = `
      const toggle = (id: string) => {
        void sync().updateConfig({ tool_policy: { [id]: {} } }).catch((error) => console.error("failed", error))
      }
      const savePeers = (next: Peer[]) => {
        void sync().updateConfig({ instances: next }).catch(() => undefined)
      }
      const pin = (next: string[]) => void sync.updateConfig({ folder_bookmarks: next }).catch(() => {})
      const seen = () => void sync.updateConfig({ seen: true }).then(refresh).catch(() => undefined)
    `
    const found = scanText(bad)
    expect(found.console.length).toBe(1)
    // Line 9 is the chain-walking half: a handler reached THROUGH a `.then` is still this write's.
    expect(found.discarded.map((s) => s.line)).toEqual([6, 8, 9])
  })

  test("NEGATIVE CONTROL — the sanctioned shapes and the prose about them are NOT flagged", () => {
    // Each line is a real shape from this tree that an earlier draft of these regexes caught.
    const good = `
      /** Never end an updateConfig with .catch(() => undefined) or .catch((e) => console.error(e)). */
      // void sync().updateConfig(patch).catch(() => undefined)
      const saved = await reportedWrite(() => sync().updateConfig(patch), report)
      const rows = await listThings(base).catch(() => undefined)
      void sync().updateConfig(patch).catch((error) => showToast({ description: String(error) }))
      const text = await res.text().catch(() => "")
      const url = "https://example.invalid/a//b"
    `
    const found = scanText(good)
    expect(found.console).toEqual([])
    expect(found.discarded).toEqual([])
  })

  test("the scan is reading real files (vacuity)", () => {
    // Every number above is a match over text read from disk. A broken walk makes them all zero and
    // every assertion agree with itself forever, so the ledger's own non-zero lines prove it looks.
    const found = scan()
    expect(sourceFiles(APP_SRC).length).toBeGreaterThan(100)
    expect(Object.keys(found.console).length).toBeGreaterThan(0)
    expect(Object.keys(found.discarded).length).toBeGreaterThan(0)
    // The three panels this ledger opened with are converted, and must stay converted.
    for (const converted of [
      "components/settings-v2/tools.tsx",
      "components/settings-v2/instances-access.tsx",
      "components/settings-v2/policies.tsx",
    ]) {
      expect(found.console[converted], `${converted} went back to a console-only report`).toBeUndefined()
      expect(found.discarded[converted], `${converted} went back to a discarded rejection`).toBeUndefined()
    }
  })
})
