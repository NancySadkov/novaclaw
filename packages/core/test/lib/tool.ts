import { AgentV2 } from "@novaclaw/core/agent"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Effect, Layer } from "effect"

/**
 * A pre-action policy gate that consults nothing — for tests whose subject is a TOOL.
 *
 * ⚠️ **Test-only, and there is deliberately no production twin.** The real gate reaches the
 * database, the permission service and the project-file cache; a test about `resource_status`
 * should not have to stand all three up. What must never exist is a shipped "policies off" layer:
 * the gate is where `novaclaw.json`'s missing-policy refusal and every installed guard live, so a
 * passthrough wired into a real location would silently disarm all of it while every test stayed
 * green. Naming it `bypassed` is the point — a test that used this has not exercised policies, and
 * the ones that do (`tool-policy*.test.ts`) build the real node.
 */
export const bypassedPolicyGate = Layer.succeed(
  ToolPolicyGate.Service,
  ToolPolicyGate.Service.of({
    install: () => Effect.void,
    installed: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    screen: (input) => Effect.succeed({ kind: "run", input: input.input }),
  }),
)

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
