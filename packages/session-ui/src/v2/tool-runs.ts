import type { SessionMessage, SessionMessageAssistant, SessionMessageAssistantTool } from "@novaclaw/sdk/v2"
import { stripAutomatedEcho } from "@novaclaw/core/session/steer-provenance"
import { answerStart, nestToolWork } from "./turn-group"

export interface AssistantFragment {
  readonly key: string
  readonly message: SessionMessageAssistant
  readonly content: SessionMessageAssistant["content"]
  chrome: boolean
  receipt: boolean
}

export type ToolRun = {
  readonly kind: "tools"
  readonly key: string
  readonly fragments: AssistantFragment[]
  readonly tools: SessionMessageAssistantTool[]
}

export type TranscriptRow =
  | ToolRun
  | { readonly kind: "assistant"; readonly key: string; readonly fragment: AssistantFragment }
  | { readonly kind: "message"; readonly key: string; readonly message: SessionMessage }

export function groupToolRuns(messages: readonly SessionMessage[], workOnlyID?: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: ToolRun | undefined
  for (const message of messages) {
    if (message.type !== "assistant") {
      run = undefined
      rows.push({ kind: "message", key: message.id, message })
      continue
    }
    const workOnly = message.id === workOnlyID
    const content = workOnly
      ? message.content.slice(
          0,
          answerStart(
            message.content.map((part) =>
              part.type === "text" ? { ...part, text: stripAutomatedEcho(part.text) } : part,
            ),
          ),
        )
      : message.content
    const nested = nestToolWork(message.content).nestedReasoningIDs
    const fragments: Array<{ fragment: AssistantFragment; tools: boolean }> = []
    for (const part of content) {
      if (nested.has(part.id)) continue
      if ((part.type === "text" || part.type === "reasoning") && !stripAutomatedEcho(part.text).trim()) continue
      const tools = part.type === "tool"
      const last = fragments.at(-1)
      if (last?.tools === tools) {
        last.fragment.content.push(part)
        continue
      }
      fragments.push({
        tools,
        fragment: { key: `${message.id}:${part.id}`, message, content: [part], chrome: false, receipt: false },
      })
    }
    const hasFault = !workOnly && (message.error !== undefined || message.finish === "broken")
    let chrome = hasFault ? fragments.at(-1) : fragments.findLast((fragment) => !fragment.tools)
    if ((hasFault && chrome?.tools) || (!fragments.length && (message.timing || !message.time.completed || hasFault))) {
      chrome = {
        tools: false,
        fragment: { key: `${message.id}:receipt`, message, content: [], chrome: false, receipt: false },
      }
      fragments.push(chrome)
    }
    if (chrome) {
      chrome.fragment.chrome = !workOnly
      chrome.fragment.receipt = true
    }
    for (const { fragment, tools } of fragments) {
      if (!tools) {
        run = undefined
        rows.push({ kind: "assistant", key: fragment.key, fragment })
        continue
      }
      if (!run) {
        run = { kind: "tools", key: `g:${fragment.content[0]!.id}`, fragments: [], tools: [] }
        rows.push(run)
      }
      run.fragments.push(fragment)
      run.tools.push(...fragment.content.filter((part): part is SessionMessageAssistantTool => part.type === "tool"))
    }
    if (message.acceptedExit) run = undefined
  }
  return rows
}

export function toolRunSummary(tools: readonly Pick<SessionMessageAssistantTool, "name">[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => {
      const label = name.charAt(0).toUpperCase() + name.slice(1).replaceAll("_", " ")
      return count > 1 ? `${label} ${count}x` : label
    })
    .join(", ")
}
