import { useFilteredList } from "@novaclaw/ui/hooks"
import { createMemo } from "solid-js"
import { DEFAULT_PROMPT, type ContentPart, type ImageAttachmentPart, type usePrompt } from "@/context/prompt"
import type { createEditorCore } from "./editor-core"
import type { AtOption, SlashCommand } from "./slash-popover"
import { atOptionKey, visibleAgentOptions, type PromptAgentOption } from "./popover-options"

type CustomCommand = { name: string; description?: string; source?: "command" | "mcp" | "skill" }
type BuiltinCommand = {
  id: string
  disabled?: boolean
  slash?: string
  title: string
  description?: string
  keybind?: string
}

type Input = {
  agents: () => readonly PromptAgentOption[]
  recent: () => string[]
  searchFiles: (query: string) => Promise<string[]>
  customCommands: () => readonly CustomCommand[]
  builtinCommands: () => readonly BuiltinCommand[]
  triggerCommand: (id: string) => void
  popover: () => "at" | "slash" | null
  slashPopover: () => HTMLDivElement | undefined
  imageAttachments: () => ImageAttachmentPart[]
  addPart: (part: ContentPart) => void
  close: () => void
  editor: Pick<ReturnType<typeof createEditorCore>, "setText" | "clear">
  prompt: Pick<ReturnType<typeof usePrompt>, "set">
  focusEnd: () => void
}

/** Owns @ search and slash-command selection as one suggestion engine. */
export function createPromptInputPopoverController(input: Input) {
  const agents = createMemo(() => visibleAgentOptions(input.agents()))

  const selectAt = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      input.addPart({ type: "agent", name: option.name, content: `@${option.name}`, start: 0, end: 0 })
      return
    }
    input.addPart({ type: "file", path: option.path, content: `@${option.path}`, start: 0, end: 0 })
  }

  const at = useFilteredList<AtOption>({
    items: async (query) => {
      const open = input.recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents(), ...pinned]
      const paths = await input.searchFiles(query)
      const files: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents(), ...pinned, ...files]
    },
    key: atOptionKey,
    filterKeys: ["display"],
    skipFilter: (item) => item.type === "file" && !item.recent,
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: selectAt,
  })

  const commands = createMemo<SlashCommand[]>(() => {
    const builtin = input
      .builtinCommands()
      .filter((option) => !option.disabled && !option.id.startsWith("suggested.") && option.slash)
      .map((option) => ({
        id: option.id,
        trigger: option.slash!,
        title: option.title,
        description: option.description,
        keybind: option.keybind,
        type: "builtin" as const,
      }))
    const custom = input.customCommands().map((command) => ({
      id: `custom.${command.name}`,
      trigger: command.name,
      title: command.name,
      description: command.description,
      type: "custom" as const,
      source: command.source,
    }))
    return [...custom, ...builtin]
  })

  const selectSlash = (command: SlashCommand | undefined) => {
    if (!command) return
    input.close()
    const images = input.imageAttachments()
    if (command.type === "custom") {
      const text = `/${command.trigger} `
      input.editor.setText(text)
      input.prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      input.focusEnd()
      return
    }
    input.editor.clear()
    input.prompt.set([...DEFAULT_PROMPT, ...images], 0)
    input.triggerCommand(command.id)
  }

  const slash = useFilteredList<SlashCommand>({
    items: commands,
    key: (command) => command?.id,
    filterKeys: ["trigger", "title"],
    onSelect: selectSlash,
  })

  const scrollSlashActiveIntoView = () => {
    const activeID = slash.active()
    const root = input.slashPopover()
    if (!activeID || !root) return
    requestAnimationFrame(() => {
      root.querySelector(`[data-slash-id="${activeID}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  }

  const selectActive = () => {
    if (input.popover() === "at") {
      const items = at.flat()
      if (!items.length) return
      selectAt(items.find((item) => atOptionKey(item) === at.active()) ?? items[0])
      return
    }
    if (input.popover() !== "slash") return
    const items = slash.flat()
    if (!items.length) return
    selectSlash(items.find((item) => item.id === slash.active()) ?? items[0])
  }

  return { at, slash, selectAt, selectSlash, selectActive, scrollSlashActiveIntoView }
}
