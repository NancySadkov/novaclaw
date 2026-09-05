/**
 * Byte formatting for the instance-resources rows.
 *
 * 🔴 **In a `.ts` with no component import, and that placement is the point.** `instance-resources.tsx`
 * reaches `./parts/row` → `TooltipV2` → `@kobalte/core`, which throws *"Client-only API called on the
 * server side"* at MODULE SCOPE under the unit tier — `test:unit` runs `bun test --preload ./happydom.ts`
 * WITHOUT `--conditions=browser` (only `test:browser` passes it), so solid-js resolves to its SERVER
 * build. Any test file whose import graph reaches a Kobalte component dies before its first assertion.
 *
 * ⚠️ **It failed in the shape that hides itself.** bun reported `0 pass / 1 fail` — a load error dressed
 * as a test failure — so a whole file's coverage was absent while the suite looked merely red. Keeping
 * the pure half importable on its own is what makes the test run at all.
 *
 * The same split is already the house pattern: `project-copy.ts`, `storage-entries.ts`,
 * `computer-rules.ts`, `tool-channel.ts`.
 */

import { Bytes } from "@novaclaw/core/util/bytes"
import type { InstanceResources, ResourceLevel } from "@/utils/resource-api"

// ⚠️ The body was moved VERBATIM to `@novaclaw/core/util/bytes` and is now shared with the instance's
// own resource-pressure lines, which had grown a second copy of it. The precision switch at 10 MiB and
// the bare round on the KiB branch are load-bearing — reconstructing either from memory changes what the
// user reads. (It was rewritten on the first pass; the tests below are what caught the drift.)
export const formatResourceBytes = Bytes.binary

/** The memory row must never borrow the aggregate verdict, which can be dominated by a disk. */
export const memoryPressureLevel = (
  resources: Pick<InstanceResources, "memoryLevel"> | undefined,
): ResourceLevel | "…" => resources?.memoryLevel ?? "…"
