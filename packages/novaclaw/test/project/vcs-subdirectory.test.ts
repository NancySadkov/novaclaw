import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

/**
 * 🔴 **A session opened BELOW the repository root must report the same changes as one opened at the
 * root.**
 *
 * `git status --porcelain -z -- .` and `git diff --name-status -z <ref> -- .` scope themselves to the
 * cwd's subtree but print the names they find **relative to the repository root** — verified against a
 * throwaway repository: run from `<repo>/sub`, both return `sub/tracked.txt`, not `tracked.txt`. Every
 * per-file call that takes one of those names back (`git diff --no-index -- /dev/null <file>`, and the
 * pathspec form of `git diff <ref> -- <file>`) therefore has to run at the ROOT. Run at the session
 * subdirectory instead, git resolves `sub/added.txt` against `<repo>/sub`, finds nothing, and the file
 * lands in the Changes panel with 0 additions, 0 deletions and no patch at all.
 *
 * ⚠️ **The untracked file is the assertion that bites.** A tracked file is masked: its line counts
 * come from the batched `--numstat` listing and its patch from the batched `diff … -- .`, both of
 * which are listings and both of which are correct at either cwd. Only the per-file calls are wrong,
 * and untracked files are the ones that have no batched answer to fall back on.
 */
const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsSubdirTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((service) => service.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsSubdirTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const seed = Effect.fn("VcsSubdirTest.seed")(function* () {
  const root = yield* tmpdirScoped({ git: true })
  const sub = path.join(root, "sub")

  yield* write(path.join(sub, "tracked.txt"), "base\n")
  yield* git(root, ["add", "--all"])
  yield* git(root, ["commit", "-m", "seed"])

  yield* write(path.join(sub, "tracked.txt"), "base\nchanged\n")
  yield* write(path.join(sub, "added.txt"), "brand new\n")

  return { root, sub }
})

const byFile = (list: readonly Vcs.FileDiff[]) => new Map(list.map((item) => [item.file, item] as const))

describe("Vcs below the repository root", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.live("an untracked file diffs and counts its lines from a session in a subdirectory", () =>
    Effect.gen(function* () {
      const { sub } = yield* seed()

      const files = byFile(yield* Vcs.Service.use((vcs) => vcs.diff("git")).pipe(provideInstance(sub)))

      const added = files.get("sub/added.txt")
      expect(added).toBeDefined()
      if (!added) throw new Error("the untracked file was not listed at all")
      expect(added.additions).toBe(1)
      expect(added.deletions).toBe(0)
      expect(added.patchUnavailableReason).toBeUndefined()
      expect(added.patch ?? "").toContain("brand new")
    }),
  )

  it.live("reports exactly what the same repository reports from a session at the root (control)", () =>
    Effect.gen(function* () {
      const { root, sub } = yield* seed()

      const fromRoot = byFile(yield* Vcs.Service.use((vcs) => vcs.diff("git")).pipe(provideInstance(root)))
      const fromSub = byFile(yield* Vcs.Service.use((vcs) => vcs.diff("git")).pipe(provideInstance(sub)))

      // Both files live under `sub`, so the subtree scope selects the same set at either cwd — which
      // is what makes the LINE COUNTS the only thing that can differ between the two readings.
      expect([...fromSub.keys()].toSorted()).toEqual(["sub/added.txt", "sub/tracked.txt"])
      expect([...fromRoot.keys()].toSorted()).toEqual(["sub/added.txt", "sub/tracked.txt"])

      for (const file of ["sub/added.txt", "sub/tracked.txt"]) {
        const root_ = fromRoot.get(file)
        const sub_ = fromSub.get(file)
        if (!root_ || !sub_) throw new Error(`missing ${file} in one of the two readings`)
        expect({ file, additions: sub_.additions, deletions: sub_.deletions }).toEqual({
          file,
          additions: root_.additions,
          deletions: root_.deletions,
        })
        expect(sub_.patchUnavailableReason).toBe(root_.patchUnavailableReason)
      }
    }),
  )

  it.live("diffRaw() emits the untracked file's contents from a subdirectory session", () =>
    Effect.gen(function* () {
      const { sub } = yield* seed()

      const raw = yield* Vcs.Service.use((vcs) => vcs.diffRaw()).pipe(provideInstance(sub))

      expect(raw).toContain("brand new")
    }),
  )
})
