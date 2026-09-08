/**
 * Which renderer URL a window may load.
 *
 * ⚠️ `ELECTRON_RENDERER_URL` is INHERITED from the environment. Another Electron dev shell that
 * exports it — Codex and electron-vite both do — and then launches NovaClaw would have a PACKAGED
 * build load that foreign dev server as its renderer, i.e. arbitrary remote content inside the app's
 * own window. A packaged build has no legitimate use for a dev server, so the answer is simply no.
 *
 * Ported from NancySadkov/novaclaw#4 by @DassaultFalconKing. ⚠️ Their patch guarded the LOAD path;
 * `windows.ts` reads the same variable a second time in the navigation allowlist, which would
 * otherwise keep trusting that origin. Both call sites go through here.
 */
export function resolveRendererDevUrl(packaged: boolean, inherited: string | undefined) {
  if (packaged) return undefined
  return inherited
}
