import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

/**
 * ─── the config DELETION surface ────────────────────────────────────────────────────────────────
 *
 * v0.2.0 item 4.3, 2026-08-07. `PATCH /config` **merges and never deletes** — `null` is a value
 * there, not a tombstone, and the argument for refusing RFC-7396's tombstone is written at the top
 * of `packages/core/src/merge-patch.ts`. Deletion is therefore a second verb, and this is it.
 *
 * **Why one general route instead of a sixth per-entity one.** Five already exist — `agent.remove`,
 * `command.remove`, `reference.remove`, `provider.remove`, `provider.removeModel` — and the shapes
 * still without a delete path are `mcp.servers.<name>`, `provider_presets.<id>`,
 * `permissions.<object>`, `formatter.<name>`, `tool_routing.tools.<name>`,
 * `local_model_catalog.models.<id>`, `providers.<id>.api.headers.<h>` and
 * `mcp.servers.<n>.environment.<k>`. Several of those live two and three levels inside a single
 * settings VALUE, where a dedicated HTTP route is not a design anybody would defend. AGENTS.md's
 * self-healing law is a claim about *every operational fact*, so the deletion verb has to be one
 * too.
 *
 * ⚠️ **A path is an ARRAY OF SEGMENTS, never a dotted string, and this is the part to not
 * "simplify".** Model ids carry dots and slashes (`holo3.1`, `openai/gpt-oss-120b`), MCP server
 * names are user-chosen, and header names are arbitrary — a dotted
 * `providers.spark-holo.models.holo3.1` splits into five segments and names nothing, so the route
 * would answer "no such path" for a model sitting right there.
 *
 * ⚠️ **All-or-nothing, and a path that named nothing is a 400.** An agent repairing an instance
 * sends the paths it believes are stale; if one of them was never there its model of the instance
 * is wrong, and a 2xx for "three of four" is what makes a repair loop believe it has finished.
 * `provider.removeModel` already answers a no-op with 404 for the same reason (todo.md ruling 2).
 */

/** One location in the config document: one string per level. */
export const ConfigPath = Schema.Array(Schema.String).annotate({
  identifier: "ConfigPath",
  description:
    'One config location, one segment per level — e.g. ["mcp","servers","filesystem"] or ' +
    '["providers","spark-holo","models","holo3.1"]. Segments are NOT dot-joined: config ids ' +
    "routinely contain dots and slashes.",
})

export const ConfigRemoveRequest = Schema.Struct({
  paths: Schema.Array(ConfigPath).annotate({
    description: "The paths to remove. Applied all-or-nothing: if any one names nothing, none are removed.",
  }),
}).annotate({ identifier: "ConfigRemoveRequest" })

export const ConfigRemoveResult = Schema.Struct({
  removed: Schema.Array(ConfigPath).annotate({ description: "The paths that were removed." }),
  cleared: Schema.Array(Schema.String).annotate({
    description:
      "Default refs cleared because they pointed at something removed (`model`, `default_agent`). A " +
      "dangling default reads as configured and resolves to nothing, so it is pruned with its target.",
  }),
}).annotate({ identifier: "ConfigRemoveResult" })

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.post("config.remove", "/api/config/remove", {
      payload: ConfigRemoveRequest,
      success: ConfigRemoveResult,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.remove",
        summary: "Remove config values",
        description:
          "Delete one or more values from the instance configuration by path. `PATCH /config` merges and " +
          "can never remove a key; this is the deletion verb. Instance-wide, applied in one transaction, " +
          "and live without a restart. A path that names nothing is a 400 and NOTHING is removed.",
      }),
    ),
  )
  // ⚠️ Not the bare name `config`: the legacy `/config` group already answers to it, and two tag
  // entries sharing a name is an invalid `tags` array, not a merged section — a renderer draws the
  // navigation twice. This group is the deletion verb, so it says so; the plain name is what the
  // legacy surface leaves behind when ruling 11 finishes retiring it.
  .annotateMerge(
    OpenApi.annotations({
      title: "config removal",
      description:
        "Delete instance-wide configuration keys by path — the one thing a settings write cannot express, applied in a single transaction and live without a restart.",
    }),
  )
