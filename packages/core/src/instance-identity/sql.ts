import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Remote-access R7: the instance's own durable identity — ONE row minted on first read and
// never rewritten. The URL a peer reaches us by is a ROUTE, not an identity: the same instance
// reached via mDNS name, LAN IP, or a tunnel must present the same id so discovery/dedup (and
// the future P2P identity keying) can recognize it. Lives in its own table because
// `runtime_setting` rows ARE config keys (an unrecognized key there fails config validation).
export const InstanceIdentityTable = sqliteTable("instance_identity", {
  id: text().primaryKey(),
  /**
   * Community P1: the instance's Ed25519 PUBLIC key, base64url, raw 32 bytes — the identity a peer
   * verifies. Public by definition, so it is stored in the clear.
   *
   * ⚠️ This, not `id`, is the identity in the P2P sense: `id` is a random ULID that anyone could
   * claim, whereas a signature over this key proves the claim. `id` remains the local/LAN handle
   * that mDNS and /global/health already advertise; unifying the two is deliberately NOT part of
   * this change, because those consumers ship today.
   */
  public_key: text(),
  /**
   * 🔴 The matching SECRET, encrypted with `CredentialCipher` — never the raw bytes.
   *
   * It rides the same key-file mechanism the credential store already uses rather than a second
   * secret-at-rest scheme, and it deliberately does NOT live in `runtime_setting`: those rows ARE
   * config keys, reachable through the agent-facing `PATCH /config` surface. Self-healing says
   * operational facts belong in runtime-editable stores; a private key is not an operational fact,
   * and an agent that could read it could impersonate the instance to the whole network.
   */
  secret_key: text(),
  ...Timestamps,
})
