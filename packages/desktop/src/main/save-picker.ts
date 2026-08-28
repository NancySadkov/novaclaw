import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"

export const MAX_SAVE_BYTES = 20 * 1024 * 1024

type SaveWriter = (path: string, content: string) => Promise<void>

export type SavePickerOptions = {
  readonly title?: string
  readonly defaultPath?: string
}

const optionalBoundedString = (value: unknown, name: string, maxLength: number): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`)
  if (value.length > maxLength) throw new TypeError(`${name} is too long`)
  return value
}

/** Runtime validation for the renderer-controlled save-dialog request. */
export function parseSavePickerOptions(value: unknown): SavePickerOptions {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Save picker options must be an object")
  const input = value as Record<string, unknown>
  const unexpected = Object.keys(input).filter((key) => key !== "title" && key !== "defaultPath")
  if (unexpected.length > 0) throw new TypeError(`Unexpected save picker option: ${unexpected[0]}`)
  return {
    title: optionalBoundedString(input.title, "Save picker title", 512),
    defaultPath: optionalBoundedString(input.defaultPath, "Save picker default path", 32_768),
  }
}

export async function writeSelectedFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8")
}

/**
 * Carries one native save-picker decision to exactly one bounded write.
 *
 * A token is scoped to the WebContents that opened the picker, names one main-process-held path,
 * and is deleted before its write begins. A renderer can therefore neither substitute a path nor
 * replay a successful or failed attempt.
 */
export function createSaveFileAuthorizations(write: SaveWriter = writeSelectedFile, maxBytes = MAX_SAVE_BYTES) {
  const selections = new Map<string, { sender: number; path: string }>()

  return {
    add(sender: number, path: string): string {
      const token = randomUUID()
      selections.set(token, { sender, path })
      return token
    },

    async write(sender: number, token: unknown, content: unknown): Promise<void> {
      if (typeof token !== "string" || token.length > 128) throw new TypeError("Save token must be a string")
      const selection = selections.get(token)
      if (selection?.sender !== sender) throw new Error("File was not selected for saving by this window")

      // One shot means one ATTEMPT. Burn the authority before validating or touching the file so a
      // rejected payload and a failed filesystem operation cannot be retried through the same token.
      selections.delete(token)
      if (typeof content !== "string") throw new TypeError("Saved content must be a string")
      if (Buffer.byteLength(content, "utf8") > maxBytes)
        throw new Error(`Saved content exceeds the ${maxBytes / 1024 / 1024} MB limit`)
      await write(selection.path, content)
    },

    releaseSender(sender: number): void {
      for (const [token, selection] of selections) if (selection.sender === sender) selections.delete(token)
    },
  }
}
