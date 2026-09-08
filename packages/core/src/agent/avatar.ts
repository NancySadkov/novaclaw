export * as Avatar from "./avatar"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "../global"
// @ts-expect-error Bun's file-loader import is resolved at build time; TypeScript has no WebP module.
import novaPortraitFile from "../../../app/public/assets/agents/portraits/nova.webp" with { type: "file" }
// @ts-expect-error Bun's file-loader import is resolved at build time; TypeScript has no WebP module.
import geryonPortraitFile from "../../../app/public/assets/agents/portraits/geryon.webp" with { type: "file" }
// @ts-expect-error Bun's file-loader import is resolved at build time; TypeScript has no WebP module.
import xeniaPortraitFile from "../../../app/public/assets/agents/portraits/xenia.webp" with { type: "file" }
// @ts-expect-error Bun's file-loader import is resolved at build time; TypeScript has no WebP module.
import daedalusPortraitFile from "../../../app/public/assets/agents/portraits/daedalus.webp" with { type: "file" }
// @ts-expect-error Bun's file-loader import is resolved at build time; TypeScript has no WebP module.
import myronPortraitFile from "../../../app/public/assets/agents/portraits/myron.webp" with { type: "file" }

/** The avatar is a small identity component, not an arbitrary file upload. */
export const MAX_BYTES = 5 * 1024 * 1024

const TYPES = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const

export type Mime = keyof typeof TYPES

export interface Stored {
  readonly bytes: Uint8Array
  readonly mime: Mime
  readonly hash: string
}

export type Portrait =
  | { readonly kind: "image"; readonly bytes: Uint8Array; readonly mime: Mime; readonly hash: string }
  | { readonly kind: "glyph"; readonly text: string }
  | { readonly kind: "placeholder"; readonly bytes: Uint8Array; readonly mime: "image/svg+xml"; readonly hash: string }

const extensions = Object.values(TYPES)

/**
 * The faces that ship with the initial company. They enter through the SERVER-owned portrait
 * resolver, just like an uploaded image, so the UI and a visual model receive the same bytes.
 *
 * These files remain part of the embedded web assets too, but the renderer never derives this path
 * from an agent name. The import makes the files reachable from both the standalone binary and the
 * desktop's bundled Node sidecar; a source-tree-relative `readFile` would work in development and
 * disappear in the packaged product.
 */
const BUILTIN_PORTRAITS: Readonly<Record<string, string>> = {
  nova: novaPortraitFile,
  geryon: geryonPortraitFile,
  xenia: xeniaPortraitFile,
  daedalus: daedalusPortraitFile,
  myron: myronPortraitFile,
}

const baseAgentID = (agentID: string) => agentID.trim().toLowerCase().replace(/-\d+$/, "")

/** Bun's file loader emits an absolute path in source runs and a chunk-relative path in a bundle. */
export const bundledAssetPath = (file: string, moduleURL: string = import.meta.url) =>
  path.isAbsolute(file) ? file : fileURLToPath(new URL(file, moduleURL))

export const builtin = async (agentID: string): Promise<Stored | undefined> => {
  const file = BUILTIN_PORTRAITS[baseAgentID(agentID)]
  if (file === undefined) return undefined
  try {
    const bytes = new Uint8Array(await fs.readFile(bundledAssetPath(file)))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return undefined
    return { bytes, mime: "image/webp", hash: digest(bytes) }
  } catch {
    return undefined
  }
}

export const mime = (value: string | undefined): Mime | undefined => {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase()
  return normalized !== undefined && normalized in TYPES ? (normalized as Mime) : undefined
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const agentKey = (agentID: string) => createHash("sha256").update(agentID).digest("hex")

export const rootIn = (dataDirectory: string) => path.join(dataDirectory, "agent-avatars")

const manifestPath = (root: string, agentID: string) => path.join(root, `${agentKey(agentID)}.json`)
const blobPath = (root: string, agentID: string, hash: string, format: Mime) =>
  path.join(root, `${agentKey(agentID)}-${hash}.${TYPES[format]}`)

const readManifest = async (root: string, agentID: string): Promise<{ hash: string; mime: Mime } | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath(root, agentID), "utf8"))
    if (parsed === null || typeof parsed !== "object") return undefined
    const record = parsed as { hash?: unknown; mime?: unknown }
    const format = mime(typeof record.mime === "string" ? record.mime : undefined)
    if (typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash) || format === undefined) return undefined
    return { hash: record.hash, mime: format }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return undefined
  }
}

/** Read and verify an avatar. A corrupt or half-written component is treated as absent. */
export const readIn = async (dataDirectory: string, agentID: string): Promise<Stored | undefined> => {
  const root = rootIn(dataDirectory)
  const metadata = await readManifest(root, agentID)
  if (metadata === undefined) return undefined
  try {
    const bytes = new Uint8Array(await fs.readFile(blobPath(root, agentID, metadata.hash, metadata.mime)))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES || digest(bytes) !== metadata.hash) return undefined
    return { bytes, mime: metadata.mime, hash: metadata.hash }
  } catch {
    return undefined
  }
}

/** Publish the blob before the manifest, so a crash leaves either the old avatar or a valid new one. */
export const writeIn = async (
  dataDirectory: string,
  agentID: string,
  bytes: Uint8Array,
  contentType: string | undefined,
): Promise<Stored> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new Error(`Avatar is empty or larger than ${MAX_BYTES} bytes`)
  }
  const format = mime(contentType)
  if (format === undefined) throw new Error("Avatar must be PNG, JPEG, GIF or WebP")
  const hash = digest(bytes)
  const root = rootIn(dataDirectory)
  await fs.mkdir(root, { recursive: true })
  const blob = blobPath(root, agentID, hash, format)
  const manifest = manifestPath(root, agentID)
  const blobTemp = `${blob}.tmp-${randomUUID()}`
  const manifestTemp = `${manifest}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(blobTemp, bytes, { flag: "wx" })
    await fs.rename(blobTemp, blob)
    await fs.writeFile(manifestTemp, JSON.stringify({ hash, mime: format }), { encoding: "utf8", flag: "wx" })
    await fs.rename(manifestTemp, manifest)
  } finally {
    await fs.rm(blobTemp, { force: true }).catch(() => undefined)
    await fs.rm(manifestTemp, { force: true }).catch(() => undefined)
  }
  await removeUnreferencedBlobs(root, agentID, hash, format)
  return { bytes: new Uint8Array(bytes), mime: format, hash }
}

export const removeIn = async (dataDirectory: string, agentID: string): Promise<void> => {
  const root = rootIn(dataDirectory)
  const metadata = await readManifest(root, agentID)
  await fs.rm(manifestPath(root, agentID), { force: true })
  if (metadata !== undefined) await fs.rm(blobPath(root, agentID, metadata.hash, metadata.mime), { force: true })
  await removeUnreferencedBlobs(root, agentID)
}

const removeUnreferencedBlobs = async (root: string, agentID: string, keepHash?: string, keepMime?: Mime) => {
  const prefix = `${agentKey(agentID)}-`
  const entries = await fs.readdir(root).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith(prefix) && entry !== (keepHash && keepMime ? `${prefix}${keepHash}.${TYPES[keepMime]}` : ""),
      )
      .map((entry) => fs.rm(path.join(root, entry), { force: true })),
  )
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export const placeholderLabel = (agentID: string, name?: string) =>
  [...(name?.trim() || agentID)].at(0)?.toUpperCase() || "?"

/** A stable, server-owned face for an agent that has not uploaded one. */
export const placeholder = (agentID: string, name?: string): Uint8Array => {
  const hash = digest(new TextEncoder().encode(agentID))
  const hue = Number.parseInt(hash.slice(0, 6), 16) % 360
  const label = placeholderLabel(agentID, name)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img">` +
    `<rect width="128" height="128" rx="64" fill="hsl(${hue} 45% 35%)"/>` +
    `<text x="64" y="78" text-anchor="middle" font-family="sans-serif" font-size="58" fill="white">${xml(label)}</text>` +
    `</svg>`
  return new TextEncoder().encode(svg)
}

export const portraitIn = async (
  dataDirectory: string,
  agentID: string,
  storedGlyph: string | undefined,
  name?: string,
): Promise<Portrait> => {
  const stored = await readIn(dataDirectory, agentID)
  if (stored !== undefined) return { kind: "image", ...stored }
  if (storedGlyph?.trim()) return { kind: "glyph", text: storedGlyph.trim() }
  const shipped = await builtin(agentID)
  if (shipped !== undefined) return { kind: "image", ...shipped }
  const bytes = placeholder(agentID, name)
  return { kind: "placeholder", bytes, mime: "image/svg+xml", hash: digest(bytes) }
}

export const read = (agentID: string) => readIn(Global.Path.data, agentID)
export const write = (agentID: string, bytes: Uint8Array, contentType: string | undefined) =>
  writeIn(Global.Path.data, agentID, bytes, contentType)
export const remove = (agentID: string) => removeIn(Global.Path.data, agentID)
export const portrait = (agentID: string, storedGlyph: string | undefined, name?: string) =>
  portraitIn(Global.Path.data, agentID, storedGlyph, name)
