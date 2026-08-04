import { describe, expect, test } from "bun:test"
import { QualityProvision } from "../src/session/runner/quality-provision"
import { description, manifestsToRead } from "../src/tool/quality-provision"

// ─────────────────────────────────────────────────────────────────────────────
// QE-A — the manifest table is the ONE declaration, and these are the checks that keep it so.
//
// Three things about manifests used to be stated in three places, free to drift apart while
// compiling green (v0.2.0 ruling 1's defect class exactly — a normative claim about code outside
// its own file):
//
//   ① the model-facing tool DESCRIPTION named the manifests it scans. It named five
//      (`package.json/Cargo.toml/go.mod/pyproject/Makefile`) while the table understood seven —
//      `requirements.txt` and `setup.py` were detected and never advertised. A tool description
//      is text that reaches a future session's prompt (ruling 4), so a wrong list is not a stale
//      comment: it is the model being told something false about its own capability, which is
//      ruling 2's *a fault is never described falsely* pointed at the agent instead of the user.
//   ② the TOOL held its own hardcoded list of the manifests it loads off disk. It happened to
//      match the four the scan reads, and nothing checked that it did, so adding a
//      content-reading ecosystem would have compiled green while that ecosystem silently never
//      saw its own manifest. (It never broke Rust or Go, contrary to how it reads: `Cargo.toml`
//      and `go.mod` are detected by NAME and need no content at all.)
//   ③ the QE runner renders a written FILE into the `syntax`/`check` slots
//      (`Quality.renderCommand` appends the path when there is no `{file}`), and four rules
//      claimed `check` with whole-project commands. Measured on a real crate: bare
//      `cargo check --quiet` exits 0, so rung-1 verification passes and the candidate is kept —
//      then `cargo check --quiet "src/lib.rs"` exits 1 with `error: unexpected argument`, i.e. a
//      quality gate reporting a nonexistent fault on every write, forever.
//
// ② and ③ are now closed by construction (derived read set, no rule may claim a file-rendered
// slot). ① cannot be — prose is written by hand — so it is closed by this test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extensions a manifest plausibly carries. Deliberately WIDER than the table: the job is to
 * notice a manifest name appearing in the description that the table does not back, including
 * one for an ecosystem nobody has added yet.
 */
const EXTENSIONS = [
  "json",
  "jsonc",
  "toml",
  "txt",
  "mod",
  "sum",
  "py",
  "cfg",
  "ini",
  "lock",
  "yaml",
  "yml",
  "gradle",
  "kts",
  "xml",
  "sln",
  "csproj",
  "fsproj",
  "vbproj",
  "rb",
  "gemspec",
  "cabal",
  "cmake",
  "mk",
  "nimble",
  "zig",
  "sbt",
  "mix",
  "exs",
  "nix",
  "bzl",
]

/** Manifests that carry no extension at all. */
const BARE = ["GNUmakefile", "Makefile", "makefile", "Gemfile", "Rakefile", "Podfile", "Cartfile", "Dockerfile"]

/**
 * Every manifest-shaped token in a piece of prose: `name(.part)*.ext`, a `*.ext` glob, or one of
 * the extensionless names above. A heuristic by necessity — but a tight one, and it is only ever
 * asked about a string we write ourselves.
 */
const manifestTokens = (prose: string): string[] => {
  const pattern = new RegExp(
    [
      String.raw`(?<![\w.])(?:\*|[A-Za-z][\w+-]*)(?:\.[\w+-]+)*\.(?:${EXTENSIONS.join("|")})\b`,
      String.raw`\b(?:${BARE.join("|")})\b`,
    ].join("|"),
    "g",
  )
  return [...new Set(prose.match(pattern) ?? [])].sort()
}

const sorted = (names: readonly string[]) => [...new Set(names)].sort()

describe("QE-A: the tool description and the manifest table cannot drift", () => {
  test("the extractor finds manifest names in prose, and does not invent them", () => {
    // A negative control for the INSTRUMENT: a check built on a regex that silently matched
    // nothing would pass forever while the description said anything at all.
    expect(manifestTokens("we scan package.json, Cargo.toml, *.csproj and the Makefile")).toEqual([
      "*.csproj",
      "Cargo.toml",
      "Makefile",
      "package.json",
    ])
    expect(manifestTokens("build.gradle.kts and CMakeLists.txt and go.mod")).toEqual([
      "CMakeLists.txt",
      "build.gradle.kts",
      "go.mod",
    ])
    // Ordinary prose is not a manifest list.
    expect(manifestTokens("verify each candidate for typecheck/test/lint and save to Settings → Quality")).toEqual([])
  })

  test("the description names EXACTLY the table's advertised triggers", () => {
    // Both directions in one assertion, and both matter: a name in the prose the table cannot
    // detect is a promise to the model we do not keep; a trigger the prose omits is a capability
    // the model never learns it has (which is how requirements.txt and setup.py went unadvertised).
    expect(manifestTokens(description)).toEqual(sorted(QualityProvision.MANIFEST_TRIGGERS))
  })

  test("the description is not empty of manifests — the check has something to check", () => {
    expect(manifestTokens(description).length).toBeGreaterThanOrEqual(10)
  })
})

describe("QE-A: the table is coherent", () => {
  test("rule ids are unique and every rule advertises at least one trigger", () => {
    const ids = QualityProvision.MANIFESTS.map((rule) => rule.id)
    expect(sorted(ids)).toEqual(ids.slice().sort())
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of QualityProvision.MANIFESTS)
      expect(rule.triggers.length, `${rule.id} advertises nothing`).toBeGreaterThan(0)
  })

  test("no manifest name belongs to two rules", () => {
    // A shared name makes both rules fire and makes the advertised union ambiguous.
    const owner = new Map<string, string>()
    for (const rule of QualityProvision.MANIFESTS)
      for (const name of [...rule.triggers, ...(rule.aliases ?? [])]) {
        expect(owner.get(name), `${name} is claimed by both ${owner.get(name)} and ${rule.id}`).toBeUndefined()
        owner.set(name, rule.id)
      }
  })

  test("`reads` are concrete names this rule can actually be triggered by", () => {
    for (const rule of QualityProvision.MANIFESTS) {
      const own = new Set([...rule.triggers, ...(rule.aliases ?? [])])
      for (const name of rule.reads ?? []) {
        // A glob can never be loaded off disk by name, so it can never be read.
        expect(name.includes("*"), `${rule.id} declares a glob (${name}) as readable`).toBe(false)
        expect(own.has(name), `${rule.id} reads ${name} but is not triggered by it`).toBe(true)
      }
    }
  })

  test("MANIFEST_READS is the union of the table's declarations, and the TOOL loads exactly it", () => {
    const declared = sorted(QualityProvision.MANIFESTS.flatMap((rule) => rule.reads ?? []))
    expect(sorted(QualityProvision.MANIFEST_READS)).toEqual(declared)
    // The tool's own loader, exercised — not a source-text guard. Everything present is loaded…
    expect(sorted(manifestsToRead(QualityProvision.MANIFEST_READS))).toEqual(declared)
    // …and nothing absent is, so a project of unrelated files costs zero reads.
    expect(manifestsToRead(["README.md", "src", "Cargo.toml", "go.mod"])).toEqual([])
  })
})

describe("QE-A: the scan never claims a slot the runner renders a FILE into", () => {
  /** A project containing every trigger and alias of one rule (`*.ext` materialised). */
  const projectFor = (rule: QualityProvision.ManifestRule) =>
    [...rule.triggers, ...(rule.aliases ?? [])].map((name) => (name.startsWith("*.") ? `Probe${name.slice(1)}` : name))

  /** Plausible content for any manifest a rule may read, so its content branches fire. */
  const CONTENT: Record<string, string> = {
    "package.json": JSON.stringify({
      scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc -b", check: "biome check ." },
      devDependencies: { typescript: "^5" },
    }),
    "pyproject.toml": "[tool.ruff]\n[tool.pytest.ini_options]\n[tool.mypy]\n",
    "requirements.txt": "ruff\npytest\nmypy\n",
    Makefile: "test:\n\t./t\nlint:\n\t./l\ncheck:\n\t./c\n",
    makefile: "test:\n\t./t\n",
    GNUmakefile: "test:\n\t./t\n",
    "CMakeLists.txt": "project(demo)\nenable_testing()\nadd_test(NAME t COMMAND t)\n",
    Gemfile: "gem 'rspec'\ngem 'rubocop'\n",
  }

  /** Runs a rule through the TOOL's data path: derive the read set, load it, then scan. */
  const throughTheTool = (entries: readonly string[], shell: "posix" | "cmd" = "posix") => {
    const contents = new Map<string, string | undefined>()
    for (const manifest of manifestsToRead(entries)) contents.set(manifest, CONTENT[manifest])
    return QualityProvision.scan({ files: entries, read: (file) => contents.get(file), shell })
  }

  test("every rule proposes something through the tool's own read path", () => {
    // This is what catches a MISSING `reads` declaration: the rule's content branch goes quiet
    // because the tool never loaded the file, and a rule that proposes nothing at all is the
    // symptom. It is why the read set is derived rather than restated.
    for (const rule of QualityProvision.MANIFESTS) {
      const proposal = throughTheTool(projectFor(rule))
      expect(
        Object.keys(proposal.commands).length,
        `${rule.id} proposed nothing — did it forget to declare a file in \`reads\`?`,
      ).toBeGreaterThan(0)
    }
  })

  test("no rule claims `syntax` or `check` without a `{file}` placeholder", () => {
    // `Quality.dueMidLoop` renders these per written file, APPENDING the path when there is no
    // placeholder — which is how `cargo check --quiet "src/lib.rs"` (`error: unexpected argument`)
    // became a permanent quality-gate failure the model could not fix.
    const offenders: string[] = []
    for (const rule of QualityProvision.MANIFESTS)
      for (const shell of ["posix", "cmd"] as const) {
        const { commands } = throughTheTool(projectFor(rule), shell)
        for (const slot of QualityProvision.FILE_RENDERED_SLOTS) {
          const command = commands[slot]
          if (command !== undefined && !command.includes("{file}")) offenders.push(`${rule.id}.${slot} = ${command}`)
        }
      }
    expect(offenders).toEqual([])
  })

  test("…and the whole-project slots really are populated, so the check above is not vacuous", () => {
    // A negative control for the guard: if the table stopped proposing anything, "no offenders"
    // would be trivially true. Every rule must fill at least one of typecheck/test/lint.
    for (const rule of QualityProvision.MANIFESTS) {
      const { commands } = throughTheTool(projectFor(rule))
      const whole = [commands.typecheck, commands.test, commands.lint].filter(Boolean)
      expect(whole.length, `${rule.id} fills no whole-project slot`).toBeGreaterThan(0)
    }
  })

  test("a `{file}` command IS allowed in those slots — the rule is about the placeholder", () => {
    // The slots are not forbidden, they are file-scoped. An override may use them (rung 2), and
    // rung-1 verification strips the placeholder rather than executing it literally.
    expect(QualityProvision.verifiableCommand("ruff check {file}")).toBe("ruff check")
  })
})
