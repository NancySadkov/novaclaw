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

export const route = (
  sender: Sender | undefined,
  requested: string,
  roster: ReadonlyArray<AgentV2.Info>,
): Route => {
  const target = roster.find((agent) => String(agent.id) === requested && AgentV2.isColleague(agent))
  if (!target) return { kind: "unavailable", reason: `No colleague called "${requested}" works here.` }
  if (sender?.parentID !== undefined)
    return { kind: "worker-parent", sessionID: sender.parentID, redirected: true }
  const self = sender?.agent
  if (!self || !roster.some((agent) => String(agent.id) === self && AgentV2.isColleague(agent)))
    return { kind: "unavailable", reason: "This session has no officer or parent to receive a colleague message." }
  if (self === requested)
    return { kind: "unavailable", reason: `A message to ${requested} would land in your own chat.` }
  if (self === AgentV2.NOVA_ID)
    return { kind: "officer", recipient: requested, redirected: false }
  const selfInfo = roster.find((agent) => String(agent.id) === self)!
  const superior = AgentV2.resolveSuperior(self, selfInfo.superior, roster, { includePaused: true })
  if (!superior)
    return { kind: "unavailable", reason: `No superior is available for ${self}.` }
  const superiorID = String(superior.id)
  const targetSuperior = AgentV2.resolveSuperior(requested, target.superior, roster, { includePaused: true })
  const sameTier = targetSuperior !== undefined && String(targetSuperior.id) === superiorID
  if (requested === superiorID || sameTier)
    return { kind: "officer", recipient: requested, redirected: false }
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
  return { kind: "officer", recipient: superiorID, redirected: true }
}
