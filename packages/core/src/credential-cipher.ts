export * as CredentialCipher from "./credential-cipher"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"

const ENVELOPE = "nc1"
const KEY_FILE = "credential.key"
const KEY_HEADER = "novaclaw-credential-key-v1:"
const TEST_KEY = Buffer.alloc(32, 0x42)

export class InvalidKeyError extends Schema.TaggedErrorClass<InvalidKeyError>()("CredentialCipher.InvalidKeyError", {
  message: Schema.String,
}) {}

export class DecryptError extends Schema.TaggedErrorClass<DecryptError>()("CredentialCipher.DecryptError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly encrypted: (value: string) => boolean
  readonly encrypt: (value: string, aad: string) => string
  readonly decrypt: (value: string, aad: string) => Effect.Effect<string, DecryptError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CredentialCipher") {}

const decodeKey = (value: string): Buffer => {
  const encoded = value.trim().startsWith(KEY_HEADER) ? value.trim().slice(KEY_HEADER.length) : value.trim()
  const key = Buffer.from(encoded, "base64url")
  if (key.length !== 32) throw new InvalidKeyError({ message: "Credential encryption key must contain 32 bytes." })
  return key
}

export function make(key: Uint8Array): Interface {
  if (key.length !== 32) throw new InvalidKeyError({ message: "Credential encryption key must contain 32 bytes." })
  const secret = Buffer.from(key)
  return Service.of({
    encrypted: (value) => value.startsWith(`${ENVELOPE}:`),
    encrypt: (value, aad) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", secret, iv)
      cipher.setAAD(Buffer.from(aad, "utf8"))
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return [
        ENVELOPE,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":")
    },
    decrypt: (value, aad) =>
      Effect.try({
        try: () => {
          const [version, iv, tag, ciphertext, extra] = value.split(":")
          if (version !== ENVELOPE || !iv || !tag || !ciphertext || extra !== undefined)
            throw new Error("Credential envelope is malformed.")
          const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"))
          decipher.setAAD(Buffer.from(aad, "utf8"))
          decipher.setAuthTag(Buffer.from(tag, "base64url"))
          return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
            "utf8",
          )
        },
        catch: () => new DecryptError({ message: "Stored credential could not be decrypted." }),
      }),
  })
}

const unavailable = (message: string): Interface =>
  Service.of({
    encrypted: (value) => value.startsWith(`${ENVELOPE}:`),
    encrypt: () => {
      throw new InvalidKeyError({ message })
    },
    decrypt: () => Effect.fail(new DecryptError({ message })),
  })

/** Exported for the filesystem persistence test; production calls it only through `layer`. */
export const loadOrCreate = async (target: string): Promise<Buffer> => {
  try {
    return decodeKey(await fs.readFile(target, "utf8"))
  } catch (cause) {
    if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ENOENT") throw cause
  }

  const key = randomBytes(32)
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    const handle = await fs.open(target, "wx", 0o600)
    try {
      await handle.writeFile(`${KEY_HEADER}${key.toString("base64url")}\n`, "utf8")
    } finally {
      await handle.close()
    }
    return key
  } catch (cause) {
    if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "EEXIST") throw cause
    return decodeKey(await fs.readFile(target, "utf8"))
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Hermetic test databases must not create durable keys in the user's real instance directory.
    if (process.env.NOVACLAW_DB === ":memory:") return make(TEST_KEY)
    const global = yield* Global.Service
    const key = yield* Effect.tryPromise({
      try: () => loadOrCreate(path.join(global.state, KEY_FILE)),
      catch: (cause) => new InvalidKeyError({ message: `Credential encryption key is unavailable: ${String(cause)}` }),
    })
    return make(key)
  }).pipe(
    Effect.catchCause((cause) => {
      const message = "Credential encryption is unavailable; credential reads and writes are disabled."
      return Effect.logError(`${message} ${Cause.pretty(cause)}`).pipe(Effect.as(unavailable(message)))
    }),
  ),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })
