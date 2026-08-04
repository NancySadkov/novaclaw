export * as File from "./file"

import { Revert } from "@novaclaw/schema/revert"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
