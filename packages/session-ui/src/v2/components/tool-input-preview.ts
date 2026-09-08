/**
 * Tool metadata must not wait for execution to finish. Pending calls carry their input as a live
 * JSON string, and schema-leading fields such as `path` are often complete long before a large
 * `oldString`, `newString`, or file body finishes streaming.
 *
 * Decode only complete top-level members. Returning a partial string would make the transcript
 * confidently name the wrong file; returning completed members lets every row show what is already
 * known without requiring the whole tool call to be valid JSON yet.
 */
export function toolInputForDisplay(state: {
  readonly status: string
  readonly input?: unknown
}): Record<string, unknown> {
  if (state.status !== "pending") return isRecord(state.input) ? state.input : {}
  return typeof state.input === "string" ? completeTopLevelMembers(state.input) : {}
}

function completeTopLevelMembers(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let index = whitespaceEnd(raw, 0)
  if (raw[index] !== "{") return result
  index += 1

  while (index < raw.length) {
    index = whitespaceEnd(raw, index)
    if (raw[index] === "}") return result

    const keyEnd = jsonStringEnd(raw, index)
    if (keyEnd === undefined) return result
    let key: unknown
    try {
      key = JSON.parse(raw.slice(index, keyEnd))
    } catch {
      return result
    }
    if (typeof key !== "string") return result

    index = whitespaceEnd(raw, keyEnd)
    if (raw[index] !== ":") return result
    index = whitespaceEnd(raw, index + 1)

    const valueEnd = jsonValueEnd(raw, index)
    if (valueEnd === undefined) return result
    try {
      // A model supplies these keys. Define an own data property so `__proto__` remains ordinary
      // input rather than invoking Object.prototype's legacy setter.
      Object.defineProperty(result, key, {
        value: JSON.parse(raw.slice(index, valueEnd)),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    } catch {
      return result
    }

    index = whitespaceEnd(raw, valueEnd)
    if (raw[index] === ",") {
      index += 1
      continue
    }
    return result
  }
  return result
}

function whitespaceEnd(raw: string, start: number): number {
  let index = start
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1
  return index
}

function jsonStringEnd(raw: string, start: number): number | undefined {
  if (raw[start] !== '"') return undefined
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") {
      index += 1
      continue
    }
    if (raw[index] === '"') return index + 1
  }
  return undefined
}

function jsonValueEnd(raw: string, start: number): number | undefined {
  const first = raw[start]
  if (first === '"') return jsonStringEnd(raw, start)
  if (first === "{" || first === "[") {
    const closers = [first === "{" ? "}" : "]"]
    for (let index = start + 1; index < raw.length; index += 1) {
      const char = raw[index]!
      if (char === '"') {
        const end = jsonStringEnd(raw, index)
        if (end === undefined) return undefined
        index = end - 1
        continue
      }
      if (char === "{") closers.push("}")
      else if (char === "[") closers.push("]")
      else if (char === closers.at(-1)) {
        closers.pop()
        if (closers.length === 0) return index + 1
      }
    }
    return undefined
  }

  for (let index = start; index < raw.length; index += 1) {
    if (raw[index] === "," || raw[index] === "}") return index
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
