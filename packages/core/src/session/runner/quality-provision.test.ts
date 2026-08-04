import { describe, expect, test } from "bun:test"
import { MANIFESTS, classifyRun, scan, verifiableCommand } from "./quality-provision"

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
