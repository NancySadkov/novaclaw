export * as ConfigServer from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

// Runtime server configuration for `novaclaw serve` / web (port, hostname, mDNS, CORS).
// F1d D1: promoted verbatim from ConfigServerV1 so `Config.Info` owns real runtime config
// instead of it being a V1-only field dropped on migration.
export class Info extends Schema.Class<Info>("ConfigV2.Server")({
  port: PositiveInt.pipe(Schema.optional).annotate({ description: "Port to listen on" }),
  hostname: Schema.String.pipe(Schema.optional).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.String.pipe(Schema.optional).annotate({
    description: "Custom domain name for mDNS service (default: novaclaw.local)",
  }),
  cors: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional domains to allow for CORS",
  }),
}) {}
