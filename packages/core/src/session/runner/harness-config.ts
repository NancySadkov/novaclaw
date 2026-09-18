export * as HarnessConfig from "./harness-config"

// B7 tier-1 / ruling 3 — "Read every runtime-editable value through to its store at the point of
// use; a settings change is not a reboot."
//
// The harness derivations below used to sit at `Layer.effect` construction scope in
// `runner/llm.ts`: one `config.entries()` per location boot, and persona / expertise / quality /
// strict / affective / introspection / compaction resolved from it once and closed over for
// the life of the location. Making `Config.entries()` read THROUGH to the settings store (app
// `3757af64a`) changed nothing for any of them — a frozen array projected from a live store is
// still a frozen array, and a user who edited persona or Strict mode in Settings still needed a
// restart. That is precisely the caveat ruling 3 deletes rather than documents.
//
// Extracted here rather than inlined for two reasons.
//
// 1. It makes the derivation a PURE function. `runner/llm.ts` is the one file the default gate never
//    executes (`test/session-runner.test.ts` is win32-skipped, and it is the only suite that runs
//    the runner), so a claim about behaviour inside it is unverifiable on a Windows box. A pure
//    `derive` can be exercised directly — against a real `Config.Service` over a real settings
//    store — which converts "the harness now reads through" from an assertion into a measurement.
//    Same move that made `prompt-manager.ts` testable.
// 2. It puts the list of config keys the harness consumes in ONE place, so the ratchet in
//    `test/runner-config-per-turn.test.ts` can ask the runner a structural question — "does any
//    LAYER-scope declaration still derive one of these?" — instead of chasing a growing list of names that a
//    refactor could rename out from under it.
//
// ⚠️ Derive ONCE PER TURN, never once per USE. The consumption sites number in the twenties; if each
// re-read independently, one turn could compose its system prompt from one settings snapshot and run
// its quality gate against another. A turn that half-applies a settings change is a new incoherence,
// not a fix. The runner therefore threads one `Derived` through the whole turn.

import { Config } from "../../config"
import { ConfigHarnessDrives } from "../../config/harness-drives"
import { ConfigProviderConnection } from "../../config/provider-connection"
import { Introspection } from "./introspection"
import { Quality } from "./quality"
import { OfficerHarness } from "../officer-harness"

/**
 * T9 (teach-don't-gatekeep): the plain-language stance line a Normal-level user gets, composed right
 * after the persona baseline so it survives model swaps and per-session overrides. Exported so the
 * test asserts the shipped string rather than a copy of it.
 */
export const EXPERTISE_HINT =
  "The user is not a technical expert. Explain what you do in plain language, avoid unexplained jargon, and prefer simple summaries over technical detail."

/** Pure-test fallback; production always supplies `Shell.agentDefault()`. */
export const DEFAULT_AGENT_SHELL = "bash"

/**
 * Environment facts the derivation needs but must not read for itself — passing them in is what
 * keeps `derive` pure, and what lets the supplied shell be asserted from one box.
 */
export interface Options {
  /** NovaClaw's supplied agent shell. The runner passes `Shell.agentDefault()`; tests may pin it. */
  readonly shell?: string
}

/** Everything the V2 drain loop derives from instance settings for one turn. */
export interface Derived {
  /**
   * The entries this record was derived from, carried along so the caller can build the
   * config-shaped collaborators (`SessionCompaction.make`) off the SAME read rather than a second
   * one — two reads inside one turn is the incoherence this whole item exists to remove.
   */
  readonly entries: readonly Config.Entry[]
  readonly expertiseHint: string | undefined
  readonly quality: Quality.Config
  /** The supplied shell used for spawning quality checks. */
  readonly shell: string
  readonly strict: Config.Info["strict"]
  readonly affective: Config.Info["affective"]
  readonly introspection: Introspection.Resolved
  /** The live automatic continuations applied to a finished-looking turn. */
  readonly drives: ConfigHarnessDrives.Resolved
  readonly context: Config.Info["context"]
  readonly toolRouting: Config.Info["tool_routing"]
  readonly providerStallTimeoutMs: number
}

/**
 * The officer's standing detail for one session, as `SessionEffectiveConfig`'s `defaults`
 * carries it (the `AgentDefaults` fold — no second walk). Every member is detail only:
 * stances stay on the chain, where the narrowing rules already live.
 */
export interface OfficerLayer {
  readonly strict?: OfficerHarness.StrictDetail
  readonly affective?: { readonly temperature?: number; readonly extended?: boolean }
  readonly introspection?: {
    readonly cadence?: number
    readonly model?: string
    readonly prompt?: string
    readonly interjection?: string
    readonly generateInterjection?: boolean
  }
}

/**
 * Fold one session's officer layer over an instance derivation, field-wise.
 *
 * Generic over `T extends Derived` so the turn's `compaction` (and any later per-turn
 * member) rides along untouched: this changes WHAT the harness answers, never its shape,
 * which is what lets a caller apply it to the threaded per-turn record in place.
 *
 * ⚠️ Session-free by itself: it merges the two layers it is given and knows nothing about
 * chains. The session row still wins per chat, applied by the caller through
 * `OfficerHarness.resolveStrict` / the chain-resolved stances — a whole-object session
 * value merged here would reintroduce the wipe this module exists to prevent.
 */
export const withOfficer = <T extends Derived>(derived: T, officer: OfficerLayer | undefined): T => {
  if (officer === undefined) return derived
  // An officer struct that sets nothing observable is absent, not a layer: without this,
  // `{}` would materialize `{ temperature: undefined }` over an absent instance block and a
  // surface asking "did anyone set this" could no longer tell unset from set-to-nothing.
  const defined = <V extends object>(value: V | undefined): Partial<V> | undefined => {
    if (value === undefined) return undefined
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry
    return Object.keys(out).length > 0 ? (out as Partial<V>) : undefined
  }
  const officerAffective = defined(officer.affective)
  const instanceIntro = Config.latest(derived.entries, "introspection")
  return {
    ...derived,
    strict: OfficerHarness.resolveStrict(derived.strict, officer.strict, undefined),
    affective:
      derived.affective === undefined && officerAffective === undefined
        ? derived.affective
        : { ...derived.affective, ...officerAffective },
    introspection: Introspection.resolve({ ...instanceIntro, ...defined(officer.introspection) }),
  }
}

/**
 * Fold one `Config.entries()` read into the turn's harness configuration.
 *
 * Pure and total: same entries in, same record out, no I/O and no memo. That is load-bearing — a
 * cache here would re-freeze exactly what this change unfroze, and it would do so invisibly, since
 * every caller and every type stays identical.
 */
export const derive = (entries: readonly Config.Entry[], options: Options = {}): Derived => {
  return {
    entries,
    expertiseHint: Config.latest(entries, "expertise") === "normal" ? EXPERTISE_HINT : undefined,
    quality: Quality.resolve(Config.latest(entries, "quality")),
    shell: options.shell ?? DEFAULT_AGENT_SHELL,
    strict: Config.latest(entries, "strict"),
    affective: Config.latest(entries, "affective"),
    introspection: Introspection.resolve(Config.latest(entries, "introspection")),
    drives: ConfigHarnessDrives.resolve(Config.latest(entries, "harness_drives")),
    context: Config.latest(entries, "context"),
    toolRouting: Config.latest(entries, "tool_routing"),
    providerStallTimeoutMs: ConfigProviderConnection.stallTimeoutMs(Config.latest(entries, "provider_connection")),
  }
}
