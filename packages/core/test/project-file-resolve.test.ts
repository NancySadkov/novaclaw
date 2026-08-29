import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { testEffect } from "./lib/effect"

/**
 * `todo/projects.md`: *"Resolve the nearest valid `novaclaw.json` at or above the session folder as
 * its Project root. A folder without one remains usable but is not silently registered as a
 * Project."*
 *
 * Driven through the injected reader rather than a real tree: every case here is about WHICH file
 * wins and WHERE the walk stops, and a temp directory would add I/O to a question that is entirely
 * about path arithmetic.
 */

const root = path.resolve("/home/me")
const at = (...parts: string[]) => path.join(root, ...parts)
const file = (dir: string) => path.join(dir, "novaclaw.json")

const reader = (files: Record<string, string>) => (candidate: string) => files[path.resolve(candidate)]
const project = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, ...extra })

describe("resolving a project", () => {
  test("finds a file in the folder itself", () => {
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme"), boundary: root },
      reader({ [file(at("work", "acme"))]: project({ name: "Acme" }) }),
    )
    expect(result.kind).toBe("project")
    if (result.kind !== "project") return
    expect(result.root).toBe(at("work", "acme"))
    expect(result.info.name).toBe("Acme")
  })

  test("finds the NEAREST ancestor, not the highest", () => {
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme", "packages", "api"), boundary: root },
      reader({
        [file(at("work", "acme"))]: project({ name: "near" }),
        [file(at("work"))]: project({ name: "far" }),
      }),
    )
    expect(result.kind).toBe("project")
    if (result.kind !== "project") return
    expect(result.info.name).toBe("near")
  })

  test("a folder with no file anywhere above is NOT a project, and that is fine", () => {
    const result = ProjectFileResolve.walk({ from: at("work", "acme"), boundary: root }, reader({}))
    expect(result.kind).toBe("none")
  })

  test("🔴 a MALFORMED file stops the walk instead of falling through to a grandparent", () => {
    // The defect this prevents is silent and confusing: the user edits the file in their own folder,
    // it is broken, and a settings file two directories up quietly governs their session instead —
    // their edit did nothing and said nothing.
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme"), boundary: root },
      reader({
        [file(at("work", "acme"))]: "{ not json",
        [file(at("work"))]: project({ name: "should not win" }),
      }),
    )
    expect(result.kind).toBe("invalid")
    if (result.kind !== "invalid") return
    expect(result.file).toBe(file(at("work", "acme")))
    expect(result.failure).toBe("invalid")
    expect(result.reason).toBe("unreadable")
  })

  test("a FUTURE-version file stops the walk too, and says which failure it was", () => {
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme"), boundary: root },
      reader({ [file(at("work", "acme"))]: JSON.stringify({ version: 9999 }) }),
    )
    expect(result.kind).toBe("invalid")
    if (result.kind !== "invalid") return
    // Upgrade, versus fix the file — the caller must be able to tell a user which one.
    expect(result.failure).toBe("future-version")
    expect(result.reason).toBe("future-version")
  })

  test("🔴 the walk stops AT the boundary and never goes above it", () => {
    // Above home is `C:\Users` or `/`, where a stray file — or another user's — would govern every
    // session on the machine.
    const above = path.dirname(root)
    const result = ProjectFileResolve.walk(
      { from: at("work"), boundary: root },
      reader({ [file(above)]: project({ name: "not yours" }) }),
    )
    expect(result.kind).toBe("none")
  })

  test("a file IN the boundary directory still counts", () => {
    // A user who puts one at `~` meant it; what they cannot have meant is one above `~`.
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme"), boundary: root },
      reader({ [file(root)]: project({ name: "home" }) }),
    )
    expect(result.kind).toBe("project")
    if (result.kind !== "project") return
    expect(result.root).toBe(root)
  })

  test("a start outside the boundary terminates at the filesystem root rather than looping", () => {
    // A session opened on another drive, or anywhere `boundary` is not an ancestor. The walk must
    // still end — `path.dirname` is its own fixed point at a root, and that is the only stop left.
    const elsewhere = path.resolve("/srv/scratch")
    const result = ProjectFileResolve.walk({ from: elsewhere, boundary: root }, reader({}))
    expect(result.kind).toBe("none")
  })

  test("an empty project file is a project — it declares the folder, not its settings", () => {
    const result = ProjectFileResolve.walk(
      { from: at("work", "acme"), boundary: root },
      reader({ [file(at("work", "acme"))]: project() }),
    )
    expect(result.kind).toBe("project")
  })
})

/**
 * The Effect wrapper, against a REAL filesystem.
 *
 * ⚠️ The walk above is pure and thoroughly tested, which says nothing about the function that feeds
 * it — reaching a seam inherits its failures, and `resolve` reads through `readFileStringSafe`,
 * builds its own candidate list, and hands the result to `walk`. Every one of those is a place the
 * tested logic can be fed the wrong thing.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

describe("resolving against the filesystem", () => {
  // `realpathSync` because macOS hands back `/var/...` for a `/private/var/...` temp directory, and
  // the walk compares resolved paths — an unresolved base would never equal the directory the file
  // was actually found in, and the test would fail for a reason that has nothing to do with the code.
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-project-")))

  it.effect("finds a real file from a nested folder", () =>
    Effect.gen(function* () {
      const base = tmp()
      const nested = path.join(base, "packages", "api")
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(base, "novaclaw.json"), JSON.stringify({ version: 1, name: "Real" }))
      const result = yield* ProjectFileResolve.resolve(nested, base)
      expect(result.kind).toBe("project")
      if (result.kind !== "project") return
      expect(result.root).toBe(base)
      expect(result.info.name).toBe("Real")
      fs.rmSync(base, { recursive: true, force: true })
    }),
  )

  it.effect("a real tree with no file is not a project", () =>
    Effect.gen(function* () {
      const base = tmp()
      const result = yield* ProjectFileResolve.resolve(base, base)
      expect(result.kind).toBe("none")
      fs.rmSync(base, { recursive: true, force: true })
    }),
  )

  it.effect("a real MALFORMED file is reported, not walked past", () =>
    Effect.gen(function* () {
      const base = tmp()
      const nested = path.join(base, "child")
      fs.mkdirSync(nested)
      fs.writeFileSync(path.join(base, "novaclaw.json"), JSON.stringify({ version: 1, name: "parent" }))
      fs.writeFileSync(path.join(nested, "novaclaw.json"), "{ broken")
      const result = yield* ProjectFileResolve.resolve(nested, base)
      expect(result.kind).toBe("invalid")
      if (result.kind === "invalid") expect(result.failure).toBe("invalid")
      fs.rmSync(base, { recursive: true, force: true })
    }),
  )

  it.effect("an existing directory in the file's place is UNREADABLE, never absent", () =>
    Effect.gen(function* () {
      const base = tmp()
      fs.mkdirSync(path.join(base, "novaclaw.json"))
      const result = yield* ProjectFileResolve.resolve(base, base)
      expect(result.kind).toBe("invalid")
      if (result.kind !== "invalid") return
      expect(result.failure).toBe("unreadable")
      expect(result.file).toBe(path.join(base, "novaclaw.json"))
      fs.rmSync(base, { recursive: true, force: true })
    }),
  )

  it.effect("a transient filesystem read failure is UNREADABLE and stops at the nearest file", () =>
    Effect.gen(function* () {
      const base = tmp()
      const nested = path.join(base, "child")
      fs.mkdirSync(nested)
      const real = yield* FSUtil.Service
      const nearest = path.join(nested, "novaclaw.json")
      const failing = FSUtil.Service.of({
        ...real,
        readFileStringSafe: (candidate) =>
          candidate === nearest
            ? Effect.fail(
                new FSUtil.FileSystemError({ method: "readFileString", cause: new Error("temporarily locked") }),
              )
            : real.readFileStringSafe(candidate),
      })
      const result = yield* ProjectFileResolve.resolve(nested, base).pipe(
        Effect.provideService(FSUtil.Service, failing),
      )
      expect(result.kind).toBe("invalid")
      if (result.kind !== "invalid") return
      expect(result.failure).toBe("unreadable")
      expect(result.file).toBe(nearest)
      expect(result.detail).toContain("temporarily locked")
      fs.rmSync(base, { recursive: true, force: true })
    }),
  )
})
