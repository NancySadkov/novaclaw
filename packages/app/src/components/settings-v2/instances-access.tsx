import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo, createSignal } from "solid-js"
import { RequiresLevel } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"

// P2P inter-instance access (Settings → Instances):
//   1. "This instance" — the INCOMING API token (config server.password; HTTP Basic, username
//      "novaclaw"). Gating applies live (the auth middlewares re-read the store per request);
//      clearing writes "" = open server (patch-merge cannot delete keys).
//   2. "Agent peers" — the `instances` config array: peer NovaClaw instances THIS instance's
//      agents may drive free-form over HTTP. Each peer surfaces to models as
//      NOVACLAW_INSTANCE_<NAME>_URL/_TOKEN env in bash plus a system-prompt line.
type Peer = { name: string; url: string; token?: string }

export const InstancesAccess: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const config = createMemo(() => serverSync().data.config as { server?: { password?: string }; instances?: Peer[] })
  const [tokenDraft, setTokenDraft] = createSignal<string | undefined>(undefined)
  const tokenSaved = createMemo(() => config().server?.password ?? "")
  const tokenValue = () => tokenDraft() ?? tokenSaved()
  const tokenDirty = () => tokenDraft() !== undefined && tokenDraft() !== tokenSaved()
  const saveToken = (next: string) => {
    setTokenDraft(undefined)
    void serverSync()
      .updateConfig({ server: { ...(config().server ?? {}), password: next } } as never)
      .catch(() => undefined)
  }

  const peers = createMemo(() => config().instances ?? [])
  const [draft, setDraft] = createSignal<Peer>({ name: "", url: "", token: "" })
  const savePeers = (next: Peer[]) => {
    void serverSync()
      .updateConfig({
        instances: next.map((peer) => ({
          name: peer.name,
          url: peer.url,
          ...(peer.token ? { token: peer.token } : {}),
        })),
      } as never)
      .catch(() => undefined)
  }
  const addPeer = () => {
    const value = draft()
    if (!value.name.trim() || !value.url.trim()) return
    savePeers([...peers().filter((peer) => peer.name !== value.name.trim()), { ...value, name: value.name.trim(), url: value.url.trim() }])
    setDraft({ name: "", url: "", token: "" })
  }

  return (
    <RequiresLevel min="advanced">
      <div class="flex flex-col gap-2 pb-3" data-slot="instances-access">
        <div class="flex flex-col gap-1">
          <span class="text-[13px] font-semibold text-v2-text-text-base">
            {language.t("settings.instances.access.title")}
          </span>
          <span class="text-[12px] leading-snug text-v2-text-text-faint">
            {language.t("settings.instances.access.hint")}
          </span>
          <div class="flex items-center gap-2 pt-1">
            <TextInputV2
              type="password"
              appearance="base"
              value={tokenValue()}
              onInput={(event) => setTokenDraft(event.currentTarget.value)}
              placeholder={language.t("settings.instances.access.placeholder")}
              autocomplete="off"
              data-slot="instances-access-token"
            />
            <Show when={tokenDirty()}>
              <ButtonV2 size="small" variant="contrast" data-action="instances-access-save" onClick={() => saveToken(tokenValue())}>
                {language.t("common.save")}
              </ButtonV2>
            </Show>
            <Show when={!tokenDirty() && tokenSaved().length > 0}>
              <ButtonV2 size="small" variant="neutral" data-action="instances-access-clear" onClick={() => saveToken("")}>
                {language.t("common.clear")}
              </ButtonV2>
            </Show>
          </div>
        </div>

        <div class="flex flex-col gap-1 pt-2">
          <span class="text-[13px] font-semibold text-v2-text-text-base">
            {language.t("settings.instances.peers.title")}
          </span>
          <span class="text-[12px] leading-snug text-v2-text-text-faint">
            {language.t("settings.instances.peers.hint")}
          </span>
          <For each={peers()}>
            {(peer) => (
              <div class="flex items-center gap-2 pt-1" data-slot="instances-peer-row">
                <span class="font-mono text-[12px] text-v2-text-text-base">{peer.name}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-faint">{peer.url}</span>
                <ButtonV2
                  size="small"
                  variant="neutral"
                  data-action="instances-peer-remove"
                  onClick={() => savePeers(peers().filter((item) => item.name !== peer.name))}
                >
                  {language.t("common.remove")}
                </ButtonV2>
              </div>
            )}
          </For>
          <div class="flex flex-wrap items-center gap-2 pt-1" data-slot="instances-peer-add">
            <TextInputV2
              appearance="base"
              value={draft().name}
              onInput={(event) => setDraft({ ...draft(), name: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.name")}
              autocomplete="off"
            />
            <TextInputV2
              appearance="base"
              value={draft().url}
              onInput={(event) => setDraft({ ...draft(), url: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.url")}
              autocomplete="off"
            />
            <TextInputV2
              type="password"
              appearance="base"
              value={draft().token ?? ""}
              onInput={(event) => setDraft({ ...draft(), token: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.token")}
              autocomplete="off"
            />
            <ButtonV2 size="small" variant="neutral" data-action="instances-peer-addbtn" onClick={addPeer}>
              {language.t("settings.instances.peers.add")}
            </ButtonV2>
          </div>
        </div>
      </div>
    </RequiresLevel>
  )
}
