import { Layer, ManagedRuntime } from "effect"

import { Plugin } from "@/plugin"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Snapshot } from "@/snapshot"
import { Config } from "@/config/config"
import * as Observability from "@novaclaw/core/observability"
import { memoMap } from "@novaclaw/core/effect/memo-map"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Plugin.defaultLayer,
  Format.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
).pipe(Layer.provide(Observability.layer))

export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer, { memoMap })
