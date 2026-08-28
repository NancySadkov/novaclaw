export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Layer, Logger, References } from "effect"
import { Logging } from "./observability/logging"

const logs = Logger.layer(Logging.loggers(), {
  mergeWithExisting: false,
}).pipe(
  Layer.provide(NodeFileSystem.layer),
  // ⚠️ NO `Layer.orDie` here, deliberately, and the type is what holds the line: the only
  // failure this composition could ever carry was `Logger.toFile`'s `PlatformError`, and
  // re-adding an `orDie` would be re-arming the boot-killer this line used to be
  // (`notes/reports/startup-classification-2026-08-07.md` §5, finding 2).
  //
  // ⭐ **Phase 2 went one better: there is no longer a failure to absorb.** `Logger.toFile` is
  // gone from the production path — `Logging.fileLoggerOrStderr` builds an
  // `observability/log-file.ts` writer, whose every syscall is inside a `try` and which
  // degrades to stderr instead of failing. So this layer's error channel is not merely emptied
  // by a guard, it is empty because nothing under it can fail — an `orDie` here would have
  // nothing to widen.
  Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
)

// ⭐ **The one line per boot that turns the writer's defaults from a guess into a measurement.**
// It is `Layer.provide(logs)`-ed rather than merged beside them because an `Effect.log*` run during
// layer CONSTRUCTION goes to whatever logger was ambient — i.e. not ours, i.e. not into
// `novaclaw.log`, which is the one place this line is for.
//
// ⚠️ **`logs` therefore appears twice, and the thing that must be true is that it BUILDS once.**
// Two builds would mean two `LogFile.Writer`s on one path — two descriptors, two exit hooks, two
// rotation owners — which is the residual `log-file.ts` names as its worst shared-directory case
// and would be a defect introduced *by* the line that measures the file. Effect's memo map makes
// a layer VALUE build once per build; `logs` is one `const`, referenced twice. That is an inference
// about a library, and `test/log-usage-boot.test.ts` measures it instead: it counts the writers
// actually opened across a real build of this layer, and its negative control passes the same effect
// a SECOND, structurally identical logger layer and watches the count go to 2.
const usage = Layer.effectDiscard(Logging.reportUsage()).pipe(Layer.provide(logs))

export const layer = Layer.merge(logs, usage)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })
