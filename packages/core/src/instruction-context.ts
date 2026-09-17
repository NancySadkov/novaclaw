export * as InstructionContext from "./instruction-context"

import { Array, Context, Effect, Layer, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { AgentV2 } from "./agent"
import { SystemContext } from "./system-context/index"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
/**
 * Exported so the runner can name this source when deciding whether the established context baseline
 * still matches the settings: turning the opt-in off must REBUILD the baseline, not merely append a
 * "no longer apply" notice under a system prompt that still contains the file (owner, 2026-09-17).
 */
export const KEY = SystemContext.Key.make("core/instructions")
const key = KEY

/**
 * Ambient project instructions (AGENTS.md), as an opt-in source a turn can decline.
 *
 * 🔴 **Owner, 2026-09-17: the auto-embed was unconditional and that is the defect.** Every discovered
 * `AGENTS.md` — the instance's `config/AGENTS.md` plus the whole upward walk from the working folder —
 * was folded into the system baseline for every session, with no way for an officer to decline. In this
 * very repo that file has been tens of kilobytes, so an officer whose job has nothing to do with the
 * code paid for all of it on every turn. `AgentV2.Info.instructions` is now the per-agent switch, and
 * the DEFAULT is OFF: a colleague loads project instructions only when its role opts in.
 *
 * ⚠️ **The default is deliberately the quiet one.** Principle 12(a) says work by default, and it would
 * point at ON — but the thing being defaulted here is bytes on every turn, and the owner's word for
 * this change is "opt-in". So the switch is discoverable (officer Settings) rather than the behaviour
 * being a surprise; the seeded Engineer opts IN, because coding is exactly the role the file is for.
 *
 * ⚠️ It is a SERVICE with a per-turn `load(agent)`, mirroring `SkillGuidance`, NOT a registry entry.
 * The setting lives on the agent and the registry is location-scoped, so a registry-registered source
 * could not read it. `loadSystemContext` is the one place that knows both, and it combines this with
 * the other per-agent sources.
 */
export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/InstructionContext") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: instructionUpdate,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = FSUtil.resolve(location.directory)
      const stop = FSUtil.resolve(location.root)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        (Flag.NOVACLAW_DISABLE_PROJECT_CONFIG || !insideProject
          ? []
          : yield* fs.up({
              targets: ["AGENTS.md"],
              start,
              stop,
            })
        ).map(FSUtil.resolve),
      )
      // 🔴 The exclusion screening that used to sit here is GONE with the `novaclaw.json` mechanism
      // (owner, 2026-09-16: *"We have retired the entire novaclaw.json mechanism and everything
      // related to it. Please ensure it is gone for good."*). What it did, recorded because the loss
      // is a capability and not a surface: this was the ONLY path that screened the ambient
      // `AGENTS.md` files against a folder's `exclude` list, and it is the one ingest that does not go
      // through a tool — so `exclude: ["AGENTS.md"]` was honoured by every tool and enforced here. With
      // the file gone there is no list to enforce, so every discovered `AGENTS.md` loads.
      const paths = Array.dedupe([FSUtil.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      return files.filter((file): file is File => file !== undefined)
    })

    return Service.of({
      load: Effect.fn("InstructionContext.load")(function* (selection) {
        // Opt-in: absent (and `false`) load nothing at all. An officer that never asked for the
        // working folder's rules is not handed them.
        if (selection.info?.instructions !== true) return SystemContext.empty
        const loaded = yield* observe().pipe(
          Effect.map((files) =>
            files === SystemContext.unavailable
              ? source(files)
              : files.length === 0
                ? SystemContext.empty
                : source(files),
          ),
          Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
          Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
        )
        return loaded
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node],
})

/**
 * The instruction update, as a DIFF over FILES rather than a full re-render (CACHE-005).
 *
 * 🔴 This re-rendered EVERY loaded instruction file whenever ANY of them changed, into the durable
 * transcript. In this repo `core/instructions` measures **45,644 characters** (read from a live
 * session epoch), so one edit to one AGENTS.md deposited all of it again - permanently, and
 * re-summarised by every later compaction.
 *
 * ⚠️ It is a TAIL update, so it does NOT invalidate the prefix cache. The cost is transcript bloat
 * and a model re-reading instructions it already holds - the same shape as CACHE-004.
 *
 * ⚠️ **A file that DISAPPEARS must be reported.** Emitting only "what is new" would leave the model
 * obeying instructions from a file deleted or moved out of scope - the failure the `removed` hook
 * exists to prevent for the whole set, applied per file.
 *
 * ⚠️ Exported as a SEAM: a pure function over two file lists. Reaching it through
 * `SystemContext.reconcile` would need a registry, an epoch and a store to read one string back.
 */
export const instructionUpdate = (previous: ReadonlyArray<File>, current: ReadonlyArray<File>): string => {
  const before = new Map(previous.map((file) => [file.path, file.content]))
  const after = new Map(current.map((file) => [file.path, file.content]))
  const changed = current.filter((file) => before.get(file.path) !== file.content)
  const gone = previous.filter((file) => !after.has(file.path))
  // Nothing attributable to a file (ordering churn alone): fall back to the whole render rather
  // than emitting an empty notice.
  if (changed.length === 0 && gone.length === 0)
    return `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`
  return [
    "These instructions have changed. Everything not mentioned here is unchanged and still applies.",
    ...changed.map((file) => `\nInstructions from: ${file.path}\n${file.content}`),
    ...gone.map((file) => `\nNo longer loaded: ${file.path}`),
  ].join("\n")
}

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
