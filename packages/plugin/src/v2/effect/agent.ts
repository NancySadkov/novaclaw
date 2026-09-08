import type { AgentV2Info } from "@novaclaw/sdk/v2/types"
import type { Declarative } from "./declaration.js"
import type { Hooks } from "./registration.js"

export interface AgentDraft {
  list(): readonly AgentV2Info[]
  get(id: string): AgentV2Info | undefined
  default(id: string | undefined): void
  update(id: string, update: (agent: AgentV2Info) => void): void
  remove(id: string): void
}

export type AgentHooks = Hooks<{
  transform: AgentDraft
}> &
  /**
   * ⚠️ **`declare` is the form an out-of-process plugin can use; `transform` is not.** Both are here
   * while first-party plugins still need the callback — `config/plugin/agent.ts` enumerates
   * `draft.list()` and appends to agents OTHER plugins contributed, which no contribution payload
   * expresses. The end state is that this callback moves to a core-internal context and the SDK
   * type keeps only the declarative half — a trusted API and an untrusted one differing, which is
   * the same split the permission evaluator already makes.
   */
  Declarative<AgentV2Info>
