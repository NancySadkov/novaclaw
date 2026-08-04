import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { FSUtil } from "@novaclaw/core/fs-util"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { Auth } from "../../src/auth"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Vcs } from "../../src/project/vcs"

/**
 * THE ONE hand-maintained mirror of `Workspace.layer`'s requirements in the test tree.
 *
 * ⚠️ This builds `Workspace.layer`, not `Workspace.defaultLayer` — so every service the layer acquires
 * has to be listed BELOW as well. A requirement added to `Workspace.layer` and provided only in
 * `defaultLayer` fails here at RUNTIME ("Service not found"), never at compile time. That is exactly
 * how `SessionScheduler` broke 17 tests across three suites (v0.2.0 PREP, Wave 1).
 *
 * There used to be a SECOND copy of this list in `test/plugin/workspace-adapter.test.ts`, differing
 * only in its RuntimeFlags overrides. It is gone: that suite calls this helper. Deleting a mirror beats
 * guarding one, and `test/control-plane/workspace-layer-mirrors.test.ts` fails if a new hand assembly
 * of `Workspace.layer` appears anywhere under `test/`.
 *
 * The mechanical half of the fix is that same guard: it reads `Workspace.layer`'s prologue off disk and
 * fails when this list drifts from it in EITHER direction — a missing provide, or a provide that no
 * longer corresponds to anything the layer acquires.
 *
 * The provides are in the order `Workspace.layer` yields them, so the two read side by side.
 *
 * ⚠️ `InstanceStore` / `InstanceBootstrap` are deliberately absent, and must stay absent.
 * `Workspace.layer` does NOT require InstanceStore: `runInWorkspace` yields it, and both call sites
 * (`sessionWarp`) discharge it locally with their own `Effect.provide`. The proof is mechanical —
 * `Workspace.node`'s `deps` omits it under `layer-node.ts`'s compile-checked `CheckDependencies`
 * constraint, which would reject the omission if it were a real requirement. Suites that need a live
 * store get it from `withTmpdirInstance` (test/fixture/fixture.ts), which provides its own.
 */
export const workspaceLayerWithRuntimeFlags = (overrides: Partial<RuntimeFlags.Info>) =>
  Workspace.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Vcs.defaultLayer),
    Layer.provide(RuntimeFlags.layer(overrides)),
    Layer.provide(FSUtil.defaultLayer),
    // A private ledger: these suites exercise HTTP middleware and plugin adapter installation, not
    // session eviction. The shared per-instance scheduler is wired through `Workspace.node`'s deps in
    // the real composition root.
    Layer.provide(SessionScheduler.layer),
    Layer.provide(Database.defaultLayer),
  )
