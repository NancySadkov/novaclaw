import type { AgentDraft } from "../effect/agent.js"
import type { Declaration } from "../effect/declaration.js"
import type { AgentV2Info } from "@novaclaw/sdk/v2/types"
import type { Declarative, Hooks } from "./registration.js"

export type { AgentDraft }

export type AgentHooks = Hooks<{
  transform: AgentDraft
}> &
  /** The marshallable form — see the effect SDK's `declaration.ts`. */
  Declarative<Declaration<AgentV2Info>>
