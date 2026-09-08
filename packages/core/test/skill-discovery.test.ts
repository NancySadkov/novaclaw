import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Global } from "@novaclaw/core/global"
import { SkillDiscovery } from "@novaclaw/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"

const base = "https://skills.example.test/catalog/"

async function pull(skills: unknown[], files: Record<string, string> = {}, cache?: Awaited<ReturnType<typeof tmpdir>>) {
  const tmp = cache ?? (await tmpdir())
  const requests: string[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => requests.push(request.url)).pipe(
        Effect.map(() => {
          const body = request.url === `${base}index.json` ? JSON.stringify({ skills }) : files[request.url]
          return HttpClientResponse.fromWeb(
            request,
            new Response(body ?? "Not Found", { status: body === undefined ? 404 : 200 }),
          )
        }),
      ),
    ),
  )
  const skillDiscoveryLayer = AppNodeBuilder.build(SkillDiscovery.node, [
    [LayerNodePlatform.httpClient, http],
    [Global.node, Global.layerWith({ cache: tmp.path })],
  ])
  const directories = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SkillDiscovery.Service).pull(base)
    }).pipe(Effect.provide(skillDiscoveryLayer)),
  )
  return { tmp, requests, directories }
}

describe("SkillDiscovery.pull", () => {
  test("rejects skill name traversal without fetching files", async () => {
    const result = await pull([{ name: "../outside", files: ["SKILL.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects file traversal without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "../outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects absolute file paths without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "/tmp/outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects cross-origin file URLs without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "https://evil.example.test/outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("downloads safe nested files under the skill root", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "references/guide.md"] }], {
      [`${base}deploy/SKILL.md`]: "# Deploy",
      [`${base}deploy/references/guide.md`]: "# Guide",
    })
    try {
      expect(result.directories).toHaveLength(1)
      expect(result.requests.toSorted()).toEqual(
        [`${base}index.json`, `${base}deploy/SKILL.md`, `${base}deploy/references/guide.md`].toSorted(),
      )
      expect(await fs.readFile(path.join(result.directories[0], "SKILL.md"), "utf8")).toBe("# Deploy")
      expect(await fs.readFile(path.join(result.directories[0], "references", "guide.md"), "utf8")).toBe("# Guide")
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("refreshes cached files when the version changes", async () => {
    const tmp = await tmpdir()
    try {
      const first = await pull(
        [{ name: "deploy", version: "1", files: ["SKILL.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# Old",
        },
        tmp,
      )
      const second = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# New",
        },
        tmp,
      )

      expect(await fs.readFile(path.join(first.directories[0], "SKILL.md"), "utf8")).toBe("# New")
      expect(second.requests).toContain(`${base}deploy/SKILL.md`)
      const third = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        { [`${base}deploy/SKILL.md`]: "# Ignored" },
        tmp,
      )
      expect(third.requests).toEqual([`${base}index.json`])
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("publishes complete updates and removes stale files", async () => {
    const tmp = await tmpdir()
    try {
      const first = await pull(
        [{ name: "deploy", version: "1", files: ["SKILL.md", "old.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# Old",
          [`${base}deploy/old.md`]: "old reference",
        },
        tmp,
      )
      const root = first.directories[0]

      await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md", "missing.md"] }],
        { [`${base}deploy/SKILL.md`]: "# Partial" },
        tmp,
      )
      expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("# Old")
      expect(await fs.readFile(path.join(root, "old.md"), "utf8")).toBe("old reference")

      await pull([{ name: "deploy", version: "3", files: ["SKILL.md"] }], { [`${base}deploy/SKILL.md`]: "# New" }, tmp)
      expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("# New")
      expect(await Bun.file(path.join(root, "old.md")).exists()).toBe(false)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})

/**
 * 🔴 VOLUME bounds. The 2026-08-11 audit found `pull`'s PATH posture strong and its volume posture
 * absent: no per-file cap, no file or skill count, no bound on `index.json`, and `transportOnly` pins
 * no digest. A skill source is user-configured, so these are robustness bounds — but "webfetch
 * refuses at 5 MiB and this refuses at nothing" is not a posture.
 */
describe("SkillDiscovery.pull volume bounds", () => {
  test("an oversized index is refused WHOLE, and no file is fetched", async () => {
    // One skill, padded past the 1 MiB index cap by a long (but structurally valid) name.
    const result = await pull([{ name: "x".repeat(1024 * 1024 + 10), files: ["SKILL.md"] }])
    try {
      expect(result.directories).toEqual([])
      // ⚠️ The assertion that matters: the ONLY request was the index. A cap that refused the index
      // but still walked its entries would bound nothing.
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("a skill declaring more files than the cap is DROPPED, and its siblings still install", async () => {
    const many = Array.from({ length: 201 }, (_, i) => (i === 0 ? "SKILL.md" : `asset-${i}.txt`))
    const result = await pull(
      [
        { name: "greedy", files: many },
        { name: "normal", files: ["SKILL.md"] },
      ],
      { [`${base}normal/SKILL.md`]: "# normal" },
    )
    try {
      // Dropped like every other malformed-skill case: one bad entry must not take a legitimate
      // source down with it — which is the opposite call from the index cap above, because there the
      // bad thing IS the source.
      expect(result.directories.map((directory) => path.basename(directory))).toEqual(["normal"])
      expect(result.requests.some((url) => url.includes("greedy"))).toBe(false)
      expect(result.requests).toContain(`${base}normal/SKILL.md`)
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("NEGATIVE CONTROL: an ordinary index and an ordinary skill are untouched by the caps", async () => {
    const result = await pull([{ name: "normal", files: ["SKILL.md", "assets/one.txt"] }], {
      [`${base}normal/SKILL.md`]: "# normal",
      [`${base}normal/assets/one.txt`]: "hello",
    })
    try {
      expect(result.directories.map((directory) => path.basename(directory))).toEqual(["normal"])
      expect(result.requests).toContain(`${base}normal/assets/one.txt`)
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })
})

describe("the cache directory a URL source owns", () => {
  test("🔴 it is computed on a host that does not have the Bun runtime API — the desktop server is NODE", () => {
    /**
     * The desktop server runs as an Electron `utilityProcess`, which is Node: `Bun` is undefined
     * there. `pull` read the bare global to name a source's cache directory, so adding a URL skill
     * source threw a `ReferenceError` out of a call nothing wraps in a `catch` — `SkillV2.load` died
     * and `list()` failed for EVERY source, taking the whole skill index down rather than one.
     *
     * ⚠️ The host is SIMULATED rather than the call site inspected. A test that read the source for
     * `Bun.` would pass against any other digest that still needs a runtime this host does not have;
     * this one runs the function the caller runs, with the API genuinely gone.
     *
     * ⚠️ **The API, not the object** — and the substitution is forced, not a convenience. Under bun
     * `globalThis.Bun` is non-writable AND non-configurable, so it can be neither deleted nor
     * replaced in-process; `Bun.hash` is writable, so that is what is removed. The kind of failure is
     * the same one the desktop hits (the expression throws where it used to answer) and it is proven
     * to bite below rather than assumed — a poison that stopped biting would make this pass for the
     * wrong reason.
     */
    const runtime = globalThis as unknown as { Bun: { hash: unknown } }
    const saved = runtime.Bun.hash
    try {
      runtime.Bun.hash = undefined
      // The poison BITES: the expression this defect was made of no longer works here.
      expect(() => (runtime.Bun.hash as (input: string) => unknown)(base)).toThrow()

      const root = SkillDiscovery.sourceRootFor("C:/cache", base)
      expect(path.dirname(root)).toBe(path.resolve("C:/cache", "skills"))
      // Stable and source-specific: the same base names the same directory, a different base does
      // not — otherwise two sources would install over each other.
      expect(SkillDiscovery.sourceRootFor("C:/cache", base)).toBe(root)
      expect(SkillDiscovery.sourceRootFor("C:/cache", "https://other.example.test/catalog/")).not.toBe(root)
      // A path segment, not a path: a digest carrying a separator would escape the cache root.
      expect(path.basename(root)).not.toContain("/")
      expect(path.basename(root)).not.toContain("\\")
    } finally {
      runtime.Bun.hash = saved
    }
  })

  test("NEGATIVE CONTROL: the same call with `Bun` present answers identically", () => {
    // The digest must not depend on the runtime at all — a host-dependent cache name would relocate
    // every source's directory when the desktop and the CLI disagree.
    expect(SkillDiscovery.sourceRootFor("C:/cache", base)).toBe(SkillDiscovery.sourceRootFor("C:/cache", base))
  })
})
