// THE RESOLVED-CONFIG VIEW — the read side of the agent-OS keystone (v0.2.0 batch 4.4).
//
// `resolveSessionConfig` is the parent-chain walk where `undefined` means INHERIT (AGENTS.md → *The
// organizing metaphor*; `core/src/session/config-resolve.ts`). Every consumer of it lives INSIDE the
// process — the runner, the permission evaluator, boot recovery — so until this module existed the
// answer to *"what is this session actually running with, and which ancestor decided that?"* was not
// obtainable over HTTP at all.
//
// ⭐ **THE ONE RULE THIS FILE OBEYS: it never names a config field.** `SESSION_CONFIG_FIELDS` is the
// single declaration of the field set (ruling 8, widened to a full descriptor by B2), and the defect
// ruling 8 came from was exactly *a field present in one list and absent from another*. So every
// loop below runs over `SESSION_CONFIG_FIELD_KEYS`, every merge strategy is read off the descriptor,
// and a nineteenth field appears on the wire the day it is declared, with no edit here.
//
// ⚠️ **AND IT NEVER RE-IMPLEMENTS THE MERGE ALGEBRA.** Provenance is derived by running the
// keystone's own `resolveConfig` over every PREFIX of the chain and asking where each field's value
// last changed. That is deliberately not a second fold: a hand-written "the deepest declarer wins"
// rule would be right for `override` and WRONG for `narrow` (where a deeper layer asking for more
// capability loses), and it would silently stop matching the day a third strategy is added. Here the
// answer cannot disagree with the resolution, because it IS the resolution, sampled.

import {
  EFFECTIVE_CONFIG_DEFAULTS,
  resolveConfig,
  SESSION_CONFIG_FIELD_KEYS,
  SESSION_CONFIG_FIELDS,
  sessionConfigChain,
  type EffectiveConfig,
  type SessionConfig,
  type SessionConfigMerge,
  type SessionLike,
} from "@novaclaw/core/session/config-resolve"
import { Effect } from "effect"

// The view is generic in the session-id type for ONE reason: `SessionLike.id` is a bare `string`,
// because `config-resolve.ts` is dependency-free by design and may not reach the branded `Session.ID`.
// The wire IS branded, so without this parameter the handler would need a structural cast over the
// whole response — a cast large enough to hide a real shape error. Parameterised, the only widening
// is the single `as ID` in `resolveConfigView` below, where it can be reasoned about.

/** How one field got its value. Mirrors `SessionConfigFieldResolution` in `packages/protocol`. */
export interface FieldResolution<ID extends string = string> {
  readonly value?: unknown
  readonly merge: SessionConfigMerge
  readonly origin?: ID
  readonly declaredBy: readonly ID[]
  /**
   * Where a value came from when NO session declared it.
   *
   * ⚠️ `origin` can only ever name a session, so a component supplied by a layer beneath the entity
   * — a folder's `novaclaw.json`, or the shipped defaults — read as having no origin at all, and the
   * UI could not tell "nobody set this" from "your project set this". That is the one question a
   * person opening this surface is actually asking.
   */
  readonly source?: DefaultSource
}

/** The non-session layers that can supply a component. */
export type DefaultSource =
  | { readonly kind: "instance" }
  | { readonly kind: "project"; readonly file: string }

/** What the entity resolves against: the folded defaults, and which components the folder supplied. */
export interface DefaultsLayer {
  readonly defaults: EffectiveConfig
  readonly project?: { readonly file: string; readonly applied: readonly string[] }
}

/** Mirrors `SessionConfigResolved` in `packages/protocol`. */
export interface ResolvedConfigView<ID extends string = string> {
  readonly sessionID: ID
  readonly chain: readonly ID[]
  readonly defaults: Record<string, unknown>
  readonly resolved: Record<string, unknown>
  readonly fields: Record<string, FieldResolution<ID>>
}

/**
 * Drop the keys whose value is `undefined`, and keep ONLY descriptor keys.
 *
 * The filter is not cosmetic. `undefined` disappears over JSON anyway, so emitting it would make the
 * wire quietly disagree with the type; and restricting to descriptor keys is what makes `resolved`
 * mean *the config fields* rather than *whatever happened to be on this object*.
 */
const projectFields = (config: EffectiveConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of SESSION_CONFIG_FIELD_KEYS) {
    const value = config[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Build the view from an already-walked chain: `layerIDs[i]` is the session that contributed
 * `chain[i]`, both root-first.
 *
 * Exported so the test can drive the pure half without a database — and so the ONE place the
 * provenance rule is written down is testable in isolation.
 */
export const resolvedConfigView = <ID extends string>(
  sessionID: ID,
  layerIDs: readonly ID[],
  chain: readonly SessionConfig[],
  layer: DefaultsLayer = { defaults: EFFECTIVE_CONFIG_DEFAULTS },
): ResolvedConfigView<ID> => {
  const base = layer.defaults
  // `prefixes[i]` = the resolution of the first `i` layers. `prefixes[0]` is the bare defaults, and
  // `prefixes[chain.length]` is what the session actually runs with.
  const prefixes: EffectiveConfig[] = []
  for (let i = 0; i <= chain.length; i++) prefixes.push(resolveConfig(base, chain.slice(0, i)))
  const resolved = prefixes[chain.length]!

  const fields: Record<string, FieldResolution<ID>> = {}
  for (const key of SESSION_CONFIG_FIELD_KEYS) {
    // The DEEPEST layer at which the value moved. Reference identity is the right comparison and not
    // a shortcut: `resolveConfig` assigns a declared value straight through, so an unchanged field
    // yields the very same object/primitive across prefixes, while any layer that actually supplied
    // a value produces a different one. A structural compare would additionally have to decide
    // whether two equal-looking `model` objects are "the same decision", which is a question this
    // view has no business answering.
    let originIndex: number | undefined
    for (let i = 1; i <= chain.length; i++) {
      if (!Object.is(prefixes[i]![key], prefixes[i - 1]![key])) originIndex = i - 1
    }
    const declaredBy: ID[] = []
    // `entry`, not `layer`: the enclosing `layer` is the defaults BENEATH the entity, and shadowing
    // it here would make the `source` decision below read as if it were about a chain element.
    chain.forEach((entry, index) => {
      if (entry[key] !== undefined) declaredBy.push(layerIDs[index]!)
    })
    // A component no session layer moved got its value from beneath the entity: the folder if it
    // supplied this key, otherwise the shipped defaults. Only reported when there IS a value —
    // "nothing set it and it has no default" is absence, not a source.
    const source: DefaultSource | undefined =
      originIndex !== undefined || resolved[key] === undefined
        ? undefined
        : layer.project?.applied.includes(key)
          ? { kind: "project", file: layer.project.file }
          : { kind: "instance" }
    fields[key] = {
      ...(resolved[key] === undefined ? {} : { value: resolved[key] }),
      merge: SESSION_CONFIG_FIELDS[key].merge,
      ...(originIndex === undefined ? {} : { origin: layerIDs[originIndex]! }),
      declaredBy,
      ...(source === undefined ? {} : { source }),
    }
  }

  return {
    sessionID,
    chain: layerIDs,
    defaults: projectFields(base),
    resolved: projectFields(resolved),
    fields,
  }
}

/**
 * Walk the chain and build the view.
 *
 * ⚠️ **The walk is the keystone's own `sessionConfigChain`, and the layer IDs are RECORDED FROM IT**
 * rather than collected by a second loop. That matters more than it looks: the chain walk owns a
 * cycle guard and a break-on-missing-parent rule, and a parallel walk here would be a copy of both
 * that could drift — the identical shape as the fork defect ruling 8 exists for. Wrapping
 * `getSession` makes the recording a consequence of the real traversal instead of an imitation of it.
 */
export const resolveConfigView = <ID extends string, E, R>(
  sessionID: ID,
  getSession: (id: ID) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<ResolvedConfigView<ID>, E, R> =>
  Effect.gen(function* () {
    const visited: ID[] = []
    const chain = yield* sessionConfigChain(sessionID, (id) =>
      getSession(id as ID).pipe(
        Effect.map((session) => {
          // `SessionLike.id` is a bare `string` only because `config-resolve.ts` may not import the
          // branded id (see the note above `FieldResolution`). Every value that reaches here came out
          // of the session store, so it IS a session id; nothing else can produce a `SessionLike`.
          if (session) visited.push(session.id as ID)
          return session
        }),
      ),
    )
    // `sessionConfigChain` prepends, so its output is root-first while `visited` is in visit order
    // (target → root). One reversal aligns them index-for-index.
    const layerIDs = [...visited].reverse()
    // Not defensive programming — this is the coupling above, asserted. If the walk ever visits a
    // session without contributing a layer (or the reverse), the alignment is silently wrong and
    // every `origin` on the wire points at the wrong ancestor, which is a confident falsehood rather
    // than a missing feature. Dying is the honest outcome; it cannot happen today.
    if (layerIDs.length !== chain.length) {
      return yield* Effect.die(
        new Error(
          `sessionConfigChain visited ${layerIDs.length} sessions but produced ${chain.length} layers — the provenance alignment in session-config.ts no longer holds`,
        ),
      )
    }
    return resolvedConfigView(sessionID, layerIDs, chain)
  })
