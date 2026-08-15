export * as CommunityConsent from "./consent"

import { Context, Effect, Layer } from "effect"
import { readRowsSync } from "#sqlite"
import { DatabasePath } from "../database/db-path"
import { Offline } from "../offline"
import { makeGlobalNode } from "../effect/app-node"

/**
 * 🔴 Whether this instance participates in the community at all — the gate in front of the whole
 * P2P module, and the reason it is OFF on a fresh install.
 *
 * Joining is not a neutral default. It has two consequences the user has to see BEFORE it happens,
 * and both are properties of the architecture rather than defects in it:
 *
 *   · the network is UNMODERATED — nobody can delete what a stranger writes, and it may be
 *     offensive. There is no operator to appeal to, because there is no operator.
 *   · talking to a peer reveals this machine's IP ADDRESS to them. That is what "no central server"
 *     means from the other side: connections are direct, so the other end learns where you are.
 *
 * ⚠️ Shaped after `observability/telemetry.ts`'s gate, deliberately: independent conditions read
 * from separate sources, and refusals returned as an ARRAY so one never masks another. A status
 * surface that said "airgapped" while consent was also missing would send someone to fix the wrong
 * thing.
 *
 * ⚠️ `config` is `unknown` here for the reason telemetry gives: the moment this imports the config
 * schema, "consent" and "the switch" become two fields of one object that a later refactor can
 * collapse into a single expression, and the distinction below is exactly what must not be lost.
 */
export interface Gate {
  /**
   * The user has read the warning and accepted it. STICKY — turning the module off does not un-read
   * it, which is why this is not the same question as `enabled`.
   *
   * Absent means NEVER ASKED, and absent is the default: unlike telemetry, which is on until
   * refused, this is off until accepted.
   */
  readonly consented: boolean
  /** The Community app's own on/off switch. Off is a normal, reversible state. */
  readonly enabled: boolean
  /** The live offline/airgap policy. Forces the module off regardless of the other two. */
  readonly airgap: boolean
}

/** Every reason participation is refused. Named, so a refusal is never silence. */
export type Refusal = "never_consented" | "switched_off" | "airgap"

export function resolveGate(input: {
  readonly config: unknown
  readonly policy: { readonly enabled: boolean }
}): Gate {
  const community = (input.config as { community?: { consented?: unknown; enabled?: unknown } } | undefined)?.community
  return {
    // ⚠️ `=== true`, not `!== false`. Telemetry's default is ON and absence means consent; here
    // absence means the question has never been put to anyone, and answering it for them is the one
    // thing this gate exists to prevent.
    consented: community?.consented === true,
    // Defaults ON once consented: a user who accepted the warning asked to join, and making them
    // flip a second switch afterwards would be a puzzle rather than a safeguard.
    enabled: community?.enabled !== false,
    airgap: input.policy.enabled === true,
  }
}

/**
 * Every condition currently refusing, in a stable order.
 *
 * ⚠️ An ARRAY rather than a first match: airgapped AND never-consented is a real state, and a
 * surface that reported only one of them would tell the user to fix a thing that would not help.
 */
export function refusals(gate: Gate): ReadonlyArray<Refusal> {
  const out: Refusal[] = []
  if (!gate.consented) out.push("never_consented")
  // ⚠️ Only meaningful once consented — an unasked user has not "switched it off", and reporting
  // that would be a second wrong instruction.
  else if (!gate.enabled) out.push("switched_off")
  if (gate.airgap) out.push("airgap")
  return out
}

/** Whether the module participates. The one question every caller actually asks. */
export const participates = (gate: Gate): boolean => refusals(gate).length === 0

// ── the live gate, process-wide ────────────────────────────────────────────────────────────────
//
// 🔴 One ref, for the reason `offline.ts` gives at length: a per-instance cache leaves whichever
// instance did not handle the config write stale, and every reader must flip together on its next
// call. The peer-door middleware in particular cannot resolve a service — the compiled graph does
// not re-export what it would need — so this is a plain module-level value by necessity as well as
// by choice.

let live: { readonly read: () => unknown; readonly gate: Gate } | undefined

/**
 * Publish the gate process-wide, reading config through `read`. Called when the layer is built.
 *
 * `read` rather than a snapshot: `reload` below has to see the value AFTER a write commits, and a
 * captured object would be the state at boot forever — which is the bug this whole mechanism exists
 * to avoid.
 */
export function install(read: () => unknown, policy: { readonly enabled: boolean }): Gate {
  const gate = resolveGate({ config: read(), policy })
  live = { read, gate }
  return gate
}

/**
 * Re-read after a config write commits, so accepting the warning or flipping the switch takes
 * effect on the next call rather than the next boot.
 *
 * ⚠️ Takes the airgap policy as an argument rather than importing `Offline`: the two conditions are
 * held apart on purpose (see `Gate`), and a module that imported the other would make collapsing
 * them into one expression a one-line refactor away.
 */
export function reload(policy: { readonly enabled: boolean }): Gate {
  /**
   * ⚠️ SELF-HEALING when nothing has installed a reader yet, and that is not defensive padding —
   * the first version returned early here, so any graph that did not build the node could never
   * grant consent no matter what the user clicked: the write committed, the gate stayed shut, and
   * the only symptom was a 503 that looked like the gate working correctly.
   *
   * The default reader is the same one the layer installs, so the healed state is identical to the
   * booted one rather than a second, subtly different path.
   */
  const read = live?.read ?? (() => readStoreConsent(DatabasePath.path()))
  const gate = resolveGate({ config: read(), policy })
  live = { read, gate }
  return gate
}

/**
 * Publish a gate computed from a config value the caller ALREADY HAS, without re-reading anything.
 *
 * 🔴 This is what `ConfigStoreWrite` calls, and re-reading was the bug it replaces. `reload` finds
 * the database through `DatabasePath.path()`, which is resolved once at module load — so in any
 * process whose real database is not that one (every test, which runs against a temp db) the write
 * committed, the re-read looked somewhere else, and the gate stayed shut. The symptom was a 503
 * that is indistinguishable from the gate working correctly.
 *
 * Taking the committed value directly means the live gate cannot disagree with what was just
 * stored, whichever database that was.
 */
export function applied(community: unknown, policy: { readonly enabled: boolean }): Gate {
  const gate = resolveGate({ config: { community }, policy })
  live = { read: live?.read ?? (() => readStoreConsent(DatabasePath.path())), gate }
  return gate
}

/**
 * The live gate — refuses everything until a layer installs a reader.
 *
 * ⚠️ The default is the SAFE one and that is not an accident: an instance that has not wired this
 * up does not participate, rather than participating because nothing said otherwise.
 */
export function currentGate(): Gate {
  return live?.gate ?? { consented: false, enabled: false, airgap: false }
}

/** Tests only: forget the installed reader so one file's config cannot leak into the next. */
export function resetGate(): void {
  live = undefined
}

/**
 * Read the stored `community` setting straight from the runtime settings table.
 *
 * ⚠️ Sync and outside Effect, exactly like `Offline.readStorePolicy`, and for the same reason: the
 * readers are middleware and plain functions with no runtime in scope. `undefined` on an unseeded
 * database is the pre-first-boot state, and it means NOT CONSENTED — which is the safe answer.
 */
export function readStoreConsent(dbFile: string): unknown {
  const rows = readRowsSync(dbFile, "SELECT key, value FROM runtime_setting")
  const row = rows?.find((r) => r.key === "community")
  if (row === undefined) return undefined
  if (typeof row.value !== "string") return { community: row.value }
  try {
    return { community: JSON.parse(row.value) }
  } catch {
    // A row we cannot parse is not permission to participate.
    return undefined
  }
}

export class Service extends Context.Service<Service, { readonly gate: Gate }>()(
  "@novaclaw/v2/CommunityConsent",
) {}

/**
 * Installs the process-wide gate at boot.
 *
 * ⚠️ Its own node rather than a field on `Offline`: the airgap and the user's consent are
 * independent conditions read from separate sources, and a module that imported the other would put
 * collapsing them into one expression a single refactor away — the thing `Gate`'s comment exists to
 * prevent. They meet only where a caller asks both, which is `resolveGate`.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    const gate = install(() => readStoreConsent(DatabasePath.path()), offline.policy)
    return Service.of({
      // A getter over the live ref, never the value captured above: a Settings write must take
      // effect on the next call rather than the next boot.
      get gate() {
        return currentGate()
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Offline.node] })
