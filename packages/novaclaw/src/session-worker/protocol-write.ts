import type { Writable } from "node:stream"

export type ProtocolWritable = Pick<Writable, "write" | "on">

/** Node streams report a broken pipe either synchronously, through the write callback, through the
 * `error` event, or through both. Protocol users must install both arms before their first write. */
export function observeErrors(stream: ProtocolWritable, fail: (error: Error) => void) {
  stream.on("error", fail)
}

export function write(stream: ProtocolWritable, line: string, fail: (error: Error) => void) {
  try {
    stream.write(line, (error?: Error | null) => {
      if (error) fail(error)
    })
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
}
