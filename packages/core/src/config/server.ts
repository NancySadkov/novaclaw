export * as ConfigServer from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

// Runtime server configuration for `novaclaw serve` / web (port, hostname, mDNS, CORS).
// F1d D1: this is the canonical runtime server config owned by `Config.Info`.
export class Info extends Schema.Class<Info>("ConfigV2.Server")({
  port: PositiveInt.pipe(Schema.optional).annotate({ description: "Port to listen on" }),
  hostname: Schema.String.pipe(Schema.optional).annotate({ description: "Hostname to listen on" }),
  password: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Incoming API token (HTTP Basic password; username stays 'novaclaw'). Empty/unset = open server. The NOVACLAW_SERVER_PASSWORD env overrides.",
  }),
  mdns: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.String.pipe(Schema.optional).annotate({
    description: "Custom domain name for mDNS service (default: novaclaw.local)",
  }),
  cors: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional domains to allow for CORS",
  }),
}) {}
