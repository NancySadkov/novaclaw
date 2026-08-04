export * as ToolDiscovery from "./tool-discovery"

import type { SessionMessage } from "./session/message"

export const RESULT_KIND = "tool-discovery"

/** Reconstruct the callable deferred set exclusively from the projected transcript. Rewind/undo
 *  therefore removes a discovery without a parallel session cache to repair. Compaction also forms
 *  the deliberate eviction boundary described by tool-scale T3. */
export function discovered(messages: ReadonlyArray<SessionMessage.Message>): ReadonlySet<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "tool_search" || part.state.status !== "completed") continue
      const structured = part.state.structured
      if (structured.kind !== RESULT_KIND || !Array.isArray(structured.tools)) continue
      for (const candidate of structured.tools) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue
        const name = Reflect.get(candidate, "name")
        if (typeof name === "string") names.add(name)
      }
    }
  }
  return names
}
