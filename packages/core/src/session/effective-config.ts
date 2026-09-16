export * as SessionEffectiveConfig from "./effective-config"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { MemorySetting } from "../kb-graph/memory-setting"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  agentOf,
  ownerAgentOf,
  resolveConfig,
  sessionConfigChain,
  type EffectiveConfig,
} from "./config-resolve"
import { AgentConfigStore } from "../agent-config-store"
import { AgentDefaults } from "./agent-defaults"
import type { ConfigAgent } from "../config/agent"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { WorkerProfile } from "./worker-profile"

/**
 * THE entry point for "what config is this session running with".
 *
 * 🔴 **One entry point is the whole point.** `resolveSessionConfig` takes the defaults it resolves
 * against as an argument, and eleven call sites passed `EFFECTIVE_CONFIG_DEFAULTS` directly. A
 * layer folded into one of them reached only that reader — so a folder could set `safeMode` while
 * one of its two readers saw the fold, and the same chat would be confined for one decision and not
 * the next. A supervision switch that is half on is indistinguishable from a bug and worse than not
 * offering it (`project-defaults.ts`).
 *
 * So the fold does not live at the readers. It lives here, once, and the readers ask this service.
 * `ProjectDefaults.WIRED` remains the gate on which components a folder may actually influence, but
 * it is now a statement about a single code path rather than a claim about eleven.
 *
 * ⚠️ The project is derived from the SESSION's working folder, not from a directory the caller
 * happens to hold. `permission.ts` used the instance `Location`'s directory, which answers for the
 * instance no matter whose folder was asked about — correct only while every session sits in the
 * instance's own folder, which is not a property the kernel has.
 *
 * ⚠️ Never fails. `SessionStore.get` orDies, and a project-file fault resolves to the strict
 * supervision rails while the permission/policy seams carry the actionable refusal. A config walk
 * that failed typed would put a fallback at every reader and take the chat down before it could say
 * what the user needs to fix.
 */

export interface Resolution {
  /** The effective config: the folder's tune folded under the parent chain and the session's row. */
  readonly config: EffectiveConfig
  /**
   * The layer the chain resolved AGAINST — the shipped defaults with the folder's applied tune on
   * top, before any session declared anything.
   *
   * Reported because the introspection view resolves every PREFIX of the chain to find where each
   * value last moved, and it must run that against the same base the turn did. Handed the shipped
   * defaults instead, it would report a folder-supplied value as coming from the instance.
   */
  readonly defaults: EffectiveConfig
  /**
   * 🗑️ A FOLDER could contribute tune components through its `novaclaw.json`, and these three fields
   * were that report: what it contributed, what it was refused, and what no reader folded yet. The file
   * is retired (owner, 2026-09-16), so all three are structurally empty and typed as plain names rather
   * than as a tune vocabulary that no longer exists. They stay in the shape because the provenance
   * surface reads them and "the folder contributed nothing" is the truthful answer — collapsing the
   * type as well is part of the app-side pass, not this one.
   */
  readonly applied: readonly string[]
  readonly refused: readonly string[]
  readonly deferred: readonly string[]
  /**
   * 🗑️ The project file that governed the session's folder — GONE, not "never set". It was kept one
   * pass longer than the mechanism to hold the consumers still, and the retirement is only complete
   * when the noun is out of the types: a field that can never be produced is a standing invitation to
   * write `if (resolution.project)` again, and the copy it fed ("set by this folder's project file")
   * has no source any more. Owner, 2026-09-16: *"please proceed to completion."*
   */

  /**
   * The COLLEAGUE whose chat this is, and which defaults it supplied.
   *
   * ⚠️ `applied` is what the agent DECLARED, which is not the same as what survives: the folder's
   * tune folds OVER the colleague, so a field listed here can still be overridden by a project file
   * or by a session row deeper in the chain. The reader ranks them (`session-config.ts`); this only
   * reports authorship.
   */
  readonly agent?: { readonly id: string; readonly applied: readonly string[] }
  /** The root officer that owns durable components; workers proxy this officer's RAG cabinet. */
  readonly memoryOwnerAgent?: string
  /** Immutable prototype role copied into this anonymous worker; never an ownership identity. */
  readonly workerProfile?: WorkerProfile.Snapshot
}

/**
 * Instance CEILINGS, applied after the chain resolves.
 *
 * 🔴 **A ceiling clamps down and never up.** The chain's job is to say what a session asked for; a
 * ceiling says what the instance permits, and the two are different questions. `memory` is the case
 * that forced it: the user's Memory switch in Settings is a PRIVACY choice, so a session — or a
 * `novaclaw.json` in a folder they cloned — asking `memory: true` must not turn recording back on.
 *
 * ⚠️ It lives HERE rather than at the readers, and that is the whole change. All three readers ANDed
 * `MemorySetting.memoryEnabled()` into their own expression, so the ceiling held only for as long as
 * every one of them remembered to; a fourth reader would have been off by omission, silently, and
 * "memory is off" would have been true of the parts of the system that asked and false of the part
 * that forgot. Clamping the resolution makes the answer the same everywhere by construction — and
 * makes the introspection view report `memory: false` instead of showing a stance nothing honours.
 *
 * ⚠️ It is applied to the RESOLVED config, not folded into the defaults, because a default is what
 * an absent value means while a ceiling overrides a present one. Folding it under the chain would
 * let an explicit `true` climb straight back over it.
 */
export interface Ceilings {
  /** The user's Memory privacy switch (Settings → Memory). Off caps every session at off. */
  readonly memory: boolean
}

/**
 * Exported with the ceiling values INJECTED so the rule is testable without a settings database.
 * `MemorySetting.memoryEnabled()` is a synchronous sqlite read against the instance's real path; a
 * test that had to flip it would be testing the settings store, not this clamp.
 */
export const clampToCeilings = (config: EffectiveConfig, ceilings: Ceilings): EffectiveConfig =>
  ceilings.memory ? config : { ...config, memory: false }

const currentCeilings = (): Ceilings => ({ memory: MemorySetting.memoryEnabled() })

/** The instance's live ceilings, for a caller outside this service. */
export const ceilings = currentCeilings

/**
 * 🗑️ A `folderStance` fold used to sit here: the same fold as `resolution`, for a chat that does not
 * exist yet, because a DRAFT has no session id and the composer's Tuning panel therefore showed every
 * switch at the INSTANCE stance while the chat the same click would create resolved them from the
 * folder's `novaclaw.json`. It existed so the kernel folded once and the client rendered what it was
 * told — a browser-side re-derivation once produced toggles that were the exact INVERSE of what the
 * runner resolved, because `narrowTune` is a security rule (a folder may raise a supervision switch
 * and never lower one).
 *
 * With the file retired (owner, 2026-09-16) there is no folder layer left to report: a draft resolves
 * from the shipped defaults plus its officer, which is exactly what `resolution` answers for a session
 * with no row. The app-side pass that removes the caller goes with the rest of the UI.
 */

export interface Interface {
  /** The full resolution, including where the folder layer came from and what it could not do. */
  readonly resolution: (sessionID: SessionSchema.ID) => Effect.Effect<Resolution>
  /** The effective config alone — what almost every reader wants. */
  readonly resolve: (sessionID: SessionSchema.ID) => Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionEffectiveConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionStore.Service
    const agents = yield* AgentConfigStore.Service

    /**
     * The colleague's own config layers, folded last-wins — the same fold every other reader of the
     * agent store uses, so a later layer overriding an earlier one means what it means everywhere.
     */
    const declaredFor = Effect.fn("SessionEffectiveConfig.agent")(function* (agentID: string) {
      const stored = yield* agents.agents()
      return AgentConfigStore.fold(stored[agentID] ?? [])
    })

    const resolution = Effect.fn("SessionEffectiveConfig.resolution")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      // 🔴 The COLLEAGUE's standing choices (see `agent-defaults.ts` for why the fold order is a
      // security decision, not a preference). Read from the store rather than from the live roster so
      // this resolves the same way on a headless turn as in the app.
      // 🔴 **WHOSE config to fold — the CHAIN's agent, not this row's.** A spawned sub-agent stores
      // `agent: null` and inherits its officer through the parent-chain walk (`agent` is a chain field
      // with `merge: "override"`, which is the "undefined = inherit" stance). Reading the ROW here gave
      // a second, disagreeing answer to "who is this session", and the child silently lost everything
      // `AgentDefaults` folds: its officer's MODEL, capability floor, memory stance, archive setting
      // and posture.
      //
      // Measured 2026-08-23: a Marshal officer on Qwen spawned six sub-agents; all six ran as the
      // instance default and died against a provider that had been down for days, while the officer
      // reported the fleet launched. The fleet was real and every worker was somebody else.
      //
      // ⚠️ Two passes, deliberately. The first resolves the chain against the SHIPPED defaults purely
      // to learn which agent is in force; the second resolves it again with that agent's choices
      // folded underneath. One pass cannot do it — the fold must happen before the chain overrides,
      // and the chain is what says whose fold it is. The walk is depth-capped, so this is bounded.
      // ONE walk, two answers: which colleague is in force, and the chain to resolve against. Asking
      // separately cost a second walk on every resolution and pushed `core` past the gate's kill.
      const chain = yield* sessionConfigChain(sessionID, (id) => sessions.get(id as SessionSchema.ID))
      const agentID = agentOf(chain)
      const memoryOwnerAgent = ownerAgentOf(chain)
      const workerProfile = session === undefined ? undefined : WorkerProfile.read(session)
      const ownerColleague = agentID === undefined ? undefined : yield* declaredFor(agentID)
      // A prototype is a sparse execution recipe laid OVER the spawning officer, never a second
      // owner. Keeping the officer underneath matters for every standing choice the snapshot does
      // not mention today (and for new components added later): absent means inherit, exactly as it
      // does everywhere else in the parent-chain architecture.
      const colleague =
        workerProfile === undefined
          ? ownerColleague
          : { ...(ownerColleague ?? {}), ...WorkerProfile.config(workerProfile) }
      const defaults = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, colleague as ConfigAgent.Info | undefined)
      // 🗑️ A folder layer used to sit between the colleague's choices and the session chain: the
      // `novaclaw.json` tune, folded under the chain, with a FAULT (a file we could not read) forcing
      // `safeMode` + `askBeforeChanges` afterwards so an unreadable file could never be permission to
      // keep a looser stance. The file is retired (owner, 2026-09-16), so there is no tune and no
      // fault: what remains is the colleague's fold under the chain, which is what the shipped
      // defaults plus one officer always were.
      const resolved = clampToCeilings(resolveConfig(defaults, chain), currentCeilings())
      return {
        config: resolved,
        defaults,
        // Structurally empty: the folder contributed nothing, because there is no folder layer. See
        // the `Resolution` fields' own note for why the names survive this pass.
        applied: [],
        refused: [],
        deferred: [],
        // 🔴 WHO supplied a default, so the config surface can say "Veritas chose this" instead of
        // blaming the instance. Measured 2026-08-22: every field a colleague declares — its model,
        // its posture, Strict, its permission mode — reported `source: {kind: "instance"}`, because
        // the fold writes into `defaults` and defaults were attributed to the instance by
        // elimination. A surface built to explain configuration was naming the wrong author.
        // ⚠️ The CHAIN's agent here too, not the row's. This is what the Tune dialog reads to say
        // "these settings came from Theron" — and for a sub-agent the row is null, so reporting from
        // it said no colleague was involved while the colleague's own model, floor and posture were
        // in force.
        ...(agentID === undefined
          ? {}
          : { agent: { id: agentID, applied: AgentDefaults.declaredBy(colleague as ConfigAgent.Info | undefined) } }),
        ...(memoryOwnerAgent === undefined ? {} : { memoryOwnerAgent }),
        ...(workerProfile === undefined ? {} : { workerProfile }),
      } satisfies Resolution
    })

    return Service.of({
      resolution,
      resolve: Effect.fn("SessionEffectiveConfig.resolve")(function* (sessionID: SessionSchema.ID) {
        return (yield* resolution(sessionID)).config
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, AgentConfigStore.node],
})
