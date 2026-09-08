import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"

import { resolveChannel } from "@novaclaw/script/channel"
import { verifyStagedDht } from "./scripts/dht-packaging"
import { sanitizeBuildOutput } from "./scripts/sanitize-build-output"
import { verifyArchiveLayout } from "./scripts/archive-layout"
import { packagedResourcesDirectory, verifyStagedResources, type StagedResource } from "./scripts/staged-resources"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")

// ONE resolver, shared with electron-vite, the desktop build scripts and `Script.channel`
// (`@novaclaw/script/channel`). This used to be a local copy that did NOT understand the "latest"
// alias, while electron.vite.config.ts DID — so `NOVACLAW_CHANNEL=latest` produced a binary whose
// app id said `.dev` and whose compiled-in `InstallationChannel` said `prod`. The app id picks the
// install location and the channel picks the DB filename, so the two halves of one build disagreed.
const channel = resolveChannel()

/**
 * Everything staged beside the app, checked BEFORE electron-builder copies it and AFTER it has.
 *
 * 🔴 **This is the general form of the bug that shipped twice.** `extraResources` copying from a
 * missing or empty directory is not an electron-builder error — it copies nothing and the pack
 * succeeds — and every native tree here fails silently when it is absent. The DHT acquired a guard
 * because somebody wrote one; the watchdog acquired an assertion for the same reason; `host/` had
 * neither, and nor would the next entry. `scripts/staged-resources.ts` therefore drives off THESE
 * entries: an `extraResources` entry with no declared policy fails the build by name, so a resource
 * cannot join the package without a decision about whether its absence is acceptable.
 *
 * ⚠️ Both halves, because they answer different questions. Before the pack: is there anything to
 * copy? After it: did it land? A check on only one side is a check that reports success for the
 * failure it does not look at.
 */
async function verifyBeforePack() {
  const result = await verifyStagedDht({ channel, appRoot: rootDir })
  if (result === "absent")
    console.warn("DEVELOPMENT ONLY: packaging without the DHT sidecar; beta/prod builds refuse this degradation.")

  verifyStagedResources({
    resources: EXTRA_RESOURCES,
    channel,
    label: "staged resources",
    resolve: (entry) => path.resolve(packageDir, entry.from),
  })
}

function verifyAfterPack(appOutDir: string, electronPlatformName: string | undefined) {
  // electron-builder names the TARGET platform here, which is the one the staged binaries had to be
  // built for. Fall back to this host only if the context ever stops carrying it.
  const platform = (electronPlatformName ?? process.platform) as NodeJS.Platform
  const resourcesDir = packagedResourcesDirectory(appOutDir, platform)
  verifyStagedResources({
    resources: EXTRA_RESOURCES,
    channel,
    platform,
    label: "packaged resources",
    resolve: (entry) => path.join(resourcesDir, entry.to),
  })
}

const APP_IDS = {
  dev: "app.novaclaw.desktop.dev",
  beta: "app.novaclaw.desktop.beta",
  prod: "app.novaclaw.desktop",
} as const

/** Electron's Linux runtime dependencies, named the way Arch/CachyOS spell them. */
const PACMAN_DEPENDS = ["gtk3", "libnotify", "nss", "libxss", "libxtst", "xdg-utils", "at-spi2-core", "libsecret"]

/**
 * Everything copied beside the app, as ONE value.
 *
 * ⚠️ Module scope, and the config below spreads THIS array rather than repeating it, because the
 * verifier above is driven by the same value the packager copies. A hand-kept second list would go
 * stale in exactly the direction that matters: the entry somebody forgot to add is the entry nothing
 * checks, which is the whole shape of the bug this ledger closes.
 */
const EXTRA_RESOURCES: readonly StagedResource[] = [
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
    // OS knows nothing about an asar's virtual paths. `packages/host/src/host.bun.ts` looks under
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
    // run is the one that fails on the day it is finally needed.
    from: "../watchdog/build/",
    to: "watchdog/",
  },
  ...(process.platform === "win32"
    ? [
        {
          // Staged from the build host and verified against the core executable pin.
          from: "resources/third-party/ripgrep/",
          to: "third-party/ripgrep/",
        },
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
]

const getBase = (appId: string): Configuration => ({
  // `prebuild` normally creates these artifacts. The hook is a second, independent boundary for a
  // direct electron-builder invocation: a release cannot copy absence, an old source identity, a
  // wrong target, or a binary that no longer speaks the protocol beside the current TypeScript.
  beforePack: verifyBeforePack,
  // Two jobs, in this order. First: assert that what `extraResources` promised actually LANDED in
  // the packed tree — the only place that question can be asked, and the half a pre-pack check
  // cannot answer. Then sanitize, because dependencies carry retired service names in metadata and
  // diagnostics even though the product has no integration with them; the sanitizer deliberately
  // preserves signed PE payloads so upstream Authenticode remains valid.
  afterPack: (context) => {
    verifyArchiveLayout(
      path.join(
        packagedResourcesDirectory(
          context.appOutDir,
          (context.electronPlatformName ?? process.platform) as NodeJS.Platform,
        ),
        "app.asar",
      ),
    )
    verifyAfterPack(context.appOutDir, context.electronPlatformName)
    return sanitizeBuildOutput(context.appOutDir)
  },
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
  extraResources: [...EXTRA_RESOURCES],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg"],
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
