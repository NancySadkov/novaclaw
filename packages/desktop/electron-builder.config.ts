import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

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

const channel = (() => {
  const raw = process.env.NOVACLAW_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "app.novaclaw.desktop.dev",
  beta: "app.novaclaw.desktop.beta",
  prod: "app.novaclaw.desktop",
} as const

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
  files: ["out/**/*", "resources/**/*"],
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
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
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
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
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
      }
    }
  }
}

export default getConfig()
