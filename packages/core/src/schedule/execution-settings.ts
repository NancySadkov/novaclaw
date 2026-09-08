export * as ScheduleExecutionSettings from "./execution-settings"

/**
 * Whether a schedule's execution settings can actually RUN, checked where the user can still fix them.
 *
 * 🔴 NC-REL-027 — `agent` and `model` are free-text strings that no write boundary resolved. A typo
 * persisted happily and failed hours later inside a detached session, on work nobody was present to
 * retry: *"scheduled work is explicitly unattended, so delayed validation converts a simple,
 * repairable form error into a missed report nobody is there to notice."*
 *
 * ⚠️ Pure, and it takes the KNOWN sets rather than resolving them. The interesting decisions are all
 * about wording and about which absences are legal; resolving a catalog through a location would put
 * that behind a service graph and test none of it.
 */

/**
 * What the caller was able to resolve.
 *
 * ⚠️ `undefined` means COULD NOT CHECK, and is deliberately different from an empty set. The two
 * arrive by different roads: a location-scoped catalog with no ambient location, or an instance
 * mid-reload, cannot be read at all — while an empty set is a real, readable answer that happens to
 * contain nothing. Collapsing them would make every unreadable lookup refuse every named setting,
 * which turns a transient fault into a rejected save.
 */
export type Known = {
  /** Every agent id on the roster right now, or `undefined` if the roster could not be read. */
  readonly agents: ReadonlySet<string> | undefined
  /** Every model as `providerID/modelID`, or `undefined` if no catalog was resolvable. */
  readonly models: ReadonlySet<string> | undefined
}

export type Settings = {
  readonly agent?: string | null | undefined
  readonly model?: string | null | undefined
}

/** At most this many suggestions in a refusal — a list, not a dump. */
const SUGGESTIONS = 8

const suggest = (known: ReadonlySet<string>): string =>
  known.size === 0 ? "none are configured" : [...known].sort().slice(0, SUGGESTIONS).join(", ")

/**
 * The reason these settings cannot run, or `undefined`.
 *
 * ⚠️ ABSENT is always legal, for both fields. Omitting an agent means "the instance decides at fire
 * time", which is a standing choice a user is entitled to make; refusing it would force every
 * schedule to name a colleague that might be retired before it fires. Only a NAMED thing that does
 * not exist is refused — the difference between "I did not choose" and "I chose something that is
 * not there".
 *
 * ⚠️ `null` is absent too. The update payload uses it to CLEAR a field, and treating a clear as a
 * bad value would make the only way to unset an agent impossible.
 *
 * ⚠️ An UNRESOLVED set refuses nothing — including the malformed-model check, which is skipped with
 * the rest. Naming providers is only useful advice next to a list of the ones that exist, and a
 * refusal that cannot say what to write instead is a dead end rather than a repair.
 *
 * ⚠️ The message names what is valid, not just what is wrong. The report's own complaint is that the
 * surface "requires opaque ids" — a refusal that lists the actual choices is the smallest form of
 * offering them, and it reaches every caller including the typed API, which no picker can.
 */
export function refusal(settings: Settings, known: Known): string | undefined {
  const agent = settings.agent?.trim()
  if (agent && known.agents && !known.agents.has(agent))
    return `No agent named "${agent}". Available: ${suggest(known.agents)}.`

  const model = settings.model?.trim()
  if (model && known.models) {
    // A model is `providerID/modelID`. A bare word is a different mistake from an unknown pair, and
    // saying so is the difference between the user fixing it and the user guessing.
    if (!model.includes("/"))
      return `Model "${model}" is missing its provider — write it as provider/model. Available: ${suggest(known.models)}.`
    if (!known.models.has(model)) return `No model "${model}". Available: ${suggest(known.models)}.`
  }
  return undefined
}
