import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { tmpdir } from "./fixture/tmpdir"

test("CredentialCipher persists one private per-instance key", async () => {
  await using dir = await tmpdir()
  const target = path.join(dir.path, "state", "credential.key")
  const first = await CredentialCipher.loadOrCreate(target)
  const second = await CredentialCipher.loadOrCreate(target)

  expect(first).toHaveLength(32)
  expect(second).toEqual(first)
  const stored = await fs.readFile(target, "utf8")
  expect(stored).toStartWith("novaclaw-credential-key-v1:")
  expect(stored).not.toContain(first.toString("hex"))
  if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
})
