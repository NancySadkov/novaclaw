#!/usr/bin/env bun
// Points this clone's git at the TRACKED hooks in `.githooks/`.
//
// WHY. `core.hooksPath` in this repo pointed at `.husky/_` — a directory that does not exist and has
// not existed since the opencode fork was detached. Git silently runs nothing when hooksPath names a
// missing directory, so every hook in this repo had never fired. Tracked hooks + this one-line
// installer replace it: the hooks are reviewable in the tree, and every clone opts in the same way.
//
// Run it once per clone:  bun run hooks:install
//
// It is idempotent, it reports the value it replaces (so the change is legible rather than silent),
// and it refuses outside a git work tree. It deliberately does NOT stage anything — the executable
// bit that other clones need is an index property, and the exact command for that is printed instead.
import { spawnSync } from "node:child_process"
import path from "node:path"

const HOOKS_DIR = ".githooks"
const HOOKS = ["pre-commit", "pre-push"]

const repo = path.resolve(import.meta.dir, "..")

function git(...args: string[]) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8" })
  return {
    ok: !proc.error && proc.status === 0,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? "").trim(),
    missing: Boolean(proc.error),
  }
}

function die(message: string): never {
  process.stderr.write(`\x1b[31mhooks:install — ${message}\x1b[0m\n`)
  process.exit(1)
}

// --- preconditions ---------------------------------------------------------------------------

const version = git("--version")
if (version.missing) die("git is not on PATH.")

const insideWorkTree = git("rev-parse", "--is-inside-work-tree")
if (!insideWorkTree.ok || insideWorkTree.stdout !== "true")
  die(`${repo} is not inside a git work tree, so there is no config to set.`)

const toplevel = git("rev-parse", "--show-toplevel")
if (!toplevel.ok) die(`could not resolve the repository root: ${toplevel.stderr || "git failed"}`)
// git answers with forward slashes on Windows; resolve both sides before comparing.
const root = path.resolve(toplevel.stdout)
const sameDir = process.platform === "win32" ? root.toLowerCase() === repo.toLowerCase() : root === repo
if (!sameDir)
  die(
    `this script lives in ${repo} but the enclosing repository is ${root}.\n` +
      `Refusing to configure a repository other than the one that ships these hooks.`,
  )

for (const hook of HOOKS) {
  const file = Bun.file(path.join(repo, HOOKS_DIR, hook))
  if (!(await file.exists())) die(`${HOOKS_DIR}/${hook} is missing — nothing to install.`)
}

// --- the change ------------------------------------------------------------------------------

// `--show-origin` answers "and where did that come from", which is the half that makes a silent
// inherited value (a global hooksPath, say) legible instead of mysterious.
const previous = git("config", "--show-origin", "--get", "core.hooksPath")
const previousValue = previous.ok ? previous.stdout.split("\t").pop()?.trim() : undefined
const previousOrigin = previous.ok ? previous.stdout.split("\t")[0]?.trim() : undefined

if (previousValue === HOOKS_DIR) {
  console.log(`core.hooksPath is already ${HOOKS_DIR} (${previousOrigin}) — nothing to change.`)
} else {
  const set = git("config", "core.hooksPath", HOOKS_DIR)
  if (!set.ok) die(`could not set core.hooksPath: ${set.stderr || "git failed"}`)
  if (previousValue === undefined) console.log(`core.hooksPath was unset  ->  ${HOOKS_DIR}`)
  else console.log(`core.hooksPath was ${previousValue} (${previousOrigin})  ->  ${HOOKS_DIR}`)
  if (previousValue === ".husky/_") console.log(`  (that directory does not exist — no hook in this repo had ever run)`)
}

// --- what now runs, and what still needs a human -----------------------------------------------

console.log("")
console.log("Active hooks:")
console.log(`  ${HOOKS_DIR}/pre-commit  staged mode-120000 files outside packages/app/public/,`)
console.log(`                        and the migration baseline when a *sql.ts is staged`)
console.log(`  ${HOOKS_DIR}/pre-push    mode-120000 files anywhere in the tree being pushed`)
console.log("Bypass either with --no-verify.")

// CRLF in a hook is a `bad interpreter` failure under Git Bash and a hard stop on Linux/macOS. The
// repo has no `.githooks/** text eol=lf` attribute yet, so a clone with core.autocrlf=true would
// convert them on checkout — worth saying out loud rather than debugging later.
const crlf: string[] = []
for (const hook of HOOKS) {
  const text = await Bun.file(path.join(repo, HOOKS_DIR, hook)).text()
  if (text.includes("\r\n")) crlf.push(hook)
}
if (crlf.length) {
  console.log("")
  console.log(`\x1b[33mWARNING: ${crlf.join(", ")} has CRLF line endings.\x1b[0m`)
  console.log("  sh reports 'bad interpreter' and the hook silently never runs. Re-check it out with")
  console.log("  LF, and add  .githooks/** text eol=lf  to .gitattributes so it cannot recur.")
}

// The executable bit is an INDEX property. It is moot on Windows (no file mode) but load-bearing on
// Linux/macOS, where git skips a hook that is not executable — i.e. getting this wrong reproduces the
// exact failure this whole unit exists to remove, silently, on the clones we cannot see.
const indexModes = git("ls-files", "-s", "--", HOOKS_DIR)
const untracked = indexModes.ok && indexModes.stdout.length === 0
const notExecutable = indexModes.ok && indexModes.stdout.split(/\r?\n/).some((line) => line.startsWith("100644 "))

if (untracked || notExecutable) {
  console.log("")
  console.log("The hooks still need the executable bit in the index, or git skips them on Linux/macOS:")
  console.log(`  git add --chmod=+x ${HOOKS.map((h) => `${HOOKS_DIR}/${h}`).join(" ")}`)
  console.log("  git commit -m 'ci: a git hook that actually runs'")
}
