import type { PermissionV2Request } from "@novaclaw/sdk/v2"

type DisplayRequest = Pick<PermissionV2Request, "metadata" | "resources">

export function permissionTargets(request: DisplayRequest): string[] {
  const value = request.metadata?.targets
  if (!Array.isArray(value)) return []
  return value.filter((target): target is string => typeof target === "string" && target.length > 0)
}

export function permissionOtherResources(request: DisplayRequest): string[] {
  const targets = new Set(permissionTargets(request))
  return request.resources.filter((resource) => !targets.has(resource))
}
