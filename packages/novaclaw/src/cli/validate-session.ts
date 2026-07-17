// SDK helper: validate a `-s <session>` id against a server (decode + session.get).
// Relocated out of the removed cli/tui/ dir when the TUI was retired; used by the
// headless CLI path and the server SDK tests.
import { createNovaclawClient } from "@novaclaw/sdk/v2"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

const decodeSessionID = Schema.decodeUnknownSync(SessionID)

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.sessionID) return

  let sessionID: SessionID
  try {
    sessionID = decodeSessionID(input.sessionID)
  } catch (error) {
    throw new Error(`Invalid session ID: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error })
  }

  await createNovaclawClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  }).v2.session.get({ sessionID }, { throwOnError: true })
}
