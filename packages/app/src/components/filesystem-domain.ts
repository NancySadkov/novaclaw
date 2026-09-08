export type FilesystemEntryType = "file" | "directory"
export type FilesystemShortcut = "delete" | "rename" | "new-folder"

const normalized = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")

export function filesystemName(value: string) {
  const parts = normalized(value).split("/").filter(Boolean)
  return parts.at(-1) ?? value
}

export function filesystemParent(value: string): string | undefined {
  const path = normalized(value)
  if (!path || path === "/" || /^[A-Za-z]:$/.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path)) return undefined
  const index = path.lastIndexOf("/")
  if (index < 0) return undefined
  if (index === 0) return "/"
  if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3)
  return path.slice(0, index)
}

export function filesystemJoin(parent: string, name: string) {
  const root = parent.replaceAll("\\", "/").replace(/\/+$/, "")
  if (!root || root === "/") return `/${name}`
  return `${root}/${name}`
}

export function filesystemEntryNameError(value: string): "empty" | "reserved" | "separator" | undefined {
  const name = value.trim()
  if (!name) return "empty"
  if (name === "." || name === "..") return "reserved"
  if (/[\\/\0]/.test(name)) return "separator"
  return undefined
}

export function filesystemShortcut(input: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  editable?: boolean
}): FilesystemShortcut | undefined {
  if (input.editable) return undefined
  if (input.key === "Delete" && !input.ctrlKey && !input.metaKey && !input.altKey) return "delete"
  if (input.key === "F2" && !input.ctrlKey && !input.metaKey && !input.altKey) return "rename"
  if (input.key.toLowerCase() === "n" && (input.ctrlKey || input.metaKey) && input.shiftKey && !input.altKey)
    return "new-folder"
  return undefined
}

export function isEditableFilesystemTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}
