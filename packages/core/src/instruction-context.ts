export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Schema } from "effect"
import { dirname, isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { ProjectExclusion } from "./project-exclusion"
import { ProjectFileCache } from "./project-file-cache"
import { ProjectFileResolve } from "./project-file"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const projects = yield* ProjectFileCache.Service

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
      // ⚠️ The one AMBIENT ingest of project file text, and it does not go through a tool — so it
      // does not inherit `LocationMutation.resolve`'s exclusion gate and has to ask on its own.
      // Without this, `exclude: ["AGENTS.md"]` would be honoured by every tool and quietly ignored
      // by the path that loads the file into the system prompt on EVERY turn: the loudest possible
      // way for "Never read" to be false.
      //
      // The instance's OWN `AGENTS.md` (under `global.config`) is never screened — it is not in the
      // user's project, and a folder must not be able to silence the instance's own instructions.
      const screened = yield* Effect.forEach(
        [...discovered],
        (candidate) =>
          // ⚠️ The trust root is THIS LOCATION's, not `dirname(candidate)`. Candidates are found by
          // walking, so most of them sit above the selected folder; anchoring the boundary on each
          // candidate's own folder would mean a project file could only ever screen a file sitting
          // directly beside it — including the `stop` root this very walk started from.
          ProjectExclusion.declarationFor(dirname(candidate), ProjectFileResolve.trustedBoundary(location)).pipe(
            Effect.provideService(ProjectFileCache.Service, projects),
            Effect.map((declaration) => {
              if (declaration === undefined) return candidate
              const verdict = ProjectExclusion.screen(declaration, candidate, false)
              return verdict.excluded ? undefined : candidate
            }),
          ),
        { concurrency: "unbounded" },
      )
      for (const candidate of [...discovered]) if (!screened.includes(candidate)) discovered.delete(candidate)
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

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node, ProjectFileCache.node],
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
