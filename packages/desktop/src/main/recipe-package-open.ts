import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"

export interface OpenedRecipePackage {
  readonly name: string
  readonly bytes: Uint8Array
}

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const VALUE_OPTIONS = new Set([
  "--home", "--connect", "--connect-username", "--connect-password", "--hostname", "--port",
  "--username", "--password", "--cors", "--mdns-domain",
])

export function recipePackagePaths(argv: readonly string[]): string[] {
  const paths: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    if (VALUE_OPTIONS.has(arg)) {
      index++
      continue
    }
    if (!arg.startsWith("-") && extname(arg).toLowerCase() === ".nova") paths.push(resolve(arg))
  }
  return paths
}

export async function readRecipePackage(filePath: string): Promise<OpenedRecipePackage> {
  if (extname(filePath).toLowerCase() !== ".nova") throw new Error("Open a .nova recipe package")
  const info = await stat(filePath)
  if (!info.isFile() || info.size === 0 || info.size > MAX_PACKAGE_BYTES)
    throw new Error("Recipe package must be a file of at most 32 MB")
  const bytes = await readFile(filePath)
  if (bytes.length > MAX_PACKAGE_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error("That .nova file is not a valid ZIP package")
  return { name: basename(filePath), bytes }
}
