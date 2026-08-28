import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { tmpdir } from "./fixture/tmpdir"

/**
 * `needs` — todo.md **ruling 14**'s one machine-read field, and until 2026-07-31 the only part of it
 * that was aspirational: the line was written, carried and preserved by everything in `recipe.ts` and
 * read by NOTHING, so a recipe declaring `needs: gcc` stated a prerequisite the product never checked.
 *
 * Four invariants are pinned here, each because it would otherwise be a claim in a comment (ruling 1):
 *
 *  1. **A declaration is READ.** The full chain — `SaveInput.needs` → `needsLine` → `render` → `parse` →
 *     `parseNeeds` — round-trips through a real folder on disk, so no link in it can rot silently.
 *  2. **Ruling 2: a check that cannot verify says so.** An unrecognised fact is `unknown`, NEVER
 *     `absent`, and `unmetMessage` refuses only on facts that were actually probed while naming the ones
 *     it could not check. A false "you are missing gcc" on a machine that has one is worse than no check.
 *  3. **The claim is checkable by hand.** Every candidate tried is reported (agent-jail's `probeCommand`
 *     lesson), and for a C compiler that set includes the off-PATH Windows locations `hello-c`'s own
 *     prompt requires the agent to test before concluding "no compiler".
 *  4. **The door is where it runs.** `recipe.run` checks BEFORE materializing and BEFORE creating a
 *     session, or the check is a comment: everything after that line cooks with `permissionMode:
 *     "bypass"` in a folder that has already been written.
 */

// A resolver that finds nothing, and one that finds everything — the two ends of the seam.
const nothing = () => null
const everything = (candidate: string) => candidate

describe("parseNeeds — reading the carried line", () => {
  test("reads the inline form this module writes, comma-separated", () => {
    expect(Recipe.parseNeeds(["author: Nancy", "needs: a C compiler, python3", "tags: [a]"])).toEqual([
      "a C compiler",
      "python3",
    ])
  })

  test("tolerates the casing and spacing a person actually types", () => {
    expect(Recipe.parseNeeds(["  NEEDS  :   gcc ,  , git  "])).toEqual(["gcc", "git"])
  })

  test("reads the YAML block-list form too — a declaration that silently did nothing is the whole bug", () => {
    expect(Recipe.parseNeeds(["needs:", "  - a C compiler", "  - python3", "author: Nancy"])).toEqual([
      "a C compiler",
      "python3",
    ])
  })

  test("an indented list under some OTHER key is not a needs entry", () => {
    // `needs: gcc` does not open a block, so the `- one` below belongs to `list:` and must not be read
    // as a prerequisite — a stray dash may never invent a requirement that blocks a cook.
    expect(Recipe.parseNeeds(["needs: gcc", "list:", "  - one", "  - two"])).toEqual(["gcc"])
  })

  test("a value containing a colon keeps it (the first colon is the key separator)", () => {
    expect(Recipe.parseNeeds(["needs: a compiler: gcc or clang"])).toEqual(["a compiler: gcc or clang"])
  })

  test("no needs line, or an empty one, declares nothing", () => {
    expect(Recipe.parseNeeds(["author: Nancy", "# a comment", ""])).toEqual([])
    expect(Recipe.parseNeeds(["needs:"])).toEqual([])
  })

  test("is the inverse of needsLine — what we write is what we read back", () => {
    const facts = ["a C compiler", "python3"]
    const line = Recipe.needsLine(facts)
    expect(line).toBe("needs: a C compiler, python3")
    expect(Recipe.parseNeeds([line!])).toEqual(facts)
  })
})

describe("checkNeeds — ruling 2 lives in the `unknown` arm", () => {
  test("a fact NO probe recognises is `unknown`, never `absent`", () => {
    // The load-bearing assertion of this file. `absent` blocks a cook; `unknown` must not, because we
    // know nothing about it — and a recipe may say anything at all.
    const [check] = Recipe.checkNeeds(["a quantum annealer"], nothing)
    expect(check!.status).toBe("unknown")
    expect(check!.looked).toEqual([])
  })

  test("a recognised fact with nothing on the host is `absent`, and reports what was tried", () => {
    const [check] = Recipe.checkNeeds(["a C compiler"], nothing)
    expect(check!.status).toBe("absent")
    // On PATH…
    for (const candidate of ["cc", "gcc", "clang"]) expect(check!.looked).toContain(candidate)
    // …and the off-PATH Windows locations `hello-c`'s prompt requires before concluding "no compiler".
    // Without these the checker would report `absent` on a normal Windows box that HAS a compiler.
    expect(check!.looked).toContain("C:/soft/w64devkit/bin/gcc.exe")
    expect(check!.looked).toContain("C:/msys64/mingw64/bin/gcc.exe")
    expect(check!.looked).toContain("C:/mingw64/bin/gcc.exe")
    expect(check!.looked).toContain("C:/TDM-GCC-64/bin/gcc.exe")
  })

  test("a recognised fact the host satisfies is `present` and names what resolved", () => {
    const [check] = Recipe.checkNeeds(["a C compiler"], everything)
    expect(check!.status).toBe("present")
    expect(check!.found).toBe("cc")
    // It stopped at the first hit rather than probing everything — the door must be cheap.
    expect(check!.looked).toEqual(["cc"])
  })

  test("recognises the vocabulary ruling 14 documents, and the plain binary names", () => {
    for (const fact of ["a C compiler", "C99 compiler", "gcc", "clang", "python3", "python", "node", "git"])
      expect(Recipe.checkNeeds([fact], everything)[0]!.status).toBe("present")
  })

  test("does NOT claim to check a C++ compiler — we probe no g++", () => {
    // Silently answering "a C++ compiler" with a C probe would be ruling 2's fault-described-falsely.
    expect(Recipe.checkNeeds(["a C++ compiler"], nothing)[0]!.status).toBe("unknown")
  })

  test("ONE fact naming TWO capabilities checks both", () => {
    // "python3 and a C compiler" is one comma-free fact. Checking only the first would report `present`
    // for a host missing the second.
    const found = (candidate: string) => (candidate === "python3" ? candidate : null)
    const [check] = Recipe.checkNeeds(["python3 and a C compiler"], found)
    expect(check!.status).toBe("absent")
    expect(check!.looked).toContain("gcc")
  })
})

// =============================================================================
// 🔴 A PROBE THAT FAILED IS NOT A FACT THAT IS ABSENT
// =============================================================================
//
// The same defect class as the transport receipt, one module over: `existsSync` returns `false` for
// EACCES, EPERM, ELOOP and EIO exactly as it does for ENOENT, so an unreadable path was byte-identical
// to "not installed" — and the refusal built from it told the user to *"install what is missing"* on the
// strength of a read that had simply failed. `UNREADABLE` is the third answer that separates them.

describe("a locked path is `unreadable`, never `absent`", () => {
  /**
   * Every candidate blocked: the instrument failed on all of them.
   *
   * ⚠️ Annotated as `ResolveCommand` rather than inferred. `UNREADABLE` is a `unique symbol`, and a
   * bare `() => Recipe.UNREADABLE` widens its return to plain `symbol`, which the parameter type then
   * refuses. Contextual typing keeps the unique symbol narrow.
   */
  const blocked: Recipe.ResolveCommand = () => Recipe.UNREADABLE

  test("⭐ the regression: an unreadable candidate is NOT reported as missing, and does NOT block a cook", () => {
    const [check] = Recipe.checkNeeds(["a C compiler"], blocked)
    expect(check!.status).toBe("unreadable")
    // The whole point — `unmetMessage` only refuses on `absent`, so this cannot stop a cook.
    expect(Recipe.unmetMessage("Hello, C", Recipe.checkNeeds(["a C compiler"], blocked))).toBeUndefined()
  })

  test("a hit later in the list wins — a blocked candidate is irrelevant once something resolves", () => {
    // The blocked probe must not END the search, or a locked `cc` would hide a perfectly good `gcc`.
    const resolve = (candidate: string) => (candidate === "gcc" ? candidate : Recipe.UNREADABLE)
    const [check] = Recipe.checkNeeds(["a C compiler"], resolve)
    expect(check!.status).toBe("present")
    expect(check!.found).toBe("gcc")
  })

  test("`absent` still dominates: a fact with one PROVABLY missing member is still a refusal", () => {
    // "python3 and a C compiler" where python3 is genuinely not there and every compiler probe was
    // blocked. One member is provably missing, so refusing is a claim the evidence supports.
    const resolve = (candidate: string) =>
      candidate === "python3" || candidate === "python" ? null : Recipe.UNREADABLE
    const [check] = Recipe.checkNeeds(["python3 and a C compiler"], resolve)
    expect(check!.status).toBe("absent")
  })

  test("the refusal names it under “could not check”, never among the missing", () => {
    // Ruling 2 inside the sentence: a refusal that implied we had verified a fact our instrument failed
    // on would be the fault described falsely, in the very sentence written to avoid it.
    const resolve = (candidate: string) =>
      candidate === "node" ? null : candidate === "git" ? Recipe.UNREADABLE : null
    const message = Recipe.unmetMessage("Thing", Recipe.checkNeeds(["node", "git"], resolve))!
    expect(message).toContain("I could not check: git")
    expect(message.slice(0, message.indexOf("I could not check"))).not.toContain("git")
  })

  test("⭐ the REAL errno decision, not a stub: only ENOENT/ENOTDIR mean 'not there'", () => {
    // The tests above drive an injected resolver, which proves the POLICY. This drives the production
    // decision itself, which is the line that was wrong: without it the suite would pass on a module
    // that still folded EACCES into "missing", because the seam would never produce an `UNREADABLE`.
    for (const code of ["ENOENT", "ENOTDIR"])
      expect({ code, out: Recipe.fromStatError(code) }).toEqual({ code, out: null })
    for (const code of ["EACCES", "EPERM", "ELOOP", "EIO", "EBUSY", undefined, "SOMETHING_NEW"])
      expect({ code, out: Recipe.fromStatError(code) }).toEqual({ code, out: Recipe.UNREADABLE })
  })

  test("the PRODUCTION resolver on a real filesystem: found is found, and absent is still absent", async () => {
    // The A/B on the other side. Honesty must not have been bought by disabling the probe, so this
    // drives `resolveCommand` ITSELF against real paths rather than through the injected seam.
    await using dir = await tmpdir()
    const real = path.join(dir.path, "gcc.exe")
    await fs.writeFile(real, "not really a compiler")
    expect(Recipe.resolveCommand(real)).toBe(real)
    // Nothing there at all -> ENOENT -> `null`, which is what still makes a refusal possible.
    expect(Recipe.resolveCommand(path.join(dir.path, "nope", "gcc.exe"))).toBeNull()
    // A path THROUGH a file (ENOTDIR on POSIX, ENOENT on win32) is a real absence too, not a failed
    // instrument -- both codes sit on the `null` side for exactly this case.
    expect(Recipe.resolveCommand(path.join(real, "child.exe"))).toBeNull()
  })
})

describe("unmetMessage — the refusal a normal person reads", () => {
  const checks = (resolve: (candidate: string) => string | null, facts: string[]) => Recipe.checkNeeds(facts, resolve)

  test("nothing missing means no refusal at all", () => {
    expect(Recipe.unmetMessage("Hello, C", checks(everything, ["a C compiler"]))).toBeUndefined()
    // …including when every stated fact is one we could not check.
    expect(Recipe.unmetMessage("Odd", checks(nothing, ["a quantum annealer"]))).toBeUndefined()
  })

  test("names the recipe, the recipe's own words, the search set, and the way past it", () => {
    const message = Recipe.unmetMessage("Hello, C", checks(nothing, ["a C compiler"]))!
    expect(message).toContain("Hello, C")
    expect(message).toContain("a C compiler")
    expect(message).toContain("gcc")
    expect(message).toContain("Install health check")
    // The way past it is editing the recipe's own prose — ruling 14 keeps a setting out of this artifact.
    expect(message).toContain("needs:")
    // It never asserts the host lacks the thing; it reports where it looked. That is the only claim the
    // probe supports (ruling 2), and the difference is the whole honesty of the feature.
    expect(message).toContain("I looked for")
    expect(message).not.toContain("you do not have")
  })

  test("says out loud what it could NOT check, rather than implying it verified everything", () => {
    const message = Recipe.unmetMessage("Mixed", checks(nothing, ["a C compiler", "a quantum annealer"]))!
    expect(message).toContain("I could not check: a quantum annealer")
    // …and the unchecked fact is not listed among the missing ones.
    expect(message.slice(0, message.indexOf("I could not check"))).not.toContain("quantum")
  })

  test("clips a hostile `needs` entry instead of pasting a wall of text into a toast", () => {
    const message = Recipe.unmetMessage("Shared", checks(nothing, [`gcc ${"x".repeat(500)}`]))!
    expect(message.length).toBeLessThan(700)
    expect(message).toContain("…")
  })
})

describe("needsOf — end to end through a real folder on disk", () => {
  test("a declaration written by save is read back by needsOf", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await Recipe.save({ name: "Hello C", prompt: "Write hello.c", needs: ["a C compiler", "python3"] }, options)
    // The whole chain: SaveInput.needs → needsLine → render → the file → parse → parseNeeds.
    expect(await Recipe.needsOf("hello-c", options)).toEqual(["a C compiler", "python3"])
    // …and it really is one carried frontmatter LINE, not a modelled key (see the block comment in
    // recipe.ts: promoting it would rewrite the lossless-round-trip ratchet in recipe.test.ts).
    const raw = await fs.readFile(path.join(dir.path, "hello-c", "recipe.md"), "utf8")
    expect(raw).toContain("needs: a C compiler, python3")
    expect(Recipe.parse(raw).frontmatter).toContain("needs: a C compiler, python3")
  })

  test("a hand-written recipe declaring nothing is unaffected, and an unknown slug declares nothing", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await fs.mkdir(path.join(dir.path, "bare"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "bare", "recipe.md"), "Just a pasted prompt.\n", "utf8")
    expect(await Recipe.needsOf("bare", options)).toEqual([])
    expect(await Recipe.needsOf("ghost", options)).toEqual([])
    // A traversal slug never reaches the filesystem here either.
    expect(await Recipe.needsOf("../../etc", options)).toEqual([])
  })
})

describe("the shipped set declares needs where they are true — and nowhere else", () => {
  const bySlug = (slug: string) => RecipeBuiltin.BUILTINS.find((builtin) => builtin.slug === slug)

  test("the two C recipes declare a compiler", () => {
    for (const slug of ["hello-c", "pi-100-machin"]) {
      const needs = bySlug(slug)?.needs ?? []
      expect(needs.length).toBeGreaterThan(0)
      expect(Recipe.checkNeeds(needs, everything).every((check) => check.status === "present")).toBe(true)
      expect(Recipe.checkNeeds(needs, nothing).some((check) => check.status === "absent")).toBe(true)
    }
  })

  test("`install-health-check` declares NOTHING — a gate on the diagnostic is the diagnostic failing", () => {
    // It is where every other recipe's refusal sends the user, so it has to be cookable on a machine
    // that is missing everything. This is an assertion about product behaviour, not about tidiness.
    expect(bySlug("install-health-check")?.needs).toBeUndefined()
  })

  test("no builtin declares something nothing can check", () => {
    // A shipped declaration that only ever reports "I could not check this" is decoration. (A USER's
    // recipe may say anything — that is the `unknown` arm's job — but ours must earn their place.)
    for (const builtin of RecipeBuiltin.BUILTINS)
      for (const check of Recipe.checkNeeds(builtin.needs ?? [], everything))
        expect({ slug: builtin.slug, fact: check.fact, status: check.status }).toEqual({
          slug: builtin.slug,
          fact: check.fact,
          status: "present",
        })
  })

  test("seeding writes the declarations into the folder the door reads", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await RecipeBuiltin.seed(options)
    expect(await Recipe.needsOf("hello-c", options)).toEqual(["a C compiler"])
    expect(await Recipe.needsOf("install-health-check", options)).toEqual([])
  })
})

describe("the door: recipe.run checks before it cooks", () => {
  // A source assertion, for the reason `host-exec.test.ts` and `kill-tree-ledger.test.ts` use one: the
  // handler is an Effect HttpApi group whose real behaviour needs a booted server, but the ORDER of
  // three lines inside it is the entire feature. Checking after `materialize` would leave a scratch
  // folder behind on every refusal; checking after `sessions.create` would mean the recipe had already
  // started cooking under `permissionMode: "bypass"`, which is the failure this unit exists to close.
  const HANDLER = path.resolve(import.meta.dir, "..", "..", "server", "src", "handlers", "recipe.ts")

  test("unmetMessage is consulted, and its refusal is raised, before materialize and before create", async () => {
    const whole = await fs.readFile(HANDLER, "utf8")
    // ⚠️ SCOPED to the `recipe.run` handler, not the file. This group gained sibling handlers in
    // 2026-08-18 — `recipe.source` calls `Recipe.needsOf` too, to answer "can this machine run it?"
    // before anyone presses Run — so a whole-file `indexOf` compares a line in one handler against a
    // line in another and stops being an assertion about ordering inside the door at all. It failed
    // exactly that way when the sibling landed, which is the useful kind of brittleness: it noticed.
    const start = whole.indexOf(`"recipe.run"`)
    expect({ found: start >= 0 }).toEqual({ found: true })
    const next = whole.indexOf(".handle(", start)
    const source = whole.slice(start, next === -1 ? undefined : next)
    expect(source.length).toBeGreaterThan(500) // the slice is the handler, not a sliver of it
    const at = (needle: string) => {
      const index = source.indexOf(needle)
      expect({ needle, found: index >= 0 }).toEqual({ needle, found: true })
      return index
    }
    const check = at("Recipe.unmetMessage(")
    expect(at("Recipe.needsOf(")).toBeGreaterThan(check)
    // The refusal is actually RAISED — computing it and dropping it on the floor would pass a
    // check-is-called test while cooking anyway (ruling 2: a failed check never reports success).
    // Asserted as a BOOLEAN, not `toContain` on the source: a failing `toContain` dumps 9 KB of handler
    // into the report and buries the one line that matters.
    const raises = source.includes("if (unmet !== undefined) return yield* new InvalidRequestError({ message: unmet })")
    expect({ raises }).toEqual({ raises: true })
    expect(at("if (unmet !== undefined)")).toBeLessThan(at("Recipe.materialize("))
    /**
     * ⚠️ `.create({` rather than `sessions.create(`, and the difference is not cosmetic. The needle
     * was the latter until NC-SEC-020 wrapped both creates in `.pipe(Effect.orDie)` — prettier then
     * broke `sessions` onto its own line and the needle stopped matching, failing a real ordering
     * guard for a formatting reason. A needle that a line break can defeat is measuring the
     * formatter, not the order.
     */
    expect(at("if (unmet !== undefined)")).toBeLessThan(at(".create({"))
  })
})
