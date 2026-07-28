import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Auth } from "../../src/auth"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Vcs } from "../../src/project/vcs"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"

// Mirrors `Workspace.defaultLayer`'s provides for the subset these tests need. ⚠️ It builds
// `Workspace.layer` directly, so every requirement `layer` acquires has to be listed HERE too — a
// service added to `Workspace.layer` and provided only in `defaultLayer` fails these suites at
// RUNTIME ("Service not found"), never at compile time. That is how `SessionScheduler` broke them.
export const workspaceLayerWithRuntimeFlags = (overrides: Partial<RuntimeFlags.Info>) =>
  Workspace.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Vcs.defaultLayer),
    // A private ledger: these suites exercise HTTP middleware, not eviction. The shared per-instance
    // scheduler is wired through `Workspace.node`'s deps in the real composition root.
    Layer.provide(SessionScheduler.layer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(RuntimeFlags.layer(overrides)),
    Layer.provide(InstanceStore.defaultLayer),
    Layer.provide(InstanceBootstrap.defaultLayer),
  )
