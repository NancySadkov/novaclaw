import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { diffKinds, diffPaths, type RenderedDiff } from "./session-files-derive"

const changed = (file: string, status: RenderedDiff["status"] = "modified") =>
  ({ file, status }) as RenderedDiff

describe("the changes map colours a changed file AND the folders holding it", () => {
  test("🔴 the file itself is registered, not only its directories", () => {
    // THE DEFECT THIS SHIPPED WITH. The directory walk is the part you notice while looking at the
    // tree, so the first port coloured `src/pages` and left `src/pages/session.tsx` colourless —
    // the one row the user is looking for was the one row that looked untouched.
    const kinds = diffKinds([changed("src/pages/session.tsx")])
    expect([...kinds.keys()]).toEqual(["src/pages/session.tsx", "src", "src/pages"])
  })

  test("a nested file registers every level above it", () => {
    const kinds = diffKinds([changed("a/b/c/d.txt")])
    expect([...kinds.keys()]).toEqual(["a/b/c/d.txt", "a", "a/b", "a/b/c"])
  })

  test("a root-level file registers no directory, and does not invent one", () => {
    const kinds = diffKinds([changed("README.md")])
    expect([...kinds.keys()]).toEqual(["README.md"])
  })

  test("status maps to the tree's own three kinds", () => {
    expect(diffKinds([changed("x.ts", "added")]).get("x.ts")).toBe("add")
    expect(diffKinds([changed("x.ts", "deleted")]).get("x.ts")).toBe("del")
    expect(diffKinds([changed("x.ts", "modified")]).get("x.ts")).toBe("mix")
  })

  test("a folder holding both an addition and a deletion reads as mixed, not as either one", () => {
    const kinds = diffKinds([changed("src/added.ts", "added"), changed("src/gone.ts", "deleted")])
    expect(kinds.get("src")).toBe("mix")
  })

  test("a folder holding only additions reads as added, and only deletions as deleted", () => {
    expect(diffKinds([changed("s/a.ts", "added"), changed("s/b.ts", "added")]).get("s")).toBe("add")
    expect(diffKinds([changed("s/a.ts", "deleted"), changed("s/b.ts", "deleted")]).get("s")).toBe("del")
  })
})

describe("a path is normalized to the shape the tree is keyed on", () => {
  test("🔴 a Windows-shaped path is normalized, so it can match the tree at all", () => {
    // `replaceAll("\\\\", "/")` is a TWO-backslash string and normalizes nothing; measured, it
    // leaves `src\pages\a.tsx` byte-identical. Then the key stored is a path the forward-slash
    // tree never matches, and the single-part split registers no directory either — a backslashed
    // path got no colour AND no row.
    const kinds = diffKinds([changed("src\\pages\\a.tsx")])
    expect([...kinds.keys()]).toEqual(["src/pages/a.tsx", "src", "src/pages"])
  })

  test("a trailing slash does not leave an empty segment behind", () => {
    const kinds = diffKinds([changed("src/pages/")])
    expect(kinds.has("src/pages/")).toBe(false)
    expect(kinds.has("src")).toBe(true)
  })

  test("a diff with no file contributes no key and throws nothing", () => {
    const kinds = diffKinds([{ file: "", status: "modified" } as RenderedDiff])
    expect(kinds.size).toBe(0)
  })
})

describe("the two lists are driven by the same paths", () => {
  test("diffPaths keeps order, drops absent files, and never invents a directory", () => {
    expect(diffPaths([changed("b.ts"), changed("a.ts")])).toEqual(["b.ts", "a.ts"])
    expect(diffPaths([{ file: "", status: "modified" } as RenderedDiff, changed("a.ts")])).toEqual(["a.ts"])
    expect(diffPaths([])).toEqual([])
  })

  test("an empty diff set yields an empty map, so the tree renders no stale colour", () => {
    expect(diffKinds([]).size).toBe(0)
  })
})

describe("sibling sweep: the class is an escape that stopped meaning what it meant", () => {
  test("🔴 no source file normalizes a path to forward slashes with a two-backslash literal", () => {
    // The grep the class deserves, over every app and ui source file rather than a hand-written list.
    //
    // ⚠️ THE FIRST VERSION OF THIS SWEEP WAS TOO WIDE, AND IT FOUND FOUR INNOCENT SITES. It
    // matched any `"\\\\"` string, but a two-backslash string is CORRECT in three shapes that have
    // nothing to do with this defect: a UNC prefix check (`\\server\share` really does start with
    // two backslashes — `context/file/path.ts`, `utils/path-key.ts`,
    // `prompt-input/build-request-parts.ts`) and an escape (a backslash doubled for embedding in a
    // CSS string — `context/settings.tsx`). A ratchet that fires on correct code is worse than no
    // ratchet: it would be disabled on its first false alarm, and the real defect with it. So the
    // pattern is narrowed to the SHAPE of the defect — replacing backslashes with forward slashes.
    const root = path.resolve(import.meta.dir, "..", "..", "..")
    const offenders: string[] = []
    // The needle is built by COUNT rather than written as an escape, because the whole defect is an
    // escape that means less than it looks like. `"\\"` in source is a string holding TWO backslash
    // characters (the correct single-backslash replace); `"\\\\"` holds FOUR, and is the defect.
    // A regex for this was written, matched all seven CORRECT sites, and had to be thrown away.
    const defect = `"${"\\".repeat(4)}"`
    const forwardSlash = `"/"`
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === "build") continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".test.ts")) continue
        const source = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "")
        for (const [index, line] of source.split("\n").entries()) {
          if (/replace(All)?\(/.test(line) && line.includes(defect) && line.includes(forwardSlash)) {
            offenders.push(`${path.relative(root, full)}:${index + 1}`)
          }
        }
      }
    }
    for (const dir of [path.join(root, "src"), path.join(root, "..", "ui", "src")]) walk(dir)
    expect(offenders, `two-backslash path normalization at ${offenders.join(", ")}`).toEqual([])
  })

  test("the UNC and CSS-escape sites the wide sweep flagged are still intact", () => {
    // The control for the narrowing above: if these ever stop matching, the sweep is no longer
    // finding what it claims to and its silence proves nothing.
    const read = (relative: string) => readFileSync(path.join(path.resolve(import.meta.dir, "..", "..", ".."), relative), "utf8")
    expect(read("src/utils/path-key.ts")).toContain('startsWith("\\\\\\\\")')
    expect(read("src/context/settings.tsx")).toContain('replaceAll("\\\\", "\\\\\\\\")')
  })

  test("the narrowed sweep still bites on the exact line it was written for", () => {
    // Without this the sweep above is a tautology: a pattern that matches nothing also passes. The
    // line below is the pill's original, verbatim, and the sweep must catch it.
    const defect = `"${"\\".repeat(4)}"`
    const planted = `      const normalize = (p: string) => p.replaceAll(${defect}, "/").replace(/\\/+$/, "")`
    expect(/replace(All)?\(/.test(planted) && planted.includes(defect) && planted.includes('"/"')).toBe(true)
    // And the correct line is not flagged, which is the other half.
    const correct = `      const normalize = (p: string) => p.replaceAll("\\", "/").replace(/\\/+$/, "")`
    expect(correct.includes(defect)).toBe(false)
  })

  test("the component calls the shared derivations, so there is one copy of this logic", () => {
    // A second inline copy would drift, and the drift is invisible until a tree is miscoloured.
    const source = readFileSync(path.resolve(import.meta.dir, "session-files-section.tsx"), "utf8")
    expect(source).toContain("diffKinds(props.diffs)")
    expect(source).toContain("diffPaths(props.diffs)")
  })
})
