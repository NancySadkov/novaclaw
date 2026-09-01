import { Auth } from "@/auth"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ProviderV2 } from "@novaclaw/core/provider"

const AuthParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

const LogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

/**
 * `POST /log` — a NovaClaw CLIENT process reporting its OWN fault into the instance log.
 *
 * The renderer's error ring is memory-only and evaporates on reload, so a UI
 * fault today exists in one place and dies there; this is the bridge that puts it in the same
 * bounded, rotated, key-addressable `novaclaw.log` as every server fault, under the same `run=`.
 *
 * ⚠️ **It is caller-supplied content on an HTTP surface, and it is bounded on every axis.** The
 * refusals and their measurements live in `../handlers/client-log.ts`; the ones a CALLER must know
 * are written into the annotations below, because an SDK user reads the contract and never the
 * handler.
 */
export const LogInput = Schema.Struct({
  service: Schema.String.annotate({
    description:
      "Which client emitted this — e.g. 'renderer', 'desktop-main'. Reduced to [A-Za-z0-9._-] and 64 " +
      "characters: it is a grouping label from a small vocabulary, not free text.",
  }),
  level: Schema.Union([
    Schema.Literal("debug"),
    Schema.Literal("info"),
    Schema.Literal("error"),
    Schema.Literal("warn"),
  ]).annotate({ description: "Log level" }),
  message: Schema.String.annotate({ description: "Log message. Truncated at 4000 characters, never rejected." }),
  extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Additional metadata. Every key is namespaced under 'client.extra.' so it can never collide " +
      "with a log line's own columns, values are stringified and truncated at 512 characters, and at " +
      "most 16 keys matching [A-Za-z][A-Za-z0-9._-]* are kept. The rest are dropped and counted on " +
      "the line.",
  }),
})

export const ControlPaths = {
  auth: "/auth/:providerID",
  log: "/log",
} as const

export const ControlApi = HttpApi.make("control").add(
  HttpApiGroup.make("control")
    .add(
      HttpApiEndpoint.put("authSet", ControlPaths.auth, {
        params: AuthParams,
        payload: Auth.Info,
        success: described(Schema.Boolean, "Successfully set authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.set",
          summary: "Set auth credentials",
          description: "Set authentication credentials",
        }),
      ),
      HttpApiEndpoint.delete("authRemove", ControlPaths.auth, {
        params: AuthParams,
        success: described(Schema.Boolean, "Successfully removed authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.remove",
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
        }),
      ),
      HttpApiEndpoint.post("log", ControlPaths.log, {
        query: LogQuery,
        payload: LogInput,
        success: described(
          Schema.Boolean,
          "true when the entry was written; false when it was dropped by the rate limit. Never an " +
            "exception: logging must not be able to take the instance down.",
        ),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.log",
          summary: "Write log",
          description:
            "Report a CLIENT process's own fault into this instance's log, so UI and server faults " +
            "land in one file under one run id. Not a general write endpoint: the level and the " +
            "message text of the line are the instance's, caller metadata is namespaced under " +
            "'client.extra.', and posts are rate limited (240 burst, 5/s sustained) so a client in a " +
            "crash loop cannot evict the history that explains it. A dropped post answers false.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "control", description: "Control plane routes." })),
)
