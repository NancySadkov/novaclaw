import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { RecipeVerify } from "@novaclaw/core/recipe-verify"
import { UnknownReason } from "@novaclaw/schema/unknown-reason"
import { tmpdir } from "./fixture/tmpdir"

/**
 * `produces` — the **deterministic success artifact** for a cook (``).
 *
 * Until now a cook's only output was prose: the agent said it had worked, a human read the chatter, and
 * *"nothing mechanical can read its outcome."* AGENTS.md calls the bundled set the install's health check
 * and promises a user can tell **in one click** whether their NovaClaw works — a promise prose cannot
 * keep. This suite pins the four things that make the receipt worth trusting, each of which would
 * otherwise be a claim in a comment (ruling 1):
 *
 *  1. **A declaration is READ.** `SaveInput.produces` → `producesLine` → `render` → `parse` →
 *     `parseProduces` → `producesOf` round-trips through a real folder, so no link can rot silently.
 *  2. **The vocabulary is CLOSED and CONTAINED** (ruling 14). A `produces` entry is a plain relative file
 *     name; it cannot name a command, and it cannot reach outside the folder the cook was given.
 *  3. **Four outcomes, and `unknown` is not a failure.** WORKING / NOT WORKING / NOT AVAILABLE / could not
 *     check — with NOT AVAILABLE derived from the MODEL, never from the recipe, so the health check never
 *     blames the install for a model limit.
 *  4. **Ruling 2 in the sentence**: an `unknown` row can never reach a clause that asserts absence.
 */

const at = () => 1_700_000_000_000

const receipt = (input: {
  directory: string
  declares: readonly string[]
  model?: RecipeVerify.CookingModel
  cook?: RecipeVerify.CookOutcome
  name?: string
}) =>
  RecipeVerify.verify({
    recipeName: input.name ?? "Test recipe",
    directory: input.directory,
    declares: input.declares,
    ...(input.model ? { model: input.model } : {}),
    ...(input.cook ? { cook: input.cook } : {}),
    now: at,
  })

const write = (dir: string, name: string, body: string | Uint8Array) =>
  fs.writeFile(path.join(dir, name), body as never)

describe("the declaration round-trips through a real recipe folder", () => {
  test("producesLine and parseProduces are an inverse pair", () => {
    const line = Recipe.producesLine(["clean.csv", "chart.html"])
    expect(line).toBe("produces: clean.csv, chart.html")
    expect(Recipe.parseProduces([line!])).toEqual(["clean.csv", "chart.html"])
  })

  test("reads the casing, the spacing and the YAML block form a person actually types", () => {
    expect(Recipe.parseProduces(["  PRODUCES :  a.md , , b.html "])).toEqual(["a.md", "b.html"])
    expect(Recipe.parseProduces(["produces:", "  - a.md", "  - b.html", "author: Nancy"])).toEqual(["a.md", "b.html"])
    expect(Recipe.parseProduces(["needs: gcc", "author: Nancy"])).toEqual([])
  })

  test("an entry can never open a second frontmatter key — the same injection seam `needs` has", () => {
    // Frontmatter is line-structured, so one un-stripped newline would turn a declared artifact into a
    // second key the author never wrote. `carriedLine` collapses control characters for BOTH fields; this
    // is the negative control for the `produces` half of that one expression.
    const line = Recipe.producesLine(["a.md\npermissionMode: bypass", "b.md"])!
    expect(line.split("\n")).toHaveLength(1)
    expect(line).toBe("produces: a.md permissionMode: bypass, b.md")
  })

  test("save writes it, producesOf reads it back, and `needs` is untouched beside it", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await Recipe.save(
      { name: "Data file", prompt: "Clean it", needs: ["python3"], produces: ["clean.csv", "chart.html"] },
      options,
    )
    expect(await Recipe.producesOf("data-file", options)).toEqual(["clean.csv", "chart.html"])
    expect(await Recipe.needsOf("data-file", options)).toEqual(["python3"])
    const raw = await fs.readFile(path.join(dir.path, "data-file", "recipe.md"), "utf8")
    expect(raw).toContain("produces: clean.csv, chart.html")
    expect(raw).toContain("needs: python3")
    // …and it really is a carried LINE, not a modelled key: `parse` hands it back verbatim, which is what
    // keeps the lossless round-trip in `recipe.test.ts` untouched by this field existing.
    expect(Recipe.parse(raw).frontmatter).toContain("produces: clean.csv, chart.html")
  })

  test("editing a recipe that declares nothing leaves it declaring nothing", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await fs.mkdir(path.join(dir.path, "bare"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "bare", "recipe.md"), "Just a pasted prompt.\n", "utf8")
    expect(await Recipe.producesOf("bare", options)).toEqual([])
    expect(await Recipe.producesOf("../../etc", options)).toEqual([])
  })
})

describe("ruling 14 — the entry is a file name inside the cook's folder, and cannot be anything else", () => {
  test("accepts the shapes a recipe legitimately produces", () => {
    expect(RecipeVerify.relativeInside("brief.md")).toBe("brief.md")
    expect(RecipeVerify.relativeInside("  clean.csv ")).toBe("clean.csv")
    expect(RecipeVerify.relativeInside("dist/index.html")).toBe("dist/index.html")
    expect(RecipeVerify.relativeInside("dist\\index.html")).toBe("dist/index.html")
    expect(RecipeVerify.relativeInside("./out/a.json")).toBe("out/a.json")
  })

  test("refuses every way out of the folder — this is the containment boundary, not tidiness", () => {
    for (const hostile of [
      "../../.ssh/id_rsa",
      "a/../../b",
      "/etc/passwd",
      "\\\\server\\share\\x",
      "C:/Users/nangl/secret.txt",
      "c:secret.txt",
      "",
      "   ",
      "x".repeat(201),
      "a/b/c/d/e/f/g/h/i.txt",
    ])
      expect({ hostile, resolved: RecipeVerify.relativeInside(hostile) }).toEqual({ hostile, resolved: undefined })
    // A NUL truncates a path at the syscall, so it would smuggle a different target past the check above.
    expect(RecipeVerify.relativeInside(`ok.txt${String.fromCharCode(0)}/../../x`)).toBeUndefined()
  })

  test("a refused entry is `unknown`, never `unmet` — we did not look, so we may not report absence", async () => {
    await using dir = await tmpdir()
    const result = await receipt({ directory: dir.path, declares: ["../../.ssh/id_rsa"] })
    expect(result.checks[0]!.outcome).toBe("unknown")
    expect(result.checks[0]!.reason).toBe("not-measured")
    expect(result.checks[0]!.looked).toBeUndefined()
    expect(result.verdict).toBe("unknown")
  })

  test("verification never writes and never executes — the folder is byte-identical afterwards", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "brief.md", "# Brief\n")
    const before = await fs.readdir(dir.path)
    await receipt({ directory: dir.path, declares: ["brief.md", "missing.md", "../escape.md"] })
    expect(await fs.readdir(dir.path)).toEqual(before)
    expect(await fs.readFile(path.join(dir.path, "brief.md"), "utf8")).toBe("# Brief\n")
  })
})

describe("outcome 1 of 4 — WORKING", () => {
  test("every declared artifact present and well-shaped", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "clean.csv", "name,value\na,1\n")
    await write(dir.path, "chart.html", "<!doctype html><html><body>chart</body></html>")
    const result = await receipt({ directory: dir.path, declares: ["clean.csv", "chart.html"] })
    expect(result.verdict).toBe("working")
    expect(result.checks.map((check) => check.outcome)).toEqual(["met", "met"])
    // The receipt reports the OBSERVATION, not only the verdict — a reader must be able to tell a strong
    // claim from a weak one, which is `agent-jail.ts`'s probeCommand lesson.
    expect(result.checks[0]!.checked).toContain("header row")
    expect(result.checks[1]!.checked).toContain("HTML document")
    expect(result.checks[0]!.bytes).toBeGreaterThan(0)
    expect(RecipeVerify.summary(result)).toContain("WORKING")
  })

  test("an extension the table does not know is still a COMPLETED check, on the weaker claim", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "hello.c", "int main(void){return 0;}")
    const result = await receipt({ directory: dir.path, declares: ["hello.c"] })
    expect(result.verdict).toBe("working")
    // Deliberately NOT "a .c file must contain main": a recipe producing a library would then be reported
    // NOT WORKING, and a false fault is worse than a weaker true claim (ruling 2).
    expect(result.checks[0]!.checked).toBe("exists and is not empty")
  })
})

describe("outcome 2 of 4 — NOT WORKING (the instance did not do it)", () => {
  test("a missing artifact", async () => {
    await using dir = await tmpdir()
    const result = await receipt({ directory: dir.path, declares: ["brief.md"], name: "OSINT brief" })
    expect(result.verdict).toBe("not-working")
    expect(result.checks[0]!).toMatchObject({ outcome: "unmet", looked: "brief.md" })
    const text = RecipeVerify.summary(result)
    expect(text).toContain("NOT WORKING")
    expect(text).toContain("brief.md")
    expect(text).toContain(dir.path)
  })

  test("an artifact that exists but is EMPTY — the placeholder a file-exists check would green-light", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "brief.md", "")
    const result = await receipt({ directory: dir.path, declares: ["brief.md"] })
    expect(result.checks[0]!).toMatchObject({ outcome: "unmet", checked: "the file is there but it is empty" })
    expect(result.verdict).toBe("not-working")
  })

  test("an artifact that is not the shape its own name claims", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "chart.html", "TODO: build the chart")
    await write(dir.path, "clean.csv", "just one line, no rows")
    await write(dir.path, "shot.png", "not a png at all")
    await write(dir.path, "data.json", "{ nope")
    await write(dir.path, "notes.md", "   \n \n")
    const result = await receipt({
      directory: dir.path,
      declares: ["chart.html", "clean.csv", "shot.png", "data.json", "notes.md"],
    })
    expect(result.checks.map((check) => check.outcome)).toEqual(["unmet", "unmet", "unmet", "unmet", "unmet"])
    expect(result.verdict).toBe("not-working")
  })

  test("a real PNG passes the same probe the impostor failed — the check is not vacuous", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
    const result = await receipt({ directory: dir.path, declares: ["shot.png"] })
    expect(result.checks[0]!).toMatchObject({ outcome: "met", checked: "exists and begins with a PNG header" })
  })

  test("ONE missing artifact among four decides the verdict", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "a.md", "a")
    await write(dir.path, "b.md", "b")
    await write(dir.path, "c.md", "c")
    const result = await receipt({ directory: dir.path, declares: ["a.md", "b.md", "c.md", "d.md"] })
    expect(result.verdict).toBe("not-working")
    expect(RecipeVerify.summary(result)).toContain("did arrive")
  })

  test("a folder standing where a file was declared is unmet, not a crash", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "brief.md"))
    const result = await receipt({ directory: dir.path, declares: ["brief.md"] })
    expect(result.checks[0]!).toMatchObject({
      outcome: "unmet",
      checked: "there is a folder, not a file, at that name",
    })
  })
})

describe("outcome 3 of 4 — NOT AVAILABLE (the model, never the install)", () => {
  test("a model that cannot call tools makes every declaration not-applicable", async () => {
    await using dir = await tmpdir()
    const result = await receipt({
      directory: dir.path,
      declares: ["hello.c", "hello.out.txt"],
      model: { label: "text-davinci-legacy", tools: false },
      name: "Hello, C",
    })
    expect(result.verdict).toBe("not-available")
    for (const check of result.checks) {
      expect(check.outcome).toBe("unknown")
      // `not-applicable` STOPS THE READER, so it has to be earned — and here it is: a model that cannot
      // call a tool cannot have written a file, so there is genuinely nothing to measure.
      expect(check.reason).toBe("not-applicable")
    }
    const text = RecipeVerify.summary(result)
    expect(text).toContain("NOT AVAILABLE")
    expect(text).toContain("text-davinci-legacy")
    // The whole point of this arm: it must not read as a fault in the user's install.
    expect(text).toContain("not a fault in this")
    expect(text).not.toContain("NOT WORKING")
  })

  test("NOT AVAILABLE is decided BEFORE the filesystem — the files are irrelevant, not merely absent", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "hello.c", "int main(void){return 0;}")
    const result = await receipt({
      directory: dir.path,
      declares: ["hello.c"],
      model: { label: "no-tools", tools: false },
    })
    // The file IS there. Reporting `met` would credit a model that cannot write files with having
    // written one — the artifact is a leftover from some earlier cook, and the honest answer is that
    // this model's cook cannot be judged by it.
    expect(result.checks[0]!.outcome).toBe("unknown")
  })

  test("a model that CAN call tools is judged on its files, exactly like an unstated one", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "brief.md", "# Brief")
    const withModel = await receipt({
      directory: dir.path,
      declares: ["brief.md"],
      model: { label: "holo3.1", tools: true },
    })
    const without = await receipt({ directory: dir.path, declares: ["brief.md"] })
    expect(withModel.verdict).toBe("working")
    expect(without.verdict).toBe("working")
  })
})

describe("outcome 4 of 4 — `unknown`, and ruling 2: a fault is never described falsely", () => {
  test("a recipe that declares nothing is `unknown`, never `working` — and the message teaches", async () => {
    await using dir = await tmpdir()
    const result = await receipt({ directory: dir.path, declares: [], name: "Some recipe" })
    expect(result.verdict).toBe("unknown")
    expect(result.checks).toEqual([])
    const text = RecipeVerify.summary(result)
    expect(text).toContain("produces:")
    expect(text).toContain("cannot say")
  })

  test("no folder to look in is `not-measured` — nothing cooked there, so nothing is missing", async () => {
    await using dir = await tmpdir()
    const result = await receipt({ directory: path.join(dir.path, "never-cooked"), declares: ["brief.md"] })
    expect(result.verdict).toBe("unknown")
    expect(result.checks[0]!.reason).toBe("not-measured")
  })

  test("⭐ an all-`unknown` receipt CANNOT emit a sentence asserting absence", async () => {
    // The load-bearing assertion of this file, and the one ruling 2 is actually about: a false "your
    // install did not produce brief.md" on a run we never checked is worse than no check at all. The
    // absence clause is built ONLY from `unmet` rows, so this holds by construction rather than by care.
    await using dir = await tmpdir()
    for (const result of [
      await receipt({ directory: path.join(dir.path, "gone"), declares: ["brief.md"] }),
      await receipt({ directory: dir.path, declares: ["../../etc/passwd"] }),
      await receipt({ directory: dir.path, declares: ["brief.md"], model: { label: "m", tools: false } }),
      await receipt({ directory: dir.path, declares: [] }),
    ]) {
      const text = RecipeVerify.summary(result).toLowerCase()
      for (const forbidden of ["not working", "did not find", "missing", "there is nothing at", "you do not have"])
        expect({ verdict: result.verdict, forbidden, said: text.includes(forbidden) }).toEqual({
          verdict: result.verdict,
          forbidden,
          said: false,
        })
    }
  })

  test("in a MIXED receipt the unchecked entry is named apart, never among the missing ones", async () => {
    await using dir = await tmpdir()
    const result = await receipt({ directory: dir.path, declares: ["brief.md", "../../secret"] })
    expect(result.verdict).toBe("not-working")
    const text = RecipeVerify.summary(result)
    expect(text).toContain("I could not check: ../../secret")
    // …and the unchecked one is not inside the clause that says what is absent.
    expect(text.slice(0, text.indexOf("I could not check"))).not.toContain("secret")
  })

  test("`verdictOf` never calls a receipt of unknowns a success", () => {
    expect(RecipeVerify.verdictOf([])).toBe("unknown")
    const un = (reason: "not-measured" | "not-applicable") =>
      ({ declared: "x", outcome: "unknown", reason, checked: "" }) as const
    expect(RecipeVerify.verdictOf([un("not-measured")])).toBe("unknown")
    expect(RecipeVerify.verdictOf([un("not-applicable")])).toBe("not-available")
    expect(RecipeVerify.verdictOf([un("not-measured"), { declared: "y", outcome: "met", checked: "" }])).toBe("working")
    expect(
      RecipeVerify.verdictOf([
        { declared: "y", outcome: "met", checked: "" },
        { declared: "z", outcome: "unmet", checked: "" },
      ]),
    ).toBe("not-working")
  })
})

describe("🔴 a cook that never reached the model says NOTHING about the install (2026-08-18)", () => {
  // The measured defect: six cooks "settled" having written nothing because holo3.1 had died
  // (`"finish":"error","error":{"message":"HTTP transport failed","_tag":"Transport"}`), and the receipt
  // read NOT WORKING — about: this NovaClaw. Every row was `unmet` and every `unmet` was true about the
  // FILESYSTEM; the error was in what absence MEANS. These tests pin the direction of the inference.

  const declares = ["hello.c", "hello.out.txt"]
  const blocked = {
    state: "blocked",
    why: "Can't reach the model server at 192.168.178.40:8010. It may be turned off, still starting, or on another network.",
  } as const

  test("the regression itself: an empty folder + a blocked cook is NEVER `not-working`", async () => {
    await using dir = await tmpdir()
    const before = await receipt({ directory: dir.path, declares, name: "Hello, C" })
    // The old behaviour, still correct when we were told nothing: absence with no story is a failure.
    expect(before.verdict).toBe("not-working")

    const after = await receipt({ directory: dir.path, declares, cook: blocked, name: "Hello, C" })
    expect(after.verdict).toBe("unknown")
    for (const check of after.checks) {
      expect(check.outcome).toBe("unknown")
      // `measurement-failed` = *investigate the instrument*. The model server IS the instrument.
      // NOT `not-applicable`, which would tell the reader to stop asking whether their install works.
      expect(check.reason).toBe("measurement-failed")
    }
  })

  test("…and the sentence names the endpoint, blames nothing, and says what to do", async () => {
    await using dir = await tmpdir()
    const text = RecipeVerify.summary(await receipt({ directory: dir.path, declares, cook: blocked, name: "Hello, C" }))
    expect(text).toContain("192.168.178.40:8010")
    expect(text).toContain("could not check")
    // Principle 8 — it teaches rather than accuses.
    expect(text).toContain("Start the model server again")
    for (const forbidden of ["NOT WORKING", "did not find", "missing"]) expect(text).not.toContain(forbidden)
  })

  test("⭐ the softening is ONE-DIRECTIONAL: a blocked cook cannot erase a file that IS there", async () => {
    // The safety argument for the whole arm. If a story about the instrument could overturn `met`, a
    // transport error would HIDE real failures instead of refusing to invent them. A cook whose fourth
    // turn died on transport, having written everything on its second, really did work.
    await using dir = await tmpdir()
    await write(dir.path, "hello.c", "int main(void){return 0;}")
    await write(dir.path, "hello.out.txt", "hello\n")
    const result = await receipt({ directory: dir.path, declares, cook: blocked })
    expect(result.verdict).toBe("working")
    expect(result.checks.map((check) => check.outcome)).toEqual(["met", "met"])
  })

  test("a MIXED folder keeps what it proved and stops asserting what it did not", async () => {
    await using dir = await tmpdir()
    await write(dir.path, "hello.c", "int main(void){return 0;}")
    const result = await receipt({ directory: dir.path, declares, cook: blocked })
    // `hello.c` arrived, so the cook demonstrably ran far enough to write it → still `working`.
    expect(result.verdict).toBe("working")
    expect(result.checks[0]!.outcome).toBe("met")
    expect(result.checks[1]!.outcome).toBe("unknown")
    expect(RecipeVerify.summary(result)).not.toContain("NOT WORKING")
  })

  test("`ran` is a CLAIM and it leaves the old verdict intact — absent ≠ ran", async () => {
    await using dir = await tmpdir()
    const told = await receipt({ directory: dir.path, declares, cook: { state: "ran" } })
    const untold = await receipt({ directory: dir.path, declares })
    // A cook that reached this machine and produced nothing IS the install failing. That is the ONE path
    // to a fault report, and this arm must survive the fix — otherwise the receipt can never say "no".
    expect(told.verdict).toBe("not-working")
    expect(untold.verdict).toBe("not-working")
  })

  test("a person pressing stop is `incomplete` — a floor, not a fault, and not `measurement-failed`", async () => {
    await using dir = await tmpdir()
    const result = await receipt({
      directory: dir.path,
      declares,
      cook: { state: "stopped", why: "Interrupted" },
      name: "Hello, C",
    })
    expect(result.verdict).toBe("unknown")
    // `incomplete` is the one reason whose neighbouring value is a LOWER BOUND — exactly a half-written
    // folder. Filing it as `measurement-failed` would send the user to investigate a healthy instrument.
    expect(result.checks.every((check) => check.reason === "incomplete")).toBe(true)
    const text = RecipeVerify.summary(result)
    expect(text).toContain("work that never happened")
    expect(text).not.toContain("NOT WORKING")
  })

  test("the whole four-arm surface still discriminates, each for its own reason", async () => {
    // The point of the fix is that FOUR states stay four, not that everything becomes `unknown`.
    await using dir = await tmpdir()
    await write(dir.path, "hello.c", "int main(void){return 0;}")
    await write(dir.path, "hello.out.txt", "hello\n")
    await using empty = await tmpdir()

    expect((await receipt({ directory: dir.path, declares })).verdict).toBe("working")
    expect((await receipt({ directory: empty.path, declares })).verdict).toBe("not-working")
    expect(
      (await receipt({ directory: empty.path, declares, model: { label: "no-tools", tools: false } })).verdict,
    ).toBe("not-available")
    expect((await receipt({ directory: empty.path, declares, cook: blocked })).verdict).toBe("unknown")
    expect((await receipt({ directory: empty.path, declares: [] })).verdict).toBe("unknown")
  })

  test("NOT AVAILABLE still outranks a blocked cook — a model that cannot write files never could", async () => {
    // A tools-less model whose endpoint ALSO died: `not-applicable` is the earned answer (there is
    // genuinely nothing to measure), and it is decided before the filesystem and before the cook story.
    await using dir = await tmpdir()
    const result = await receipt({
      directory: dir.path,
      declares,
      model: { label: "no-tools", tools: false },
      cook: blocked,
    })
    expect(result.verdict).toBe("not-available")
  })

  test("the reason mapping is the shared vocabulary's, not a private one", async () => {
    await using dir = await tmpdir()
    const reasons = async (state: "blocked" | "stopped") =>
      (await receipt({ directory: dir.path, declares: ["x.md"], cook: { state } })).checks[0]!.reason
    expect(await reasons("blocked")).toBe("measurement-failed")
    expect(await reasons("stopped")).toBe("incomplete")
    // Neither may ever be the one that STOPS THE READER — the question "does my install work?" is open.
    expect(UnknownReason.STOPS_THE_READER).toBe("not-applicable")
  })
})

describe("the wire: the receipt is reachable, or it is a library nobody calls", () => {
  // A SOURCE assertion, for the reason `recipe-needs.test.ts`'s door test uses one: the handler is an
  // Effect HttpApi group whose real behaviour needs a booted server, but whether these four lines exist
  // at all is the difference between a deterministic success artifact and a module with a nice test
  // suite. "Built, tested and never called" is a failure mode this tree has shipped before.
  const HANDLER = path.resolve(import.meta.dir, "..", "..", "server", "src", "handlers", "recipe.ts")

  test("`recipe.verify` reads the recipe's own declarations and answers from RecipeVerify", async () => {
    const source = await fs.readFile(HANDLER, "utf8")
    for (const needle of [
      '"recipe.verify"',
      "Recipe.producesOf(recipe.slug)",
      "RecipeVerify.verify({",
      "RecipeVerify.summary(receipt)",
    ])
      expect({ needle, found: source.includes(needle) }).toEqual({ needle, found: true })
  })

  test("the model is resolved from the CATALOG, never from the payload's word for it", async () => {
    // The payload names a model; its CAPABILITIES have to come from the instance, or a caller could
    // hand itself a NOT AVAILABLE and launder a broken install into "your model cannot do that".
    const source = await fs.readFile(HANDLER, "utf8")
    expect(source).toContain("Catalog.Service.use((catalog) => catalog.model.get(ref.providerID, ref.id))")
    expect(source).toContain("tools: info.capabilities.tools")
    // …and through the ONE server-wide location map. Recipes are instance-global while the catalog is
    // location-scoped, so a bare `yield* Catalog.Service` typechecks and dies at runtime with "Service
    // not found" — measured live 2026-08-18, and only a live run could have seen it.
    expect(source).toContain("Effect.provide(locations.get(Location.Ref.make(")
  })

  test("`recipe.run` hands back what the cook will be judged on, AND which model will cook", async () => {
    const source = await fs.readFile(HANDLER, "utf8")
    for (const needle of ["sessionID: session.id", "directory,", "assets,", "produces,"])
      expect({ needle, found: source.includes(needle) }).toEqual({ needle, found: true })
    // 🔴 The model is the half that was missing, and its absence made NOT AVAILABLE unreachable from the
    // app: `recipes.tsx` names no model on run, so unless the RUN resolves the instance default and hands
    // it back, nothing downstream can ever know a tools-less model cooked. Measured 2026-08-18 as
    // "Did not work · about: this NovaClaw" on an instance whose only model could not call tools.
    expect(source).toContain("catalog.model.default()")
    expect(source).toContain("{ model: modelSpec(cooking) }")
  })

  test("`recipe.verify` reads the COOK's own outcome, and classifies it through the shared classifier", async () => {
    // The transport defect's structural fix: an empty folder is only evidence about the install if the
    // cook reached the install. The handler must (a) read the session and (b) ask `faultEvidence` — never
    // re-derive "is this an instrument fault?" locally, which is how the next surface gets it wrong.
    const source = await fs.readFile(HANDLER, "utf8")
    for (const needle of [
      'from "@novaclaw/core/session/session-error"',
      "faultEvidence(last.error)",
      "readCook(sessions, ctx.payload.sessionID)",
      "{ cook: reading.cook }",
      "{ cookState: receipt.cook.state }",
    ])
      expect({ needle, found: source.includes(needle) }).toEqual({ needle, found: true })
  })
})

describe("the shipped set: a declaration the prompt never asks for is a guaranteed false NOT WORKING", () => {
  test("every declared artifact is named in its OWN recipe's prompt", () => {
    // The check that keeps the bundled health check honest. A `produces: report.pdf` on a prompt that
    // never mentions `report.pdf` would report NOT WORKING on every healthy install forever — ruling 2's
    // fault-described-falsely, shipped by us rather than by a stranger.
    for (const builtin of RecipeBuiltin.BUILTINS)
      for (const artifact of builtin.produces ?? [])
        expect({ slug: builtin.slug, artifact, named: builtin.prompt.includes(artifact) }).toEqual({
          slug: builtin.slug,
          artifact,
          named: true,
        })
  })

  test("every declared artifact is a legal, contained relative name", () => {
    for (const builtin of RecipeBuiltin.BUILTINS)
      for (const artifact of builtin.produces ?? [])
        expect({ slug: builtin.slug, artifact, ok: RecipeVerify.relativeInside(artifact) !== undefined }).toEqual({
          slug: builtin.slug,
          artifact,
          ok: true,
        })
  })

  test("the set actually declares something — six of seven, and the guard is not vacuous", () => {
    const declaring = RecipeBuiltin.BUILTINS.filter((builtin) => (builtin.produces ?? []).length > 0)
    expect(declaring.length).toBeGreaterThanOrEqual(6)
    // `install-health-check` declares only `health.txt` and deliberately NOT its PNG: writing image bytes
    // depends on what the host has, so an absent one is not evidence of a broken install.
    const health = RecipeBuiltin.BUILTINS.find((builtin) => builtin.slug === "install-health-check")
    expect(health?.produces).toEqual(["health.txt"])
    // No binary is ever declared: `-o hello` yields `hello` or `hello.exe` depending on the platform.
    for (const builtin of RecipeBuiltin.BUILTINS)
      for (const artifact of builtin.produces ?? []) expect(artifact).not.toContain(".exe")
  })

  test("seeding writes the declarations into the folder the checker reads", async () => {
    await using dir = await tmpdir()
    const options = { root: dir.path }
    await RecipeBuiltin.seed(options)
    expect(await Recipe.producesOf("hello-c", options)).toEqual(["hello.c", "hello.out.txt"])
    expect(await Recipe.producesOf("csv-insight", options)).toEqual(["clean.csv", "chart.html"])
    // …and the door's own field still round-trips beside it.
    expect(await Recipe.needsOf("hello-c", options)).toEqual(["a C compiler"])
  })

  test("end to end: seed, cook badly, and read a verdict a machine can act on", async () => {
    await using recipes = await tmpdir()
    await using work = await tmpdir()
    await RecipeBuiltin.seed({ root: recipes.path })
    const declares = await Recipe.producesOf("csv-insight", { root: recipes.path })

    const failed = await receipt({ directory: work.path, declares, name: "Data file to insight" })
    expect(failed.verdict).toBe("not-working")

    await write(work.path, "clean.csv", "a,b\n1,2\n")
    await write(work.path, "chart.html", "<html><body><svg/></body></html>")
    const passed = await receipt({ directory: work.path, declares, name: "Data file to insight" })
    expect(passed.verdict).toBe("working")
    // Deterministic: the same folder read twice gives the same answer, so a receipt can be re-read rather
    // than stored, and re-running the check can never itself be the thing that changed.
    expect(await receipt({ directory: work.path, declares, name: "Data file to insight" })).toEqual(passed)
  })
})
