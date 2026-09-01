import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * Community P1 — the instance's cryptographic identity (`notes/spec/community-p2p.md`).
 *
 * `instanceID` is a random handle that recognises one install across routes; `networkID` is the
 * public key, which is the half a peer can verify and the string a user shares to be added as
 * someone's contact.
 */
export interface InstanceIdentity {
  readonly instanceID: string
  readonly networkID: string
}

export interface IdentityBackup {
  readonly version: 1
  readonly id: string
  readonly networkID: string
  /** 🔴 The secret. Whoever holds this can sign as this instance; there is no revocation. */
  readonly secretKey: string
}

/** Read the identity off the health endpoint, which already reports both halves. */
export function instanceIdentity(server: ServerConnection.HttpBase, options?: { readonly signal?: AbortSignal }) {
  return instanceFetch<InstanceIdentity & { readonly healthy: boolean }>(server, {
    route: "global/health",
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  })
}

/**
 * Export the identity INCLUDING its secret.
 *
 * ⚠️ POST, matching the server: a secret does not belong in a URL that proxies, browser history and
 * access logs record. Only ever called from a deliberate user action — never on page load.
 */
export function instanceIdentityBackup(server: ServerConnection.HttpBase) {
  return instanceFetch<IdentityBackup>(server, { route: "api/identity/backup", method: "POST" })
}

/**
 * Import an identity exported by `instanceIdentityBackup`.
 *
 * 🔴 `replace` overwrites the identity this instance already has, which orphans every contact and
 * channel that knows it — there is no authority to appeal to afterwards. It is passed only from a
 * confirmed user action, never defaulted on, and the server refuses without it.
 */
export function instanceIdentityRestore(
  server: ServerConnection.HttpBase,
  backup: IdentityBackup,
  options?: { readonly replace?: boolean },
) {
  return instanceFetch<{ readonly id: string; readonly networkID: string }>(server, {
    route: "api/identity/restore",
    method: "POST",
    body: { backup, ...(options?.replace === undefined ? {} : { replace: options.replace }) },
  })
}
