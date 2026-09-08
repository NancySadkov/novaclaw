export * as SessionWorkerFraming from "./protocol-framing"

import type { Readable } from "node:stream"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"

/** Physical pipe frames stay small even when one logical protocol message carries media. */
export const MAX_FRAME_BYTES = 1024 * 1024
const CHUNK_BYTES = 760 * 1024
const PREFIX = "@novaclaw-frame-v1:"
const encoder = new TextEncoder()

/** The read tool accepts 20 MiB files, whose base64 spelling is larger than the former 1 MiB line
 * ceiling. Chunking belongs here at the transport seam: valid application values must never look
 * like dead workers to the execution controller. */
export function encode(line: string): string {
  const logical = line.endsWith("\n") ? line.slice(0, -1) : line
  const bytes = encoder.encode(logical)
  if (bytes.byteLength > SessionWorkerProtocol.MAX_MESSAGE_BYTES)
    throw new Error("worker message exceeds logical transport limit")
  if (bytes.byteLength <= MAX_FRAME_BYTES) return `${logical}\n`

  const total = Math.ceil(bytes.byteLength / CHUNK_BYTES)
  const frames: string[] = []
  for (let index = 0; index < total; index += 1) {
    const chunk = bytes.slice(index * CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * CHUNK_BYTES))
    const frame = `${PREFIX}${index + 1}:${total}:${Buffer.from(chunk).toString("base64")}\n`
    if (encoder.encode(frame.slice(0, -1)).byteLength > MAX_FRAME_BYTES)
      throw new Error("worker transport frame exceeds limit")
    frames.push(frame)
  }
  return frames.join("")
}

/** Yield logical JSON lines from bounded physical frames. One encoded chunk sequence is emitted by
 * one stream write, so another line in its middle is corruption rather than legitimate concurrency. */
export async function* lines(stream: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let chunks: Uint8Array[] = []
  let chunkBytes = 0
  let expectedIndex = 1
  let expectedTotal = 0

  const append = (bytes: Uint8Array) => {
    if (bytes.length === 0) return
    pending.push(bytes)
    pendingBytes += bytes.byteLength
    if (pendingBytes > MAX_FRAME_BYTES) throw new Error("worker transport frame exceeds limit")
  }
  const join = (parts: Uint8Array[], size: number) => {
    if (parts.length === 1) return parts[0]!
    const joined = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.byteLength
    }
    return joined
  }
  const consume = (physical: string): string | undefined => {
    if (!physical.startsWith(PREFIX)) {
      if (chunks.length > 0) throw new Error("worker chunk sequence was interrupted")
      return physical
    }
    const match = /^@novaclaw-frame-v1:(\d+):(\d+):([A-Za-z0-9+/]*={0,2})$/.exec(physical)
    if (!match) throw new Error("worker transport frame is malformed")
    const index = Number(match[1])
    const total = Number(match[2])
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 2 || index !== expectedIndex)
      throw new Error("worker transport frame is out of sequence")
    if (expectedIndex === 1) expectedTotal = total
    if (total !== expectedTotal) throw new Error("worker transport frame count changed mid-message")
    const chunk = new Uint8Array(Buffer.from(match[3]!, "base64"))
    if (chunk.byteLength === 0 || chunk.byteLength > CHUNK_BYTES)
      throw new Error("worker transport frame has an invalid payload")
    chunks.push(chunk)
    chunkBytes += chunk.byteLength
    if (chunkBytes > SessionWorkerProtocol.MAX_MESSAGE_BYTES)
      throw new Error("worker message exceeds logical transport limit")
    expectedIndex += 1
    if (index !== total) return undefined
    const logical = decoder.decode(join(chunks, chunkBytes))
    chunks = []
    chunkBytes = 0
    expectedIndex = 1
    expectedTotal = 0
    return logical
  }

  for await (const raw of stream) {
    const bytes = typeof raw === "string" ? encoder.encode(raw) : new Uint8Array(raw as Uint8Array)
    let offset = 0
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(10, offset)
      if (newline < 0) {
        append(bytes.slice(offset))
        break
      }
      append(bytes.slice(offset, newline))
      const physical = decoder.decode(join(pending, pendingBytes)).replace(/\r$/, "")
      pending = []
      pendingBytes = 0
      const logical = consume(physical)
      if (logical) yield logical
      offset = newline + 1
    }
  }
  if (pendingBytes > 0) {
    const logical = consume(decoder.decode(join(pending, pendingBytes)).replace(/\r$/, ""))
    if (logical) yield logical
  }
  if (chunks.length > 0) throw new Error("worker transport ended mid-message")
}
