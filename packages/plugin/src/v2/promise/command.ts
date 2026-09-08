import type { CommandDraft } from "../effect/command.js"
import type { Declaration } from "../effect/declaration.js"
import type { CommandV2Info } from "../effect/command.js"
import type { Declarative, Hooks } from "./registration.js"

export type { CommandDraft }

export type CommandHooks = Hooks<{
  transform: CommandDraft
}> &
  /** The marshallable form — see the effect SDK's `declaration.ts`. */
  Declarative<Declaration<CommandV2Info>>
