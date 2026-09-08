import { readFileSync } from "node:fs"
import path from "node:path"

/** Extract dictionary keys from the source form used by the app and desktop locale modules. */
export function i18nKeys(source: string): string[] {
  const keys = new Set<string>()
  for (const match of source.matchAll(/^\s*["']([^"']+)["']\s*:/gm)) keys.add(match[1]!)
  return [...keys].sort()
}

export type RendererI18nResult = {
  readonly expected: number
  readonly missing: readonly string[]
  readonly controlKey: string
  readonly controlPresent: boolean
}

/**
 * Check that the bytes emitted into the packaged renderer still contain every source dictionary key.
 *
 * The bundle is intentionally treated as opaque text. An asar is an archive of the emitted files,
 * and the locale keys are ordinary UTF-8 string literals in the renderer chunk; reading the archive
 * bytes catches a stale renderer without needing to unpack or execute it. It also works for a
 * signed/package directory where the renderer is inside `resources/app.asar`.
 */
export function checkRendererI18n(
  sources: readonly string[],
  bundle: string,
  controlKey = "files.title",
): RendererI18nResult {
  const expected = [...new Set(sources.flatMap(i18nKeys))].sort()
  // Scan the opaque asar once. Calling `bundle.includes` once per key turns a 100 MB archive into
  // an O(keys × archive) check and made the smoke look hung on the real packaged artifact.
  const expectedSet = new Set(expected)
  const present = new Set<string>()
  for (const match of bundle.matchAll(/[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)*/g)) {
    const key = match[0]
    if (key !== undefined && expectedSet.has(key)) present.add(key)
  }
  const missing = expected.filter((key) => !present.has(key))
  return {
    expected: expected.length,
    missing,
    controlKey,
    controlPresent: present.has(controlKey),
  }
}

/** Read the packaged Electron archive beside an executable. */
export function readPackagedRenderer(executable: string): string {
  const archive = path.join(path.dirname(executable), "resources", "app.asar")
  return readFileSync(archive, "utf8")
}
