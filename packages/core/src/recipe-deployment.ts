import fs from "node:fs/promises"
import path from "node:path"
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { lookup } from "mime-types"
import { Global } from "./global"
import * as Recipe from "./recipe"

export interface Launch {
  readonly kind: "html" | "executable"
  readonly path: string
}

const launchFile = ".nova-launch.json"
const ownerFile = ".novaclaw-project"
const previewKey = randomBytes(32)
const PREVIEW_LIFETIME_MS = 60 * 60 * 1000
const previewGenerations = new Map<string, number>()

export async function materialize(
  slug: string,
  projectID: string,
  options?: {
    readonly directory?: string
    readonly homeDirectory?: string
    readonly recipesRoot?: string
  },
): Promise<string> {
  const directory =
    options?.directory?.trim() ||
    path.join(
      options?.homeDirectory ?? Global.Path.explicitHome ?? Global.Path.data,
      "projects",
      `${slug}-${projectID.slice(-8)}`,
    )
  if (!path.isAbsolute(directory)) throw new Error("Use an absolute project folder path on the server.")
  const target = path.resolve(directory)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const parent = await fs.realpath(path.dirname(target))
  const resolved = path.join(parent, path.basename(target))
  const stage = path.join(parent, `.nova-stage-${randomUUID()}`)
  let claimed = false
  try {
    await fs.mkdir(resolved)
    claimed = true
    const receipt = await Recipe.materialize(
      slug,
      stage,
      options?.recipesRoot ? { root: options.recipesRoot } : undefined,
    )
    if (receipt.skipped.length || receipt.failed.length)
      throw new Error(`Recipe inputs could not be copied: ${[...receipt.skipped, ...receipt.failed].join(", ")}`)
    await fs.rm(path.join(stage, launchFile), { force: true })
    await fs.writeFile(path.join(stage, ownerFile), projectID, "utf8")
    for (const entry of await fs.readdir(stage)) await fs.rename(path.join(stage, entry), path.join(resolved, entry))
    return resolved
  } catch (cause) {
    if (claimed) await fs.rm(resolved, { recursive: true, force: true })
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("The project folder already exists. Choose a new folder; existing files are never replaced.")
    throw cause
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

export async function remove(projectID: string, directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Invalid project folder.")
  const stat = await fs.lstat(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined
    throw cause
  })
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== path.resolve(directory))
    throw new Error("The project folder was moved or replaced. Its files were preserved.")
  if ((await fs.readFile(path.join(directory, ownerFile), "utf8")) !== projectID)
    throw new Error("The project folder's ownership could not be verified. Its files were preserved.")
  previewGenerations.set(projectID, (previewGenerations.get(projectID) ?? 0) + 1)
  await fs.rm(directory, { recursive: true, force: true })
}

const contained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export const readyLaunch = async (dir: string): Promise<Launch | undefined> => {
  const root = await fs.lstat(dir).catch(() => undefined)
  if (!root?.isDirectory() || root.isSymbolicLink()) return undefined
  const raw = await fs.readFile(path.join(dir, launchFile), "utf8").catch(() => undefined)
  if (!raw) return undefined
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!candidate || typeof candidate !== "object") return undefined
  const launch = candidate as Record<string, unknown>
  if (launch.kind !== "html" && launch.kind !== "executable") return undefined
  if (typeof launch.path !== "string" || !launch.path || launch.path.includes("\\") || launch.path.includes("\0"))
    return undefined
  const parts = launch.path.split("/")
  if (parts.some((part) => !part || part === "." || part === "..") || path.isAbsolute(launch.path)) return undefined
  const target = path.resolve(dir, ...parts)
  if (!contained(dir, target)) return undefined
  let current = dir
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) return undefined
  }
  const stat = await fs.lstat(target).catch(() => undefined)
  if (!stat?.isFile()) return undefined
  if (!contained(await fs.realpath(dir), await fs.realpath(target))) return undefined
  if (launch.kind === "html" && !/\.html?$/i.test(target)) return undefined
  return { kind: launch.kind, path: target }
}

export function issuePreviewTicket(slug: string): string {
  if (!Recipe.isValidSlug(slug)) throw new Error("Invalid deployment id")
  const expires = Date.now() + PREVIEW_LIFETIME_MS
  const nonce = randomBytes(12).toString("hex")
  const payload = `${slug}.${previewGenerations.get(slug) ?? 0}.${expires}.${nonce}`
  const signature = createHmac("sha256", previewKey).update(payload).digest("hex")
  return `${payload}.${signature}`
}

export function verifyPreviewTicket(slug: string, ticket: string): boolean {
  const match = /^([a-z0-9][a-z0-9-_]{0,63})\.(\d+)\.(\d{13})\.([a-f0-9]{24})\.([a-f0-9]{64})$/.exec(ticket)
  if (
    !match ||
    match[1] !== slug ||
    Number(match[2]) !== (previewGenerations.get(slug) ?? 0) ||
    Number(match[3]) < Date.now()
  )
    return false
  const payload = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
  const wanted = createHmac("sha256", previewKey).update(payload).digest()
  return timingSafeEqual(wanted, Buffer.from(match[5], "hex"))
}

export async function readPreviewFile(
  slug: string,
  relative: string,
  directory: string,
): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const dir = directory
  const dirStat = await fs.lstat(dir).catch(() => undefined)
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return undefined
  const parts = relative.split("/")
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
    parts[0] === Recipe.RECIPE_FILE ||
    relative.includes("\\") ||
    relative.includes("\0")
  )
    return undefined
  const target = path.resolve(dir, ...parts)
  if (!contained(dir, target)) return undefined
  let cursor = dir
  for (const part of parts) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) return undefined
  }
  const stat = await fs.lstat(target).catch(() => undefined)
  if (!stat?.isFile() || stat.size > Recipe.ARCHIVE_FILE_CAP) return undefined
  const canonicalDir = await fs.realpath(dir).catch(() => undefined)
  const canonicalTarget = await fs.realpath(target).catch(() => undefined)
  if (!canonicalDir || !canonicalTarget || !contained(canonicalDir, canonicalTarget)) return undefined
  return { bytes: await fs.readFile(target), mime: lookup(target) || "application/octet-stream" }
}
