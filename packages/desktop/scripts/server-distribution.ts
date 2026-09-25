#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Assemble the standalone SERVER distribution — the half a host machine gets when it runs NovaClaw
 * with no desktop.
 *
 * It reuses the desktop build's staged trees instead of rebuilding anything: `resources/server` is the
 * compiled headless server (with `host.dll` and the DHT sidecar beside it) and `resources/third-party`
 * is the agent toolchain. `bundled-tool.ts` lets the server find those beside itself, so no launcher
 * has to export paths.
 *
 * Run after the desktop `prebuild` (which is where both source trees are produced).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, "..")
const repo = path.resolve(desktop, "../..")
const version = (await Bun.file(path.join(repo, "package.json")).json()).version as string
const platform = process.platform === "win32" ? "windows" : process.platform
const serverSource = path.join(repo, "packages", "novaclaw", "dist", `novaclaw-${platform}-${process.arch}`, "bin")
const toolsSource = path.join(desktop, "resources", "third-party")
const ladybugSource = path.join(desktop, "node_modules", "@ladybugdb")
const name = `NovaClaw-${version}-server-${platform}-${process.arch}`
const out = path.join(desktop, "dist", name)
const archive = path.join(desktop, "dist", `${name}.7z`)

if (!existsSync(serverSource))
  throw new Error(`the compiled server is missing at ${serverSource}; run prebuild first`)

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(serverSource, out, { recursive: true })
if (existsSync(toolsSource)) await cp(toolsSource, path.join(out, "third-party"), { recursive: true })
// The KB graph engine is loaded by a runtime `createRequire`; the standalone server finds it beside
// itself through `bundledModulePath`. `dereference` is load-bearing: the workspace copy is a symlink
// into Bun's store, and a link would dangle on the host the archive is unpacked on.
if (!existsSync(ladybugSource)) throw new Error(`the KB engine is missing at ${ladybugSource}`)
await cp(ladybugSource, path.join(out, "node_modules", "@ladybugdb"), { recursive: true, dereference: true })

const binary = process.platform === "win32" ? "novaclaw.exe" : "novaclaw"
await writeFile(
  path.join(out, "README.txt"),
  [
    `NovaClaw Server ${version} (${platform}-${process.arch})`,
    "",
    `Run:  ${binary} serve --port=4096 --password=<a token you choose>`,
    "",
    "Then either open http://127.0.0.1:4096 in a browser (the server serves its own web UI),",
    "or point a NovaClaw desktop client at it with:",
    "",
    `  NovaClaw.exe --client-only --connect=http://<host>:4096 --connect-password=<token>`,
    "",
    "Everything is local: the server stores its data under ~/.local/share/novaclaw unless --home",
    "names another directory.",
    "",
  ].join("\n"),
)
await writeFile(
  path.join(out, "start-server.bat"),
  ["@echo off", "cd /d \"%~dp0\"", `${binary} serve %*`, ""].join("\r\n"),
)

await rm(archive, { force: true })
const sevenZip = ["7z", "7za", "7zr"].map((exe) => Bun.which(exe)).find((found) => found)
const tar = Bun.which("bsdtar") ?? Bun.which("tar")
const argv = sevenZip
  ? [sevenZip, "a", "-mx=9", "-y", archive, "."]
  : tar && Bun.spawnSync([tar, "--version"]).stdout.toString().includes("bsdtar")
    ? [tar, "-a", "-c", "--options", "7zip:compression=lzma2", "-f", archive, "."]
    : undefined
if (!argv)
  throw new Error("cannot write the server archive: no 7-Zip (7z/7za/7zr) and no bsdtar on PATH")

const result = Bun.spawnSync(argv, { cwd: out, stdout: "inherit", stderr: "inherit" })
if (result.exitCode !== 0) throw new Error(`${argv[0]} exited ${result.exitCode} archiving ${name}`)

const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`)
console.log(`server distribution: ${archive}`)
console.log(`sha256: ${digest}`)
