/** User-facing metadata for a worker spawn, kept plain so the presentation contract is unit-testable
 * without loading the native transcript's Vite worker. */
import type { UiI18n } from "@novaclaw/ui/context/i18n"
import type { Row } from "./colleague-row"
import { fallbackWorkerLabel } from "@novaclaw/core/agent-status/worker-label"

export const spawnRow = (input: Record<string, unknown>, generatedTitle: string | undefined, t: UiI18n["t"]): Row => {
  const prompt = typeof input.prompt === "string" ? input.prompt : ""
  const subtitle = generatedTitle?.trim() || fallbackWorkerLabel(prompt)
  return {
    title: t("ui.transcript.tool.spawn"),
    ...(subtitle ? { subtitle } : {}),
  }
}
