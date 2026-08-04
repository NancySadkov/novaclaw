export * as QualityProvision from "./quality-provision"

// QE-A — the deterministic half of the project provisioner: propose quality commands
// from the project's own manifests. Pure and injectable (files + reader + shell family),
// so the whole detection matrix is unit-testable without a filesystem. The codehamr
// escalation-ladder shape governs the tool built on top:
//   rung 0 (free)  — this scan: manifests → candidate commands;
//   rung 1 (cheap) — VERIFY each candidate by running it once with a timeout; the named
//                    failure loop is "a hung test command" → the timeout is the fire-once
//                    rule, and "tool not installed" (exit 127 class) drops the candidate;
//   rung 2 (model) — the calling model fills gaps by re-calling with explicit commands;
//   rung 3 (gated) — actually INSTALLING a missing toolchain stays a bash-tool action
//                    under its own permission gate — never automatic.
//
// ⚠️ THE TABLE IS THE SCAN. `MANIFESTS` is the single declaration of every manifest this
// project understands, and everything else about manifests is DERIVED from it instead of
// restating it. Three drifts are closed that way, all of which compiled green before:
//
//   · `MANIFEST_TRIGGERS` — the names the tool's model-facing description advertises, pinned
//     EQUAL to the table by `core/test/quality-provision-drift.test.ts`. A description that
//     promises an ecosystem the table cannot detect is v0.2.0 ruling 2's *a fault is never
//     described falsely*, and it is worse than a plain gap: tool prose is text that reaches a
//     future session's prompt (ruling 4), so the model reads the promise and believes it.
//   · `MANIFEST_READS` — the files `tool/quality-provision.ts` loads off disk before calling
//     `scan`. It used to hold its own hardcoded list of four names, which happened to match
//     and was pinned by nothing. A rule's `read` now serves ONLY the names that rule declares,
//     so an undeclared read is `undefined` in a unit test exactly as it is on the host —
//     forgetting to declare one fails loudly in the matrix instead of silently degrading in
//     production. (Presence-only manifests declare no reads: `Cargo.toml` and `go.mod` are
//     detected by NAME, which is why Rust and Go were never actually broken by the old list.)
//   · `FILE_RENDERED_SLOTS` — see below; this is the one that was a live fault.

import type { Commands } from "./quality"

/** The one-shot runner steer when quality mode is ON but nothing is provisioned. */
export const NUDGE =
  "Quality mode is enabled for this project, but no quality commands are provisioned — the gates are inert. " +
  "Call the quality_provision tool now: it scans the project's manifests for check/typecheck/test/lint commands, " +
  "verifies each candidate actually runs, and saves quality.commands to the instance settings " +
  "(active for future sessions). If the scan finds nothing, re-call it passing explicit commands. Then continue your task."

/**
 * Syntax family of the shell the provisioned commands will RUN in — `Shell.agentShellIsPosix()`
 * at the call site, NOT `process.platform`: the agent shell is Git Bash on Windows whenever one
 * is found, and cmd.exe only as the documented fallback. It decides `./gradlew` vs `gradlew.bat`.
 */
export type ShellFamily = "posix" | "cmd"

export interface ScanInput {
  /** Top-level entry names of the project directory (files AND directories). */
  readonly files: readonly string[]
  /** Reads a top-level file's text; undefined when missing/unreadable. */
  readonly read: (name: string) => string | undefined
  /** Defaults to "posix" — the agent shell is bash wherever one exists. */
  readonly shell?: ShellFamily
}

export interface Proposal {
  readonly commands: Commands
  /** Human/model-facing trail: which manifest produced which command. */
  readonly evidence: string[]
}

/**
 * The QE slots the runner substitutes a touched FILE into — `Quality.dueMidLoop` renders them
 * through `Quality.renderCommand`, which APPENDS the path when the template has no `{file}`
 * placeholder.
 *
 * ⚠️ **The scan therefore never claims them, and that is a fix, not a limitation.** Every command
 * derivable from a manifest is whole-project, and four of them were being claimed as `check`:
 * `cargo check --quiet`, `go vet ./...`, `make check`, `<pm> run check`. Measured 2026-07-30 on a
 * real crate: bare `cargo check --quiet` exits 0 (so rung-1 verification passes and the candidate
 * is never dropped), while the form QE-B actually runs — `cargo check --quiet "src/lib.rs"` — exits
 * 1 with `error: unexpected argument 'src/lib.rs' found`. That is a quality gate reporting, on every
 * single write, a fault that does not exist and that the model cannot fix: v0.2.0 ruling 2's *a
 * fault is never described falsely*. Whole-project verifiers belong in `typecheck`/`test`/`lint`,
 * which are never file-rendered. A genuine per-file `check` is project-specific and arrives through
 * the tool's `input.commands` (rung 2), where it may carry `{file}`.
 */
export const FILE_RENDERED_SLOTS: readonly (keyof Commands)[] = ["syntax", "check"]

/** What a rule may do: look at the project, read the files IT declared, claim a slot. */
export interface RuleContext {
  readonly shell: ShellFamily
  /** Is this top-level entry present? A leading `*.` matches by suffix (`*.csproj`). */
  readonly has: (name: string) => boolean
  /** Text of a top-level file — undefined unless the rule DECLARED it in `reads`. */
  readonly read: (name: string) => string | undefined
  /** Has some earlier rule already taken this slot? (First manifest wins per key.) */
  readonly claimed: (key: keyof Commands) => boolean
  readonly claim: (key: keyof Commands, command: string, why: string) => void
}

export interface ManifestRule {
  /** Ecosystem id, for evidence and for failure messages naming the rule. */
  readonly id: string
  /**
   * ADVERTISED trigger names. The tool's description must name exactly the union of these
   * across the table — no more (a promise we cannot keep) and no fewer (a capability the
   * model never learns it has).
   */
  readonly triggers: readonly string[]
  /**
   * Accepted equivalents not worth advertising separately — case variants, alternate DSLs.
   * They trigger the rule and may be read; they are deliberately absent from the description
   * so 13 advertised names do not become 20.
   */
  readonly aliases?: readonly string[]
  /**
   * Concrete names (never globs) whose TEXT this rule reads. The tool loads exactly the union
   * of these; a name absent from here reads as `undefined` even when the file is on disk.
   */
  readonly reads?: readonly string[]
  readonly propose: (context: RuleContext) => void
}

interface PackageJson {
  readonly scripts?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly dependencies?: Record<string, string>
}

function packageManager(has: (name: string) => boolean): string {
  if (has("bun.lock") || has("bun.lockb")) return "bun"
  if (has("pnpm-lock.yaml")) return "pnpm"
  if (has("yarn.lock")) return "yarn"
  return "npm"
}

const NPM_PLACEHOLDER_TEST = /echo .Error: no test specified./

/** `./gradlew` under a POSIX shell, `gradlew.bat` under cmd, bare `gradle` with no wrapper. */
function wrapper(context: RuleContext, posix: string, cmd: string, bare: string): string {
  if (context.shell === "cmd") return context.has(cmd) ? cmd : bare
  return context.has(posix) ? `./${posix}` : bare
}

/**
 * THE MANIFEST TABLE — one entry per ecosystem, in precedence order (first claim of a slot
 * wins, so the four original rules keep their exact relative order and the ecosystems added
 * afterwards can only FILL GAPS, never displace an existing proposal).
 *
 * ⚠️ Refiners are NOT triggers. A lock file (`bun.lock`), a `tsconfig.json`, a `.golangci.yml`
 * or an existing `build/` directory only *sharpens* a rule that some trigger already fired —
 * it is presence-checked through `has`, needs no read, and is not advertised. Only a file that
 * can make the scan speak on its own belongs in `triggers`.
 */
export const MANIFESTS: readonly ManifestRule[] = [
  {
    id: "node",
    triggers: ["package.json"],
    reads: ["package.json"],
    propose: (context) => {
      const parsed = ((): PackageJson | undefined => {
        try {
          return JSON.parse(context.read("package.json") ?? "") as PackageJson
        } catch {
          return undefined
        }
      })()
      if (!parsed) return
      const pm = packageManager(context.has)
      const runner = pm === "bun" ? "bunx" : "npx"
      const scripts = parsed.scripts ?? {}
      const deps = { ...parsed.dependencies, ...parsed.devDependencies }
      if (scripts.typecheck) context.claim("typecheck", `${pm} run typecheck`, "package.json scripts.typecheck")
      else if (deps.typescript && (context.has("tsconfig.json") || scripts.build?.includes("tsc")))
        context.claim("typecheck", `${runner} tsc --noEmit`, "typescript + tsconfig.json")
      if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test))
        context.claim("test", `${pm} run test`, "package.json scripts.test")
      if (scripts.lint) context.claim("lint", `${pm} run lint`, "package.json scripts.lint")
      // `scripts.check` is a WHOLE-PROJECT script, so it fills a whole-project slot rather than
      // the file-rendered `check` slot it used to take (see FILE_RENDERED_SLOTS: `npm run check
      // "src/a.ts"` forwards the path into a script that usually has its own target list).
      // `lint` before `typecheck` deliberately: a `check` script in the wild is usually the
      // project's AGGREGATE verifier, and `lint` is the turn-end gate (once per drain) while
      // `typecheck` is mid-loop (every `cadence`-th write) — so the cheaper slot wins, and it
      // claims ONE of them, never both.
      if (scripts.check) {
        if (!context.claimed("lint"))
          context.claim("lint", `${pm} run check`, "package.json scripts.check (whole-project aggregate)")
        else if (!context.claimed("typecheck"))
          context.claim("typecheck", `${pm} run check`, "package.json scripts.check (whole-project aggregate)")
      }
    },
  },
  {
    id: "cargo",
    triggers: ["Cargo.toml"],
    propose: (context) => {
      // `cargo check` takes no path argument — hence `typecheck` (whole-module, never rendered
      // with a file) and not `check`. See FILE_RENDERED_SLOTS.
      context.claim("typecheck", "cargo check --quiet", "Cargo.toml")
      context.claim("test", "cargo test --quiet", "Cargo.toml")
      context.claim("lint", "cargo clippy --quiet -- -D warnings", "Cargo.toml (clippy)")
    },
  },
  {
    id: "go",
    triggers: ["go.mod"],
    propose: (context) => {
      // `go vet` type-checks as part of its analysis, so it fails on compile errors too — the
      // honest whole-module verifier for Go, and it writes nothing (unlike `go build ./...`,
      // which drops an executable in the working directory for a main package).
      context.claim("typecheck", "go vet ./...", "go.mod")
      context.claim("test", "go test ./...", "go.mod")
      if (
        context.has(".golangci.yml") ||
        context.has(".golangci.yaml") ||
        context.has(".golangci.toml") ||
        context.has(".golangci.json")
      )
        context.claim("lint", "golangci-lint run", "go.mod + .golangci config")
    },
  },
  {
    id: "python",
    triggers: ["pyproject.toml", "requirements.txt", "setup.py"],
    reads: ["pyproject.toml", "requirements.txt"],
    propose: (context) => {
      const declared = `${context.read("pyproject.toml") ?? ""}\n${context.read("requirements.txt") ?? ""}`
      if (/\bruff\b/.test(declared)) context.claim("lint", "ruff check .", "ruff configured")
      if (/\bpytest\b/.test(declared) || context.has("tests"))
        context.claim("test", "python -m pytest -q", "pytest configured / tests dir")
      if (/\bmypy\b/.test(declared)) context.claim("typecheck", "python -m mypy .", "mypy configured")
    },
  },
  {
    id: "make",
    // GNU make's own search order, so a lowercase `makefile` is no longer invisible.
    triggers: ["Makefile"],
    aliases: ["GNUmakefile", "makefile"],
    reads: ["GNUmakefile", "makefile", "Makefile"],
    propose: (context) => {
      const name = ["GNUmakefile", "makefile", "Makefile"].find((file) => context.has(file))
      const makefile = (name && context.read(name)) || ""
      const target = (rule: string) => new RegExp(`^${rule}\\s*:`, "m").test(makefile)
      if (target("test")) context.claim("test", "make test", "Makefile target")
      if (target("lint")) context.claim("lint", "make lint", "Makefile target")
      // GNU coding standards: `make check` RUNS THE TEST SUITE. It used to be claimed as the
      // file-rendered `check` slot, where `make check "a.c"` asks make for a target named a.c.
      if (target("check")) context.claim("test", "make check", "Makefile check target (runs the suite)")
    },
  },
  {
    id: "cmake",
    triggers: ["CMakeLists.txt"],
    reads: ["CMakeLists.txt"],
    propose: (context) => {
      // Self-bootstrapping on purpose: a fresh clone has no build tree, and `cmake --build build`
      // alone would report "does not appear to contain CMakeCache.txt" — a real-looking fault whose
      // actual cause is that nobody configured yet. Re-configuring an existing tree is cheap.
      const configure = "cmake -S . -B build"
      context.claim("typecheck", `${configure} && cmake --build build`, "CMakeLists.txt (configure + build)")
      const lists = context.read("CMakeLists.txt") ?? ""
      if (/\benable_testing\s*\(|\badd_test\s*\(/.test(lists))
        context.claim(
          "test",
          `${configure} && cmake --build build && ctest --test-dir build --output-on-failure`,
          "CMakeLists.txt (enable_testing/add_test → ctest)",
        )
    },
  },
  {
    id: "gradle",
    triggers: ["build.gradle"],
    aliases: ["build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    propose: (context) => {
      const gradle = wrapper(context, "gradlew", "gradlew.bat", "gradle")
      context.claim("test", `${gradle} test`, "build.gradle (Gradle test task)")
      // `check` depends on `test`; excluding it leaves exactly the verification tasks.
      context.claim("lint", `${gradle} check -x test`, "build.gradle (Gradle check, tests excluded)")
    },
  },
  {
    id: "maven",
    triggers: ["pom.xml"],
    propose: (context) => {
      const mvn = wrapper(context, "mvnw", "mvnw.cmd", "mvn")
      context.claim("typecheck", `${mvn} -q compile`, "pom.xml (Maven compile)")
      context.claim("test", `${mvn} -q test`, "pom.xml (Maven test)")
    },
  },
  {
    id: "dotnet",
    triggers: ["*.sln", "*.csproj"],
    aliases: ["*.fsproj", "*.vbproj"],
    propose: (context) => {
      context.claim("typecheck", "dotnet build --nologo", "*.sln/*.csproj (dotnet build)")
      context.claim("test", "dotnet test --nologo", "*.sln/*.csproj (dotnet test)")
      if (context.has(".editorconfig"))
        context.claim("lint", "dotnet format --verify-no-changes", "*.csproj + .editorconfig")
    },
  },
  {
    id: "ruby",
    triggers: ["Gemfile"],
    reads: ["Gemfile"],
    propose: (context) => {
      const gemfile = context.read("Gemfile") ?? ""
      if (/\brspec\b/.test(gemfile) || context.has("spec"))
        context.claim("test", "bundle exec rspec", "Gemfile rspec / spec dir")
      if (/\brubocop\b/.test(gemfile)) context.claim("lint", "bundle exec rubocop", "Gemfile rubocop")
    },
  },
]

const unique = (names: readonly string[]): readonly string[] => [...new Set(names)]

/**
 * Every ADVERTISED manifest name, table order. `tool/quality-provision.ts`'s description must
 * name exactly this set — pinned by `core/test/quality-provision-drift.test.ts`.
 */
export const MANIFEST_TRIGGERS: readonly string[] = unique(MANIFESTS.flatMap((rule) => rule.triggers))

/** Every name a rule may be handed the TEXT of. The tool loads exactly these (and nothing else). */
export const MANIFEST_READS: readonly string[] = unique(MANIFESTS.flatMap((rule) => rule.reads ?? []))

export function scan(input: ScanInput): Proposal {
  const files = new Set(input.files)
  const has = (name: string) =>
    name.startsWith("*.") ? [...files].some((file) => file.endsWith(name.slice(1))) : files.has(name)
  const commands: { -readonly [K in keyof Commands]: Commands[K] } = {}
  const evidence: string[] = []
  const shell = input.shell ?? "posix"

  for (const rule of MANIFESTS) {
    const own = [...rule.triggers, ...(rule.aliases ?? [])]
    if (!own.some(has)) continue
    const declared = new Set(rule.reads ?? [])
    rule.propose({
      shell,
      has,
      // A rule reads what it DECLARED and nothing more, so a missing declaration fails
      // identically in a unit test and on the host (see MANIFEST_READS at the top).
      read: (name) => (declared.has(name) ? input.read(name) : undefined),
      claimed: (key) => Boolean(commands[key]),
      claim: (key, command, why) => {
        if (commands[key]) return
        commands[key] = command
        evidence.push(`${key}: ${command}  (${why})`)
      },
    })
  }

  return { commands, evidence }
}

/**
 * The form a candidate is VERIFIED in at rung 1. Verification answers exactly one question —
 * *does this toolchain exist* — so a `{file}` placeholder is DROPPED rather than executed
 * literally. Running `ruff check {file}` as written makes ruff report `No such file or
 * directory`, which `classifyRun` reads as a MISSING TOOLCHAIN: a perfectly good per-file check
 * silently discarded and the reason misreported (v0.2.0 ruling 2). The placeholder only ever has
 * a value once the runner has a touched file (`Quality.renderCommand`).
 */
export function verifiableCommand(command: string): string {
  return command
    .replaceAll("{file}", " ")
    .replace(/\s{2,}/g, " ")
    .trim()
}

/** Rung-1 verification verdict for one executed candidate command. */
export interface Verification {
  readonly command: string
  /** "ran" = the toolchain exists (any exit incl. failures); "missing" = drop it. */
  readonly verdict: "ran" | "missing" | "timeout"
  readonly exit?: number
}

const MISSING_PATTERNS = [
  /command not found/i,
  /not recognized as an internal or external command/i,
  /No such file or directory/i,
  /ENOENT/,
  /is not recognized/i,
  /CommandNotFoundException/i,
]

/** Classify a finished candidate run: distinguish "toolchain missing" from "ran (even if red)". */
export function classifyRun(input: {
  readonly exit?: number
  readonly output: string
  readonly timedOut?: boolean
}): Verification["verdict"] {
  if (input.timedOut) return "timeout"
  if (input.exit === 127 || input.exit === 9009) return "missing"
  if (input.exit !== 0 && MISSING_PATTERNS.some((pattern) => pattern.test(input.output))) return "missing"
  return "ran"
}

// patchProjectConfig (surgical project-jsonc quality.commands patch) died with the
// config-sqlite flip: nothing reads a project novaclaw.jsonc at runtime, so the tool
// now saves to the instance settings store instead (tool/quality-provision.ts).
