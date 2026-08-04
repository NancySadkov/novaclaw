import { $ } from "bun"

import { resolveChannel } from "./utils"

// Resolve here rather than forwarding the raw env var: this used to be `process.env.NOVACLAW_CHANNEL
// ?? "dev"`, a second copy of the unset-means-dev rule that also passed the "latest" alias through
// unnormalised. One resolver — see script/lib/channel.ts.
await $`bun ./scripts/copy-icons.ts ${resolveChannel()}`

await $`cd ../novaclaw && bun script/build-node.ts`
