import { AgentV2 } from "@novaclaw/core/agent"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Effect } from "effect"

export const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
) => registry.materialize(permissions).pipe(Effect.map((materialized) => materialized.definitions))

export const settleTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  registry.materialize().pipe(Effect.flatMap((materialized) => materialized.settle(input)))

export const executeTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  // Unit tests target the executor, not provider disclosure. Mark the named tool discovered so the
  // same helper exercises resident and deferred registrations; horizon tests use `settleTool` or
  // inspect `materialize()` directly when disclosure itself is the subject.
  registry
    .materialize([], () => true, new Set([input.call.name]))
    .pipe(
      Effect.flatMap((materialized) => materialized.settle(input)),
      Effect.map((settlement) => settlement.result),
    )
