import type { IconName } from "@novaclaw/ui/v2/icon"

/**
 * One icon vocabulary for transcript tools. The shell row used to be the only professional-looking
 * tool because its caller remembered to attach `terminal`; every other core tool silently omitted
 * the same field. Keep the choice at the renderer seam so a new or external tool still receives a
 * neutral task icon instead of reopening the blank-icon class.
 */
const ICONS: Readonly<Record<string, IconName>> = {
  apply_patch: "code-lines",
  bash: "terminal",
  bash_jobs: "terminal",
  colleague: "chats",
  community: "community",
  computer: "window-cursor",
  configure: "settings-gear",
  db_registry: "server",
  define_tool: "plus-small",
  docs: "open-file",
  edit: "edit",
  exit: "circle-check",
  glob: "magnifying-glass",
  grep: "magnifying-glass",
  hex: "code-lines",
  js: "code",
  kb: "brain",
  list: "bullet-list",
  log: "status",
  messenger: "speech-bubble",
  permission: "shield",
  plugin: "mcp",
  profile: "user",
  quality_provision: "check",
  read: "open-file",
  read_hex: "code-lines",
  recipe: "checklist",
  register_app: "grid-plus",
  resource_status: "cpu",
  revert: "reset",
  self: "user",
  session: "chats",
  skill: "models",
  spawn: "fork",
  task: "task",
  todowrite: "checklist",
  tool_call: "code",
  tool_manual: "help",
  tool_search: "magnifying-glass-menu",
  trash: "trash",
  upgrade_chat: "arrow-up",
  wait: "status",
  webfetch: "link",
  websearch: "magnifying-glass",
  write: "pencil-line",
  write_hex: "code-lines",
}

export const toolIcon = (name: string): IconName => ICONS[name.trim().toLowerCase().replaceAll("-", "_")] ?? "task"
