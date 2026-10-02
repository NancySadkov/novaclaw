export * as ColleagueRoute from "./colleague-route"

import { AgentV2 } from "../agent"
import type { SessionSchema } from "./schema"

export type Sender = {
  readonly agent?: string | undefined
  readonly parentID?: SessionSchema.ID | undefined
}

export type Route =
  | { readonly kind: "officer"; readonly recipient: string; readonly redirected: boolean }
  | { readonly kind: "worker-parent"; readonly sessionID: SessionSchema.ID; readonly redirected: boolean }
  | { readonly kind: "unavailable"; readonly reason: string }

export const route = (sender: Sender | undefined, requested: string, roster: ReadonlyArray<AgentV2.Info>): Route => {
  const target = roster.find((agent) => String(agent.id) === requested && AgentV2.isColleague(agent))
  if (!target) return { kind: "unavailable", reason: `No colleague called "${requested}" works here.` }
  if (sender?.parentID !== undefined) return { kind: "worker-parent", sessionID: sender.parentID, redirected: true }
  const self = sender?.agent
  if (!self || !roster.some((agent) => String(agent.id) === self && AgentV2.isColleague(agent)))
    return { kind: "unavailable", reason: "This session has no officer or parent to receive a colleague message." }
  if (self === requested)
    return { kind: "unavailable", reason: `A message to ${requested} would land in your own chat.` }
  const selfInfo = roster.find((agent) => String(agent.id) === self)!
  const superior = AgentV2.resolveSuperior(self, selfInfo.superior, roster, { includePaused: true })
  const superiorID = superior === undefined ? undefined : String(superior.id)
  const targetSuperior = AgentV2.resolveSuperior(requested, target.superior, roster, { includePaused: true })
  // 🔴 A SHARED SUPERIOR IS ONLY A TIER WHEN THAT SUPERIOR IS AN OFFICER. Owners of agents that
  // both report to the human owner are not peers: the CEO and the owner's personal staff are not a
  // messaging guild, and treating them as one let Nova address an owner's officer directly instead
  // of being redirected to that officer's real superior. Measured 2026-10-02 on the live instance:
  // `lacedaemon` (superior `owner`) received a direct `colleague ask` from Nova because
  // `resolveSuperior` answers the owner for both and the ids compared equal. The human tier is not
  // a conference (AGENTS.md: authority narrows DOWNWARD from the CEO; the owner is above it).
  const sameTier =
    superiorID !== undefined &&
    targetSuperior !== undefined &&
    String(targetSuperior.id) === superiorID &&
    AgentV2.kindOf(superior) === "agent"
  if (requested === superiorID || sameTier) return { kind: "officer", recipient: requested, redirected: false }
  let branch = target
  const visited = new Set<string>()
  while (!visited.has(String(branch.id))) {
    visited.add(String(branch.id))
    const parent = AgentV2.resolveSuperior(String(branch.id), branch.superior, roster, { includePaused: true })
    if (!parent) break
    if (String(parent.id) === self)
      return { kind: "officer", recipient: String(branch.id), redirected: requested !== String(branch.id) }
    branch = parent
  }
  return superiorID === undefined
    ? { kind: "unavailable", reason: `No direct report can receive a message to ${requested} from ${self}.` }
    : { kind: "officer", recipient: superiorID, redirected: true }
}
