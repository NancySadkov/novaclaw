export * as WorkerProfile from "./worker-profile"

import type { AgentV2 } from "../agent"
import type { ConfigAgent } from "../config/agent"
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
  /** The prototype's full Strict detail — new lever/budget fields ride along because
   *  the shape is shared with the officer schema, not re-listed. */
  readonly strict?: {
    readonly enabled?: boolean
    readonly verification?: boolean
    readonly recovery?: boolean
    readonly editingAids?: boolean
    readonly budgetSteering?: boolean
    readonly attempts?: number
    readonly wallMinutes?: number
    readonly executionTokens?: number
    readonly reasoningTokens?: number
  }
  readonly shortChat?: boolean
  readonly reasoningBudget?: number
  readonly maxToolTimeoutMs?: number
  readonly needsTaxonomy?: Requirement
  /** The prototype's tool horizon (`false` denies). Narrowing only, like everywhere else. */
  readonly tools?: Record<string, boolean>
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
  tools: (prototype as unknown as Record<string, unknown>)["tools"] as Snapshot["tools"],
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
  const tools = value["tools"]
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
    // Narrowing only: a hand-edited blob may deny tools, never grant them — grants are
    // decided by the permission floor and the routing table at read time, not stored here.
    tools:
      typeof tools === "object" && tools !== null
        ? Object.fromEntries(
            Object.entries(tools as Record<string, unknown>).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
            ),
          )
        : undefined,
  }
}

/** Execution preferences only. Permission mode and tool denials narrow through the parent chain;
 * they must never replace the officer's defaults. The closed return type keeps that split explicit. */
export const config = (
  profile: Snapshot,
): Pick<
  ConfigAgent.Info,
  "model" | "variant" | "reasoningModel" | "strict" | "shortChat" | "reasoningBudget" | "maxToolTimeoutMs"
> => ({
  ...(profile.model === undefined ? {} : { model: profile.model }),
  ...(profile.variant === undefined ? {} : { variant: profile.variant }),
  ...(profile.reasoningModel === undefined ? {} : { reasoningModel: profile.reasoningModel }),
  ...(profile.strict === undefined ? {} : { strict: profile.strict }),
  ...(profile.shortChat === undefined ? {} : { shortChat: profile.shortChat }),
  ...(profile.reasoningBudget === undefined ? {} : { reasoningBudget: profile.reasoningBudget }),
  ...(profile.maxToolTimeoutMs === undefined ? {} : { maxToolTimeoutMs: profile.maxToolTimeoutMs }),
})
