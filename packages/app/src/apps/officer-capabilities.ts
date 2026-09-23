export type OfficerPermissionMode = "plan" | "ask" | "bypass" | "yolo"
export const PERMISSION_MODE_CHOICES: OfficerPermissionMode[] = ["plan", "ask", "bypass", "yolo"]
export const CORE_TOOLS = ["read", "grep", "glob", "write", "edit", "apply_patch", "bash", "task", "webfetch"] as const

export type OfficerRule = { readonly action: string; readonly resource: string; readonly effect: string }

export interface OfficerCapabilities {
  readonly permissionMode: OfficerPermissionMode
  readonly tools: Readonly<Record<string, boolean>>
  readonly rules: readonly OfficerRule[]
  readonly computerUse: boolean
  readonly maxWorkers: number
  readonly spawnDepth: number
  readonly workerModel?: string
  readonly workerPrototype?: string
}

const computerDeny = (rule: OfficerRule) =>
  rule.action === "computer" && rule.resource === "*" && rule.effect === "deny"

export const officerCapabilities = (config: Record<string, unknown> | undefined): OfficerCapabilities => {
  const permissionMode = config?.permissionMode
  const rules = Array.isArray(config?.permissions) ? (config.permissions as OfficerRule[]) : []
  const tools = config?.tools
  return {
    permissionMode:
      permissionMode === "plan" || permissionMode === "ask" || permissionMode === "yolo" || permissionMode === "bypass"
        ? permissionMode
        : "bypass",
    tools: typeof tools === "object" && tools !== null && !Array.isArray(tools)
      ? (tools as Record<string, boolean>)
      : {},
    rules,
    computerUse: !rules.some(computerDeny),
    maxWorkers: typeof config?.maxWorkers === "number" ? config.maxWorkers : 100,
    spawnDepth: typeof config?.spawnDepth === "number" ? config.spawnDepth : 1,
    workerModel: typeof config?.workerModel === "string" ? config.workerModel : undefined,
    workerPrototype: typeof config?.workerPrototype === "string" ? config.workerPrototype : undefined,
  }
}

export const withComputerUse = (rules: readonly OfficerRule[], enabled: boolean): OfficerRule[] => {
  const kept = rules.filter((rule) => !computerDeny(rule))
  return enabled ? kept : [...kept, { action: "computer", resource: "*", effect: "deny" }]
}

export const withToolOverride = (tools: Readonly<Record<string, boolean>>, name: string, enabled?: boolean) => {
  const next = { ...tools }
  if (enabled === undefined) delete next[name]
  else next[name] = enabled
  return next
}
