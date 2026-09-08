/**
 * Every path in this repo that installs dependencies, and whether it installs FROM the lockfile.
 *
 * ─── why this exists ───────────────────────────────────────────────────────────────────────────────
 * On 2026-08-04 the `keyv`/`cacheable` maintainer's package-registry account was taken over and
 * poisoned releases went out carrying VALID npm provenance; a worm reached ~444 packages. We
 * were not hit, and the reason is precise and worth stating exactly: **we survived on the lockfile, not
 * on our version ranges.** Three of the poisoned versions were INSIDE our declared `^` ranges
 * (`@cacheable/utils ^2.5.0` → 2.5.1, `@cacheable/memory ^2.2.0` → 2.2.1, `cacheable ^2.3.1` → 2.5.1),
 * so any install that re-RESOLVED instead of replaying `bun.lock` would have taken them. The control
 * that actually worked is therefore "refuse rather than re-resolve", and it is the only one that
 * generalises to the next compromised package rather than to that one.
 * (novaclaw-plan `todo/supply-chain.md` §8 holds the full measurement.)
 *
 * ─── why a mechanical check and not a convention ───────────────────────────────────────────────────
 * todo.md ruling 1: *every invariant whose violation compiles green ships with a mechanical check.* A
 * missing `--frozen-lockfile` is the purest example of that class — the build is GREENER without it
 * (it silently fixes whatever drifted), nothing typechecks it, no test observes it, and its absence is
 * only ever discovered by the compromise it was supposed to stop. This module makes the omission
 * detectable instead of merely regrettable; `install-paths.test.ts` makes it fail the gate.
 *
 * ⚠️ **A flag that is present but INERT is the whole failure mode here**, so read what was actually
 * measured (bun 1.3.14, 2026-08-07) rather than assuming:
 *   · `frozenLockfile = true` in the repo-root `bunfig.toml` is honoured when the install runs from a
 *     SUBDIRECTORY, via `--cwd <subdir>`, and even when that subdirectory has its own bunfig with no
 *     `[install]` section. That is why the root bunfig is treated as the primary control here and the
 *     per-call-site flag as reinforcement: the bunfig also covers call sites nobody has written yet.
 *   · It is INERT when there is no lockfile at all — a frozen install in a directory without a
 *     `bun.lock` resolves freely and writes one. So `bun.lock` being TRACKED is part of the control,
 *     and the test asserts it.
 *   · `bun install <pkg>@<ver>` is `bun add`, and `bun add` is not lockfile-replay at all: it succeeds
 *     under `frozenLockfile` when it needs no lockfile change and refuses when it does. Adding
 *     `--frozen-lockfile` to such a call site would be a flag with no effect — the definition of the
 *     failure above. Those call sites are therefore PINNED BY NAME in the test's shrink-only ledger
 *     instead, because a tree-mutating install on a build path is a thing to keep countable, not a
 *     thing to decorate.
 *
 * ⚠️ **Comments are stripped before matching, and that is load-bearing, not tidiness.** This repo has
 * already produced three wrong numbers in one day from regexes that counted PROSE — and the files most
 * likely to be miscounted are the well-commented ones, because a file that documents a hazard mentions
 * it. `build-linux.sh` says "bun install is ~800 MB" in a comment; `packages/core/src/agent-jail.ts`
 * says "would kill `npm install`". Neither is an install path. A scanner that counted them would report
 * violations that cannot be fixed, and would be turned off within a day.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** A package manager whose install command replays (or re-resolves) a lockfile. */
export type Manager = "bun" | "npm" | "pnpm" | "yarn"

const MANAGERS: readonly string[] = ["bun", "npm", "pnpm", "yarn"]
const isManager = (value: string): value is Manager => MANAGERS.includes(value)

export type InstallInvocation = {
  /** Repo-relative, forward slashes. */
  readonly file: string
  /** 1-based line within `file`, or 0 for a `package.json` script (which has no meaningful line). */
  readonly line: number
  readonly manager: Manager
  readonly subcommand: string
  /** The invocation as found, comments and shell redirection already removed. */
  readonly command: string
  /**
   * `bare` = "install whatever the manifests declare" — the shape a lockfile governs, and the shape
   * that MUST refuse. `specifier` = a named package, i.e. `bun add`, which mutates the tree by design.
   */
  readonly kind: "bare" | "specifier"
  /** Does this invocation refuse rather than re-resolve? */
  readonly frozen: boolean
}

/**
 * Where an install path can legitimately live. Deliberately NOT a package's `src` tree — the only installs
 * there are `packages/core/src/npm.ts`, which is the PRODUCT installing a user's plugin at runtime
 * (a different concern with its own design), and the `packages/app/src/i18n/*.ts` translation strings,
 * where "e.g. bun install" is placeholder text in eighteen languages. Build and release tooling lives
 * in `script/`, `scripts/`, a shell script at the root, or a `package.json` script.
 */
export const SCAN_GLOBS: readonly string[] = [
  "*.sh",
  "*.ps1",
  "*.cmd",
  "*.bat",
  "script/**/*.{ts,sh,ps1,cmd,bat}",
  "packages/*/script/**/*.{ts,sh,ps1,cmd,bat}",
  "packages/*/scripts/**/*.{ts,sh,ps1,cmd,bat}",
  "packages/sdk/js/script/**/*.{ts,sh,ps1,cmd,bat}",
  "package.json",
  "script/package.json",
  "packages/*/package.json",
  "packages/sdk/js/package.json",
]

const EXCLUDED_SEGMENTS = ["node_modules/", "/dist/", "/tmp/", "/.turbo/", "/fixture/", "/fixtures/"]

/**
 * Test files are not install paths, and scanning them makes the scanner report ITSELF: this module's
 * own test plants `bun install` strings as fixtures and negative controls, and every one of them would
 * come back as an unfrozen violation in a file that cannot be fixed. (Nothing in this tree installs
 * dependencies from a test — a test that did would be a much larger problem than a missing flag.)
 */
const isTestFile = (relative: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)

/** Flags that consume the following token, so it is a VALUE and not a package specifier. */
const VALUE_FLAGS = new Set(["--cwd", "--config", "--filter", "--backend", "--registry", "--os", "--cpu", "-c", "-p"])

/** Where a shell command ends — everything after is redirection or the next command, never an argument. */
const TERMINATORS = /^(\||\|\||&&|;|&|>|>>|<|2>&1|\)|\}|\/\/|\/\*)/

/** Strip line comments, block comments and `#` comments. Which of the three applies is by language. */
export function stripComments(source: string, language: "ts" | "shell"): string {
  let text = source
  if (language === "ts") {
    text = text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    return text
      .split("\n")
      .map((line) => {
        // Not a full JS lexer: this drops a line comment marker inside a string literal too. Safe direction
        // — it can only hide a would-be match, and a `bun install` written inside a string after a `//`
        // on the same line is not a shape this repo has ever used. The array-literal form
        // (`["bun", "install", …]`) is matched separately and is unaffected, because it has no `//`.
        const index = line.indexOf("//")
        return index === -1 ? line : line.slice(0, index)
      })
      .join("\n")
  }
  return text
    .split("\n")
    .map((line) => {
      // A `#` inside a shell string is legal but does not occur in this tree's install lines; cutting
      // at the first `#` that is not `$#`/`${#` is again the safe direction.
      const index = line.search(/(^|[^$\w])#/)
      const withoutComment = index === -1 ? line : line.slice(0, line[index] === "#" ? index : index + 1)
      return blankShellStrings(withoutComment)
    })
    .join("\n")
}

/**
 * Blank the CONTENTS of quoted shell strings, keeping length and column positions.
 *
 * ⚠️ This is the second half of "do not count prose", and it was not hypothetical: `build-linux.sh`
 * reports its own progress with `progress "Installing dependencies (bun install --frozen-lockfile)"`
 * and fails with a message naming the flag. A scanner without this blanked nothing and reported those
 * two message strings as install invocations — one of them as an UNFROZEN one, i.e. a violation that
 * could only be silenced by making the human-readable message worse. A comment is not the only place
 * prose hides; a user-facing string is the other.
 *
 * The cost is that a genuine command smuggled inside a quoted string (`sh -c "bun install"`) becomes
 * invisible to this scanner. That shape does not exist in this tree, and the root bunfig's
 * `frozenLockfile = true` covers it regardless — which is exactly why the bunfig is the primary control
 * and this scan is the reinforcement, rather than the other way round.
 */
function blankShellStrings(line: string): string {
  let out = ""
  let quote: string | undefined
  for (const character of line) {
    if (quote === undefined) {
      out += character
      if (character === '"' || character === "'") quote = character
      continue
    }
    if (character === quote) {
      out += character
      quote = undefined
      continue
    }
    out += " "
  }
  return out
}

function classify(
  manager: Manager,
  subcommand: string,
  rest: string,
): { kind: "bare" | "specifier"; frozen: boolean; command: string } {
  const tokens: string[] = []
  // A backtick closes the `$\`…\`` shell template these invocations are written in inside .ts build
  // scripts, so nothing past it is an argument.
  for (const raw of (rest.split("`")[0] ?? "").split(/\s+/)) {
    if (raw.length === 0) continue
    if (TERMINATORS.test(raw)) break
    tokens.push(raw)
  }
  const command = [manager, subcommand, ...tokens].join(" ")
  let kind: "bare" | "specifier" = subcommand === "add" ? "specifier" : "bare"
  let frozen = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.replace(/^["']|["'],?$/g, "")
    if (token.startsWith("-")) {
      if (token === "--frozen-lockfile" || token === "--immutable") frozen = true
      if (VALUE_FLAGS.has(token)) index += 1
      continue
    }
    if (token.length > 0) kind = "specifier"
  }
  // `npm ci` IS the frozen install — it is not a flag on `npm install`, it is a different command.
  if (manager === "npm" && subcommand === "ci") frozen = true
  return { kind, frozen, command }
}

/** `bun install …` / `npm ci …` written as a shell command. */
const SHELL_PATTERN = /(?<![\w./-])(bun|npm|pnpm|yarn)\s+(install|add|ci)(?![\w-])([^\n]*)/g
/** The same thing written as an argv array — `run(["npm", "install", archive, …])`. */
const ARRAY_PATTERN = /\[\s*"(bun|npm|pnpm|yarn)"\s*,\s*"(install|add|ci)"((?:\s*,\s*[^\]\n]*)*)\]/g

function scanText(file: string, text: string, language: "ts" | "shell"): InstallInvocation[] {
  const code = stripComments(text, language)
  const found: InstallInvocation[] = []
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length

  for (const match of code.matchAll(SHELL_PATTERN)) {
    const [, manager = "", subcommand = "", rest = ""] = match
    if (!isManager(manager)) continue
    found.push({ file, line: lineOf(match.index), manager, subcommand, ...classify(manager, subcommand, rest) })
  }
  for (const match of code.matchAll(ARRAY_PATTERN)) {
    const [, manager = "", subcommand = "", rest = ""] = match
    if (!isManager(manager)) continue
    found.push({
      file,
      line: lineOf(match.index),
      manager,
      subcommand,
      ...classify(manager, subcommand, rest.replaceAll(",", " ")),
    })
  }
  return found
}

type Manifest = { readonly scripts?: Readonly<Record<string, string>> }

/** Every install invocation in the repo's build, release and test tooling. */
export function scanInstallInvocations(root: string): InstallInvocation[] {
  const files = new Set<string>()
  for (const pattern of SCAN_GLOBS)
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: false })) {
      const relative = hit.replaceAll("\\", "/")
      if (EXCLUDED_SEGMENTS.some((segment) => `/${relative}`.includes(segment))) continue
      if (isTestFile(relative)) continue
      files.add(relative)
    }

  const found: InstallInvocation[] = []
  for (const file of [...files].sort()) {
    const text = readFileSync(join(root, file), "utf8")
    if (file.endsWith("package.json")) {
      const scripts = (JSON.parse(text) as Manifest).scripts ?? {}
      for (const [name, body] of Object.entries(scripts))
        for (const hit of scanText(file, body, "shell"))
          found.push({ ...hit, line: 0, command: `${name}: ${hit.command}` })
      continue
    }
    found.push(...scanText(file, text, file.endsWith(".ts") ? "ts" : "shell"))
  }
  return found
}

/** Stable identity for a ledger entry — line numbers drift, the command does not. */
export const invocationKey = (invocation: InstallInvocation): string => `${invocation.file} :: ${invocation.command}`

/** Is `frozenLockfile = true` set in the `[install]` section of a bunfig? Comments stripped first. */
export function bunfigFreezesLockfile(bunfigPath: string): boolean {
  const code = stripComments(readFileSync(bunfigPath, "utf8"), "shell")
  let inInstall = false
  for (const raw of code.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("[")) {
      inInstall = line.startsWith("[install]")
      continue
    }
    if (inInstall && /^frozenLockfile\s*=\s*true\s*$/.test(line)) return true
  }
  return false
}
