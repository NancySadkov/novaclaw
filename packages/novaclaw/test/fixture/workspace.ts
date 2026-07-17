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

export const workspaceLayerWithRuntimeFlags = (overrides: Partial<RuntimeFlags.Info>) =>
  Workspace.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Vcs.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(RuntimeFlags.layer(overrides)),
    Layer.provide(InstanceStore.defaultLayer),
    Layer.provide(InstanceBootstrap.defaultLayer),
  )
