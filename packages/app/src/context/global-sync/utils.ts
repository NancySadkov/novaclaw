import type { Agent, ModelV2Info, ProviderListResponse } from "@novaclaw/sdk/v2/client"
import { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  const models = new Map<string, ModelV2Info[]>()
  for (const model of input.models) {
    if (model.status === "deprecated") continue
    const list = models.get(model.providerID) ?? []
    list.push(model)
    models.set(model.providerID, list)
  }
  return {
    all: new Map(input.providers.map((provider) => [provider.id, provider])),
    models,
    default: input.default,
    connected: input.connected,
  }
}


