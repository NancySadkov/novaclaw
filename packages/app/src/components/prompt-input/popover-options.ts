import type { AtOption } from "./slash-popover"

export type PromptAgentOption = { name: string; hidden?: boolean; mode: string }

export const atOptionKey = (option: AtOption | undefined) => {
  if (!option) return ""
  return option.type === "agent" ? `agent:${option.name}` : `file:${option.path}`
}

export const visibleAgentOptions = (agents: readonly PromptAgentOption[]): AtOption[] =>
  agents
    .filter((agent) => !agent.hidden && agent.mode !== "primary")
    .map((agent) => ({ type: "agent", name: agent.name, display: agent.name }))
