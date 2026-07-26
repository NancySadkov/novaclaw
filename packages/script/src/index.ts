import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  NOVACLAW_CHANNEL: process.env["NOVACLAW_CHANNEL"],
  NOVACLAW_VERSION: process.env["NOVACLAW_VERSION"],
  NOVACLAW_RELEASE: process.env["NOVACLAW_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.NOVACLAW_CHANNEL) return env.NOVACLAW_CHANNEL
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

// The version is REPO STATE, not something to discover at build time. This used to ask the npm
// registry for `novaclaw-ai/latest` and increment it — inherited from the opencode fork and dead on
// arrival here, because we deliberately never publish to npm (todo.md → "No npm, ever"), so the
// fetch could only 404 or, worse, resolve some unrelated package. It also meant a preview build
// stamped `0.0.0-<channel>-<timestamp>` instead of the version the tree actually says it is.
// Now there is ONE source: the root package.json. The env var stays as a CI override for tagging a
// build differently from the checked-out tree; nothing else may invent a version.
const VERSION = env.NOVACLAW_VERSION ?? rootPkg.version

if (typeof VERSION !== "string" || VERSION.length === 0)
  throw new Error(`the root package.json has no "version" — it is the single source of truth`)

const bot = ["actions-user", "novaclaw", "novaclaw-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  // `.github/TEAM_MEMBERS` was removed in the opencode detach (it's upstream infra); tolerate its
  // absence so importing this build-tooling module never throws (it broke `predev`/build-node.ts).
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))
    .catch(() => [] as string[])),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.NOVACLAW_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`novaclaw script`, JSON.stringify(Script, null, 2))
