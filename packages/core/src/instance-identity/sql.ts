import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Remote-access R7: the instance's own durable identity — ONE row minted on first read and
// never rewritten. The URL a peer reaches us by is a ROUTE, not an identity: the same instance
// reached via mDNS name, LAN IP, or a tunnel must present the same id so discovery/dedup (and
// the future P2P identity keying) can recognize it. Lives in its own table because
// `runtime_setting` rows ARE config keys (an unrecognized key there fails config validation).
export const InstanceIdentityTable = sqliteTable("instance_identity", {
  id: text().primaryKey(),
  ...Timestamps,
})
