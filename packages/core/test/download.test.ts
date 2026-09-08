import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Download } from "@novaclaw/core/download"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"

const bytes = (value: string) => new TextEncoder().encode(value)
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

const response = (request: HttpClientRequest.HttpClientRequest, body: Uint8Array, init?: ResponseInit) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body.slice().buffer as ArrayBuffer, {
      ...init,
      headers: { "content-length": String(body.byteLength), ...init?.headers },
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, FSUtil.Service | HttpClient.HttpClient>,
  client: HttpClient.HttpClient,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(FSUtil.defaultLayer, Layer.succeed(HttpClient.HttpClient, client)))),
  )

/**
 * Wait until a path exists, bounded.
 *
 * A download writes its partial as it streams, so "has the first chunk landed?" is a CONDITION, not a
 * duration — and the only honest way to wait for one is to look. The bound turns a genuine failure
 * (nothing ever written) into a red test in two seconds rather than a hang.
 */
const waitForFile = (target: string, timeoutMs = 2_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (exists(target)) return
      yield* Effect.sleep("5 millis")
    }
  })

/** A sync peek, because the loop above is a poll and `fs/promises` is what this file already imports. */
const exists = (target: string): boolean => existsSync(target)

describe("Download.toFile", () => {
  test("streams a pinned file, reports progress, and publishes it only after verification", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("six chunks would be large in production")
    const destination = path.join(tmp.path, "artifact.bin")
    const progress: Download.Progress[] = []
    const client = HttpClient.make((request) => Effect.succeed(response(request, payload)))

    await run(
      Download.toFile({
        url: "https://download.example/artifact.bin",
        destination,
        integrity: { sha256: digest(payload) },
        onProgress: (value) => Effect.sync(() => progress.push(value)),
      }),
      client,
    )

    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
    expect(progress.at(0)).toEqual({ completed: 0, total: payload.byteLength })
    expect(progress.at(-1)).toEqual({ completed: payload.byteLength, total: payload.byteLength })
    expect((await fs.readdir(tmp.path)).filter((file) => file.includes(".partial-"))).toEqual([])
  })

  test("resumes a digest-named partial with a validated byte range", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("abcdef")
    const sha256 = digest(payload)
    const destination = path.join(tmp.path, "artifact.bin")
    await fs.writeFile(`${destination}.partial-${sha256}`, payload.slice(0, 3))
    const ranges: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      ranges.push(request.headers.range)
      return Effect.succeed(
        response(request, payload.slice(3), {
          status: 206,
          headers: { "content-range": "bytes 3-5/6" },
        }),
      )
    })

    await run(
      Download.toFile({
        url: "https://download.example/artifact.bin",
        destination,
        integrity: { sha256 },
      }),
      client,
    )

    expect(ranges).toEqual(["bytes=3-"])
    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })

  test("restarts safely when a server ignores the range request", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("replacement")
    const sha256 = digest(payload)
    const destination = path.join(tmp.path, "artifact.bin")
    await fs.writeFile(`${destination}.partial-${sha256}`, bytes("stale"))
    const client = HttpClient.make((request) => Effect.succeed(response(request, payload)))

    await run(
      Download.toFile({ url: "https://download.example/artifact.bin", destination, integrity: { sha256 } }),
      client,
    )

    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })

  test("detects a stalled body and resumes it within the same operation", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("abcdef")
    const sha256 = digest(payload)
    const destination = path.join(tmp.path, "artifact.bin")
    const ranges: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      ranges.push(request.headers.range)
      if (ranges.length === 1) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(payload.slice(0, 3))
                },
              }),
              { headers: { "content-length": "6" } },
            ),
          ),
        )
      }
      return Effect.succeed(
        response(request, payload.slice(3), { status: 206, headers: { "content-range": "bytes 3-5/6" } }),
      )
    })

    await run(
      Download.toFile({
        url: "https://download.example/artifact.bin",
        destination,
        integrity: { sha256 },
        stallTimeout: "10 millis",
        retries: 1,
      }),
      client,
    )

    expect(ranges).toEqual([undefined, "bytes=3-"])
    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })

  test("discards a server's wrong byte range and retries from zero", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("abcdef")
    const sha256 = digest(payload)
    const destination = path.join(tmp.path, "artifact.bin")
    await fs.writeFile(`${destination}.partial-${sha256}`, payload.slice(0, 3))
    const ranges: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      ranges.push(request.headers.range)
      if (ranges.length === 1) {
        return Effect.succeed(
          response(request, payload.slice(2), { status: 206, headers: { "content-range": "bytes 2-5/6" } }),
        )
      }
      return Effect.succeed(response(request, payload))
    })

    await run(
      Download.toFile({
        url: "https://download.example/artifact.bin",
        destination,
        integrity: { sha256 },
        retries: 1,
      }),
      client,
    )

    expect(ranges).toEqual(["bytes=3-", undefined])
    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })

  test("fails closed on a bad digest and removes the unusable partial", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.bin")
    const expected = digest(bytes("expected"))
    const client = HttpClient.make((request) => Effect.succeed(response(request, bytes("tampered"))))

    await expect(
      run(
        Download.toFile({
          url: "https://download.example/artifact.bin",
          destination,
          integrity: { sha256: expected },
          retries: 0,
        }),
        client,
      ),
    ).rejects.toThrow(/SHA-256 mismatch/)
    expect(await Bun.file(destination).exists()).toBe(false)
    expect(await Bun.file(`${destination}.partial-${expected}`).exists()).toBe(false)
  })

  test("refuses a missing pin before making a request", async () => {
    await using tmp = await tmpdir()
    let requests = 0
    const client = HttpClient.make((request) => {
      requests += 1
      return Effect.succeed(response(request, bytes("anything")))
    })

    await expect(
      run(
        Download.toFile({
          url: "https://download.example/artifact.bin",
          destination: path.join(tmp.path, "artifact.bin"),
          integrity: { sha256: "" },
        }),
        client,
      ),
    ).rejects.toThrow(/missing or malformed/)
    expect(requests).toBe(0)
  })

  test("transport-only downloads restart instead of splicing an unpinned partial", async () => {
    await using tmp = await tmpdir()
    const url = "https://skills.example/SKILL.md"
    const destination = path.join(tmp.path, "SKILL.md")
    const suffix = createHash("sha256").update(url).digest("hex").slice(0, 16)
    await fs.writeFile(`${destination}.partial-${suffix}`, bytes("stale prefix"))
    const ranges: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      ranges.push(request.headers.range)
      return Effect.succeed(response(request, bytes("# Fresh")))
    })

    await run(Download.toFile({ url, destination, integrity: { transportOnly: true } }), client)

    expect(ranges).toEqual([undefined])
    expect(await fs.readFile(destination, "utf8")).toBe("# Fresh")
  })

  test("concurrent callers share one transfer for a destination", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("one network transfer")
    const destination = path.join(tmp.path, "artifact.bin")
    let requests = 0
    const client = HttpClient.make((request) => {
      requests += 1
      return Effect.succeed(response(request, payload))
    })
    const operation = Download.toFile({
      url: "https://download.example/artifact.bin",
      destination,
      integrity: { sha256: digest(payload) },
    })

    await run(Effect.all([operation, operation], { concurrency: "unbounded" }), client)

    expect(requests).toBe(1)
    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })

  test("an explicit cancellation reclaims its partial", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.bin")
    const sha256 = digest(bytes("never arrives"))
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new ReadableStream({ start() {} }), { headers: { "content-length": "13" } }),
        ),
      ),
    )

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Download.toFile({
            url: "https://download.example/artifact.bin",
            destination,
            integrity: { sha256 },
            stallTimeout: "1 minute",
          }).pipe(Effect.forkScoped)
          // ⚠️ Wait for the PARTIAL TO EXIST, never for a duration. This slept 20ms and assumed the
          // first chunk had reached disk — true when the file runs alone, and not true inside a
          // 6,000-test unit under load, where it failed once and passed the next five runs. A fixed
          // sleep in a test is a race whose flake looks like a product defect: the assertion that goes
          // red is "the partial was preserved", which reads as broken resume rather than as an
          // interrupt that landed too early.
          yield* waitForFile(`${destination}.partial-${sha256}`)
          yield* Fiber.interrupt(fiber)
        }),
      ),
      client,
    )

    expect(await Bun.file(`${destination}.partial-${sha256}`).exists()).toBe(false)
    expect(await Bun.file(destination).exists()).toBe(false)
  })

  test("a verified installer can preserve and resume its partial across cancellation", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("resume after restart")
    const sha256 = digest(payload)
    const destination = path.join(tmp.path, "artifact.bin")
    const requests: Array<string | undefined> = []
    const first = HttpClient.make((request) => {
      requests.push(request.headers.range)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(payload.slice(0, 6))
              },
            }),
            { headers: { "content-length": String(payload.byteLength) } },
          ),
        ),
      )
    })

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Download.toFile({
            url: "https://download.example/artifact.bin",
            destination,
            integrity: { sha256 },
            stallTimeout: "1 minute",
            preservePartialOnInterrupt: true,
          }).pipe(Effect.forkScoped)
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(fiber)
        }),
      ),
      first,
    )

    expect(await Bun.file(`${destination}.partial-${sha256}`).exists()).toBe(true)
    const second = HttpClient.make((request) => {
      requests.push(request.headers.range)
      return Effect.succeed(
        response(request, payload.slice(6), {
          status: 206,
          headers: { "content-range": `bytes 6-${payload.byteLength - 1}/${payload.byteLength}` },
        }),
      )
    })
    await run(
      Download.toFile({
        url: "https://download.example/artifact.bin",
        destination,
        integrity: { sha256 },
        preservePartialOnInterrupt: true,
      }),
      second,
    )

    expect(requests).toEqual([undefined, "bytes=6-"])
    expect(new Uint8Array(await fs.readFile(destination))).toEqual(payload)
  })
})

/**
 * 🔴 `Download.Options` had NO size field at all — no per-file cap, no bound on an index, and
 * `transportOnly` pins no digest, so an unpinned response of any size streamed straight to disk while
 * `webfetch` refused at 5 MiB (`notes/reports/skill-pull-bounds-2026-08-11.md`).
 */
describe("Download.toFile volume bound", () => {
  test("refuses a body whose declared length is over the cap, before writing anything", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("x".repeat(500))
    const destination = path.join(tmp.path, "big.bin")
    const client = HttpClient.make((request) => Effect.succeed(response(request, payload)))

    const error = await run(
      Download.toFile({
        url: "https://download.example/big.bin",
        destination,
        integrity: { transportOnly: true },
        maxBytes: 100,
      }).pipe(Effect.flip),
      client,
    )
    expect(String(error)).toContain("exceeds the 100 byte limit")
    // Neither the file nor its partial may exist — refusing after the bytes land is not refusing.
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("refuses a body with NO declared length once the arriving bytes cross the cap", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "chunked.bin")
    // ⚠️ THE case a content-length check alone cannot catch, and the reason the cap is enforced twice.
    // A server may omit the header or lie about it; the running total is what actually bounds the
    // disk. Without the per-chunk check this test passes while the file is written in full.
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 10; i++) controller.enqueue(bytes("y".repeat(50)))
                controller.close()
              },
            }),
          ),
        ),
      ),
    )

    const error = await run(
      Download.toFile({
        url: "https://download.example/chunked.bin",
        destination,
        integrity: { transportOnly: true },
        maxBytes: 100,
        retries: 0,
      }).pipe(Effect.flip),
      client,
    )
    expect(String(error)).toContain("byte limit")
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("NEGATIVE CONTROL: a body under the cap is unaffected, and no cap means no bound", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("small enough")
    const client = HttpClient.make((request) => Effect.succeed(response(request, payload)))

    const capped = path.join(tmp.path, "capped.bin")
    await run(
      Download.toFile({
        url: "https://download.example/a.bin",
        destination: capped,
        integrity: { transportOnly: true },
        maxBytes: 1000,
      }),
      client,
    )
    expect(await fs.readFile(capped, "utf8")).toBe("small enough")

    // Omitting maxBytes must keep the previous behaviour, or every existing caller silently gained a
    // limit they never asked for.
    const uncapped = path.join(tmp.path, "uncapped.bin")
    await run(
      Download.toFile({
        url: "https://download.example/b.bin",
        destination: uncapped,
        integrity: { transportOnly: true },
      }),
      client,
    )
    expect(await fs.readFile(uncapped, "utf8")).toBe("small enough")
  })

  test("the refusal does NOT retry — re-fetching an oversize body reaches the same verdict", async () => {
    await using tmp = await tmpdir()
    const payload = bytes("z".repeat(500))
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts++
      return Effect.succeed(response(request, payload))
    })

    await run(
      Download.toFile({
        url: "https://download.example/big.bin",
        destination: path.join(tmp.path, "big.bin"),
        integrity: { transportOnly: true },
        maxBytes: 100,
        // The default is 2, so a retryable refusal would triple the traffic this exists to refuse.
      }).pipe(Effect.flip),
      client,
    )
    expect(attempts).toBe(1)
  })
})
