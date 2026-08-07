export * as ConfigServer from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../schema"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

// Runtime server configuration for `novaclaw serve` / web (port, hostname, mDNS, CORS).
// F1d D1: this is the canonical runtime server config owned by `Config.Info`.
export class Info extends Schema.Class<Info>("ConfigV2.Server")({
  port: PositiveInt.pipe(Schema.optional).annotate({ description: "Port to listen on" }),
  hostname: Schema.String.pipe(Schema.optional).annotate({ description: "Hostname to listen on" }),
  // Ruling 5 calls this instance's own incoming token account-equivalent, so it is marked at the
  // SCHEMA rather than left to a name test: `configure`'s read op hands whatever it reads to a model,
  // and a model that has seen it has put it in a transcript, a compaction summary and possibly a
  // messenger reply.
  password: ConfigAnnotation.secret(
    Schema.String.pipe(Schema.optional).annotate({
      description:
        "Incoming API token (HTTP Basic password; username stays 'novaclaw'). Empty/unset = open server. The NOVACLAW_SERVER_PASSWORD env overrides.",
    }),
  ),
  mdns: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: ConfigAnnotation.depends(
    Schema.String.pipe(Schema.optional).annotate({
      description: "Custom domain name for mDNS service (default: novaclaw.local)",
    }),
    [
      {
        path: ["server", "mdns"],
        when: "set",
        effect: "nothing is advertised, so the domain is never used",
        source: "packages/novaclaw/src/cli/cmd/web.ts:69",
      },
    ],
  ),
  cors: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional domains to allow for CORS",
  }),
}) {}
