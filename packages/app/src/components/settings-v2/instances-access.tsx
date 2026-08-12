import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo, createSignal } from "solid-js"
import { RequiresLevel } from "@/context/expertise"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { discoverInstances, type DiscoveredInstance } from "@/utils/instance-discovery"
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

  // Rule 2, offer what exists: the LAN already knows which instances are reachable, so asking a
  // person to type `http://host:port` asks them to look up something the product can see.
  //
  // ⚠️ Scanning is a deliberate ACTION, never an on-open effect. It is real network work on the
  // instance, and Settings → Instances is opened for other reasons far more often than for adding a
  // peer. ⚠️ `self` is filtered out — the scanning instance always finds itself, and offering it
  // would invite a peer pointing at the machine you are already using.
  const server = useServer()
  const global = useGlobal()
  const [scanning, setScanning] = createSignal(false)
  const [found, setFound] = createSignal<DiscoveredInstance[] | undefined>(undefined)
  const scan = async () => {
    const connection = server.current ?? global.servers.list()[0]
    if (!connection) return
    setScanning(true)
    try {
      setFound((await discoverInstances(connection.http)).filter((instance) => !instance.self))
    } catch {
      // A failed scan must leave the manual fields usable rather than blocking the row: an empty
      // result and an unreachable network look the same to a user, and both mean "type it".
      setFound([])
    } finally {
      setScanning(false)
    }
  }
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
    savePeers([
      ...peers().filter((peer) => peer.name !== value.name.trim()),
      { ...value, name: value.name.trim(), url: value.url.trim() },
    ])
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
              <ButtonV2
                size="small"
                variant="contrast"
                data-action="instances-access-save"
                onClick={() => saveToken(tokenValue())}
              >
                {language.t("common.save")}
              </ButtonV2>
            </Show>
            <Show when={!tokenDirty() && tokenSaved().length > 0}>
              <ButtonV2
                size="small"
                variant="neutral"
                data-action="instances-access-clear"
                onClick={() => saveToken("")}
              >
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
          <div class="flex flex-wrap items-center gap-2 pt-1" data-slot="instances-peer-discover">
            <ButtonV2 size="small" variant="neutral" data-action="instances-peer-scan" onClick={() => void scan()}>
              {scanning()
                ? language.t("settings.instances.peers.scanning")
                : language.t("settings.instances.peers.scan")}
            </ButtonV2>
            <Show when={found()?.length}>
              <For each={found()}>
                {(instance) => (
                  <ButtonV2
                    size="small"
                    variant="neutral"
                    data-action="instances-peer-pick"
                    onClick={() => setDraft({ ...draft(), name: instance.name, url: instance.url })}
                  >
                    {instance.name} — {instance.url}
                  </ButtonV2>
                )}
              </For>
            </Show>
            {/* An empty scan says so. Silence would read as "still scanning" or as a broken button,
                and the honest next step is the manual fields immediately below. */}
            <Show when={found() !== undefined && found()!.length === 0 && !scanning()}>
              <span class="settings-v2-field-description">{language.t("settings.instances.peers.none")}</span>
            </Show>
          </div>
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
