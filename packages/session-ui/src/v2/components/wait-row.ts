import type { SessionMessage, SessionMessageAssistantTool } from "@novaclaw/sdk/v2"
import type { UiI18n } from "@novaclaw/ui/context/i18n"
import type { Row } from "./colleague-row"
import { fallbackWorkerLabel } from "@novaclaw/core/agent-status/worker-label"
import { toolInputForDisplay } from "./tool-input-preview"

const inputOf = (part: SessionMessageAssistantTool): Record<string, unknown> => toolInputForDisplay(part.state)

/** Resolve an opaque wait id back to the purpose shown on its earlier spawn row. */
export const waitRow = (input: Record<string, unknown>, messages: readonly SessionMessage[], t: UiI18n["t"]): Row => {
  const childID = typeof input.sessionID === "string" ? input.sessionID : undefined
  const spawn = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast((part): part is SessionMessageAssistantTool => {
      if (part.type !== "tool" || part.name !== "spawn") return false
      if (part.state.status !== "completed") return false
      return (part.state.structured as { childID?: unknown }).childID === childID
    })
  const prompt = spawn === undefined ? undefined : inputOf(spawn).prompt
  const purpose = spawn?.title?.trim() || (typeof prompt === "string" ? fallbackWorkerLabel(prompt) : undefined)
  return {
    title: t("ui.transcript.tool.wait"),
    subtitle: purpose || childID,
  }
}
