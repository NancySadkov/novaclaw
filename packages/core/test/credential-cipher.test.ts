import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { tmpdir } from "./fixture/tmpdir"

/**
 * 🔴 NC-REL-030, second half — the key is never CREATED any more.
 *
 * This test asserted the opposite until 2026-08-28: that reading a missing key MINTED and persisted
 * one. That behaviour is the defect. An instance whose `credential.key` was lost in a partial
 * restore got a valid but unrelated replacement, so every existing row then failed authentication —
 * while the boot looked like a perfectly ordinary first run. The state that needed the loudest
 * signal available produced none at all.
 *
 * Nothing encrypts any more (decision §5 of `decisions-v0.2.0.md`), so a reader minting keys has no
 * purpose left to serve.
 *
 * A/B: restore the create-on-missing branch and the first assertion fails.
 */
test("🔴 a missing credential key is NOT created", async () => {
  await using dir = await tmpdir()
  const target = path.join(dir.path, "state", "credential.key")

  expect(await CredentialCipher.loadExisting(target)).toBeUndefined()
  // And it left nothing behind. A key written here would be one an operator has to know about,
  // back up, and restore — for data this build never produces.
  await expect(fs.access(target)).rejects.toThrow()
})

/**
 * The other direction: a key an OLDER build wrote is still read, unchanged. This is what keeps
 * existing instances able to open their own ciphertext long enough for the drain to run.
 */
test("🔴 a key written by an older build is still read", async () => {
  await using dir = await tmpdir()
  const target = path.join(dir.path, "state", "credential.key")
  const key = Buffer.alloc(32, 0x11)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `novaclaw-credential-key-v1:${key.toString("base64url")}\n`, { mode: 0o600 })

  const loaded = await CredentialCipher.loadExisting(target)
  expect(loaded).toEqual(key)
  // Round-trips through the real cipher, which is the property that actually matters — a key that
  // loads but decodes differently would open nothing and say nothing.
  const cipher = CredentialCipher.make(loaded!)
  const envelope = cipher.encrypt("secret", "aad")
  expect(cipher.encrypted(envelope)).toBe(true)
  expect(await Effect.runPromise(cipher.decrypt(envelope, "aad"))).toBe("secret")
})

test("a malformed key is refused rather than silently truncated", async () => {
  await using dir = await tmpdir()
  const target = path.join(dir.path, "state", "credential.key")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, "novaclaw-credential-key-v1:tooshort\n")

  // ⚠️ Throws rather than returning undefined. "No key" and "a key I cannot use" are different
  // states: the first is ordinary now, the second means somebody's file is damaged and silently
  // treating it as absent would look identical to a healthy new instance.
  await expect(CredentialCipher.loadExisting(target)).rejects.toThrow("32 bytes")
})
