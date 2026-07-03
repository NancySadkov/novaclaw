import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { Snapshot } from "@novaclaw/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ApplicationTools } from "../src/tool/application-tools"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

// B11 — the SHADOW snapshot path: a location that is NOT a git repository still gets
// per-turn snapshots via a shadow repo in the data dir (tracking the location directory),
// so the revert substrate covers any opened folder. Guarded against home/root elsewhere.
describe("Snapshot shadow repo (non-git project)", () => {
  it.live("captures, diffs, and restores in a plain folder", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(dir.path)
          yield* Effect.promise(() => fs.writeFile(path.join(dir.path, "keep.txt"), "original\n"))

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()

            yield* Effect.promise(() => fs.writeFile(path.join(dir.path, "new-file.txt"), "DOOMED"))
            yield* Effect.promise(() => fs.writeFile(path.join(dir.path, "keep.txt"), "changed\n"))
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()

            const changed = yield* snapshot.files({ from: before!, to: after! })
            expect(changed).toContain(RelativePath.make("new-file.txt"))
            expect(changed).toContain(RelativePath.make("keep.txt"))

            // Restore both paths to the BEFORE tree: the new file must vanish,
            // the edited file must return to its original content.
            yield* snapshot.restore({
              files: new Map([
                [RelativePath.make("new-file.txt"), before!],
                [RelativePath.make("keep.txt"), before!],
              ]),
            })
            const gone = yield* Effect.promise(() =>
              fs.readFile(path.join(dir.path, "new-file.txt"), "utf8").then(
                () => false,
                () => true,
              ),
            )
            expect(gone).toBe(true)
            const restored = yield* Effect.promise(() => fs.readFile(path.join(dir.path, "keep.txt"), "utf8"))
            expect(restored).toBe("original\n")
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory }))),
          )
        }),
      ),
    ),
  )
})
