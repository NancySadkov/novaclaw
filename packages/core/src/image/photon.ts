// @ts-ignore Bun's static file import is embedded by `bun build --compile`; some consumers also declare *.wasm.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "../filesystem"
import { DecodeError, ResizerUnavailableError, SizeError } from "../image"

/** Try the most likely quality first; the remaining values are the measured fallback ladder. */
export const JPEG_QUALITIES = [85, 80, 70, 55, 40] as const
/** A malformed or unusually large image must not turn one tool call into an unbounded encode loop. */
export const MAX_RESIZE_ATTEMPTS = 8

export const make = Effect.gen(function* () {
  ;(globalThis as typeof globalThis & { __NOVACLAW_PHOTON_WASM_PATH?: string }).__NOVACLAW_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  const loadPhoton = yield* Effect.cached(
    Effect.tryPromise({
      try: () => import("@silvia-odwyer/photon-node"),
      catch: () => new ResizerUnavailableError(),
    }),
  )
  const inspect = Effect.fn("Image.Photon.inspect")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) {
    const photon = yield* loadPhoton
    const decoded = yield* Effect.try({
      try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64")),
      catch: () => new DecodeError({ resource }),
    })
    try {
      return { width: decoded.get_width(), height: decoded.get_height() }
    } finally {
      decoded.free()
    }
  })
  const normalize = Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: {
      readonly autoResize: boolean
      readonly maxWidth: number
      readonly maxHeight: number
      readonly maxBase64Bytes: number
    },
  ) {
    const photon = yield* loadPhoton
    const decoded = yield* Effect.try({
      try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64")),
      catch: () => new DecodeError({ resource }),
    })
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      const bytes = Buffer.byteLength(content.content, "utf-8")
      if (width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes) return content
      if (!limits.autoResize)
        return yield* new SizeError({
          resource,
          width,
          height,
          bytes,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        })
      const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
      const sizes = Array.from({ length: MAX_RESIZE_ATTEMPTS }).reduce<Array<{ width: number; height: number }>>((acc) => {
        const previous = acc.at(-1) ?? {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        }
        const next =
          acc.length === 0
            ? previous
            : {
                width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
              }
        return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
      }, [])
      for (const size of sizes) {
        const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
        try {
          const encoders: Array<readonly [mime: string, encode: () => Uint8Array]> = [
            ["image/png", () => resized.get_bytes()],
            ...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const),
          ]
          for (const [mime, encode] of encoders) {
            const candidate = Buffer.from(encode()).toString("base64")
            if (Buffer.byteLength(candidate, "utf-8") <= limits.maxBase64Bytes)
              return { ...content, content: candidate, encoding: "base64" as const, mime }
          }
        } finally {
          resized.free()
        }
      }
      return yield* new SizeError({
        resource,
        width,
        height,
        bytes,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxBytes: limits.maxBase64Bytes,
      })
    } finally {
      decoded.free()
    }
  })
  return { inspect, normalize }
})
