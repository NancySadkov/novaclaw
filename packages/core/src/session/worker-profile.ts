export * as WorkerProfile from "./worker-profile"

import type { AgentV2 } from "../agent"
import type { Requirement } from "../model-taxonomy"

/**
 * The immutable, session-owned part of a prototype worker.
 *
 * A worker must never carry the prototype officer's id: that id owns a memory cabinet and an
 * authority position in the org chart.  The spawner snapshots only the role/model choices into the
 * worker's existing metadata component, while the normal parent-chain still owns identity,
 * permissions and memory.  That is a clone, not an alias to another named officer.
 */
export const KEY = "novaclaw.worker-profile"

export interface Snapshot {
  readonly version: 1
  readonly prototypeID: string
  readonly system?: string
  readonly model?: string
  readonly variant?: string
  readonly reasoningModel?: string
  readonly permissionMode?: "plan" | "ask" | "bypass" | "yolo"
  readonly strict?: { readonly enabled?: boolean; readonly attempts?: number; readonly wallMinutes?: number }
  readonly shortChat?: boolean
  readonly reasoningBudget?: number
  readonly maxToolTimeoutMs?: number
  readonly needsTaxonomy?: Requirement
}

const modelString = (model: AgentV2.Info["model"]): string | undefined =>
  model === undefined ? undefined : `${model.providerID}/${model.id}`

export const capture = (prototype: AgentV2.Info): Snapshot => ({
  version: 1,
  prototypeID: String(prototype.id),
  system: prototype.system,
  model: modelString(prototype.model),
  variant: prototype.model?.variant,
  reasoningModel: modelString(prototype.reasoningModel),
  permissionMode: prototype.permissionMode,
  strict: prototype.strict,
  shortChat: prototype.shortChat,
  reasoningBudget: prototype.reasoningBudget,
  maxToolTimeoutMs: prototype.maxToolTimeoutMs,
  needsTaxonomy: prototype.needsTaxonomy,
})

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
/** Read a class back through the closed vocabulary so a hand-edited metadata blob cannot smuggle a
 *  fourth word into the selection path. `special` is excluded: a colleague may not REQUIRE it. */
const optionalTaxonomy = (value: unknown): Requirement | undefined =>
  value === "smart" || value === "usual" || value === "fast" ? value : undefined

/** Read only a spawner-authored, versioned profile from a child session. */
export const read = (session: {
  readonly parentID?: string
  readonly metadata?: Record<string, unknown>
}): Snapshot | undefined => {
  if (session.parentID === undefined) return undefined
  const raw = session.metadata?.[KEY]
  if (typeof raw !== "object" || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (value["version"] !== 1) return undefined
  const prototypeID = optionalString(value["prototypeID"])
  if (prototypeID === undefined) return undefined
  const permissionMode = value["permissionMode"]
  return {
    version: 1,
    prototypeID,
    system: optionalString(value["system"]),
    model: optionalString(value["model"]),
    variant: optionalString(value["variant"]),
    reasoningModel: optionalString(value["reasoningModel"]),
    permissionMode:
      permissionMode === "plan" || permissionMode === "ask" || permissionMode === "bypass" || permissionMode === "yolo"
        ? permissionMode
        : undefined,
    strict:
      typeof value["strict"] === "object" && value["strict"] !== null
        ? (value["strict"] as Snapshot["strict"])
        : undefined,
    shortChat: typeof value["shortChat"] === "boolean" ? value["shortChat"] : undefined,
    reasoningBudget: optionalNumber(value["reasoningBudget"]),
    maxToolTimeoutMs: optionalNumber(value["maxToolTimeoutMs"]),
    needsTaxonomy: optionalTaxonomy(value["needsTaxonomy"]),
  }
}

/** Shape consumed by AgentDefaults; deliberately omits identity and authority fields. */
export const config = (profile: Snapshot): Record<string, unknown> => ({
  ...(profile.model === undefined ? {} : { model: profile.model }),
  ...(profile.variant === undefined ? {} : { variant: profile.variant }),
  ...(profile.reasoningModel === undefined ? {} : { reasoningModel: profile.reasoningModel }),
  ...(profile.permissionMode === undefined ? {} : { permissionMode: profile.permissionMode }),
  ...(profile.strict === undefined ? {} : { strict: profile.strict }),
  ...(profile.shortChat === undefined ? {} : { shortChat: profile.shortChat }),
  ...(profile.reasoningBudget === undefined ? {} : { reasoningBudget: profile.reasoningBudget }),
  ...(profile.maxToolTimeoutMs === undefined ? {} : { maxToolTimeoutMs: profile.maxToolTimeoutMs }),
})
