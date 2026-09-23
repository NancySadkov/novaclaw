import fs from "node:fs/promises"
import path from "node:path"
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { lookup } from "mime-types"
import { Global } from "./global"
import * as Recipe from "./recipe"

export interface Options {
  readonly dataDirectory?: string
  readonly recipesRoot?: string
}

export interface Launch {
  readonly kind: "html" | "executable"
  readonly path: string
}

export interface Deployment {
  readonly slug: string
  readonly name: string
  readonly description?: string
  readonly state: "deploying" | "ready"
  readonly sessionID?: string
  readonly launch?: Launch
}

const rootIn = (options?: Options) => path.join(options?.dataDirectory ?? Global.Path.data, "deployed")
const metadataFile = ".novaclaw-deployment.json"
const launchFile = ".nova-launch.json"
const previewKey = randomBytes(32)
const PREVIEW_LIFETIME_MS = 60 * 60 * 1000
const previewGenerations = new Map<string, number>()

const directoryOf = (slug: string, options?: Options): string => {
  if (!Recipe.isValidSlug(slug)) throw new Error(`Invalid recipe id: ${slug}`)
  return path.join(rootIn(options), slug)
}

const contained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const readyLaunch = async (dir: string): Promise<Launch | undefined> => {
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
  if (launch.kind === "html" && !/\.html?$/i.test(target)) return undefined
  return { kind: launch.kind, path: target }
}

export async function read(slug: string, options?: Options): Promise<Deployment | undefined> {
  const dir = directoryOf(slug, options)
  const dirStat = await fs.lstat(dir).catch(() => undefined)
  if (!dirStat?.isDirectory()) return undefined
  const raw = await fs.readFile(path.join(dir, metadataFile), "utf8").catch(() => undefined)
  if (!raw) return undefined
  let metadata: unknown
  try {
    metadata = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!metadata || typeof metadata !== "object") return undefined
  const row = metadata as Record<string, unknown>
  if (typeof row.name !== "string") return undefined
  const launch = await readyLaunch(dir)
  return {
    slug,
    name: row.name,
    ...(typeof row.description === "string" ? { description: row.description } : {}),
    state: launch ? "ready" : "deploying",
    ...(typeof row.sessionID === "string" ? { sessionID: row.sessionID } : {}),
    ...(launch ? { launch } : {}),
  }
}

export async function list(options?: Options): Promise<Deployment[]> {
  const entries = await fs.readdir(rootIn(options), { withFileTypes: true }).catch(() => [])
  const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => read(entry.name, options)))
  return records.filter((record): record is Deployment => record !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

export async function deploy(slug: string, options?: Options): Promise<Deployment> {
  const recipe = await Recipe.read(slug, { ...(options?.recipesRoot ? { root: options.recipesRoot } : {}) })
  if (!recipe) throw new Error(`No recipe named "${slug}"`)
  const root = rootIn(options)
  const target = directoryOf(slug, options)
  await fs.mkdir(root, { recursive: true })
  if (await fs.lstat(target).then(() => true, () => false)) throw new Error(`Recipe "${slug}" is already deployed`)
  const stage = path.join(root, `.${slug}.stage-${randomUUID()}`)
  try {
    const receipt = await Recipe.materialize(slug, stage, { ...(options?.recipesRoot ? { root: options.recipesRoot } : {}) })
    if (receipt.skipped.length || receipt.failed.length) throw new Error(`Recipe inputs could not be copied: ${[...receipt.skipped, ...receipt.failed].join(", ")}`)
    await fs.rm(path.join(stage, launchFile), { force: true })
    await fs.writeFile(path.join(stage, metadataFile), JSON.stringify({ name: recipe.name, description: recipe.description }), "utf8")
    await fs.rename(stage, target)
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
  const deployed = await read(slug, options)
  if (!deployed) throw new Error(`Deployment "${slug}" could not be read back`)
  return deployed
}

export async function assignSession(slug: string, sessionID: string, options?: Options): Promise<Deployment> {
  const dir = directoryOf(slug, options)
  const current = await read(slug, options)
  if (!current) throw new Error(`No deployment named "${slug}"`)
  await fs.writeFile(path.join(dir, metadataFile), JSON.stringify({ name: current.name, description: current.description, sessionID }), "utf8")
  return (await read(slug, options))!
}

export async function undeploy(slug: string, options?: Options): Promise<boolean> {
  const dir = directoryOf(slug, options)
  const stat = await fs.lstat(dir).catch(() => undefined)
  if (!stat?.isDirectory()) return false
  previewGenerations.set(slug, (previewGenerations.get(slug) ?? 0) + 1)
  await fs.rm(dir, { recursive: true, force: true })
  return true
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
  if (!match || match[1] !== slug || Number(match[2]) !== (previewGenerations.get(slug) ?? 0) || Number(match[3]) < Date.now()) return false
  const payload = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
  const wanted = createHmac("sha256", previewKey).update(payload).digest()
  return timingSafeEqual(wanted, Buffer.from(match[5], "hex"))
}

export async function readPreviewFile(slug: string, relative: string, options?: Options): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const dir = directoryOf(slug, options)
  const dirStat = await fs.lstat(dir).catch(() => undefined)
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return undefined
  const parts = relative.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
      parts[0] === Recipe.RECIPE_FILE || relative.includes("\\") || relative.includes("\0")) return undefined
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
