import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"

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

const run = <A>(effect: Effect.Effect<A, never, ProjectFileCache.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ProjectFileCache.defaultLayer)))

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
        const before = yield* cache.read(root)
        // A write lands, and nobody tells the cache.
        writeProject(root, "webfetch")
        const after = yield* cache.read(root)
        return { before: firstAction(before), after: firstAction(after) }
      }),
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
        const before = yield* cache.read(root)
        writeProject(root, "webfetch")
        yield* cache.invalidate(root)
        const after = yield* cache.read(root)
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
        const before = yield* cache.read(sub)
        writeProject(root, "webfetch")
        yield* cache.invalidate(root)
        const after = yield* cache.read(sub)
        return { before: firstAction(before), after: firstAction(after) }
      }),
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
        const before = yield* cache.read(sub) // no project anywhere yet
        writeProject(sub, "bash") // a file appears IN the descendant
        yield* cache.invalidate(sub)
        const after = yield* cache.read(sub)
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
        yield* cache.read(legacy)
        writeProject(legacy, "webfetch") // changed on disk, but we invalidate the OTHER folder
        yield* cache.invalidate(app)
        return firstAction(yield* cache.read(legacy))
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
        yield* cache.read(root)
        writeProject(root, "webfetch")
        // Same folder, spelled with forward slashes and a trailing separator.
        yield* cache.invalidate(`${root.replaceAll(path.sep, "/")}/`)
        return firstAction(yield* cache.read(root))
      }),
    )
    expect(seen).toBe("webfetch")
  })
})
