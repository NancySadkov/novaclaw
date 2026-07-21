export * as QualityProvision from "./quality-provision"

// QE-A — the deterministic half of the project provisioner: propose quality commands
// from the project's own manifests. Pure and injectable (files + reader), so the whole
// detection matrix is unit-testable without a filesystem. The codehamr escalation-ladder
// shape governs the tool built on top:
//   rung 0 (free)  — this scan: manifests → candidate commands;
//   rung 1 (cheap) — VERIFY each candidate by running it once with a timeout; the named
//                    failure loop is "a hung test command" → the timeout is the fire-once
//                    rule, and "tool not installed" (exit 127 class) drops the candidate;
//   rung 2 (model) — the calling model fills gaps by re-calling with explicit commands;
//   rung 3 (gated) — actually INSTALLING a missing toolchain stays a bash-tool action
//                    under its own permission gate — never automatic.

import type { Commands } from "./quality"

/** The one-shot runner steer when quality mode is ON but nothing is provisioned. */
export const NUDGE =
  "Quality mode is enabled for this project, but no quality commands are provisioned — the gates are inert. " +
  "Call the quality_provision tool now: it scans the project's manifests for check/typecheck/test/lint commands, " +
  "verifies each candidate actually runs, and saves quality.commands to the instance settings " +
  "(active for future sessions). If the scan finds nothing, re-call it passing explicit commands. Then continue your task."

export interface ScanInput {
  /** Top-level entry names of the project directory. */
  readonly files: readonly string[]
  /** Reads a top-level file's text; undefined when missing/unreadable. */
  readonly read: (name: string) => string | undefined
}

export interface Proposal {
  readonly commands: Commands
  /** Human/model-facing trail: which manifest produced which command. */
  readonly evidence: string[]
}

interface PackageJson {
  readonly scripts?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly dependencies?: Record<string, string>
}

function packageManager(files: ReadonlySet<string>): string {
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun"
  if (files.has("pnpm-lock.yaml")) return "pnpm"
  if (files.has("yarn.lock")) return "yarn"
  return "npm"
}

const NPM_PLACEHOLDER_TEST = /echo .Error: no test specified./

export function scan(input: ScanInput): Proposal {
  const files = new Set(input.files)
  const commands: { -readonly [K in keyof Commands]: Commands[K] } = {}
  const evidence: string[] = []
  const claim = (key: keyof Commands, command: string, why: string) => {
    if (commands[key]) return
    commands[key] = command
    evidence.push(`${key}: ${command}  (${why})`)
  }

  // package.json — scripts first (the project's own vocabulary), then dep-derived.
  if (files.has("package.json")) {
    const parsed = ((): PackageJson | undefined => {
      try {
        return JSON.parse(input.read("package.json") ?? "") as PackageJson
      } catch {
        return undefined
      }
    })()
    if (parsed) {
      const pm = packageManager(files)
      const scripts = parsed.scripts ?? {}
      const deps = { ...parsed.dependencies, ...parsed.devDependencies }
      if (scripts.typecheck) claim("typecheck", `${pm} run typecheck`, "package.json scripts.typecheck")
      else if (deps.typescript && (files.has("tsconfig.json") || scripts.build?.includes("tsc")))
        claim("typecheck", pm === "bun" ? "bunx tsc --noEmit" : "npx tsc --noEmit", "typescript + tsconfig.json")
      if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test))
        claim("test", `${pm} run test`, "package.json scripts.test")
      if (scripts.lint) claim("lint", `${pm} run lint`, "package.json scripts.lint")
      if (scripts.check) claim("check", `${pm} run check`, "package.json scripts.check")
    }
  }

  if (files.has("Cargo.toml")) {
    claim("check", "cargo check --quiet", "Cargo.toml")
    claim("test", "cargo test --quiet", "Cargo.toml")
    claim("lint", "cargo clippy --quiet -- -D warnings", "Cargo.toml (clippy)")
  }

  if (files.has("go.mod")) {
    claim("check", "go vet ./...", "go.mod")
    claim("test", "go test ./...", "go.mod")
  }

  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("setup.py")) {
    const pyproject = input.read("pyproject.toml") ?? ""
    const requirements = input.read("requirements.txt") ?? ""
    if (/\bruff\b/.test(pyproject) || /\bruff\b/.test(requirements)) claim("lint", "ruff check .", "ruff configured")
    if (/\bpytest\b/.test(pyproject) || /\bpytest\b/.test(requirements) || files.has("tests"))
      claim("test", "python -m pytest -q", "pytest configured / tests dir")
    if (/\bmypy\b/.test(pyproject) || /\bmypy\b/.test(requirements)) claim("typecheck", "python -m mypy .", "mypy configured")
  }

  if (files.has("Makefile")) {
    const makefile = input.read("Makefile") ?? ""
    const target = (name: string) => new RegExp(`^${name}\\s*:`, "m").test(makefile)
    if (target("test")) claim("test", "make test", "Makefile target")
    if (target("lint")) claim("lint", "make lint", "Makefile target")
    if (target("check")) claim("check", "make check", "Makefile target")
  }

  return { commands, evidence }
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
export function classifyRun(input: { readonly exit?: number; readonly output: string; readonly timedOut?: boolean }): Verification["verdict"] {
  if (input.timedOut) return "timeout"
  if (input.exit === 127 || input.exit === 9009) return "missing"
  if (input.exit !== 0 && MISSING_PATTERNS.some((pattern) => pattern.test(input.output))) return "missing"
  return "ran"
}

// patchProjectConfig (surgical project-jsonc quality.commands patch) died with the
// config-sqlite flip: nothing reads a project novaclaw.jsonc at runtime, so the tool
// now saves to the instance settings store instead (tool/quality-provision.ts).
