import { execFile } from "child_process"
import { createHash } from "crypto"
import fsSync from "fs"
import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { Repository } from "@novaclaw/core/repository"
import { tmpdir } from "./tmpdir"

/**
 * **The ONE place a fixture git repository is built.**
 *
 * ⚠️ **A fixture repo is built once per PROCESS and COPIED per test.** Measured 2026-07-28 on this
 * box (loaded, four agents): `git init` + 4 × `git config` + `add` + `commit` costs **820 ms** via
 * `execFile` and **1177 ms** via `bun $` — one git process is ~100 ms and the ritual is eight of
 * them. `fs.cp` of the finished 27-file repository costs **19–36 ms**, and removing it costs 11 ms.
 * A per-test rebuild therefore pays ~25× for a directory that is byte-identical every time. Five
 * suites were doing exactly that — Snapshot, RepositoryCache, Git, Git worktrees/trees and
 * MoveSession — through *three* hand-rolled copies of the same ritual (`snapshot.test.ts` inline,
 * `git.test.ts:initRepo`, `move-session.test.ts:initRepo`) plus two copies of `withRemote`.
 *
 * ⚠️ **Reuse is by COPY, never by sharing one live repository.** These suites commit, stage, branch
 * and `git worktree add`; a template that one test dirties and the next one reads is a flaky suite,
 * which is strictly worse than a slow one. A template directory is written once and thereafter only
 * ever READ, as the source of an `fs.cp`. Verified 2026-07-28 against real repositories: after a
 * copy is committed to and given a linked worktree the template is still 1 commit / clean status,
 * and a second copy comes out pristine; after `remote set-url` a push from a copy lands in the
 * copy's own bare origin (`feature/docs` present there, absent from the template's).
 *
 * ⚠️ **What is NOT collapsed, on purpose.** Where the git process is the *subject* — cloning a
 * remote, `git worktree add`, fetch/checkout/reset, staging a file the test then asserts on — it
 * stays a live git call. Only the *scenery* (a checkout has to exist) comes from a template.
 *
 * A hand-rolled `git init` or identity-config ritual anywhere under `packages/core/test/` is caught
 * by `git-fixture-ledger.test.ts` — a shrink-only ratchet, per todo.md ruling 1.
 */

const exec = promisify(execFile)

/** Where built templates live for the lifetime of the test process. Named by PID — see `home()`. */
const TEMPLATE_PREFIX = "novaclaw-core-git-template-"
let templateHome: string | undefined
const templates = new Map<string, Promise<string>>()

function home(): string {
  if (templateHome !== undefined) return templateHome
  // ⚠️ **`bun test` does NOT run `process.on("exit")` handlers.** Measured 2026-07-28 on bun
  // 1.3.14: a handler registered from a passing test never wrote its marker file and never deleted
  // its directory — 15 template roots had piled up in %TEMP%, one per run, before this was caught.
  // So teardown cannot be an exit hook. Instead the root is named by PID and every run reaps the
  // roots whose owner is gone, which bounds %TEMP% at one directory per LIVE test process and heals
  // whatever an earlier crash left behind (AGENTS.md pitfall #8 — nothing you start goes
  // unaccounted for).
  reapAbandonedTemplateRoots()
  const root = path.join(osTmpdir(), `${TEMPLATE_PREFIX}${process.pid}`)
  fsSync.rmSync(root, { recursive: true, force: true })
  fsSync.mkdirSync(root, { recursive: true })
  templateHome = root
  // Best-effort fast path: a no-op under `bun test`, correct everywhere else.
  process.on("exit", () => {
    try {
      fsSync.rmSync(root, { recursive: true, force: true })
    } catch {
      // A teardown failure must never turn a green suite red — the reap above is the real mechanism.
    }
  })
  return root
}

/**
 * Delete template roots whose owning process is gone.
 *
 * Keyed on PID, never on age: `script/test.ts` runs units in their own processes, and an age-based
 * sweep would eventually delete a CONCURRENT run's templates out from under it — trading a leaked
 * directory for a flaky suite. `process.kill(pid, 0)` is the liveness probe (verified 2026-07-28:
 * no throw for a live pid, `ESRCH` for a dead one, on Windows under bun). A recycled PID just means
 * one stale root survives until the next run.
 */
function reapAbandonedTemplateRoots() {
  let entries: string[]
  try {
    entries = fsSync.readdirSync(osTmpdir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(TEMPLATE_PREFIX)) continue
    const pid = Number(entry.slice(TEMPLATE_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      // ESRCH means gone. EPERM means alive under another account: leave it alone.
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fsSync.rmSync(path.join(osTmpdir(), entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same root; losing the race is fine.
    }
  }
}

/**
 * Build a template once, keyed by a digest of its RECIPE rather than by a name a caller picks. Two
 * call sites that ask for the same content share one build; two that ask for different content can
 * never silently collide on one repository — which is the failure mode that makes a shared fixture
 * worse than a slow one.
 */
function template(key: string, build: (directory: string) => Promise<void>) {
  let pending = templates.get(key)
  if (pending === undefined) {
    pending = (async () => {
      const directory = path.join(home(), key)
      await fs.mkdir(directory, { recursive: true })
      await build(directory)
      return directory
    })()
    templates.set(key, pending)
  }
  return pending
}

function digestOf(value: unknown) {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12)
}

/**
 * Copy a repository tree, **keeping the file timestamps**.
 *
 * ⚠️ Not cosmetic. `.git/index` caches each file's mtime and size; a plain `fs.cp` rewrites every
 * mtime, so git sees the whole worktree as stat-dirty and re-hashes it — and `Git.repo.create`
 * (git.ts) copies the seed's index into a snapshot repo, so a stale stat cache propagates there
 * too. Preserving timestamps keeps the copy's index valid, which is the property `git init` +
 * `git add` gave the hand-rolled fixtures for free. Correctness never depended on it (git falls back
 * to content comparison — a copy's `git status` is clean either way, verified 2026-07-28); speed did.
 */
function copyTree(source: string, destination: string) {
  return fs.cp(source, destination, { recursive: true, preserveTimestamps: true })
}

/**
 * Identity and determinism for a fixture repository, in one place.
 *
 * `core.autocrlf false` applies to every fixture (it used to be set only by `move-session.test.ts`):
 * without it the checked-out line endings depend on whatever Git for Windows wrote into this
 * machine's SYSTEM config, which is not a thing any of these suites is testing. `core.fsmonitor
 * false` keeps git from starting a watcher daemon against a directory that is about to be deleted,
 * and `commit.gpgsign false` keeps a developer's signing config out of the fixture.
 *
 * Deliberately not exported — every fixture repository comes from `repo()` or `gitRemote()`, and a
 * caller that could run the ritual itself is a caller that will.
 */
async function configure(directory: string) {
  await git(directory, "config", "core.autocrlf", "false")
  await git(directory, "config", "core.fsmonitor", "false")
  await git(directory, "config", "commit.gpgsign", "false")
  await git(directory, "config", "user.email", "test@novaclaw.test")
  await git(directory, "config", "user.name", "Test")
}

/**
 * `git init` + `configure` — six git processes, paid ONCE per process, and the starting point every
 * other template is copied from.
 *
 * ⚠️ This second stage is what makes the collapse worth doing, and the measurement is why it exists.
 * Memoizing whole repositories alone saved only **7 of 14** builds across these suites, because six
 * of the seven shapes commit different content and therefore never share: within `snapshot.test.ts`
 * all three fixtures differ. Starting each shape from the base instead makes a *new* shape cost two
 * git processes (`add` + `commit`) rather than eight, which is a saving that does not depend on two
 * tests happening to want the same files.
 *
 * It is also the `repo(…, { commit: false })` shape verbatim, so that option copies this directory
 * straight out. Still only ever READ, exactly as when it seeds another template — the invariant at
 * the top of this file ("a template is written once and thereafter only ever the source of an
 * `fs.cp`") is what makes handing it out safe.
 */
function baseRepo() {
  return template("base", async (directory) => {
    await git(directory, "init")
    await configure(directory)
  })
}

/**
 * A fresh, independent git checkout at `destination` whose single root commit holds `files`
 * (project-relative path → content; the default `{}` gives an empty root commit). `destination` is
 * created if missing and may already exist — a `tmpdir()` root is the normal caller.
 *
 * One root commit where a caller previously made two changes nothing these suites assert on: they
 * compare working-tree state against HEAD, never ancestry.
 *
 * `options` covers the two shapes `ProjectV2.resolve` needs that a plain checkout does not, and
 * **neither of them belongs in the template key**:
 *
 * - `commit: false` — `git init` + the identity config and **nothing else**, i.e. a repository with
 *   no commits at all. That is a state `resolve` has a named case for ("no commits and no remote" →
 *   the global id), and it is `baseRepo()` exactly, so it costs a copy and zero git processes.
 * - `origin` — a remote URL, added to the COPY with one `git remote add`. ⚠️ Deliberately **not**
 *   part of the memo key. `project.test.ts` uses four distinct URLs, and one of them is
 *   `file://<the test's own tmpdir>` — different on every single call. Keying on the URL would
 *   therefore build a fresh template per URL and, for that one, a fresh template per CALL: a memo
 *   that never hits plus unbounded template growth in `%TEMP%`. Same post-copy shape as
 *   `gitRemote()`'s `remote set-url` below, and for the same reason — a per-copy fact is applied per
 *   copy.
 */
export async function repo(
  destination: string,
  files: Readonly<Record<string, string>> = {},
  options: Readonly<{ commit?: boolean; origin?: string }> = {},
) {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (options.commit === false && entries.length > 0)
    // A commit-less checkout carrying files is a third shape (untracked or staged?) that nothing
    // asks for. Failing here beats silently picking one.
    throw new Error("repo(): `commit: false` builds a repository with no commits, so it cannot carry files")
  const source =
    options.commit === false
      ? await baseRepo()
      : await template(`repo-${digestOf(entries)}`, async (directory) => {
          await copyTree(await baseRepo(), directory)
          for (const [file, content] of entries) {
            const target = path.join(directory, file)
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, content)
          }
          if (entries.length === 0) await git(directory, "commit", "--allow-empty", "-m", "root")
          else {
            await git(directory, "add", ".")
            await git(directory, "commit", "-m", "root")
          }
        })
  await fs.mkdir(destination, { recursive: true })
  await copyTree(source, destination)
  if (options.origin !== undefined) await git(destination, "remote", "add", "origin", options.origin)
  return destination
}

/**
 * A bare `origin.git` plus a `source` checkout pushed to it, both under `root`. Eleven git processes
 * as this used to be written, eight to build the template once, and one (`remote set-url`) per use.
 * Six of these across `RepositoryCache` (4) and `Git` (2) now share one build.
 */
export async function gitRemote(root: string) {
  const source = await template(`remote-${digestOf("one\n")}`, async (directory) => {
    const origin = path.join(directory, "origin.git")
    const work = path.join(directory, "source")
    await git(directory, "init", "--bare", origin)
    await copyTree(await baseRepo(), work)
    await fs.writeFile(path.join(work, "README.md"), "one\n")
    await git(work, "add", "README.md")
    await git(work, "commit", "-m", "initial")
    await git(work, "branch", "-M", "main")
    await git(work, "remote", "add", "origin", pathToFileURL(origin).href)
    await git(work, "push", "-u", "origin", "main")
    await git(directory, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main")
  })
  await fs.mkdir(root, { recursive: true })
  await copyTree(source, root)
  const origin = path.join(root, "origin.git")
  const work = path.join(root, "source")
  // ⚠️ The copied checkout still points `origin` at the TEMPLATE's bare repo. Repoint it at its own
  // copy: `git.test.ts` pushes a commit and a branch through it, and a push that reached the
  // template would leak one test's refs into every later test — the exact flakiness a shared fixture
  // is supposed to avoid.
  await git(work, "remote", "set-url", "origin", pathToFileURL(origin).href)
  return {
    root,
    source: work,
    remote: pathToFileURL(origin).href,
    reference: { ...Repository.parseRemote("owner/repo"), remote: pathToFileURL(origin).href },
  }
}

/** A `gitRemote()` fixture in its own temp directory, disposed with the test. */
export function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

export async function commit(source: string, content: string, message: string) {
  await fs.writeFile(path.join(source, "README.md"), content)
  await git(source, "add", "README.md")
  await git(source, "commit", "-m", message)
  await git(source, "push")
}

export async function branch(source: string, name: string, content: string) {
  await git(source, "checkout", "-b", name)
  await fs.writeFile(path.join(source, "README.md"), content)
  await git(source, "add", "README.md")
  await git(source, "commit", "-m", name)
  await git(source, "push", "-u", "origin", name)
}

export async function git(cwd: string, ...args: string[]) {
  await exec("git", args, { cwd })
}

/** `git(...)` for the handful of assertions that read git's own output. */
export async function gitText(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout
}
