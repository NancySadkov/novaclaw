const defaults: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const palette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

export function agentColor(name: string, custom?: string) {
  if (custom) return custom
  return defaults[name] ?? defaults[name.toLowerCase()] ?? tone(name.toLowerCase())
}

/**
 * The tint color for a session's agent. Replaces the V1 `messageAgentColor` (which walked
 * the message list for the last user message's `agent` field) — native user messages don't
 * carry `agent`, so derive the color from the session's current agent directly (F1e S5).
 */
export function sessionAgentColor(
  agent: string | undefined,
  agents: readonly { name: string; color?: string }[],
) {
  if (!agent) return undefined
  return agentColor(agent, agents.find((a) => a.name === agent)?.color)
}
