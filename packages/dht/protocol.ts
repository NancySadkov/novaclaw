import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DHT_PROTOCOL_VERSION = "novaclaw-dht-jsonl/1"
export const DHT_ARTIFACT_SCHEMA = 1

const DHT_ROOT = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_FILES = ["Cargo.toml", "Cargo.lock", "src/main.rs"] as const

export interface DhtArtifactIdentity {
  readonly protocol: string
  readonly version: string
  readonly source: string
  readonly platform: string
  readonly arch: string
}

export interface DhtArtifactManifest extends DhtArtifactIdentity {
  readonly schema: number
  readonly executable: string
}

export interface DhtProbeResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

export type DhtProbeRunner = (
  executable: string,
  options: { readonly input: string; readonly env: NodeJS.ProcessEnv; readonly timeout: number },
) => DhtProbeResult

function normalizePlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? "windows" : platform
}

function normalizeArch(arch: string): string {
  if (arch === "x64") return "x86_64"
  if (arch === "arm64") return "aarch64"
  return arch
}

/**
 * ⚠️ **`packages/core/src/community/dht.ts` exports an identical `dhtExecutableName`, and the two
 * copies are deliberate.** This file is the TS shim beside a cargo crate: `packages/dht` declares no
 * dependencies and publishes no `exports` map, so it can neither import from the workspace nor be
 * imported by it — its readers (`build.ts` here, `desktop/scripts/dht-packaging.ts`) reach it by
 * relative path precisely because of that. Merging would mean giving a Rust crate a workspace
 * dependency and a published TypeScript surface to save one ternary.
 *
 * **If you rename the binary, change BOTH** — and the Rust crate's own output name with them.
 */
export function dhtExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "novaclaw-dht.exe" : "novaclaw-dht"
}

/**
 * The content identity compiled into the sidecar and written beside it.
 *
 * A git hash is deliberately not used: release source archives have no `.git`, and a dirty source
 * tree still needs an honest identity. Hashing the Rust source plus its dependency lock makes the
 * identifier reproducible in both environments and changes whenever the executable's inputs do.
 */
export async function dhtSourceIdentity(root: string = DHT_ROOT): Promise<string> {
  const hash = createHash("sha256")
  for (const relative of SOURCE_FILES) {
    const bytes = await readFile(path.join(root, relative))
    hash.update(relative)
    hash.update("\0")
    hash.update(String(bytes.byteLength))
    hash.update("\0")
    hash.update(bytes)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

export async function expectedDhtIdentity(
  root: string = DHT_ROOT,
  productVersion?: string,
): Promise<DhtArtifactIdentity> {
  const version =
    productVersion ??
    (JSON.parse(await readFile(path.resolve(root, "../..", "package.json"), "utf8")) as { version: string }).version
  return {
    protocol: DHT_PROTOCOL_VERSION,
    version,
    source: await dhtSourceIdentity(root),
    platform: normalizePlatform(process.platform),
    arch: normalizeArch(process.arch),
  }
}

function defaultProbeRunner(executable: string, options: Parameters<DhtProbeRunner>[1]): DhtProbeResult {
  const result = spawnSync(executable, [], {
    encoding: "utf8",
    windowsHide: true,
    input: options.input,
    env: options.env,
    timeout: options.timeout,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  }
}

function describeMismatch(expected: DhtArtifactIdentity, actual: unknown): string | undefined {
  if (typeof actual !== "object" || actual === null) return "the version reply was not an object"
  const reply = actual as Record<string, unknown>
  for (const key of ["protocol", "version", "source", "platform", "arch"] as const) {
    if (reply[key] !== expected[key])
      return `${key} mismatch: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(reply[key])}`
  }
  return undefined
}

/**
 * Execute the sidecar without contacting a peer and exercise the three protocol frames packaging
 * depends on. Execution itself rejects a binary for the wrong operating system/architecture; the
 * explicit target fields catch a mislabeled executable that happens to be runnable.
 */
export function probeDhtExecutable(
  executable: string,
  expected: DhtArtifactIdentity,
  run: DhtProbeRunner = defaultProbeRunner,
): void {
  const input = [
    JSON.stringify({ op: "version" }),
    JSON.stringify({ op: "announce", addr: "not-a-routable-address" }),
    JSON.stringify({ op: "find" }),
    "",
  ].join("\n")
  const result = run(executable, {
    input,
    env: {
      ...process.env,
      NOVACLAW_DHT_BOOTSTRAP: "",
      NOVACLAW_DHT_WARMUP_SECS: "0",
      NOVACLAW_DHT_FIND_SECS: "0",
    },
    timeout: 10_000,
  })
  if (result.error) throw new Error(`could not execute ${executable}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${String(result.status)} during its protocol smoke: ${result.stderr || result.stdout}`,
    )

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 3) throw new Error(`expected 3 DHT replies, got ${lines.length}: ${result.stdout}`)

  const replies = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      throw new Error(`DHT reply ${index + 1} was not JSON: ${line}`)
    }
  })
  const mismatch = describeMismatch(expected, replies[0])
  if (mismatch) throw new Error(`incompatible DHT executable: ${mismatch}`)

  const announce = replies[1] as { announced?: unknown }
  if (announce?.announced !== false)
    throw new Error(`DHT announce frame was incompatible: expected announced:false, got ${lines[1]}`)
  const find = replies[2] as { peers?: unknown }
  if (find?.peers !== undefined && !Array.isArray(find.peers))
    throw new Error(`DHT find frame was incompatible: expected an optional peers array, got ${lines[2]}`)
}

function manifestMismatch(expected: DhtArtifactManifest, actual: unknown): string | undefined {
  if (typeof actual !== "object" || actual === null) return "manifest was not an object"
  const manifest = actual as Record<string, unknown>
  for (const key of ["schema", "executable", "protocol", "version", "source", "platform", "arch"] as const) {
    if (manifest[key] !== expected[key])
      return `${key} mismatch: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(manifest[key])}`
  }
  return undefined
}

/** Verify one staged/resources directory. Only an explicit development caller may accept absence. */
export async function verifyDhtArtifactDirectory(
  directory: string,
  options: {
    readonly required: boolean
    readonly root?: string
    readonly productVersion?: string
    readonly run?: DhtProbeRunner
  },
): Promise<"absent" | "verified"> {
  const executableName = dhtExecutableName()
  const executable = path.join(directory, executableName)
  const manifestPath = path.join(directory, "manifest.json")
  const present = existsSync(executable) || existsSync(manifestPath)
  if (!present) {
    if (options.required) throw new Error(`required DHT sidecar is absent from ${directory}`)
    return "absent"
  }
  if (!existsSync(executable)) throw new Error(`DHT artifact is incomplete: missing ${executable}`)
  if (!existsSync(manifestPath)) throw new Error(`DHT artifact is incomplete: missing ${manifestPath}`)

  const identity = await expectedDhtIdentity(options.root, options.productVersion)
  const expected: DhtArtifactManifest = {
    schema: DHT_ARTIFACT_SCHEMA,
    executable: executableName,
    ...identity,
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(`could not read DHT artifact manifest ${manifestPath}: ${String(error)}`)
  }
  const mismatch = manifestMismatch(expected, manifest)
  if (mismatch) throw new Error(`stale or wrong-platform DHT artifact: ${mismatch}`)
  probeDhtExecutable(executable, identity, options.run)
  return "verified"
}
