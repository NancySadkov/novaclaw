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
   * 🔴 The matching SECRET. **Stored in PLAINTEXT**, under OS account protection — this column
   * is not encrypted at rest, and a reader deciding how to protect the state directory must start
   * from that. Ruling 5 of `notes/reports/decisions-v0.2.0.md` settled it: no keyring exists in
   * every run mode NovaClaw ships, and the key FILE that shipped instead bought none of a
   * keyring's security while stranding `novaclaw serve`, the CLI and backup/restore.
   * Raw base64url key material is the sole stored representation.
   *
   * It still deliberately does NOT live in `runtime_setting`: those rows ARE config keys, reachable
   * through the agent-facing `PATCH /config` surface. Self-healing says operational facts belong in
   * runtime-editable stores; a private key is not an operational fact, and an agent that could read
   * it could impersonate the instance to the whole network.
   */
  secret_key: text(),
  /**
   * 🔴 The X25519 SEALING key — a second keypair, and deliberately not derived from the first.
   *
   * The identity key signs; this one agrees. Converting Ed25519 to X25519 is the curve arithmetic
   * §11 called "the kind that looks finished long before it is correct", so the two are separate keys
   * and the identity SIGNS this one to bind them. Nullable: instances that predate it mint one on
   * first use, exactly as the identity keypair itself is backfilled.
   */
  sealing_public_key: text(),
  /** Plaintext, like `secret_key`, and for the same reason — see the note above. */
  sealing_secret_key: text(),
  ...Timestamps,
})
