import { Command } from "@novaclaw/schema/command"
import { Location } from "@novaclaw/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const CommandGroup = HttpApiGroup.make("server.command")
  .add(
    HttpApiEndpoint.get("command.list", "/api/command", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Command.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.command.list",
          summary: "List commands",
          description: "Retrieve currently registered commands.",
        }),
      ),
  )
  .add(
    // Self-healing (AGENTS.md): same gap as `agent.remove` — `PATCH /config` merges `commands`
    // and can never delete one. Removes the STORE row only; the list this group serves is the
    // union CommandV2 ∪ skills ∪ MCP prompts, and the other two are not config rows.
    HttpApiEndpoint.delete("command.remove", "/api/command/:name", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.command.remove",
          summary: "Remove command",
          description:
            "Delete a config-defined command from the instance command store. Takes effect fully on the next serve boot.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "commands",
      description: "Experimental command routes.",
    }),
  )
