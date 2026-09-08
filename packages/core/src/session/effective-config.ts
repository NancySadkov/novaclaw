export * as SessionEffectiveConfig from "./effective-config"

import { Context, Effect, Layer } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { makeGlobalNode } from "../effect/app-node"
import { MemorySetting } from "../kb-graph/memory-setting"
import { ProjectFileCache } from "../project-file-cache"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  agentOf,
  resolveConfig,
  sessionConfigChain,
  type EffectiveConfig,
} from "./config-resolve"
import { AgentConfigStore } from "../agent-config-store"
import { AgentDefaults } from "./agent-defaults"
import type { ConfigAgent } from "../config/agent"
import { ProjectDefaults } from "./project-defaults"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"

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
  /** The tune components the folder actually contributed. */
  readonly applied: readonly ProjectFile.TuneFeature[]
  /** Declared and refused, because the folder may not loosen what a lower layer already set. */
  readonly refused: readonly ProjectFile.TuneFeature[]
  /** Declared, allowed, and not applied because a reader of it does not fold yet (`WIRED`). */
  readonly deferred: readonly ProjectFile.TuneFeature[]
  /** The project file that supplied the tune, when one governs the session's folder. */
  readonly project?: { readonly root: string; readonly file: string }
  /**
   * The COLLEAGUE whose chat this is, and which defaults it supplied.
   *
   * ⚠️ `applied` is what the agent DECLARED, which is not the same as what survives: the folder's
   * tune folds OVER the colleague, so a field listed here can still be overridden by a project file
   * or by a session row deeper in the chain. The reader ranks them (`session-config.ts`); this only
   * reports authorship.
   */
  readonly agent?: { readonly id: string; readonly applied: readonly string[] }
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

/** The instance's live ceilings, for a caller outside this service (`GET /api/project`). */
export const ceilings = currentCeilings

/** What a folder alone decides, before any chat exists to declare anything. */
export interface FolderStance {
  /** The stance a chat created here would START with — the folded defaults, ceilings applied. */
  readonly config: EffectiveConfig
  /** The tune components the folder actually contributes to it. */
  readonly applied: readonly ProjectFile.TuneFeature[]
  /** Declared and refused: a folder may raise a supervision rail and may never lower one. */
  readonly refused: readonly ProjectFile.TuneFeature[]
  /** Declared, allowed, and not applied because no reader folds it yet (`ProjectDefaults.WIRED`). */
  readonly deferred: readonly ProjectFile.TuneFeature[]
}

/**
 * 🔴 **The same fold, for a chat that does not exist yet — and it lives HERE for the reason the rest
 * of this file exists.**
 *
 * A DRAFT has no session id, so `resolution` cannot answer for it, and the composer's Tuning panel
 * therefore showed every switch at the INSTANCE stance: a draft in a folder declaring
 * `quality: true` rendered *"Using Settings default: Off"* while the chat that same click would
 * create resolves `quality: true` from the folder. Measured 2026-08-19. The sentence above the
 * switches had already been fixed to name the folder's file, so the two halves of one panel
 * contradicted each other — worse than either alone.
 *
 * The obvious repair is to let the browser fold the folder's declared tune over its own baseline.
 * That is the mistake `config-provenance.ts` records: a browser-side re-derivation once produced
 * toggles that were the exact INVERSE of what the runner resolved. `narrowTune` is a security rule —
 * a folder may raise a supervision switch and never lower one — and a second implementation of it in
 * a renderer is a second chance to get a security rule wrong. So the kernel folds, and the client
 * renders what it is told.
 *
 * ⚠️ There is no chain step because there is no chain: `resolveConfig(base, [])` is `{...base}`, so
 * running the walk over an empty chain would be a longer spelling of `folded.defaults`. The
 * CEILINGS still apply, because they clamp the resolution rather than the defaults — a folder that
 * asks for `memory: true` while the user's privacy switch is off must not be reported as supplying
 * it, since the chat this creates will not have it.
 */
export const folderStance = (tune: ProjectFile.Tune | undefined, limits: Ceilings): FolderStance => {
  const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune)
  const config = clampToCeilings(folded.defaults, limits)
  return {
    config,
    applied: folded.applied.filter((feature) => config[feature] === folded.defaults[feature]),
    refused: folded.refused,
    deferred: folded.deferred,
  }
}

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
    const projects = yield* ProjectFileCache.Service
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
      // No session means no folder, and the chain walk below returns an empty chain — so the answer
      // is the shipped defaults. Resolving anyway (rather than short-circuiting) keeps this method's
      // result identical to what the readers computed before, for a session that vanished mid-turn.
      const found = session
        ? yield* projects.read(session.location.directory, session.location.directory)
        : ProjectFileCache.EMPTY
      // 🔴 The COLLEAGUE's standing choices, folded UNDER the folder (see `agent-defaults.ts` for why
      // that order is a security decision, not a preference). Read from the store rather than from
      // the live roster so this resolves the same way on a headless turn as in the app.
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
      const colleague = agentID === undefined ? undefined : yield* declaredFor(agentID)
      const projectFault = ProjectFileCache.fault(found)
      const folded = ProjectDefaults.fold(
        AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, colleague),
        projectFault === undefined ? found.tune : undefined,
      )
      const guardedDefaults =
        projectFault === undefined ? folded.defaults : { ...folded.defaults, safeMode: true, askBeforeChanges: true }
      const resolved = clampToCeilings(resolveConfig(guardedDefaults, chain), currentCeilings())
      // A tune we cannot read is not permission to keep a looser stance. These are the two
      // supervision rails a project may raise but never lower, applied AFTER the session chain so a
      // per-chat override cannot turn a project-file fault back into capability. Permission and
      // policy consumers provide the actionable refusal; keeping config resolution successful is
      // what lets the chat itself remain usable.
      const config = projectFault === undefined ? resolved : { ...resolved, safeMode: true, askBeforeChanges: true }
      return {
        config,
        defaults: guardedDefaults,
        applied: folded.applied,
        refused: folded.refused,
        deferred: folded.deferred,
        ...(found.root !== undefined && found.file !== undefined
          ? { project: { root: found.root, file: found.file } }
          : {}),
        // 🔴 WHO supplied a default, so the config surface can say "Veritas chose this" instead of
        // blaming the instance. Measured 2026-08-22: every field a colleague declares — its model,
        // its posture, Strict, its permission mode — reported `source: {kind: "instance"}`, because
        // the fold writes into `defaults` and defaults were attributed to the instance by
        // elimination. A surface built to explain configuration was naming the wrong author.
        // ⚠️ The CHAIN's agent here too, not the row's. This is what the Tune dialog and the folder
        // report read to say "these settings came from Theron" — and for a sub-agent the row is null,
        // so reporting from it said no colleague was involved while the colleague's own model, floor
        // and posture were in force.
        ...(agentID === undefined ? {} : { agent: { id: agentID, applied: AgentDefaults.declaredBy(colleague) } }),
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
  deps: [SessionStore.node, ProjectFileCache.node, AgentConfigStore.node],
})
