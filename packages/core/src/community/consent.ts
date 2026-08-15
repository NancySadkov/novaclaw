export * as CommunityConsent from "./consent"

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
