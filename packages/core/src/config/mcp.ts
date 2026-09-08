export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  // The designated place a user parks a server's API key (`SERVICE_TOKEN`, `BRAVE_API_KEY`, …). Marked
  // whole rather than per-entry, because the entry NAMES are the user's and a name test over them is
  // the guess item 4.1 refuses — `tool/configure.ts`'s `SECRET_FIELDS` reads this map in the clear
  // today for exactly that reason. Redaction keeps the keys and blanks the values, so "which
  // variables are set" stays answerable.
  environment: ConfigAnnotation.secret(
    Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
      description: "Environment variables for the server process. Values are credentials as often as not.",
    }),
  ),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  // Not the string "secret" — which is why the name test misses it and the marker does not.
  client_secret: ConfigAnnotation.secret(Schema.String.pipe(Schema.optional)),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  // Where a bearer token is parked by hand.
  headers: ConfigAnnotation.secret(
    Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
      description: "Request headers sent to the remote server (this is where an Authorization token goes).",
    }),
  ),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Server).pipe(Schema.optional),
}) {}
