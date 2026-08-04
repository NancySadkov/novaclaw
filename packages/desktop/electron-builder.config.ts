import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

import { resolveChannel } from "../../script/lib/channel"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

// ONE resolver, shared with electron-vite, the desktop build scripts and `Script.channel`
// (`script/lib/channel.ts`). This used to be a local copy that did NOT understand the "latest"
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
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    ...(process.platform === "win32"
      ? [
          {
            // Prepared and SHA-256 verified by scripts/prepare-w64devkit.ts before every Windows
            // build. Ship the expanded tree so first launch needs neither network nor extraction.
            from: "resources/third-party/w64devkit/",
            to: "third-party/w64devkit/",
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
    target: ["nsis"],
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
