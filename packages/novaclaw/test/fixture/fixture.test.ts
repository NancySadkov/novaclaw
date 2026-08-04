import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import { gitTemplateDir, tmpdir, tmpdirScoped } from "./fixture"

/**
 * `git: true` is provisioned by copying a template built ONCE per process (see the block comment in
 * `fixture.ts`). The speed of that is not what needs checking — `git-fixture-ledger.test.ts` pins the
 * mechanism, and the numbers are in the comment. What needs checking is that the copy is still a
 * REAL, INDEPENDENT repository, because every way this optimisation can go wrong is a way of handing
 * two tests one identity.
 */

const gitText = (cwd: string, ...args: string[]) => $`git ${args}`.cwd(cwd).quiet().text()

const rootCommit = async (cwd: string) => (await gitText(cwd, "rev-list", "--max-parents=0", "HEAD")).trim()

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("hands out a clean checkout carrying exactly one commit", async () => {
    await using tmp = await tmpdir({ git: true })

    // A copy whose `.git/index` disagreed with the worktree would report modifications here, which
    // is the failure mode `preserveTimestamps` exists to avoid — and it would be invisible to every
    // other assertion in this file.
    expect((await gitText(tmp.path, "status", "--porcelain")).trim()).toBe("")
    expect((await gitText(tmp.path, "rev-list", "--count", "HEAD")).trim()).toBe("1")
    expect((await gitText(tmp.path, "config", "user.email")).trim()).toBe("test@novaclaw.test")
  })
})

describe("the git fixture template", () => {
  test("is built once per process and reused", async () => {
    // The memo is the whole optimisation: a second call that rebuilt would silently give back the
    // six git processes per site this fixture exists to remove.
    expect(await gitTemplateDir()).toBe(await gitTemplateDir())
  })

  test("carries NO commit, so no copy can inherit an identity", async () => {
    // ⚠️ The load-bearing asymmetry with `packages/core/test/fixture/git.ts`, which DOES commit into
    // its template. `Project.resolve` identifies a remote-less repository by its root-commit SHA, so
    // a committed template would give every fixture directory in this process one project id.
    // `git rev-parse HEAD` on an unborn HEAD exits non-zero — that failure IS the assertion.
    const template = await gitTemplateDir()
    const born = await gitText(template, "rev-parse", "HEAD")
      .then(() => true)
      .catch(() => false)
    expect(born).toBe(false)
  })

  test("gives each provisioned directory its OWN root commit", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })

    const [first, second] = [await rootCommit(one.path), await rootCommit(two.path)]
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    expect(second).toMatch(/^[0-9a-f]{40}$/)
    expect(first).not.toBe(second)
  })

  test("provisions tmpdirScoped through the SAME path as tmpdir", async () => {
    // The two entry points used to hold two hand-written copies of the ritual under a comment asking
    // for them to be kept in sync. They now share `provisionGit`, and this is what that buys: a repo
    // from either one is indistinguishable, including the per-directory identity.
    await using plain = await tmpdir({ git: true })
    const scopedRoot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped({ git: true })
          return yield* Effect.promise(async () => ({
            root: await rootCommit(dir),
            email: (await gitText(dir, "config", "user.email")).trim(),
            fsmonitor: (await gitText(dir, "config", "core.fsmonitor")).trim(),
            status: (await gitText(dir, "status", "--porcelain")).trim(),
          }))
        }),
      ),
    )

    expect(scopedRoot.email).toBe((await gitText(plain.path, "config", "user.email")).trim())
    expect(scopedRoot.fsmonitor).toBe("false")
    expect(scopedRoot.status).toBe("")
    expect(scopedRoot.root).not.toBe(await rootCommit(plain.path))
  })
})
