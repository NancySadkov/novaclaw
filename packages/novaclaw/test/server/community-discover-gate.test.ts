import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunitySeeds } from "@novaclaw/core/community/seeds"
import { Offline } from "@novaclaw/core/offline"
import { MDNS } from "../../src/server/mdns"
import { CommunityPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/**
 * 🔴 Codex review P2 — **discovery reached the network before it asked whether it was allowed to.**
 *
 * `communityDiscover` called `MDNS.browse()` first and resolved the DNS seed zone second; only the
 * DHT branch checked the gate. So a direct call to this endpoint emitted LAN multicast and a DNS
 * query after the user had switched Community off or sealed the machine in airgap. The panel hides
 * the button in those states, which lowers the incidence and is not enforcement — principle 4's
 * "nothing goes in or out" is not a claim about which buttons are visible.
 *
 * ⚠️ These count CALLS, not outcomes. A test that only read the response would pass against a
 * version that browsed the LAN, resolved the seeds, threw the results away and answered zeroes —
 * which is precisely the shape of the defect, since the endpoint already answered zeroes when it
 * found nobody.
 */

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
  return (path: string, directory: string) =>
    handler(
      new Request(new URL(path, "http://localhost"), {
        method: "POST",
        headers: { "x-novaclaw-directory": directory, "content-type": "application/json", "content-length": "2" },
        body: "{}",
      }),
      HttpApiApp.context,
    )
}

afterEach(async () => {
  CommunityConsent.resetGate()
  Offline.resetPolicy()
  delete process.env["NOVACLAW_OFFLINE"]
  await disposeAllInstances()
  await resetDatabase()
})

describe("discovery asks the gate before it opens a socket (Codex P2)", () => {
  const REFUSALS = [
    {
      name: "never consented",
      gate: () => CommunityConsent.applied({ consented: false, enabled: false }, { enabled: false }),
      expect: ["never_consented"],
    },
    {
      name: "switched off",
      gate: () => CommunityConsent.applied({ consented: true, enabled: false }, { enabled: false }),
      expect: ["switched_off"],
    },
  ]

  for (const refusal of REFUSALS) {
    test(`🔴 ${refusal.name}: no mDNS browse, no DNS resolve, and it says why`, async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false } })
      const browse = spyOn(MDNS, "browse")
      const resolve = spyOn(CommunitySeeds, "resolve")
      try {
        refusal.gate()
        const response = await app()(CommunityPaths.discover, tmp.path)
        const body = (await response.json()) as { refused?: string[]; learned: number; seedsAsked: boolean }

        expect(browse, "the LAN must not be probed by an instance that has not joined").toHaveBeenCalledTimes(0)
        expect(resolve, "the seed zone must not be resolved either").toHaveBeenCalledTimes(0)
        // Named, because zeroes read as "the network is empty" — the opposite repair.
        expect(body.refused).toEqual(refusal.expect)
        expect(body.seedsAsked).toBe(false)
      } finally {
        browse.mockRestore()
        resolve.mockRestore()
      }
    })
  }

  test("🔴 airgapped: the same, and the airgap is named beside any other reason", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    process.env["NOVACLAW_OFFLINE"] = "true"
    const browse = spyOn(MDNS, "browse")
    const resolve = spyOn(CommunitySeeds, "resolve")
    try {
      // Consented AND enabled, so the airgap is the only thing refusing — the state a user reaches
      // by sealing a machine they had already joined the community on.
      CommunityConsent.applied({ consented: true, enabled: true }, { enabled: true })
      const response = await app()(CommunityPaths.discover, tmp.path)
      const body = (await response.json()) as { refused?: string[] }

      expect(browse, "an airgapped machine must not emit LAN multicast").toHaveBeenCalledTimes(0)
      expect(resolve, "an airgapped machine must not resolve a seed zone").toHaveBeenCalledTimes(0)
      expect(body.refused).toEqual(["airgap"])
    } finally {
      browse.mockRestore()
      resolve.mockRestore()
    }
  })

  test("⚠️ and the control: a joined instance really does browse and resolve", async () => {
    // A gate that simply broke discovery would pass every test above and kill the feature.
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const browse = spyOn(MDNS, "browse").mockResolvedValue([])
    const resolve = spyOn(CommunitySeeds, "resolve").mockReturnValue(Effect.succeed([]))
    try {
      CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })
      const response = await app()(CommunityPaths.discover, tmp.path)
      const body = (await response.json()) as { refused?: string[] }

      expect(browse).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(body.refused, "nothing refused it, so nothing is claimed to have").toBeUndefined()
    } finally {
      browse.mockRestore()
      resolve.mockRestore()
    }
  })
})
