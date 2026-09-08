export * as Sqlite from "./sqlite"

import { Context } from "effect"

export class Native extends Context.Service<Native, unknown>()("@novaclaw/core/database/SqliteNative") {}
