import { writeFileSync } from "node:fs"
import { InstanceJob } from "../../src/util/instance-job"

// Spawned by `test/util/instance-job.test.ts`. `adopt` joins a kill-on-close Job Object first; the
// grandchild is DETACHED, which is what lets it outlive the libuv job and exposes a leak.
const [mode, pidFile] = process.argv.slice(2)
if (mode === "adopt") await InstanceJob.adopt()

const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
})
writeFileSync(pidFile!, String(grandchild.pid))
setInterval(() => {}, 1000)
