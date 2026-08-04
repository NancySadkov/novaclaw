import { $ } from "bun"
import path from "node:path"

// The channel resolver lives in ONE place (`script/lib/channel.ts`) and is re-exported here so the
// existing `./utils` import sites (copy-icons, copy-metainfo, prebuild) keep working. The local copy
// this replaces silently fell back to "dev" on an unrecognised value and did not understand the
// "latest" alias, so it disagreed with electron.vite.config.ts about what `latest` means.
export { resolveChannel } from "../../../script/lib/channel"
export type { Channel } from "../../../script/lib/channel"

/** The canonical version — the root package.json, the single source of truth. Read from disk rather
 *  than imported from @novaclaw/core so these build scripts need no dependency on the kernel. */
export async function canonicalVersion(): Promise<string> {
  const rootPkg = path.resolve(import.meta.dir, "../../../package.json")
  const version = (await Bun.file(rootPkg).json()).version
  if (typeof version !== "string" || version.length === 0)
    throw new Error(`the root package.json has no "version" — it is the single source of truth`)
  return version
}

export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "novaclaw-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "novaclaw-darwin-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    ocBinary: "novaclaw-windows-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "novaclaw-windows-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "novaclaw-linux-x64-baseline",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "novaclaw-linux-arm64",
    assetExt: "tar.gz",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentSidecar(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${target}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string) {
  const dir = `resources`
  await $`mkdir -p ${dir}`
  const dest = windowsify(`${dir}/novaclaw-cli`)
  await $`cp ${source} ${dest}`
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
