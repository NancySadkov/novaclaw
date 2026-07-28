import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { CommandList } from "@novaclaw/core/command/list"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

// P6 (/command reconciliation): serve the ONE slash-command union — CommandV2 ∪ skills ∪ MCP
// prompts (CommandList) — instead of the bare CommandV2 state. This is the list the composer's
// slash popover renders (sync.data.command); everything listed here is dispatchable by the
// session command op (it falls back to skills and the MCP ExternalCommandSource on a
// CommandV2 miss).
export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers
    .handle("command.list", () => response(CommandList.list))
    .handle(
      "command.remove",
      Effect.fn(function* (ctx) {
        // Deletes the config-store row only — the served list is a union, and skills/MCP prompts
        // are not config rows, so this cannot pretend to remove one. No default points at a
        // command, so there is no dangling ref to prune here (unlike `agent.remove`).
        const store = yield* CommandConfigStore.Service
        yield* store.removeCommand(ctx.params.name)
      }),
    ),
)
