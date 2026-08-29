import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

import { resolveChannel } from "@novaclaw/script/channel"
import { windowsSigning } from "./scripts/windows-signing"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
/**
 * 🔴 **NC-SEC-010 — a RELEASE build that could not sign must not package.**
 *
 * This returned silently whenever it was not on Windows under GitHub Actions, and electron-builder
 * has no force-signing requirement to contradict it, so `beta`/`latest` packaged to a normal `.7z`
 * and every later hash/SBOM/release-record step ran green over an unsigned binary. One missing
 * secret, one renamed CI variable, or one local emergency build was enough.
 *
 * ⚠️ **The build LOG is not evidence, and that is what made this survive.** electron-builder prints
 * `• signing with signtool.exe path=…` BEFORE it calls this function — 267 of those lines in the
 * 0.1.67 Windows build, with nothing signed. Reading that log is how a reviewer (and an agent, on
 * 2026-08-28) concludes a build "signed everything". A guard here is the only thing that can tell
 * the difference, because the log says the same words either way.
 *
 * ⚠️ `dev` is EXEMPT and stays silent-but-stated. Dev builds are the ones a person makes on their own
 * machine all day, they are never published, and failing them would make the guard something people
 * route around — which is how a release guard stops being one. The exemption is by CHANNEL, not by
 * "am I in CI": a beta cut on a laptop is exactly the emergency build this exists to catch.
 *
 * The shape is the one this build already uses for the native host module: refuse to package rather
 * than ship a degraded artifact and call it success.
 */
async function signWindows(configuration: { path: string }) {
  const verdict = windowsSigning({
    channel,
    platform: process.platform,
    githubActions: process.env.GITHUB_ACTIONS,
  })
  if (verdict === "skip-allowed") return
  if (verdict === "refuse")
    throw new Error(
      `Refusing to package a ${channel} Windows build without code signing.\n` +
        `Signing runs only on Windows under GITHUB_ACTIONS=true, and this build is neither — so ` +
        `"${configuration.path}" would ship with no authenticated publisher while every later ` +
        `hash/SBOM/release step reported success.\n` +
        `Build the ${channel} channel in CI, or use the dev channel for a local build.`,
    )

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

// ONE resolver, shared with electron-vite, the desktop build scripts and `Script.channel`
// (`@novaclaw/script/channel`). This used to be a local copy that did NOT understand the "latest"
// alias, while electron.vite.config.ts DID — so `NOVACLAW_CHANNEL=latest` produced a binary whose
// app id said `.dev` and whose compiled-in `InstallationChannel` said `prod`. The app id picks the
// install location and the channel picks the DB filename, so the two halves of one build disagreed.
const channel = resolveChannel()

const APP_IDS = {
  dev: "app.novaclaw.desktop.dev",
  beta: "app.novaclaw.desktop.beta",
  prod: "app.novaclaw.desktop",
} as const

/** Electron's Linux runtime dependencies, named the way Arch/CachyOS spell them. */
const PACMAN_DEPENDS = ["gtk3", "libnotify", "nss", "libxss", "libxtst", "xdg-utils", "at-spi2-core", "libsecret"]

const getBase = (appId: string): Configuration => ({
  artifactName: "novaclaw-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "app.novaclaw.desktop" becomes
  // "app.novaclaw.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  // The expanded w64devkit tree is a native extraResource below. Excluding it here is load-bearing:
  // otherwise electron-builder copies ~575 MiB into app.asar (where native subprocesses cannot use
  // it) and then copies it a second time beside the asar.
  files: ["out/**/*", "resources/**/*", "!resources/third-party/**"],
  // The KB graph engine (@ladybugdb/wasm-core) is loaded by the sidecar through a RUNTIME
  // `createRequire(...)("@ladybugdb/wasm-core/nodejs/sync")`, which no bundler can see — so it is
  // neither inlined into the main bundle nor emitted as an asset, and it has to ship as a real
  // package that Node resolution can find (hence the dependency in package.json).
  //
  // Unpacked, not left in the asar, because its Emscripten loader resolves the 13.5 MB
  // `lbug_wasm.wasm` from `__dirname` and reaches for `WebAssembly.instantiateStreaming` — neither
  // is reliable against an asar's virtual paths. Without this, `WasmMemory.open` throws, the KB
  // layer degrades to a disabled client by design, and Memory is silently dead in the packaged app
  // while working fine in dev. It shipped that way in v0.0.1.
  asarUnpack: ["node_modules/@ladybugdb/**"],
  extraResources: [
    {
      // ⚠️ `windows.ts`'s `iconsDir()` resolves to `join(process.resourcesPath, "icons")` when
      // packaged, but nothing copied `resources/icons/` there — so the BrowserWindow icon and the
      // macOS dock icon pointed at a directory that does not exist in a packaged build and silently
      // fell back to the Electron default. These are NATIVE resources; Electron cannot read them
      // from inside `app.asar` through `process.resourcesPath`, so they need a real copy beside it.
      // Ported from NancySadkov/novaclaw#4 by @DassaultFalconKing.
      from: "resources/icons/",
      to: "icons/",
    },
    {
      // NovaClaw's own native host module (`packages/host`), which replaced `@parcel/watcher`.
      //
      // ⚠️ It cannot live in the asar: `bun:ffi`'s `dlopen` hands the path to the OS loader, and the
      // OS knows nothing about an asar's virtual paths. `packages/host/src/host.ts` looks under
      // `process.resourcesPath/host` for exactly this copy. Without it the file watcher is not
      // broken-with-an-error but SILENTLY absent, because an unavailable host means the watcher
      // layer provides no binding at all — the same shape in which Memory shipped dead in v0.0.1.
      from: "../host/build/",
      to: "host/",
    },
    {
      // The DHT sidecar (`packages/dht`), built by `scripts/prebuild.ts`.
      //
      // ⚠️ A separate process, so the asar is doubly wrong for it: `spawn` hands the path to the OS,
      // which knows nothing about an asar's virtual paths. `community/dht.ts`'s `binaryPath()` looks
      // under `process.resourcesPath/dht` for exactly this copy — the same shape `packages/host`
      // uses, because the failure is the same shape: no binary means no error, just an instance
      // that quietly discovers nobody through the DHT.
      //
      // ⚠️ `build/`, not `target/release/`: cargo's scratch tree is hundreds of megabytes and this
      // is 2.7 MB of it.
      from: "../dht/build/",
      to: "dht/",
    },
    {
      // The watchdog (`packages/watchdog`), built by `scripts/prebuild.ts`.
      //
      // ⚠️ A separate process by definition — it supervises the one this app runs in, so it can be
      // neither in the asar nor inside the thing it restarts. 220 KB, `build/` rather than cargo's
      // scratch tree, same as the two entries above.
      //
      // 🔴 **NOTHING LAUNCHES IT YET, and shipping it anyway is deliberate.** Adoption puts three
      // supervision layers in a line (watchdog → `serve --supervise` → server) and that is a design
      // decision to take on purpose, not to arrive at by packaging. But the binary must be PRESENT
      // before it can be adopted, it costs a fifth of a megabyte, and a build step nobody has ever
      // run is the one that fails on the day it is finally needed. See `todo/watchdog.md`.
      from: "../watchdog/build/",
      to: "watchdog/",
    },
    ...(process.platform === "win32"
      ? [
          {
            // Prepared and SHA-256 verified by scripts/prepare-w64devkit.ts before every Windows
            // build. Ship the expanded tree so first launch needs neither network nor extraction.
            from: "resources/third-party/w64devkit/",
            to: "third-party/w64devkit/",
          },
          {
            // ImageMagick (owner, 2026-08-23) — one static `magick.exe` plus the XML configuration
            // it reads from beside itself. Prepared and SHA-256 verified by
            // scripts/prepare-imagemagick.ts. 32 MB, not the 240 MB the archive expands to: the
            // portable build ships eight byte-identical copies of the same binary dispatching on
            // argv[0], and IM7 reaches all of them through `magick <verb>`.
            from: "resources/third-party/imagemagick/",
            to: "third-party/imagemagick/",
          },
        ]
      : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    // ⚠️ The `zip` here is NOT a size choice and must not be traded for a 7z. electron-updater's
    // macOS updater downloads the artifact named in `latest-mac.yml` and hands it to Squirrel.Mac,
    // which unpacks ZIP only — drop it and macOS autoupdate stops working, which is the one thing
    // AGENTS.md's "we tend the flame for you" promise cannot lose. The dmg is the human download
    // and is already compressed. Windows, which has no such constraint, ships 7z (see `win`).
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "NovaClaw",
    schemes: ["novaclaw"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    // What Windows actually ships is the PORTABLE app — a folder you unpack anywhere and run, no
    // installer and no admin rights (README) — so the default target is the ARCHIVE, and the archive
    // is 7z rather than zip: same tree, LZMA2-solid at `-mx=9` instead of deflate, which is a much
    // smaller download for a ~1.15 GB unpacked app. The release script used to build `dir` and then
    // zip it by hand with bsdtar; electron-builder packs the same directory itself, so the format
    // now lives HERE, in one place the test below pins, instead of in a batch file nothing checks.
    // `nsis` was the default before this and its options block below is untouched — an explicit
    // `electron-builder --win nsis` still produces the one-click installer. Only the default moved.
    artifactName: "NovaClaw-${version}-windows-${arch}.${ext}",
    target: ["7z"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    synopsis: "NovaClaw — a local-first AI agent OS",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm", "pacman"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "NovaClaw Dev",
        rpm: { packageName: "novaclaw-dev" },
        pacman: {
          packageName: "novaclaw-dev",
          compression: "zstd",
          artifactName: "novaclaw-dev-${version}-${arch}.pkg.tar.zst",
          depends: PACMAN_DEPENDS,
        },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "NovaClaw Beta",
        protocols: { name: "NovaClaw Beta", schemes: ["novaclaw"] },
        publish: { provider: "github", owner: "nancysadkov", repo: "novaclaw-beta", channel: "latest" },
        rpm: { packageName: "novaclaw-beta" },
        pacman: {
          packageName: "novaclaw-beta",
          compression: "zstd",
          artifactName: "novaclaw-beta-${version}-${arch}.pkg.tar.zst",
          depends: PACMAN_DEPENDS,
        },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "NovaClaw",
        protocols: { name: "NovaClaw", schemes: ["novaclaw"] },
        publish: { provider: "github", owner: "nancysadkov", repo: "novaclaw", channel: "latest" },
        rpm: { packageName: "novaclaw" },
        pacman: {
          packageName: "novaclaw",
          compression: "zstd",
          artifactName: "novaclaw-${version}-${arch}.pkg.tar.zst",
          depends: PACMAN_DEPENDS,
        },
      }
    }
  }
}

export default getConfig()
