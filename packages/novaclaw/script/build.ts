#!/usr/bin/env bun

import { $ } from "bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { fileURLToPath } from "url"

import { Shell } from "@novaclaw/core/shell"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@novaclaw/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`NOVACLAW_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
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

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

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

async function smokeServer(binaryPath: string) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  const home = mkdtempSync(path.join(tmpdir(), "novaclaw-build-smoke-"))
  const server = Bun.spawn([binaryPath, "serve", "--no-supervise", "--port", String(port)], {
    env: { ...process.env, NOVACLAW_HOME: home, NOVACLAW_OFFLINE: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  server.unref()
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForServer(url)
    const html = await fetchSmoke(url).then((response) => response.text())
    if (!html.includes("<title>NovaClaw</title>")) throw new Error("Compiled server did not serve the embedded UI")
    const memory = await fetchSmoke(`${url}/memory/stats`).then((response) => response.json())
    if (memory.total !== 0 || memory.valid !== 0)
      throw new Error("Compiled server memory smoke returned unexpected data")
  } finally {
    // By TREE (pitfall #8): `serve` can spawn MCP children, and a bare kill leaves them holding GBs.
    await Shell.killTree(server.pid).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
}

// Best-effort clean, NOT fatal. On Windows a virus scanner or the search indexer routinely keeps a
// handle on the directory of a binary that was just deleted, so `rm` fails with "Device or resource
// busy" on a directory that is EMPTY and still perfectly writable — and the whole build died over
// it. Every artifact below is written to a fixed path and overwritten, so continuing after a partial
// clean cannot produce a wrong binary; it can only leave an unrelated stale file from an earlier
// target, which is why this warns loudly instead of failing silently.
await $`rm -rf dist`.catch((error) => {
  console.warn(`WARNING: could not fully clean dist/ — ${error?.stderr?.toString().trim() || error}`)
  console.warn(`Continuing: build outputs are overwritten by name, but stale files may remain.`)
})

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    // A compiled executable must keep the runtime graph in ONE module. Bun's split chunks can
    // evaluate circular LayerNode imports in a different order than the source graph, leaving a
    // dependency undefined — and only AFTER the first HTTP request, so `--version` still passes and
    // the binary looks fine. Reported against the standalone Linux build by an outside contributor.
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
      // at the canonical generated icon (scripts/generate-brand.ts owns it; referenced rather than
      // copied so a rebrand cannot leave a second stale copy behind) and stamp our own identity.
      // Only meaningful for win32 targets; Bun ignores it elsewhere, but keep it explicit.
      windows:
        item.os === "win32"
          ? {
              icon: path.resolve(dir, "../desktop/resources/icons/icon.ico"),
              title: "NovaClaw",
              publisher: "Nancy Sadkov",
              version: Script.version,
              description: "NovaClaw — a local-first AI agent OS",
              copyright: `© 2025-2026 Nancy Sadkov`,
            }
          : {},
    },
    files: embeddedFileMap ? { "novaclaw-web-ui.gen.ts": embeddedFileMap } : {},
    // The embedded UI map is reachable from `src/index.ts`; listing it as a SECOND entrypoint was
    // what forced a shared chunk even with splitting off, reintroducing the ordering hazard above.
    entrypoints: ["./src/index.ts"],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      // No NOVACLAW_VERSION define: the version is no longer a build-time global. It comes from
      // `installation/version.gen.ts`, generated from the root package.json — so it is right in every
      // bundle, including ones (like the Electron sidecar's build-node.ts) that never set a define.
      NOVACLAW_MODELS_DEV: generated.modelsData,
      NOVACLAW_CHANNEL: `'${Script.channel}'`,
      NOVACLAW_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  // Smoke test: only run if binary is for current platform — and only when the UI is actually
  // embedded. A `--skip-embed-web-ui` (server-only) binary bundles no UI, so smokeServer's
  // `<title>NovaClaw</title>` assertion would always throw → process.exit(1) on a perfectly good
  // build (the standalone server serves `<title>NovaClaw API</title>`). Its HTTP serving is smoked
  // separately by build-linux.sh (--version + /api/health). See todo/linux-build.md (server-only).
  if (item.os === process.platform && item.arch === process.arch && !item.abi && !skipEmbedWebUi) {
    const binaryPath = `dist/${name}/bin/novaclaw`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      console.log(`Running server smoke test: ${binaryPath} serve`)
      await smokeServer(binaryPath)
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

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
