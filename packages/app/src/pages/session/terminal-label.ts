import { isDefaultTitle as isDefaultTerminalTitle } from "@/context/terminal-title"
import type { Translator } from "@/context/language"

export const terminalTabLabel = (input: { title?: string; titleNumber?: number; t: Translator }) => {
  const title = input.title ?? ""
  const number = input.titleNumber ?? 0
  const isDefaultTitle = Number.isFinite(number) && number > 0 && isDefaultTerminalTitle(title, number)

  if (title && !isDefaultTitle) return title
  if (number > 0) return input.t("terminal.title.numbered", { number })
  if (title) return title
  return input.t("terminal.title")
}
