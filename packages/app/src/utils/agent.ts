/**
 * The two posture ids (`AgentV2.POSTURE_IDS`) with a token of their own. `ask` and `docs` sat here
 * too until 2026-09-03: V1 agent names that are ids nowhere in core, only CSS tokens that outlived
 * them — so a hire named "docs" would have worn a colour by accident of history.
 */
const defaults: Record<string, string> = {
  build: "var(--icon-agent-build-base)",
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

/**
 * The colleague's own colour when it has one; otherwise a client-side PLACEHOLDER hashed from the
 * name. The placeholder is the second identity source NC-REV-038 names — the instance never learns
 * which colour a colleague without one is wearing — and it stays only until the instance assigns
 * colours at hire, which is that entry's programme. Do not add name → colour rows here.
 */
export function agentColor(name: string, custom?: string) {
  if (custom) return custom
  return defaults[name] ?? defaults[name.toLowerCase()] ?? tone(name.toLowerCase())
}

/**
 * The tint color for a session's agent. Replaces the V1 `messageAgentColor` (which walked
 * the message list for the last user message's `agent` field) — native user messages don't
 * carry `agent`, so derive the color from the session's current agent directly (F1e S5).
 */
export function sessionAgentColor(agent: string | undefined, agents: readonly { name: string; color?: string }[]) {
  if (!agent) return undefined
  return agentColor(agent, agents.find((a) => a.name === agent)?.color)
}
