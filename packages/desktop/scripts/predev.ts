import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.NOVACLAW_CHANNEL ?? "dev"}`

await $`cd ../novaclaw && bun script/build-node.ts`
