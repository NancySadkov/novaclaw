import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobMatch } from "@novaclaw/core/util/glob-match"
import { CASES } from "./glob-conformance-corpus"

/**
 * The owned matcher against the answers `minimatch@10.2.5` gave on the day it was replaced
 * (`glob-conformance-record.ts` wrote `glob-conformance-expected.json`). One test per case, named
 * so a red says which pair moved. The corpus is the shapes this tree's callers actually pass plus
 * the classic gotchas; see the corpus file for what each group covers.
 */
const expected = JSON.parse(readFileSync(join(import.meta.dir, "glob-conformance-expected.json"), "utf8")) as boolean[]

describe("GlobMatch answers what minimatch answered", () => {
  test("the recording covers the corpus", () => {
    expect(expected.length).toBe(CASES.length)
  })
  CASES.forEach((c, index) => {
    const flags = `${c.dot ? "dot" : "nodot"}${c.nocase ? ",nocase" : ""}`
    test(`${JSON.stringify(c.pattern)} vs ${JSON.stringify(c.path)} [${flags}] → ${expected[index]}`, () => {
      expect(GlobMatch.match(c.pattern, c.path, { dot: c.dot, nocase: c.nocase })).toBe(expected[index]!)
    })
  })
})

describe("the helpers a scan plans with", () => {
  test("staticPrefix names the literal directories a walk can start in", () => {
    expect(GlobMatch.staticPrefix("src/**/*.ts")).toEqual(["src"])
    expect(GlobMatch.staticPrefix("**/*.ts")).toEqual([])
    expect(GlobMatch.staticPrefix("a/b/c.txt")).toEqual(["a", "b"])
    expect(GlobMatch.staticPrefix("*.txt")).toEqual([])
    expect(GlobMatch.staticPrefix("{command,commands}/**/*.md")).toEqual([])
    expect(GlobMatch.staticPrefix(".forge/*.md")).toEqual([".forge"])
  })
  test("hasGlobstar sees only a whole `**` segment", () => {
    expect(GlobMatch.hasGlobstar("a/**/b")).toBe(true)
    expect(GlobMatch.hasGlobstar("a/**b")).toBe(false)
    expect(GlobMatch.hasGlobstar("{a/**,b}")).toBe(true)
  })
  test("expandBraces", () => {
    expect(GlobMatch.expandBraces("*.{js,ts}")).toEqual(["*.js", "*.ts"])
    expect(GlobMatch.expandBraces("a{1..3}")).toEqual(["a1", "a2", "a3"])
    expect(GlobMatch.expandBraces("{a,{b,c}}x")).toEqual(["ax", "bx", "cx"])
    expect(GlobMatch.expandBraces("plain")).toEqual(["plain"])
  })
  test("NEGATIVE CONTROL: the corpus can disagree — a wrong answer is not silently equal", () => {
    // `*` must not cross a separator; if it did, this pair would be true and the corpus row that
    // records false would fail. Asserted directly so the recording is not the only witness.
    expect(GlobMatch.match("*", "a/b", { dot: true })).toBe(false)
    expect(GlobMatch.match("**", "a/b", { dot: true })).toBe(true)
  })
})
