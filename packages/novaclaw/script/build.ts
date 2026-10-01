#!/usr/bin/env bun

import { $ } from "bun"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { fileURLToPath } from "url"

import { killTree } from "@novaclaw/core/util/kill-tree"
import { dhtExecutableName } from "../../dht/protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const prepareBundle = process.argv.includes("--prepare-bundle")
const compileBundle = process.argv.includes("--compile-bundle")
if (prepareBundle === compileBundle || !process.env.NOVACLAW_SERVER_BUILD_DIR)
  throw new Error("Run script/build-server.bat to build the standalone server")
const bundleDirectory = path.resolve(process.env.NOVACLAW_SERVER_BUILD_DIR)
const scratchDirectory = path.resolve(dir, "../../tmp")
if (!bundleDirectory.startsWith(scratchDirectory + path.sep)) throw new Error("Unexpected server build directory")
const generated = prepareBundle ? await import("./generate.ts") : undefined

import { Script } from "@novaclaw/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const reuseWebUi = process.argv.includes("--reuse-web-ui")
/**
 * Boot each host-matching artifact and prove it serves. OFF by default, on purpose — see the block at
 * the bottom of the target loop. The release gate passes it; a plain compile does not.
 */
const verifyArtifacts = process.argv.includes("--verify")

const createWebUIResourceMap = async () => {
  console.log(`Preparing Web UI resources`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  if (!reuseWebUi) await $`NOVACLAW_CHANNEL=${Script.channel} bun --smol run --cwd ${appDir} build`
  if (!existsSync(path.join(dist, "index.html"))) throw new Error("The embedded Web UI has not been built")
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = !prepareBundle || skipEmbedWebUi ? null : await createWebUIResourceMap()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

/**
 * Boot the JUST-BUILT binary and prove it actually serves.
 *
 * `--version` is not enough: the chunk-ordering bug that `splitting: false` fixes left a dependency
 * undefined only AFTER the first HTTP request, so the binary passed its version check and then failed
 * in a user's hands. Same lesson as the desktop artifact smoke — a green suite says nothing about the
 * packaged thing.
 *
 * Hermetic on purpose: a throwaway NOVACLAW_HOME and NOVACLAW_OFFLINE=1, so it cannot touch the real
 * instance or reach the network. Every request is loopback.
 */
const fetchSmoke = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) })

const waitForServer = async (url: string, attempts = 100): Promise<void> => {
  const response = await fetchSmoke(`${url}/api/health`).catch(() => undefined)
  if (response?.ok && (await response.text()) === '{"healthy":true}') return
  if (attempts === 1) throw new Error(`Compiled server did not become healthy at ${url}`)
  await Bun.sleep(100)
  return waitForServer(url, attempts - 1)
}

async function smokeServer(binaryPath: string, expectEmbeddedUI: boolean) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  const home = mkdtempSync(path.join(tmpdir(), "novaclaw-build-smoke-"))
  const server = Bun.spawn([binaryPath, "serve", "--no-supervise", "--port", String(port)], {
    // The KB engine is a RUNTIME `createRequire` target the compiled binary cannot bundle; without a
    // resolvable copy the RAG routes answer 400 and this smoke's world-memory probe fails. The
    // monorepo's installed copy is the same one the desktop stages beside the binary.
    env: {
      ...process.env,
      NOVACLAW_HOME: home,
      NOVACLAW_OFFLINE: "1",
      NODE_PATH: path.resolve(dir, "../desktop/node_modules"),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  server.unref()
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForServer(url)
    const html = await fetchSmoke(url).then((response) => response.text())
    const title = expectEmbeddedUI ? "<title>NovaClaw</title>" : "<title>NovaClaw API</title>"
    if (!html.includes(title))
      throw new Error(
        expectEmbeddedUI
          ? "Compiled server did not serve the embedded UI"
          : "Compiled server did not serve the API landing page",
      )
    // 🔴 NOTHING RAG-RELATED IS EXECUTED HERE, and nothing is asserted about staging either.
    //
    // The removed probe asked whether the KB engine RUNS. It was answering a packaging question by
    // running a runtime subsystem, which is why it answered 400 ("memory worker timed out in list")
    // and failed release builds on 2026-09-26 and again on 2026-09-27.
    //
    // The honest replacement would be a check that `@ladybugdb/wasm-core` sits where a packaged
    // process can resolve it, and it is NOT written here because the standalone build stages NOTHING:
    // `dist/novaclaw-windows-x64/` contains only `bin/`, measured after a full build. There is no
    // staged copy to assert, so any such check would be a guess about a layout that does not exist —
    // a check that either fails every build or passes without meaning anything, and both are worse
    // than saying so.
    //
    // So this is stated instead of enforced: the standalone server resolves the KB engine through
    // NODE_PATH in development, and the packaged DESKTOP ships it unpacked
    // (`electron-builder.config.ts` → `asarUnpack: ["node_modules/@ladybugdb/**"]`). Whether the
    // standalone release drops a copy beside its binary is an open question about the release
    // packaging, not about this build, and it is recorded in
    // `notes/reports/` rather than guessed at here.
    console.log(`Note: no KB engine copy is staged into ${path.dirname(binaryPath)}; RAG is resolved via NODE_PATH.`)
  } finally {
    // By TREE (pitfall #8): `serve` can spawn MCP children, and a bare kill leaves them holding GBs.
    await killTree(server.pid).catch(() => undefined)
    // A Windows handle (the memory worker's database, a scanner) can outlive the kill by a moment.
    // A cleanup failure must never REPLACE the smoke's own error with "EBUSY" — which is exactly how
    // this step spent two release builds reporting the wrong cause. Retry, then leave the temp dir.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(home, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(250)
      }
    }
  }
}

// Best-effort clean, NOT fatal. On Windows a virus scanner or the search indexer routinely keeps a
// handle on the directory of a binary that was just deleted, so `rm` fails with "Device or resource
// busy" on a directory that is EMPTY and still perfectly writable — and the whole build died over
// it. Every artifact below is written to a fixed path and overwritten, so continuing after a partial
// clean cannot produce a wrong binary; it can only leave an unrelated stale file from an earlier
// target, which is why this warns loudly instead of failing silently.
if (prepareBundle)
  await $`rm -rf dist`.catch((error) => {
    console.warn(`WARNING: could not fully clean dist/ — ${error?.stderr?.toString().trim() || error}`)
    console.warn(`Continuing: build outputs are overwritten by name, but stale files may remain.`)
  })

const binaries: Record<string, string> = {}
if (prepareBundle && !skipInstall) {
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}

/**
 * The native host module (`packages/host`), which replaced `@parcel/watcher`.
 *
 * BUILT here rather than installed, because we own it now — that was the point of writing it. It
 * ships BESIDE the executable: a compiled binary has no `node_modules`, and `packages/host/src/host.ts`
 * looks next to `process.execPath` before anywhere else.
 *
 * ⚠️ Only the target matching THIS machine can get one — a C++ shared library is not cross-compiled
 * by the toolchain we ship, and macOS has no backend at all yet. A build failure here is therefore
 * NOT fatal, but every target that ends up without a library is named on stdout, because the
 * alternative is a release whose file watching is silently dead while every test on the machine that
 * built it was green.
 */
const hostLibrary = `host.${process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so"}`
const hostBuilt = path.resolve(dir, "../host/build", hostLibrary)
if (prepareBundle)
  await import("../../host/build").catch((error) => {
    console.warn(`WARNING: could not build the host module — ${error?.stderr?.toString().trim() || error}`)
  })

/**
 * The DHT sidecar (`packages/dht`), which finds instances through a public Kademlia DHT.
 *
 * ⚠️ Same rules as the host module and for the same reasons: built here because we own it, shipped
 * BESIDE the executable because a compiled binary has no `node_modules`, and NOT fatal when it is
 * missing — the app must build on a machine that has never heard of Rust, and an instance without
 * it simply finds no peers through the DHT.
 *
 * 🔴 But every target that ends up without one is NAMED below. A release whose discovery is
 * silently DHT-less looks identical to a network with nobody in it, and the person who can fix that
 * is the one reading this build's output.
 */
const dhtBinary = dhtExecutableName()
// ⚠️ `build/`, not `target/release/` — the sidecar build publishes its one artifact there so the
// desktop packager can copy a directory without dragging cargo's whole scratch tree with it.
const dhtBuilt = path.resolve(dir, "../dht/build", dhtBinary)
if (prepareBundle)
  await (await import("../../dht/build")).buildDht({ development: false }).catch((error) => {
    console.warn(`WARNING: could not build the DHT sidecar — ${error?.stderr?.toString().trim() || error}`)
  })
/**
 * Make a compiled Windows binary a GUI-subsystem executable, so it never opens a console window.
 *
 * 🔴 A compiled Bun binary is a CONSOLE-subsystem executable by DEFAULT, so the headless server — the
 * `--server-only` child the desktop launches, its supervised re-exec, and the memory worker — each
 * opened its own Command Prompt beside the app. Measured 2026-09-26: `conhost.exe` sat parented to the
 * re-exec'd child.
 *
 * ⚠️ Two things that look like the fix and are NOT. Bun 1.3.14's `--windows-hide-console` and
 * `compile.windows.hideConsole` leave the subsystem at 3 (verified for both the CLI flag and the JS
 * option), and `Bun.spawn`'s `windowsHide` does not suppress it either. The subsystem is the root.
 *
 * ⚠️ Flipping it does NOT cost stdout: a GUI process still writes to whatever standard handles its
 * launcher handed it, and everything here reads the server through a PIPE (the supervisor's readiness
 * line, the desktop's log, every test). Verified with a GUI-subsystem binary whose stdout and stderr
 * both arrived intact over pipes. The cost is an INTERACTIVE `novaclaw ...` in a terminal losing its
 * console attach — acceptable for a CLI AGENTS.md calls vestigial and headless-only.
 */
function makeWindowsSubsystemGui(executable: string) {
  const bytes = readFileSync(executable)
  const optionalHeader = bytes.readInt32LE(0x3c) + 24
  const subsystemOffset = optionalHeader + 68
  const subsystem = bytes.readUInt16LE(subsystemOffset)
  if (subsystem === 2) return // IMAGE_SUBSYSTEM_WINDOWS_GUI — already done
  if (subsystem !== 3)
    throw new Error(`${executable}: unexpected PE subsystem ${subsystem}; refusing to guess at its layout`)
  bytes.writeUInt16LE(2, subsystemOffset)
  writeFileSync(executable, bytes)
  // Read back what landed on disk, so a silent write failure fails the BUILD rather than shipping a
  // binary whose console window nobody sees until a user does.
  const written = readFileSync(executable).readUInt16LE(subsystemOffset)
  if (written !== 2) throw new Error(`${executable}: subsystem is ${written} after patching, expected 2`)
}

const targetName = (item: (typeof allTargets)[number]) =>
  [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
if (prepareBundle) {
  mkdirSync(bundleDirectory, { recursive: true })
  await Bun.write(
    path.join(bundleDirectory, "plan.json"),
    JSON.stringify(
      targets.map((item) => ({
        root: dir,
        output: path.join(bundleDirectory, targetName(item), "server.mjs"),
        launcher: path.join(bundleDirectory, targetName(item), "launcher.ts"),
        embeddedFileMap,
        sourcemaps: sourcemapsFlag,
        define: {
          FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
          "process.platform": JSON.stringify(item.os),
          "process.arch": JSON.stringify(item.arch),
          NOVACLAW_MODELS_DEV: JSON.stringify(generated!.modelsData),
          NOVACLAW_CHANNEL: `'${Script.channel}'`,
          NOVACLAW_LIBC: JSON.stringify(item.os === "linux" ? (item.abi ?? "glibc") : ""),
          NOVACLAW_STANDALONE_BINARY: "true",
        },
      })),
    ),
  )
  process.exit(0)
}

for (const item of targets) {
  const name = targetName(item)
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    external: ["node-gyp"],
    format: "esm",
    minify: false,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: false,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/novaclaw`,
      execArgv: [`--user-agent=novaclaw/${Script.version}`, "--use-system-ca", "--"],
      // Left empty, a compiled binary ships with BUN's icon and Bun's version metadata — so the
      // CLI showed up in Explorer and Task Manager as something the user never installed. Point it
      // at the canonical tracked channel icon and stamp our own identity. Do not read the desktop
      // packager's `resources/icons` staging directory here: a headless/server build does not run
      // desktop predev, so that generated copy legitimately does not exist.
      // Only meaningful for win32 targets; Bun ignores it elsewhere, but keep it explicit.
      windows:
        item.os === "win32"
          ? {
              icon: path.resolve(dir, `../desktop/icons/${Script.channel}/icon.ico`),
              title: "NovaClaw",
              publisher: "Nancy Sadkov",
              version: Script.version,
              description: "NovaClaw — a local-first AI agent OS",
              copyright: `© 2025-2026 Nancy Sadkov`,
            }
          : {},
    },
    entrypoints: [path.join(bundleDirectory, name, "launcher.ts")],
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not compile ${name}`)
  cpSync(path.join(bundleDirectory, name, "server.mjs"), `dist/${name}/bin/server.mjs`)
  cpSync(path.join(bundleDirectory, name, "assets"), `dist/${name}/bin/assets`, { recursive: true })

  if (item.os === "win32") makeWindowsSubsystemGui(`dist/${name}/bin/novaclaw.exe`)

  // The host library, beside the binary. Named when absent rather than skipped quietly — see above.
  if (item.os === process.platform && item.arch === process.arch && existsSync(hostBuilt)) {
    await Bun.write(`dist/${name}/bin/${hostLibrary}`, Bun.file(hostBuilt))
  } else {
    console.warn(`WARNING: ${name} ships NO host library (${hostLibrary}) — file watching is off in it.`)
  }

  // ⚠️ Only the target matching THIS machine can get one: cargo cross-compilation is not wired up,
  // so every other target ships without and says so. Discovery still works there — LAN, peer
  // exchange, and addresses the user types — which is exactly why this is a warning and not a stop.
  if (item.os === process.platform && item.arch === process.arch && existsSync(dhtBuilt)) {
    await Bun.write(`dist/${name}/bin/${dhtBinary}`, Bun.file(dhtBuilt))
  } else {
    console.warn(`WARNING: ${name} ships NO DHT sidecar (${dhtBinary}) — it discovers by LAN and typed addresses only.`)
  }

  // 🔴 BOOTING THE ARTIFACT IS A GATE, NOT A BUILD STEP, and it is off unless asked for.
  //
  // Owner, 2026-09-27: *"building zip shouldn't require running anything at all. That is just
  // compilation and packing."* Measured the same day: the 0.1.80 zip build failed in `prebuild`
  // because this file's sibling, `build-node.ts`, booted the sidecar and asked it for
  // `world-memory/list`. Memory had just become OPT-IN, so that call was the first COLD one and paid
  // the ~1.3 GB `WasmMemory.open` arena inside a 30 s capability deadline. Nothing was wrong with the
  // bundle; a user-visible feature was in a state the user had legitimately chosen, and it stopped a
  // compile.
  //
  // ⚠️ THE SAME 400 APPEARED HERE TWICE ALREADY, and each time it was answered with patience rather
  // than a cause. 2026-09-26: `probeWorldMemory` "answered 400 ... and failed two release builds, then
  // returned `[]` in ~2 s when driven directly", so it grew a 6-attempt retry. 2026-09-27: the same
  // 400, and the retry did not save it. A retry loop on a deterministic failure is a class of its own
  // — it converts a bug into flake, and flake is not reported.
  //
  // ⚠️ The smoke is NOT deleted, because it exists for a real defect: the chunk-ordering bug that
  // `splitting: false` fixes left a dependency undefined only AFTER the first HTTP request, so
  // `--version` passed and the binary then failed in a user's hands. Run it with `--verify`, and the
  // release gate does.
  if (verifyArtifacts && item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/novaclaw`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      console.log(`Running server smoke test: ${binaryPath} serve`)
      await smokeServer(binaryPath, !skipEmbedWebUi)
      console.log(`Server smoke test passed`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

/**
 * The Windows/macOS release archives are **7z**, not zip: these carry a ~150 MB binary each and
 * deflate is the wrong codec for that: LZMA2 is the whole reason to publish an archive rather than
 * the bare exe. Same choice as the desktop package (`packages/desktop/electron-builder.config.ts`).
 *
 * Two writers, probed in order, because there is no one tool present everywhere this runs:
 * real 7-Zip if the box has it (multi-threaded, and what everyone else uses), else **bsdtar**, whose
 * libarchive back end writes 7z natively — that is macOS's and Windows' system `tar`. GNU tar does
 * NOT, which is why this probes for the `bsdtar` banner instead of just calling `tar`. Linux keeps
 * `.tar.gz`: 7z there means telling people to install p7zip, and the platform already opens tar.gz.
 */
function sevenZipArgv(outFile: string): string[] {
  const sevenZip = ["7z", "7za", "7zr"].map((exe) => Bun.which(exe)).find((found) => found)
  if (sevenZip) return [sevenZip, "a", "-mx=9", "-y", outFile, "."]

  const tar = Bun.which("bsdtar") ?? Bun.which("tar")
  const banner = tar ? Bun.spawnSync([tar, "--version"]).stdout.toString() : ""
  if (tar && banner.includes("bsdtar"))
    return [tar, "-a", "-c", "--options", "7zip:compression=lzma2", "-f", outFile, "."]

  throw new Error(
    `cannot write ${outFile}: no 7-Zip (7z/7za/7zr) and no bsdtar on PATH` +
      (tar ? ` — ${tar} is ${banner.split("\n")[0] || "not bsdtar"}, which has no 7z writer` : ""),
  )
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      // 7-Zip APPENDS to an existing archive, so a re-run would otherwise ship a mixed-version
      // binary alongside the current one. bsdtar truncates; delete either way.
      rmSync(`dist/${key}.7z`, { force: true })
      const argv = sevenZipArgv(`../../${key}.7z`)
      const result = Bun.spawnSync(argv, { cwd: `dist/${key}/bin`, stdout: "inherit", stderr: "inherit" })
      if (result.exitCode !== 0) throw new Error(`${argv[0]} exited ${result.exitCode} archiving ${key}`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.7z ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

// ⚠️ LOUD WHEN SKIPPED, because a skipped check that says nothing is indistinguishable from a passing
// one — the same rule `build-node.ts` applies to a missing `node`. The artifacts are bytes on disk and
// nothing has booted them, so nobody should read this build as proof that they serve.
if (!verifyArtifacts)
  console.log(
    "NOTE: artifacts were NOT booted (compile + pack only). " +
      "Pass --verify, or run `bun run verify:sidecar`, before treating them as release-ready.",
  )

rmSync(bundleDirectory, { recursive: true, force: true })
export { binaries }
