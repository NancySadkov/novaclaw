export * as Download from "./download"

import { createHash } from "node:crypto"
import path from "path"
import { Duration, Effect, Schedule, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"

const HEX_SHA256 = /^[0-9a-f]{64}$/
const locks = KeyedMutex.makeUnsafe<string>()

/**
 * `sha256` is the executable-artefact arm: the pin is mandatory, the partial is named by it, range
 * resume is safe, and the completed file is published only after it hashes to that identity.
 * `transportOnly` is deliberately loud for protocols (currently skill indexes) that publish no
 * content digest. Those downloads still stream and publish atomically, but always restart after a
 * failure because appending bytes from two unpinned representations would invent a third file.
 */
export type Integrity = { readonly sha256: string } | { readonly transportOnly: true }

export interface Progress {
  readonly completed: number
  readonly total?: number
}

export interface Options {
  readonly url: string
  readonly destination: string
  readonly integrity: Integrity
  readonly stallTimeout?: Duration.Input
  readonly retries?: number
  readonly onProgress?: (progress: Progress) => Effect.Effect<void>
  /** Keep a digest-named partial across an app shutdown so the next call can resume it safely. */
  readonly preservePartialOnInterrupt?: boolean
}

export class DownloadError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false, options?: ErrorOptions) {
    super(message, options)
    this.name = "DownloadError"
    this.retryable = retryable
  }
}

const expectedDigest = (integrity: Integrity) => ("sha256" in integrity ? integrity.sha256.toLowerCase() : undefined)

const hashFile = Effect.fn("Download.hashFile")(function* (filePath: string) {
  const fs = yield* FSUtil.Service
  const hash = createHash("sha256")
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filePath, { flag: "r" })
      while (true) {
        const chunk = yield* file.readAlloc(1024 * 1024)
        if (chunk._tag === "None") break
        hash.update(chunk.value)
      }
    }),
  )
  return hash.digest("hex")
})

const contentRange = (value: string | undefined) => {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/)
  if (match == null) return undefined
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? undefined : Number(match[3]),
  }
}

const toFileUnlocked = Effect.fn("Download.toFileUnlocked")(function* (options: Options) {
  const fs = yield* FSUtil.Service
  const http = yield* HttpClient.HttpClient
  const digest = expectedDigest(options.integrity)
  if (digest !== undefined && !HEX_SHA256.test(digest)) {
    return yield* Effect.fail(
      new DownloadError(`refusing to download ${options.url}: expected SHA-256 is missing or malformed`),
    )
  }

  if (yield* fs.isFile(options.destination)) {
    if (digest === undefined || (yield* hashFile(options.destination)) === digest) return options.destination
    yield* fs.remove(options.destination, { force: true })
  }

  yield* fs.ensureDir(path.dirname(options.destination))
  const partial = `${options.destination}.partial-${digest ?? createHash("sha256").update(options.url).digest("hex").slice(0, 16)}`
  const progress = options.onProgress ?? (() => Effect.void)

  const transfer = Effect.gen(function* () {
    if (digest === undefined) yield* fs.remove(partial, { force: true }).pipe(Effect.ignore)
    const info = yield* fs.stat(partial).pipe(Effect.orElseSucceed(() => undefined))
    const offset = info?.type === "File" ? Number(info.size) : 0
    const request = (
      offset === 0
        ? HttpClientRequest.get(options.url)
        : HttpClientRequest.get(options.url).pipe(HttpClientRequest.setHeader("range", `bytes=${offset}-`))
    ).pipe(HttpClientRequest.setHeader("accept-encoding", "identity"))
    const response = yield* http
      .execute(request)
      .pipe(
        Effect.mapError(
          (error) => new DownloadError(`download request failed for ${options.url}`, true, { cause: error }),
        ),
      )
    if (response.status === 416 && offset > 0) {
      yield* fs.remove(partial, { force: true }).pipe(Effect.ignore)
      return yield* Effect.fail(
        new DownloadError(`server rejected the saved byte range for ${options.url}; restarting`, true),
      )
    }
    if (response.status < 200 || response.status >= 300) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      return yield* Effect.fail(
        new DownloadError(`download request for ${options.url} returned HTTP ${response.status}`, retryable),
      )
    }

    const encoding = response.headers["content-encoding"]
    if (digest !== undefined && encoding !== undefined && encoding !== "identity") {
      return yield* Effect.fail(
        new DownloadError(
          `refusing encoded response for ${options.url}: byte ranges and the pinned digest require identity encoding`,
        ),
      )
    }

    const range = contentRange(response.headers["content-range"])
    if (response.status === 206 && (range === undefined || range.start !== offset)) {
      yield* fs.remove(partial, { force: true }).pipe(Effect.ignore)
      return yield* Effect.fail(
        new DownloadError(`invalid resume response for ${options.url}: expected byte ${offset}; restarting`, true),
      )
    }
    const resumed = response.status === 206 && offset > 0
    const completedAtStart = resumed ? offset : 0
    const length = Number(response.headers["content-length"])
    const total = range?.total ?? (Number.isSafeInteger(length) && length >= 0 ? completedAtStart + length : undefined)
    let completed = completedAtStart
    yield* progress({ completed, ...(total === undefined ? {} : { total }) })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(partial, { flag: resumed ? "a" : "w" })
        yield* response.stream.pipe(
          Stream.timeoutOrElse({
            duration: options.stallTimeout ?? Duration.seconds(30),
            orElse: () => Stream.fail(new DownloadError(`download stalled while reading ${options.url}`, true)),
          }),
          Stream.runForEach((chunk) => {
            completed += chunk.byteLength
            return file
              .writeAll(chunk)
              .pipe(Effect.andThen(progress({ completed, ...(total === undefined ? {} : { total }) })))
          }),
          Effect.mapError((error) =>
            error instanceof DownloadError
              ? error
              : new DownloadError(`download stream failed for ${options.url}`, true, { cause: error }),
          ),
        )
        yield* file.sync
      }),
    )

    if (total !== undefined && completed !== total) {
      return yield* Effect.fail(
        new DownloadError(`download ended early for ${options.url}: received ${completed} of ${total} bytes`, true),
      )
    }
  })

  const retries = Math.max(0, Math.floor(options.retries ?? 2))
  const result = transfer.pipe(
    Effect.mapError((error) =>
      error instanceof DownloadError
        ? error
        : new DownloadError(`download failed for ${options.url}`, true, { cause: error }),
    ),
    Effect.retry({ while: (error) => error.retryable, schedule: Schedule.recurs(retries) }),
    Effect.andThen(
      Effect.gen(function* () {
        if (!(yield* fs.isFile(partial)))
          return yield* Effect.fail(new DownloadError(`download produced no file: ${options.url}`))
        if (digest !== undefined) {
          const actual = yield* hashFile(partial)
          if (actual !== digest) {
            yield* fs.remove(partial, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(
              new DownloadError(`refusing ${options.url}: SHA-256 mismatch — expected ${digest}, got ${actual}`),
            )
          }
        }
        yield* fs.rename(partial, options.destination)
        return options.destination
      }),
    ),
  )

  return yield* result.pipe(
    Effect.onInterrupt(() =>
      options.preservePartialOnInterrupt && digest !== undefined
        ? Effect.void
        : fs.remove(partial, { force: true }).pipe(Effect.ignore),
    ),
  )
})

export const toFile = Effect.fn("Download.toFile")(function* (options: Options) {
  return yield* locks.withLock(options.destination)(toFileUnlocked(options))
})
