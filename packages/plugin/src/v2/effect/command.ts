import type { CommandV2Info as CommandV2InfoWire } from "@novaclaw/sdk/v2/types"
import type { Hooks } from "./registration.js"

/** The draft-facing view of the wire type: generated OpenAPI types can't express `readonly`
 *  arrays, but the host's drafts hand out core's readonly shapes — widen the array fields so the
 *  plugin surface accepts them (same wire shape, immutability made explicit). */
export type CommandV2Info = Omit<CommandV2InfoWire, "hints"> & { hints?: readonly string[] }

export interface CommandDraft {
  list(): readonly CommandV2Info[]
  get(name: string): CommandV2Info | undefined
  update(name: string, update: (command: CommandV2Info) => void): void
  remove(name: string): void
}

export type CommandHooks = Hooks<{
  transform: CommandDraft
}>
