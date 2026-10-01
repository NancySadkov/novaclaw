import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { bundledToolFile } from "../bundled-tool"

import { RipgrepPin } from "./pin"

export namespace RipgrepBinary {
  export const { VERSION, PLATFORM, CHECKSUM, sha256Hex, verifyDigest } = RipgrepPin
  const PINNED = CHECKSUM[VERSION]

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@novaclaw/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const pin = PINNED[platformKey]
            if (!pin) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            // Desktop packages set this to the verified binary embedded at build time; a standalone
            // server finds the same tree beside itself. A supplied path is authoritative and therefore
            // fails closed instead of falling through silently.
            const embedded = bundledToolFile(
              "ripgrep",
              process.platform === "win32" ? "rg.exe" : "rg",
              process.env.NOVACLAW_RIPGREP_PATH,
            )
            if (embedded) {
              if (!(yield* fs.isFile(embedded).pipe(Effect.orDie)))
                throw new Error(`the embedded ripgrep binary is missing: ${embedded}`)
              const bytes = yield* fs.readFile(embedded)
              verifyDigest(bytes, pin.executable, embedded)
              return embedded
            }
            throw new Error(
              "NovaClaw's bundled ripgrep is missing. Restore the third-party/ripgrep folder from the NovaClaw distribution.",
            )
          }),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node],
  })
}
