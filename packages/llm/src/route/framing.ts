import type { Stream } from "effect"
import * as ProviderShared from "../protocols/shared"
import type { LLMError } from "../schema"

/**
 * Decode a streaming HTTP response body into provider-protocol frames.
 *
 * `Framing` is the byte-stream-shaped seam between transport and protocol.
 * Exactly one implementation ships: SSE (`Framing.sse`) — UTF-8 decode the
 * body, run the SSE channel decoder, drop empty / `[DONE]` keep-alives. Each
 * emitted frame is the JSON `data:` payload of one event.
 *
 * The seam is generic in `Frame` because a binary wire (length-prefixed
 * frames, CRC checksums) would decode to something other than a string — but
 * no such wire is implemented here, so a reader adding one is writing the
 * FIRST binary framing, not finding an existing one.
 *
 * The frame type is opaque to this layer; the protocol's `decode` step turns
 * a frame into a typed chunk.
 */
export interface Framing<Frame> {
  readonly id: string
  readonly frame: (bytes: Stream.Stream<Uint8Array, LLMError>) => Stream.Stream<Frame, LLMError>
}

/** Server-Sent Events framing. Used by every JSON-streaming HTTP provider. */
export const sse: Framing<string> = { id: "sse", frame: ProviderShared.sseFraming }

/** Runtime framing implementations. The type-level `Framing` interface shares this public name. */
export const Framing = { sse } as const
