// Hiring a colleague from the ROSTER — the user's own half of the CEO's power (owner: "user can
// create new agents on demand, with name, system prompt surviving compactions, private RAGs").
//
// Nova can hire through the `colleague` tool; this is the same act performed by the person. The two
// share the naming rule deliberately: whoever hires, the colleague is named from the instance's own
// pool, so the roster never reads like a list of people.

import { OfficerName } from "@novaclaw/core/agent/officer-name"
import type { AgentLike } from "./contacts"

export interface Hire {
  /** The new colleague's id — the key its memory scope and its chat hang off, fixed from birth. */
  readonly id: string
  readonly name: string
  /** The `agents.<id>` fragment to PATCH. */
  readonly fragment: Record<string, unknown>
}

/**
 * Plan a hire.
 *
 * ⚠️ **The new colleague starts with a NAME and nothing else** — no title, no brief. That is not
 * laziness: a hire made from a button has nothing to say about the job yet, and pre-filling
 * "Assistant" or "Helper" would put words in the user's mouth that the roster then displays as if
 * they meant them. The config dialog opens straight after, on an empty job title, which is the
 * question the user is actually being asked.
 */
export const planHire = (input: { readonly roster: readonly AgentLike[]; readonly random: () => number }): Hire => {
  const drawn = OfficerName.pick({
    // Ids AND display names: two colleagues reading as "Theron" are indistinguishable in a hand-off
    // line even when their keys differ.
    taken: input.roster.flatMap((agent) => [agent.id, agent.name ?? ""]),
    random: input.random,
  })
  const name = OfficerName.display(drawn)
  // `mode: primary` is what makes it a COLLEAGUE rather than staff — without it the new row would
  // take the store's default and could vanish from the very list the user just hired it into.
  return { id: drawn, name, fragment: { name, mode: "primary" } }
}
