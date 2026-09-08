/** User-facing metadata for a worker spawn, kept plain so the presentation contract is unit-testable
 * without loading the native transcript's Vite worker. */
import type { UiI18n } from "@novaclaw/ui/context/i18n"
import type { Row } from "./colleague-row"

export const spawnRow = (input: Record<string, unknown>, t: UiI18n["t"]): Row => ({
  title: t("ui.transcript.tool.spawn"),
  ...(typeof input.prompt === "string" && input.prompt.trim().length > 0 ? { subtitle: input.prompt } : {}),
})
