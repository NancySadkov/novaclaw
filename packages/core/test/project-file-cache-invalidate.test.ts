import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectV2 } from "@novaclaw/core/project"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { AbsolutePath } from "@novaclaw/core/schema"

/**
 * ─── the cache must not serve the file WE just replaced ──────────────────────────────────────────
 *
 * `ProjectFileCache` holds a folder's `novaclaw.json` for a 1 s freshness bound, and that bound is
 * deliberate: it is a hedge against an edit made OUTSIDE the app, which we cannot see coming. Our own
 * write is different — we know the exact moment it landed — and waiting the window out means a turn
 * started inside it runs against the previous file. That is the *"half by what its owner just wrote,
 * half by what it used to say"* stance this module's own header rejects.
 *
 * ⚠️ **Nothing here touches time, and that is on purpose.** The TTL reads wall clock (deliberately —
 * see the module header), so a TTL test would have to sleep or freeze a clock the code does not
 * consult. Invalidation needs neither: write, read, change the file, invalidate, read again. The
 * assertion is that the second read differs, which is only possible if the entry was actually dropped.
 */

const repositoryLayer = (root: string) =>
  Layer.succeed(
    ProjectV2.Service,
    ProjectV2.Service.of({
      resolve: () =>
        Effect.succeed({
          id: ProjectV2.ID.global,
          directory: AbsolutePath.make(root),
          vcs: { type: "git" as const, store: AbsolutePath.make(path.join(root, ".git")) },
        }),
    }),
  )

const cacheLayer = (root?: string) =>
  root === undefined
    ? ProjectFileCache.defaultLayer
    : ProjectFileCache.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(repositoryLayer(root)))

const run = <A>(effect: Effect.Effect<A, never, ProjectFileCache.Service>, repositoryRoot?: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(cacheLayer(repositoryRoot))))

const tempRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pfc-")))

const writeProject = (directory: string, rule: string) =>
  fs.writeFileSync(
    path.join(directory, "novaclaw.json"),
    JSON.stringify({ version: 1, permissions: [{ action: rule, resource: "*", effect: "deny" }] }),
    { encoding: "utf8" },
  )

const firstAction = (entry: ProjectFileCache.Entry) => entry.rules[0]?.action

describe("ProjectFileCache.invalidate", () => {
  test("without invalidation the cache serves the OLD file — the defect this closes", async () => {
    const root = tempRoot()
    writeProject(root, "bash")
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        const before = yield* cache.read(root, root)
        // A write lands, and nobody tells the cache.
        writeProject(root, "webfetch")
        const after = yield* cache.read(root, root)
        return { before: firstAction(before), after: firstAction(after) }
      }),
      root,
    )
    expect(seen.before).toBe("bash")
    // Stale ON PURPOSE in this case: it proves the cache is real, so the next test is not vacuous.
    expect(seen.after).toBe("bash")
  })

  test("after invalidate, the very next read sees the new file", async () => {
    const root = tempRoot()
    writeProject(root, "bash")
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        const before = yield* cache.read(root, root)
        writeProject(root, "webfetch")
        yield* cache.invalidate(root)
        const after = yield* cache.read(root, root)
        return { before: firstAction(before), after: firstAction(after) }
      }),
    )
    expect(seen.before).toBe("bash")
    expect(seen.after).toBe("webfetch")
  })

  test("🔴 a DESCENDANT's entry is dropped too — the resolver walks upward", async () => {
    // The subtle half. Entries are keyed by the directory a caller ASKED about, so a session in
    // `<root>/sub` holds an entry produced by `<root>/novaclaw.json` under the key `<root>/sub`.
    // Invalidating only the written directory leaves that one serving the previous file.
    const root = tempRoot()
    const sub = path.join(root, "sub", "deeper")
    fs.mkdirSync(sub, { recursive: true })
    writeProject(root, "bash")
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        const before = yield* cache.read(sub, sub)
        writeProject(root, "webfetch")
        yield* cache.invalidate(root)
        const after = yield* cache.read(sub, sub)
        return { before: firstAction(before), after: firstAction(after) }
      }),
      root,
    )
    expect(seen.before).toBe("bash")
    expect(seen.after).toBe("webfetch")
  })

  test("🔴 a NEW file steals governance from a descendant that had none of its own", async () => {
    // Matching cached entries by the written file's PATH would miss this one: the descendant's entry
    // names the ancestor's file, or no file at all, so the created file appears in neither.
    const root = tempRoot()
    const sub = path.join(root, "sub")
    fs.mkdirSync(sub, { recursive: true })
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        const before = yield* cache.read(sub, sub) // no project anywhere yet
        writeProject(sub, "bash") // a file appears IN the descendant
        yield* cache.invalidate(sub)
        const after = yield* cache.read(sub, sub)
        return { before: before.rules.length, after: firstAction(after) }
      }),
    )
    expect(seen.before).toBe(0)
    expect(seen.after).toBe("bash")
  })

  test("a SIBLING sharing a name prefix is NOT cleared", async () => {
    // `startsWith(target)` without a separator would clear `<root>/app-legacy` when `<root>/app` was
    // written — a different folder, and its cached read is still perfectly good.
    const root = tempRoot()
    const app = path.join(root, "app")
    const legacy = path.join(root, "app-legacy")
    fs.mkdirSync(app)
    fs.mkdirSync(legacy)
    writeProject(app, "bash")
    writeProject(legacy, "bash")
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        yield* cache.read(legacy, legacy)
        writeProject(legacy, "webfetch") // changed on disk, but we invalidate the OTHER folder
        yield* cache.invalidate(app)
        return firstAction(yield* cache.read(legacy, legacy))
      }),
    )
    // Still the cached value: the sibling was left alone, which is the point.
    expect(seen).toBe("bash")
  })

  test("a differently SPELLED path still invalidates — keys are stored as callers passed them", async () => {
    // One caller arrives from the browser's session record and another from the server's own
    // `path.resolve`, so `C:\a\b`, `C:/a/b` and a trailing slash are three keys for one folder.
    const root = tempRoot()
    writeProject(root, "bash")
    const seen = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        yield* cache.read(root, root)
        writeProject(root, "webfetch")
        // Same folder, spelled with forward slashes and a trailing separator.
        yield* cache.invalidate(`${root.replaceAll(path.sep, "/")}/`)
        return firstAction(yield* cache.read(root, root))
      }),
    )
    expect(seen).toBe("webfetch")
  })
})

// ⚠️ Every `read` here passes the folder as its OWN boundary, which is what a session rooted in that
// folder does (`ProjectFileCache.localLayer`). The second argument is the caller's trusted root: the
// resolver may climb from the first argument up to it, and inside a repository the worktree widens it
// further. Passing the same value twice is therefore the *tightest* thing a caller can ask for, and
// the containment cases below are exactly the ones where nothing widens it.
describe("ProjectFileCache containment", () => {
  test("the shared cache uses the resolved repository worktree as its one trusted ancestor", async () => {
    const root = tempRoot()
    const nested = path.join(root, "packages", "core")
    fs.mkdirSync(nested, { recursive: true })
    writeProject(root, "bash")
    const entry = await run(Effect.flatMap(ProjectFileCache.Service, (cache) => cache.read(nested, nested)), root)
    expect(entry.kind).toBe("project")
    expect(firstAction(entry)).toBe("bash")
  })

  // 🔴 **This replaced two tests that asserted the OPPOSITE, and the replacement is the point.**
  // They read "a non-repository location does not inherit a %s file from an untrusted parent" and
  // expected `none`. They arrived with `trustedBoundary`, pinning a boundary of "the selected folder"
  // — which does not tighten the feature but switches it off, because a project file exists to govern
  // the folders BENEATH it. Three pre-existing tests across two units say so, including the
  // HTTP-level `httpapi-project-write-invalidates.test.ts`. A guard added in the same change as the
  // behaviour it guards cannot referee that behaviour.
  //
  // What is actually true, and now asserted: outside a repository the walk climbs to HOME, because
  // what must never be inherited is a file ABOVE home — where one `novaclaw.json` would govern every
  // session on the machine.
  test("a non-repository location DOES inherit from a parent, which is what a project file is for", async () => {
    const parent = tempRoot()
    const selected = path.join(parent, "selected")
    fs.mkdirSync(selected)
    writeProject(parent, "bash")
    const entry = await run(Effect.flatMap(ProjectFileCache.Service, (cache) => cache.read(selected, selected)))
    expect(entry.kind).toBe("project")
    expect(firstAction(entry)).toBe("bash")
  })

  test("a malformed file in that parent is inherited as a FAULT, not flattened to none", async () => {
    const parent = tempRoot()
    const selected = path.join(parent, "selected")
    fs.mkdirSync(selected)
    fs.writeFileSync(path.join(parent, "novaclaw.json"), "{ broken")
    const entry = await run(Effect.flatMap(ProjectFileCache.Service, (cache) => cache.read(selected, selected)))
    // Ruling 2's shape: a file we could not read is reported, never silently treated as absent.
    expect(entry.kind).toBe("invalid")
  })

  test("🔴 the walk stops AT the boundary — a file above it is never seen", () => {
    // Driven through `walk` directly with injected reads, because the real containment claim is about
    // a path above HOME and no test may write there. `read` answers for every ancestor, so only the
    // boundary stops the climb; if it did not, this would find the file at the volume root.
    const asked: string[] = []
    const resolution = ProjectFileResolve.walk(
      { from: path.join("C:", "home", "me", "project", "sub"), boundary: path.join("C:", "home", "me", "project") },
      (file) => {
        asked.push(file)
        return JSON.stringify({ version: 1, permissions: [{ action: "bash", resource: "*", effect: "deny" }] })
      },
    )
    expect(resolution.kind).toBe("project")
    // It found the NEAREST file and never asked above the boundary.
    expect(asked.some((file) => file.includes(path.join("me", "project", "sub")))).toBe(true)
    expect(asked.some((file) => file === path.join("C:", "novaclaw.json"))).toBe(false)
    expect(asked.some((file) => file === path.join("C:", "home", "novaclaw.json"))).toBe(false)
  })
})

describe("ProjectFileCache project-file states", () => {
  test("only a genuinely absent file is `none`", async () => {
    const root = tempRoot()
    const entry = await run(Effect.flatMap(ProjectFileCache.Service, (cache) => cache.read(root, root)))
    expect(entry.kind).toBe("none")
    expect(ProjectFileCache.fault(entry)).toBeUndefined()
  })

  test("malformed and future-version files remain distinct cached faults", async () => {
    const malformed = tempRoot()
    fs.writeFileSync(path.join(malformed, "novaclaw.json"), "{ not json")
    const future = tempRoot()
    fs.writeFileSync(path.join(future, "novaclaw.json"), JSON.stringify({ version: 9999 }))

    const entries = await run(
      Effect.gen(function* () {
        const cache = yield* ProjectFileCache.Service
        return [yield* cache.read(malformed, malformed), yield* cache.read(future, future)] as const
      }),
    )
    expect(entries[0].kind).toBe("invalid")
    expect(entries[1].kind).toBe("future-version")
    expect(ProjectFileCache.refusal(ProjectFileCache.fault(entries[0])!)).toContain("Fix the project file")
    expect(ProjectFileCache.refusal(ProjectFileCache.fault(entries[1])!)).toContain("Upgrade NovaClaw")
  })

  test("an existing unreadable path is cached as `unreadable`, not flattened to `none`", async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, "novaclaw.json"))
    const entry = await run(Effect.flatMap(ProjectFileCache.Service, (cache) => cache.read(root, root)))
    expect(entry.kind).toBe("unreadable")
    const fault = ProjectFileCache.fault(entry)!
    expect(fault.file).toBe(path.join(root, "novaclaw.json"))
    expect(ProjectFileCache.refusal(fault)).toContain("restore read access")
  })
})
