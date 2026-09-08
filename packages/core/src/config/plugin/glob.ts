export * as ConfigPluginGlob from "./glob"

/**
 * The ONE pattern, and the one directory, an external plugin may be loaded from: `{plugin,plugins}/`
 * directly under the INSTANCE CONFIG DIR (`Global.Service.config` / `Global.make().config`, i.e.
 * `<instance-home>/config` or `NOVACLAW_CONFIG_DIR`). The loader is `./external.ts`; the reasoning
 * for why it is that directory and nothing else lives in that file's header and must be read before
 * anything here is widened.
 *
 * ⚠️ **A LEAF module on purpose — it must never grow an import.** `external.ts` pulls in
 * `plugin/internal.ts`, which drags Catalog, Integration, ModelsDev and the HTTP client behind it;
 * the CLI's `debug info` prints this same directory and must not pay for that graph at startup
 * (startup speed is first-class, and `config-store-write.ts` makes the identical argument about its
 * own import direction). So the pattern lives here, where both sides can read it for free.
 */
export const PATTERN = "{plugin,plugins}/*.{ts,js}"
