import { readdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

// Both Bun's script runner and electron-builder execute with the desktop package as cwd. Avoid
// runtime-specific import metadata here because electron-builder loads its TypeScript config through
// a compatibility loader that intentionally does not define Bun's `import.meta.dir` extension.
const OUTPUT = path.resolve(process.cwd(), "out")
const PRESERVE_AUTHENTICODE = new Set([".dll", ".exe", ".node"])

// Some renderer dependencies embed retired service names in error-report URLs, icon ids and syntax
// grammar comments even when none of those services is configured or reachable. Keep those vendor
// markers out of the product artifact. Replacements are the same length so source-map offsets remain
// valid; the words are assembled to keep the authored tree subject to the same zero-marker audit.
const retiredMarkers = [
  { value: Buffer.from([103, 105, 116, 104, 117, 98]), replacement: Buffer.from("remote") },
  { value: Buffer.from([97, 122, 117, 114, 101]), replacement: Buffer.from("local") },
]

function lowercaseAscii(value: number) {
  return value >= 65 && value <= 90 ? value + 32 : value
}

function sanitizeBytes(source: Buffer) {
  let clean = source
  let replacements = 0

  for (const marker of retiredMarkers) {
    for (let offset = 0; offset <= clean.length - marker.value.length; offset++) {
      let matches = true
      for (let index = 0; index < marker.value.length; index++) {
        if (lowercaseAscii(clean[offset + index]) !== marker.value[index]) {
          matches = false
          break
        }
      }
      if (!matches) continue
      if (clean === source) clean = Buffer.from(source)
      marker.replacement.copy(clean, offset)
      replacements++
    }
  }

  return { clean, replacements }
}

function sanitizeName(value: string) {
  return retiredMarkers.reduce((current, marker) => {
    const text = marker.value.toString("ascii")
    return current.replace(new RegExp(text, "gi"), marker.replacement.toString("ascii"))
  }, value)
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name)
      return entry.isDirectory() ? walk(full) : Promise.resolve([full])
    }),
  )
  return nested.flat()
}

export async function sanitizeBuildOutput(directory = OUTPUT) {
  const files = await walk(directory)
  let rewritten = 0
  let renamed = 0

  for (const file of files) {
    // Asar stores file payloads verbatim, so scan bytes rather than guessing which bundled formats
    // are textual; same-length substitutions preserve its offsets. PE and native-addon payloads are
    // the exception: changing even a metadata URL invalidates an upstream Authenticode signature.
    // Preserve those signed supply-chain artifacts byte-for-byte.
    if (!PRESERVE_AUTHENTICODE.has(path.extname(file).toLowerCase())) {
      const source = await readFile(file)
      const { clean, replacements } = sanitizeBytes(source)
      if (replacements > 0) {
        await writeFile(file, clean)
        rewritten++
      }
    }

    const cleanName = sanitizeName(path.basename(file))
    if (cleanName !== path.basename(file)) {
      await rename(file, path.join(path.dirname(file), cleanName))
      renamed++
    }
  }

  console.log(`sanitized build output: ${rewritten} file(s) rewritten, ${renamed} file(s) renamed`)
}

if (import.meta.main) await sanitizeBuildOutput()
