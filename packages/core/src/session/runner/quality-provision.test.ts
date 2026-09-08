import { describe, expect, test } from "bun:test"
import {
  FILE_RENDERED_SLOTS,
  MANIFESTS,
  STALE_FILE_RENDERED_CLAIMS,
  classifyRun,
  migrateCommands,
  scan,
  verifiableCommand,
} from "./quality-provision"
import { Quality } from "./quality"

const reader = (files: Record<string, string>) => (name: string) => files[name]

describe("QE-A manifest scan", () => {
  test("package.json scripts win, with the right package manager", () => {
    const files = {
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc -b" },
      }),
    }
    const bun = scan({ files: ["package.json", "bun.lock"], read: reader(files) })
    expect(bun.commands.test).toBe("bun run test")
    expect(bun.commands.lint).toBe("bun run lint")
    expect(bun.commands.typecheck).toBe("bun run typecheck")
    const pnpm = scan({ files: ["package.json", "pnpm-lock.yaml"], read: reader(files) })
    expect(pnpm.commands.test).toBe("pnpm run test")
  })

  test("npm placeholder test script is not a test command", () => {
    const files = {
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    }
    const proposal = scan({ files: ["package.json"], read: reader(files) })
    expect(proposal.commands.test).toBeUndefined()
  })

  test("typescript dep + tsconfig derives a typecheck without a script", () => {
    const files = {
      "package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
    }
    const proposal = scan({ files: ["package.json", "tsconfig.json", "bun.lock"], read: reader(files) })
    expect(proposal.commands.typecheck).toBe("bunx tsc --noEmit")
  })

  test("scripts.check fills a FREE whole-project slot, never the file-rendered `check`", () => {
    // It used to be claimed as `check`, which `Quality.renderCommand` renders per written file.
    // The cheaper (turn-end) `lint` slot goes first; an aggregate check script is not free.
    const free = scan({
      files: ["package.json"],
      read: reader({ "package.json": JSON.stringify({ scripts: { check: "biome check ." } }) }),
    })
    expect(free.commands.check).toBeUndefined()
    expect(free.commands.lint).toBe("npm run check")
    expect(free.commands.typecheck).toBeUndefined()
    // lint already taken → it falls through to typecheck, and claims ONE slot, not both.
    const taken = scan({
      files: ["package.json"],
      read: reader({ "package.json": JSON.stringify({ scripts: { lint: "eslint .", check: "biome check ." } }) }),
    })
    expect(taken.commands.lint).toBe("npm run lint")
    expect(taken.commands.typecheck).toBe("npm run check")
    // …and with both taken it claims nothing at all rather than overwriting.
    const full = scan({
      files: ["package.json"],
      read: reader({
        "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", check: "biome check ." } }),
      }),
    })
    expect(full.commands.lint).toBe("npm run lint")
    expect(full.commands.typecheck).toBe("npm run typecheck")
  })

  test("cargo / go / python / make matrices", () => {
    // ⚠️ cargo and go land in `typecheck`, NOT `check`: both are whole-project commands that take
    // no path, and `check` is rendered per written file (see FILE_RENDERED_SLOTS).
    expect(scan({ files: ["Cargo.toml"], read: () => undefined }).commands).toMatchObject({
      typecheck: "cargo check --quiet",
      test: "cargo test --quiet",
    })
    expect(scan({ files: ["go.mod"], read: () => undefined }).commands).toMatchObject({
      typecheck: "go vet ./...",
      test: "go test ./...",
    })
    const py = scan({
      files: ["pyproject.toml"],
      read: reader({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n" }),
    })
    expect(py.commands.lint).toBe("ruff check .")
    expect(py.commands.test).toBe("python -m pytest -q")
    const make = scan({
      files: ["Makefile"],
      read: reader({ Makefile: "build:\n\tcc main.c\ntest:\n\t./run-tests.sh\nlint:\n\tclang-tidy\n" }),
    })
    expect(make.commands.test).toBe("make test")
    expect(make.commands.lint).toBe("make lint")
  })

  test("a lowercase makefile / GNUmakefile is not invisible, and `make check` is a TEST", () => {
    // GNU make's own search order. `Makefile` was the only spelling the table knew.
    for (const name of ["GNUmakefile", "makefile", "Makefile"]) {
      const proposal = scan({ files: [name], read: reader({ [name]: "test:\n\t./t\n" }) })
      expect(proposal.commands.test, `${name} was not detected`).toBe("make test")
    }
    // `make check` runs the suite (GNU coding standards) — it must not land in the per-file slot,
    // where `make check "a.c"` asks make for a target named a.c.
    const autotools = scan({ files: ["Makefile"], read: reader({ Makefile: "all:\n\tcc\ncheck:\n\t./t\n" }) })
    expect(autotools.commands.check).toBeUndefined()
    expect(autotools.commands.test).toBe("make check")
  })

  test("cmake: self-bootstrapping build, and ctest only when the project enables testing", () => {
    const plain = scan({ files: ["CMakeLists.txt"], read: reader({ "CMakeLists.txt": "project(demo)\n" }) })
    expect(plain.commands.typecheck).toBe("cmake -S . -B build && cmake --build build")
    expect(plain.commands.test).toBeUndefined()
    const tested = scan({
      files: ["CMakeLists.txt"],
      read: reader({ "CMakeLists.txt": "project(demo)\nenable_testing()\nadd_test(NAME t COMMAND t)\n" }),
    })
    expect(tested.commands.test).toBe(
      "cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure",
    )
  })

  test("gradle / maven wrappers follow the SHELL family, not the platform", () => {
    const gradleFiles = ["build.gradle.kts", "gradlew", "gradlew.bat"]
    expect(scan({ files: gradleFiles, read: () => undefined, shell: "posix" }).commands.test).toBe("./gradlew test")
    expect(scan({ files: gradleFiles, read: () => undefined, shell: "cmd" }).commands.test).toBe("gradlew.bat test")
    // No wrapper committed → the installed CLI, and a missing one is dropped honestly at rung 1.
    expect(scan({ files: ["build.gradle"], read: () => undefined }).commands.lint).toBe("gradle check -x test")
    expect(scan({ files: ["settings.gradle"], read: () => undefined }).commands.test).toBe("gradle test")
    expect(
      scan({ files: ["pom.xml", "mvnw", "mvnw.cmd"], read: () => undefined, shell: "posix" }).commands,
    ).toMatchObject({ typecheck: "./mvnw -q compile", test: "./mvnw -q test" })
    expect(scan({ files: ["pom.xml"], read: () => undefined, shell: "cmd" }).commands.test).toBe("mvn -q test")
  })

  test("dotnet matches by SUFFIX, and formats only with an .editorconfig", () => {
    const bare = scan({ files: ["Widget.csproj", "Widget.cs"], read: () => undefined })
    expect(bare.commands).toMatchObject({ typecheck: "dotnet build --nologo", test: "dotnet test --nologo" })
    expect(bare.commands.lint).toBeUndefined()
    expect(scan({ files: ["App.sln", ".editorconfig"], read: () => undefined }).commands.lint).toBe(
      "dotnet format --verify-no-changes",
    )
    expect(scan({ files: ["Lib.fsproj"], read: () => undefined }).commands.test).toBe("dotnet test --nologo")
    // A `.csproj`-shaped name must not be matched by a bare `csproj` substring somewhere else.
    expect(scan({ files: ["csproj-notes.md"], read: () => undefined }).commands).toEqual({})
  })

  test("ruby reads its Gemfile", () => {
    const proposal = scan({
      files: ["Gemfile"],
      read: reader({ Gemfile: "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n" }),
    })
    expect(proposal.commands.test).toBe("bundle exec rspec")
    expect(proposal.commands.lint).toBe("bundle exec rubocop")
    expect(scan({ files: ["Gemfile", "spec"], read: reader({ Gemfile: "" }) }).commands.test).toBe("bundle exec rspec")
  })

  test("go picks up golangci-lint only when it is configured", () => {
    expect(scan({ files: ["go.mod"], read: () => undefined }).commands.lint).toBeUndefined()
    expect(scan({ files: ["go.mod", ".golangci.yml"], read: () => undefined }).commands.lint).toBe("golangci-lint run")
  })

  test("first manifest wins per key (package.json over Makefile)", () => {
    const files = {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      Makefile: "test:\n\techo make-test\n",
    }
    const proposal = scan({ files: ["package.json", "Makefile"], read: reader(files) })
    expect(proposal.commands.test).toBe("npm run test")
    expect(proposal.evidence.some((line) => line.includes("scripts.test"))).toBe(true)
  })

  test("a rule is handed ONLY the files it declared in `reads`", () => {
    // The read seam is per-rule, so an undeclared read is undefined in a unit test exactly as it
    // is on the host — which is what makes a forgotten declaration fail loudly instead of
    // silently degrading in production. Ruby declares `Gemfile`; it must not see a Makefile.
    const seen: string[] = []
    scan({
      files: ["Gemfile", "Makefile", "Cargo.toml"],
      read: (name) => {
        seen.push(name)
        return name === "Gemfile" ? "gem 'rspec'" : "test:\n\t./t\n"
      },
    })
    // Every name that reached the caller is one some rule DECLARED.
    const declared = new Set(MANIFESTS.flatMap((rule) => rule.reads ?? []))
    for (const name of seen) expect(declared.has(name), `${name} was read but no rule declares it`).toBe(true)
  })

  test("empty project proposes nothing", () => {
    expect(scan({ files: ["README.md"], read: () => undefined }).commands).toEqual({})
  })
})

describe("QE-A rung-1 verification form", () => {
  test("a `{file}` placeholder is dropped, not executed literally", () => {
    // `ruff check {file}` verified as written makes ruff report "No such file or directory",
    // which classifyRun reads as a MISSING TOOLCHAIN — a good command discarded and the reason
    // misreported (v0.2.0 ruling 2: a fault is never described falsely).
    expect(verifiableCommand("ruff check {file}")).toBe("ruff check")
    expect(verifiableCommand("tsc --noEmit {file} --pretty")).toBe("tsc --noEmit --pretty")
    expect(verifiableCommand("eslint {file}")).toBe("eslint")
    // A command with no placeholder is untouched.
    expect(verifiableCommand("cargo test --quiet")).toBe("cargo test --quiet")
    expect(classifyRun({ exit: 1, output: "ruff: No such file or directory: {file}" })).toBe("missing")
  })
})

describe("QE-A run classification", () => {
  test("failing checks still count as ran; missing toolchains do not", () => {
    expect(classifyRun({ exit: 1, output: "3 tests failed" })).toBe("ran")
    expect(classifyRun({ exit: 0, output: "" })).toBe("ran")
    expect(classifyRun({ exit: 127, output: "" })).toBe("missing")
    expect(classifyRun({ exit: 9009, output: "" })).toBe("missing")
    expect(classifyRun({ exit: 1, output: "'ruff' is not recognized as an internal or external command" })).toBe(
      "missing",
    )
    expect(classifyRun({ exit: 1, output: "bash: cargo: command not found" })).toBe("missing")
    expect(classifyRun({ exit: undefined, output: "", timedOut: true })).toBe("timeout")
  })
})

// The project-config patch suite died with patchProjectConfig (config-sqlite: the tool
// saves to the instance settings store; nothing reads a project jsonc at runtime).

/**
 * ── the migration for stores written BEFORE FILE_RENDERED_SLOTS ─────────────────────────────────
 *
 * Ruling 1: an invariant whose violation compiles green ships with a mechanical check — and a
 * migration nothing tests is a migration nobody knows ran. Three properties are load-bearing:
 * every destination still matches the LIVE table, the repair is idempotent, and a command that is
 * fine is not touched.
 */

/**
 * The synthetic project that makes the CURRENT scan propose each stale command. Keyed by command so
 * a new entry in the table without a probe fails below rather than going unchecked.
 */
const PROBES: Record<string, Parameters<typeof scan>[0]> = {
  "cargo check --quiet": { files: ["Cargo.toml"], read: () => undefined },
  "go vet ./...": { files: ["go.mod"], read: () => undefined },
  "make check": {
    files: ["Makefile"],
    read: (name) => (name === "Makefile" ? "all:\n\tcc\ncheck:\n\t./t\n" : undefined),
  },
  ...Object.fromEntries(
    (
      [
        ["npm", []],
        ["bun", ["bun.lock"]],
        ["pnpm", ["pnpm-lock.yaml"]],
        ["yarn", ["yarn.lock"]],
      ] as const
    ).map(([pm, lock]) => [
      `${pm} run check`,
      {
        files: ["package.json", ...lock],
        read: (name: string) =>
          name === "package.json" ? JSON.stringify({ scripts: { check: "biome check ." } }) : undefined,
      },
    ]),
  ),
}

/** Every QE slot, in step order — the search space for "where does the live table put this?". */
const ALL_SLOTS = ["syntax", "check", "typecheck", "test", "lint"] as const

describe("QE-A migration: the stale table is PINNED to the live table", () => {
  test("every claim's command and destination are what the current scan actually produces", () => {
    // This is the whole reason the migration may hard-code a historical list: the DESTINATIONS are
    // not historical. If someone reworded `cargo check --quiet`, or moved it out of `typecheck`,
    // the migration would quietly relocate a command to a slot the product no longer uses. It
    // fails here instead.
    const faults: string[] = []
    for (const claim of STALE_FILE_RENDERED_CLAIMS) {
      const probe = PROBES[claim.command]
      if (!probe) {
        faults.push(`${claim.command}: no probe project — add one so this claim is checked`)
        continue
      }
      const proposed = scan(probe).commands
      const landed = ALL_SLOTS.filter((slot) => proposed[slot] === claim.command)
      if (landed.length === 0) faults.push(`${claim.command}: the current scan no longer proposes this command at all`)
      else if (landed[0] !== claim.to[0])
        faults.push(`${claim.command}: the current scan puts it in \`${landed[0]}\`, the claim says \`${claim.to[0]}\``)
    }
    expect(faults).toEqual([])
    // …and the loop really ran over something.
    expect(STALE_FILE_RENDERED_CLAIMS.length).toBeGreaterThanOrEqual(7)
  })

  test("no claim's command is one the scan would put in a FILE-RENDERED slot", () => {
    // The premise of the whole migration. If the table ever legitimately claims `check` again, this
    // list must be re-derived rather than trusted.
    for (const claim of STALE_FILE_RENDERED_CLAIMS) {
      const proposed = scan(PROBES[claim.command]).commands
      for (const slot of FILE_RENDERED_SLOTS) expect(proposed[slot], `${claim.command} → ${slot}`).toBeUndefined()
    }
  })
})

describe("QE-A migration: repair, not drop", () => {
  test("the measured case — `cargo check --quiet` moves to the free whole-project slot", () => {
    const before = { check: "cargo check --quiet", test: "cargo test --quiet" }
    const { commands, repairs } = migrateCommands(before)
    expect(commands).toEqual({ typecheck: "cargo check --quiet", test: "cargo test --quiet" })
    expect(repairs).toHaveLength(1)
    expect(repairs[0]).toMatchObject({ slot: "check", action: "moved", to: "typecheck" })
    // The note is self-contained: it names the value, the fault, and where the value went.
    expect(repairs[0].note).toContain('"cargo check --quiet"')
    expect(repairs[0].note).toContain("unexpected argument")
    expect(repairs[0].note).toContain("MOVED")
    // …and the rendered command the runner would have produced is gone from the per-file steps.
    const config = Quality.resolve({ enabled: true, commands })
    const due = Quality.dueMidLoop(config, Quality.initialState(), ["src/lib.rs"])
    expect(due.map((step) => step.command)).not.toContain('cargo check --quiet "src/lib.rs"')
    expect(due.some((step) => step.label === "check")).toBe(false)
  })

  test("`make check` → test, `go vet ./...` → typecheck, `<pm> run check` → lint", () => {
    expect(migrateCommands({ check: "make check" }).commands).toEqual({ test: "make check" })
    expect(migrateCommands({ check: "go vet ./..." }).commands).toEqual({ typecheck: "go vet ./..." })
    for (const pm of ["npm", "bun", "pnpm", "yarn"])
      expect(migrateCommands({ check: `${pm} run check` }).commands).toEqual({ lint: `${pm} run check` })
    // …and the node entry falls through to its SECOND destination when lint is taken, exactly as
    // the live rule does.
    expect(migrateCommands({ check: "bun run check", lint: "biome check ." }).commands).toEqual({
      lint: "biome check .",
      typecheck: "bun run check",
    })
  })

  test("a `syntax` slot carrying the same value is repaired identically", () => {
    // The old scan only ever claimed `check`, but `syntax` is file-rendered by the same rule and a
    // person can paste a value into either row. Matching on the VALUE covers both for free.
    const { commands, repairs } = migrateCommands({ syntax: "go vet ./..." })
    expect(commands).toEqual({ typecheck: "go vet ./..." })
    expect(repairs[0]).toMatchObject({ slot: "syntax", action: "moved", to: "typecheck" })
  })

  test("DROPS only when the destination is already taken — and says what it dropped and why", () => {
    const { commands, repairs } = migrateCommands({
      check: "cargo check --quiet",
      typecheck: "cargo build --quiet",
    })
    // The setting the user still has is never overwritten.
    expect(commands).toEqual({ typecheck: "cargo build --quiet" })
    expect(repairs[0]).toMatchObject({ slot: "check", action: "dropped", to: "typecheck" })
    expect(repairs[0].note).toContain('"cargo build --quiet"')
    expect(repairs[0].note).toContain("Settings → Quality")
  })

  test("an exact duplicate is removed as a duplicate, not reported as a loss", () => {
    const { commands, repairs } = migrateCommands({
      check: "cargo check --quiet",
      typecheck: "cargo check --quiet",
    })
    expect(commands).toEqual({ typecheck: "cargo check --quiet" })
    expect(repairs[0].note).toContain("duplicate")
  })

  test("NEGATIVE CONTROL — a valid saved command is left exactly as it was", () => {
    // The defect is a WHOLE-PROJECT command in a per-file slot, never "no {file} placeholder":
    // `renderCommand` appends the path and `ruff check "a.py"` is correct. A heuristic on the
    // placeholder would delete every one of these.
    const untouched = [
      { check: "ruff check", typecheck: "cargo check --quiet" },
      { check: "eslint {file}", syntax: "bun build --no-bundle {file}" },
      { check: "cargo check --quiet --manifest-path Cargo.toml" }, // near-miss, NOT the old value
      { check: "make checkall" }, // prefix of a stale value
      { typecheck: "cargo check --quiet", test: "make check", lint: "npm run check" }, // already correct
      {},
    ]
    for (const commands of untouched) {
      const result = migrateCommands(commands)
      expect(result.repairs, JSON.stringify(commands)).toEqual([])
      expect(result.commands, JSON.stringify(commands)).toEqual(commands)
    }
  })

  test("IDEMPOTENT — a second pass over its own output is a no-op", () => {
    // It runs on every boot. If it were not idempotent it would keep rewriting the store and
    // re-notifying the user forever.
    const first = migrateCommands({ check: "cargo check --quiet", syntax: "make check", lint: "npm run lint" })
    expect(first.repairs).toHaveLength(2)
    const second = migrateCommands(first.commands)
    expect(second.repairs).toEqual([])
    expect(second.commands).toEqual(first.commands)
  })

  test("whitespace variants of the stale value are still recognised", () => {
    expect(migrateCommands({ check: "  cargo   check  --quiet " }).repairs).toHaveLength(1)
    expect(migrateCommands({ check: "  cargo   check  --quiet " }).commands.typecheck).toBe("  cargo   check  --quiet ")
  })
})
