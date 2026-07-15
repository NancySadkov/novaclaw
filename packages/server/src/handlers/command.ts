import { CommandList } from "@novaclaw/core/command/list"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

// P6 (/command reconciliation): serve the ONE slash-command union — CommandV2 ∪ skills ∪ MCP
// prompts (CommandList) — instead of the bare CommandV2 state. This is the list the composer's
// slash popover renders (sync.data.command); everything listed here is dispatchable by the
// session command op (it falls back to skills and the MCP ExternalCommandSource on a
// CommandV2 miss).
export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () => response(CommandList.list)),
)
