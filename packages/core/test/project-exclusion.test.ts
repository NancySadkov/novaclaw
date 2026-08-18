import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FileSystem } from "@novaclaw/core/filesystem"
import { Location } from "@novaclaw/core/location"
import { LocationMutation } from "@novaclaw/core/location-mutation"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ProjectExclusion } from "@novaclaw/core/project-exclusion"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { SessionV2 } from "@novaclaw/core/session"
import { GlobTool } from "@novaclaw/core/tool/glob"
import { GrepTool } from "@novaclaw/core/tool/grep"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ReadToolFileSystem } from "@novaclaw/core/tool/read-filesystem"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

/**
 * `todo/projects.md` — **Project exclusions**, the enforcement half.
 *
 * ⚠️ **What was measured before any of this existed (2026-08-18).** With
 * `novaclaw.json` = `{"version":1,"exclude":["secret.txt"]}` beside a `secret.txt`,
 * `LocationMutation.resolve({path:"secret.txt"})` returned a target and
 * `ReadToolFileSystem.read` returned `"SUPER SECRET"` — the exact scenario the Settings page
 * described as *"Never read"*. `exclude` was declared in the schema, displayed in the UI, and
 * consulted by nothing.
 *
 * 🔴 **These tests are written to FAIL when the enforcement is removed, not to describe it.** The
 * repo rule is *"running it beats testing it"* — a test that still passes with the feature deleted
 * is worthless. The A/B for this file: delete the `input.readsContent !== false` block in
 * `location-mutation.ts` and every `refuses` case below must go red. That was run.
 */

/** The real thing: real filesystem, real `ProjectFileCache`, real `LocationMutation`. */
function provide(directory: string) {
  return Effect.provide(
    LayerNode.compile(LayerNode.group([LocationMutation.node, ReadToolFileSystem.node]), [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

const project = (directory: string, exclude: readonly string[]) =>
  Effect.promise(() =>
    fs.writeFile(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 1, exclude }, null, 2)),
  )

const write = (file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })

/**
 * Resolve, and say in one word what happened.
 *
 * ⚠️ NOT `Effect.exit` + property access. An `Exit` on effect@4.0.0-beta.83 carries its `_tag` and
 * `cause` through a `toJSON`, not as own properties (`Object.keys` returns only
 * `~effect/Effect/args`), so `exit._tag === "Failure"` is `undefined === "Failure"` — every
 * assertion reads FALSE while the enforcement is working perfectly. That cost a round here; a
 * word-shaped verdict also makes a failure say which of the three outcomes actually happened
 * instead of `expected true, received false`.
 */
const verdictOf = (input: LocationMutation.ResolveInput) =>
  Effect.gen(function* () {
    const mutation = yield* LocationMutation.Service
    return yield* mutation.resolve(input).pipe(
      Effect.map(() => "allowed" as const),
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof ProjectExclusion.ExcludedError
            ? "excluded"
            : `other-failure:${(error as { _tag?: string })._tag ?? String(error)}`,
        ),
      ),
    )
  })

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. The promise itself, end to end through the real read path.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — the promise", () => {
  it.live("an excluded file is refused, and its bytes never come back", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secret.txt"])
        yield* write(path.join(directory, "secret.txt"), "SUPER SECRET")
        expect(yield* verdictOf({ path: "secret.txt", kind: "directory" })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )

  it.live("a NON-excluded file in the same project still reads fine", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secret.txt"])
        yield* write(path.join(directory, "README.md"), "hello")
        const mutation = yield* LocationMutation.Service
        const reader = yield* ReadToolFileSystem.Service
        const target = yield* mutation.resolve({ path: "README.md", kind: "directory" })
        const content = yield* reader.read(AbsolutePath.make(target.canonical), target.resource)
        expect((content as { content: string }).content).toBe("hello")
      }).pipe(provide(directory)),
    ),
  )

  it.live("a folder with no novaclaw.json is unaffected", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* write(path.join(directory, "secret.txt"), "SUPER SECRET")
        const mutation = yield* LocationMutation.Service
        const reader = yield* ReadToolFileSystem.Service
        const target = yield* mutation.resolve({ path: "secret.txt", kind: "directory" })
        const content = yield* reader.read(AbsolutePath.make(target.canonical), target.resource)
        expect((content as { content: string }).content).toBe("SUPER SECRET")
      }).pipe(provide(directory)),
    ),
  )

  it.live("a project that declares no exclude section excludes nothing", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 1 })),
        )
        yield* write(path.join(directory, "secret.txt"), "x")
        expect(yield* verdictOf({ path: "secret.txt" })).toBe("allowed")
      }).pipe(provide(directory)),
    ),
  )

  it.live("an unparseable novaclaw.json does not silently grant access it cannot read", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        // A malformed file means NO project (the posture `ProjectFileCache` already takes so a
        // broken file cannot take the session down), so it declares no exclusions either. The point
        // of pinning it is that the answer is a DECISION, not an accident of error handling.
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "novaclaw.json"), "{ not json"))
        yield* write(path.join(directory, "secret.txt"), "x")
        expect(yield* verdictOf({ path: "secret.txt" })).toBe("allowed")
      }).pipe(provide(directory)),
    ),
  )
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. Path aliases. This is where the bypasses live, so there is one test per vector.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — path aliases cannot spell their way around it", () => {
  const vectors: ReadonlyArray<{
    readonly name: string
    readonly spell: (directory: string) => string
    readonly skip?: () => boolean
  }> = [
    { name: "the plain relative path", spell: () => path.join("nested", "secret.txt") },
    {
      name: "a `..` traversal that comes back in",
      spell: () => path.join("nested", "..", "nested", ".", "secret.txt"),
    },
    { name: "an absolute path", spell: (d) => path.join(d, "nested", "secret.txt") },
    {
      name: "an absolute path arriving through the parent directory",
      spell: (d) => path.join(d, "..", path.basename(d), "nested", "secret.txt"),
    },
    { name: "forward slashes on a backslash platform", spell: () => "nested/secret.txt" },
    { name: "backslashes on a forward-slash platform", spell: () => "nested\\secret.txt" },
    {
      name: "a different case",
      spell: () => path.join("NESTED", "SECRET.TXT"),
      // Only a bypass where the filesystem folds case; on Linux that is a different file entirely.
      skip: () => process.platform !== "win32" && process.platform !== "darwin",
    },
  ]

  for (const vector of vectors)
    it.live(`refuses ${vector.name}`, () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          if (vector.skip?.()) return
          yield* project(directory, ["nested/secret.txt"])
          yield* write(path.join(directory, "nested", "secret.txt"), "SUPER SECRET")
          expect(yield* verdictOf({ path: vector.spell(directory) })).toBe("excluded")
        }).pipe(provide(directory)),
      ),
    )

  it.live("refuses a symlink inside the project that points at the excluded file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secret.txt"])
        yield* write(path.join(directory, "secret.txt"), "SUPER SECRET")
        const linked = yield* Effect.promise(() =>
          fs
            .symlink(path.join(directory, "secret.txt"), path.join(directory, "innocent.txt"))
            .then(() => true)
            .catch(() => false),
        )
        // Windows needs Developer Mode or elevation for symlinks; a machine without it says so
        // rather than passing vacuously.
        if (!linked) return
        expect(yield* verdictOf({ path: "innocent.txt" })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )

  it.live("refuses a path that reaches the project from OUTSIDE its root", () =>
    withTmp((outside) =>
      Effect.gen(function* () {
        // The session's Location is a sibling directory; the project — and its exclusion — lives
        // somewhere else entirely, and the file is named absolutely. The declaration that binds is
        // the one that CONTAINS the file, not the one governing the session folder.
        const project_ = path.join(outside, "project")
        const session = path.join(outside, "session")
        yield* Effect.promise(() => fs.mkdir(session, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(project_, { recursive: true }))
        yield* project(project_, ["*.env"])
        yield* write(path.join(project_, "prod.env"), "TOKEN=1")
        const verdict = yield* verdictOf({ path: path.join(project_, "prod.env") }).pipe(provide(session))
        expect(verdict).toBe("excluded")
      }),
    ),
  )

  it.live("refuses a file excluded by a NESTED project inside the session folder", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const inner = path.join(directory, "vendor")
        yield* Effect.promise(() => fs.mkdir(inner, { recursive: true }))
        yield* project(directory, [])
        yield* project(inner, ["licence.key"])
        yield* write(path.join(inner, "licence.key"), "KEY")
        expect(yield* verdictOf({ path: path.join("vendor", "licence.key") })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )

  it.live(
    "refuses through a directory exclusion reached by its 8.3 short name where the volume has one",
    () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          if (process.platform !== "win32") return
          yield* project(directory, ["Long Secret Folder/"])
          yield* write(path.join(directory, "Long Secret Folder", "a.txt"), "x")
          // 8.3 generation can be off on a volume; when it is, there is no alias to test and the
          // case SAYS SO rather than passing vacuously. On the machine this was written on it is
          // on, and the alias was `LONGSE~1` — which `fs.realpath` did not expand and
          // `realpathSync.native` did. See `unalias` in `project-exclusion.ts`.
          const short = shortName(directory, "Long Secret Folder")
          if (short === undefined) {
            console.log("[8.3] this volume generates no short names — vector not exercised here")
            return
          }
          console.log(`[8.3] exercising alias ${short} for "Long Secret Folder"`)
          expect(yield* verdictOf({ path: path.join(short, "a.txt") })).toBe("excluded")
        }).pipe(provide(directory)),
      ),
  )

  it.live("refuses an extended-length `\\\\?\\` path naming the excluded file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        yield* project(directory, ["secret.txt"])
        yield* write(path.join(directory, "secret.txt"), "SUPER SECRET")
        expect(yield* verdictOf({ path: `\\\\?\\${path.join(directory, "secret.txt")}` })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )
})

/**
 * The 8.3 alias of `name` inside `parent`, or `undefined` when the volume generates none.
 *
 * ⚠️ The candidate is VERIFIED against the filesystem before it is returned. Parsing `dir /x` and
 * trusting the match produced a phantom alias on this laptop — 8.3 generation is off on modern NTFS
 * volumes, so the column simply is not there — and the test then "failed" on a path that names no
 * file at all. A probe that cannot tell "no alias exists" from "the alias was not caught" is worse
 * than no probe.
 */
function shortName(parent: string, name: string): string | undefined {
  const long = path.join(parent, name)
  let out: string
  try {
    out = Bun.spawnSync(["cmd", "/c", "dir", "/x", "/a", parent]).stdout.toString()
  } catch {
    return undefined
  }
  for (const line of out.split(/\r?\n/)) {
    if (!line.trimEnd().endsWith(name)) continue
    for (const token of line.split(/\s+/)) {
      if (token === name || !/^[A-Z0-9~_]{1,8}(?:\.[A-Z0-9~_]{1,3})?$/u.test(token)) continue
      const candidate = path.join(parent, token)
      try {
        if (fsSync.realpathSync.native(candidate) === fsSync.realpathSync.native(long)) return token
      } catch {
        /* not a real alias */
      }
    }
  }
  return undefined
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. Read eligibility is not a write ban.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — read eligibility, distinctly", () => {
  it.live("a pure write to an excluded path is NOT refused", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["*.env"])
        expect(yield* verdictOf({ path: "new.env", kind: "file", readsContent: false })).toBe("allowed")
      }).pipe(provide(directory)),
    ),
  )

  it.live("…but the default is to refuse, so a tool that forgets to classify itself fails closed", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["*.env"])
        expect(yield* verdictOf({ path: "new.env", kind: "file" })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )

  it.live("an excluded path that does not exist yet is still refused", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secrets/"])
        expect(yield* verdictOf({ path: path.join("secrets", "not-created-yet.txt") })).toBe("excluded")
      }).pipe(provide(directory)),
    ),
  )
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. The refusal has to be legible, and it has to reach the model.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — the refusal is legible", () => {
  it.live("names the exclusion, the pattern, and the file that declared it", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["*.env"])
        yield* write(path.join(directory, "prod.env"), "TOKEN=1")
        const mutation = yield* LocationMutation.Service
        const error = yield* Effect.flip(mutation.resolve({ path: "prod.env" }))
        const message = (error as ProjectExclusion.ExcludedError).message
        expect(message).toContain("project exclusion")
        expect(message).toContain("`*.env`")
        expect(message).toContain("novaclaw.json")
        expect(message).toContain("prod.env")
        // Not a lie, and not a dead end: it must not read as "missing".
        expect(message.toLowerCase()).not.toContain("not found")
        expect(message.toLowerCase()).not.toContain("no such file")
        // It has to tell the reader the way out, or the agent retries forever.
        expect(message).toContain("Never read")
      }).pipe(provide(directory)),
    ),
  )

  test("every tool's blanket absorber lowers it, because denialMessage does", () => {
    const error = new ProjectExclusion.ExcludedError({
      resource: "prod.env",
      pattern: "*.env",
      file: "/p/novaclaw.json",
    })
    // 🔴 This is the whole legibility mechanism. Each tool's `mapError` already calls
    // `PermissionV2.denialMessage(error)` FIRST; routing the exclusion through it is what gives
    // `read`, `edit`, `glob`, `grep`, `apply_patch`, `trash`, the hex pair and `bash` a truthful
    // refusal without a line added to any of them. Delete the delegation in `permission.ts` and
    // this fails — and so does every tool's message, silently, which is why it is pinned here.
    expect(PermissionV2.denialMessage(error)).toBe(error.message)
    expect(PermissionV2.denialMessage(new Error("something else"))).toBeUndefined()
  })

  test("every path-taking tool routes its errors through that absorber", () => {
    // The structural half: legibility is inherited only for tools that use the shared absorber, so
    // a new one that does not is caught HERE rather than by a user reading "Unable to read x".
    const dir = path.join(import.meta.dir, "..", "src", "tool")
    const offenders: string[] = []
    for (const entry of fsSync.readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
      const text = fsSync.readFileSync(path.join(dir, entry), "utf8")
      if (!text.includes("mutation.resolve")) continue
      if (!text.includes("denialMessage")) offenders.push(entry)
    }
    expect(offenders).toEqual(["kb.ts"])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. Pattern semantics — the decision, pinned.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — gitignore-style semantics", () => {
  const check = (patterns: readonly string[], target: string, isDirectory = false) =>
    ProjectExclusion.evaluate(ProjectExclusion.compile(patterns), target, isDirectory).excluded

  test("a bare name matches at any depth", () => {
    expect(check(["secret.txt"], "secret.txt")).toBe(true)
    expect(check(["secret.txt"], "a/b/secret.txt")).toBe(true)
    expect(check(["*.env"], "config/prod.env")).toBe(true)
  })

  test("a pattern containing a slash is anchored to the project root", () => {
    expect(check(["build/out"], "build/out")).toBe(true)
    expect(check(["build/out"], "packages/build/out")).toBe(false)
    expect(check(["/secrets"], "secrets/key")).toBe(true)
    expect(check(["/secrets"], "a/secrets/key")).toBe(false)
  })

  test("excluding a directory excludes everything beneath it", () => {
    expect(check(["secrets"], "secrets/keys/id_rsa")).toBe(true)
    expect(check(["secrets"], "secrets", true)).toBe(true)
  })

  test("a trailing slash is directory-only", () => {
    expect(check(["logs/"], "logs", false)).toBe(false)
    expect(check(["logs/"], "logs", true)).toBe(true)
    expect(check(["logs/"], "logs/today.txt")).toBe(true)
  })

  test("`!` re-includes and the LAST matching pattern wins", () => {
    expect(check(["*.env", "!.env.example"], ".env.example")).toBe(false)
    expect(check(["*.env", "!.env.example"], "prod.env")).toBe(true)
    expect(check(["!secret.txt", "secret.txt"], "secret.txt")).toBe(true)
  })

  test("dotfiles match — a privacy list that could not name .env would be useless", () => {
    expect(check([".env"], ".env")).toBe(true)
    expect(check(["**/.ssh/**"], ".ssh/id_rsa")).toBe(true)
  })

  test("blank lines and # comments are ignored", () => {
    expect(check(["", "   ", "# a comment", "secret.txt"], "secret.txt")).toBe(true)
    expect(check(["# secret.txt"], "secret.txt")).toBe(false)
  })

  test("a backslash is a separator, not an escape — this file is edited on Windows", () => {
    expect(check(["build\\out"], "build/out")).toBe(true)
  })

  test("a pattern cannot address outside the root it is relative to", () => {
    expect(check(["../outside"], "outside")).toBe(false)
    expect(check(["../../etc/passwd"], "etc/passwd")).toBe(false)
  })

  test("case sensitivity follows the platform's filesystem, not git", () => {
    const folded = process.platform === "win32" || process.platform === "darwin"
    expect(check(["secrets/"], "SECRETS", true)).toBe(folded)
    expect(check(["*.env"], "PROD.ENV")).toBe(folded)
  })

  test("relativeWithin refuses a path that is not inside the root", () => {
    const root = path.resolve(path.sep, "p")
    expect(ProjectExclusion.relativeWithin(root, path.join(root, "a", "b.txt"))).toBe("a/b.txt")
    expect(ProjectExclusion.relativeWithin(root, path.resolve(path.sep, "q", "b.txt"))).toBeUndefined()
  })

  test("screenAll drops excluded rows and counts what it withheld", () => {
    const declaration: ProjectExclusion.Declaration = {
      root: path.resolve(path.sep, "p"),
      file: path.resolve(path.sep, "p", "novaclaw.json"),
      patterns: ["secrets"],
      matcher: ProjectExclusion.compile(["secrets"]),
    }
    const rows = ["a.txt", "secrets/key", "b.txt"].map((rel) => path.join(declaration.root, rel))
    const result = ProjectExclusion.screenAll(declaration, rows, (row) => row)
    expect(result.kept).toHaveLength(2)
    expect(result.withheld).toBe(1)
    expect(ProjectExclusion.screenAll(undefined, rows, (row) => row).kept).toHaveLength(3)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 6. Distinct from the watcher/build ignore list — `todo/projects.md` requires it and they drift.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — distinct from watcher/build ignores", () => {
  test("nothing in the exclusion path consults filesystem/ignore.ts", () => {
    const text = fsSync.readFileSync(path.join(import.meta.dir, "..", "src", "project-exclusion.ts"), "utf8")
    expect(text).not.toContain('from "./filesystem/ignore"')
    expect(text).not.toContain("Ignore.match")
    expect(text).not.toContain("Ignore.PATTERNS")
  })

  test("a folder the watcher ignores is still readable unless the project says otherwise", () =>
    // `node_modules` is in `Ignore.FOLDERS`. That is a performance judgement about watching and
    // indexing; it must not become a privacy verdict, or the two lists would answer for each other
    // and a build-ignore tweak would silently change what Nova may see.
    expect(ProjectExclusion.evaluate(ProjectExclusion.compile([]), "node_modules/pkg/index.js", false).excluded).toBe(
      false,
    ))
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 7. The SECOND seam: the two tools that enumerate instead of naming.
//
// `LocationMutation.resolve` speaks for a search ROOT, never for the rows underneath it, so glob
// and grep would happily list — and, for grep, QUOTE — every excluded file. The tools run here for
// real (real `LocationMutation`, real project file); only ripgrep is stubbed, so the rows are known
// and the assertion is about what the tool did with them, not about ripgrep.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe("project exclusions — glob and grep filter their rows", () => {
  const rows = ["README.md", "secrets/key.pem", "src/app.ts"]

  const ripgrepStub = Layer.succeed(
    Ripgrep.Service,
    Ripgrep.Service.of({
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed(rows.map((p) => FileSystem.Entry.make({ path: RelativePath.make(p), type: "file" }))),
      grep: () =>
        Effect.succeed(
          rows.map((p) =>
            FileSystem.Match.make({
              entry: FileSystem.Entry.make({ path: RelativePath.make(p), type: "file" }),
              line: 1,
              offset: 0,
              text: `TOKEN inside ${p}`,
              submatches: [],
            }),
          ),
        ),
    }),
  )

  const permissionStub = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.void,
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )

  const runTool = (directory: string, tool: "glob" | "grep") =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      return yield* executeTool(registry, {
        sessionID: SessionV2.ID.make("ses_exclusion_search"),
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${tool}`, name: tool, input: { pattern: tool === "glob" ? "**/*" : "TOKEN" } },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]),
          [
            [PermissionV2.node, permissionStub],
            [Ripgrep.node, ripgrepStub],
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ],
          ],
        ),
      ),
    )

  it.live("glob does not list a file the project excluded", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secrets/"])
        const result = yield* runTool(directory, "glob")
        const text = JSON.stringify(result)
        expect(text).toContain("README.md")
        expect(text).toContain("app.ts")
        expect(text).not.toContain("key.pem")
      }),
    ),
  )

  it.live("grep does not quote a LINE from a file the project excluded", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, ["secrets/"])
        const result = yield* runTool(directory, "grep")
        const text = JSON.stringify(result)
        expect(text).toContain("TOKEN inside README.md")
        expect(text).not.toContain("key.pem")
      }),
    ),
  )

  it.live("…and both still return everything when the project excludes nothing", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* project(directory, [])
        expect(JSON.stringify(yield* runTool(directory, "glob"))).toContain("key.pem")
        expect(JSON.stringify(yield* runTool(directory, "grep"))).toContain("key.pem")
      }),
    ),
  )
})
