import { expect } from "bun:test"
import { Effect } from "effect"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { InstanceIdentityTable } from "@novaclaw/core/instance-identity/sql"
import { CredentialRepair } from "@novaclaw/core/credential/repair"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node])))

it.effect("identity reads validate raw keys without rewriting stored secrets", () =>
  Effect.gen(function* () {
    const identity = yield* InstanceIdentityStore.Service
    const { db } = yield* Database.Service
    const original = yield* identity.identity()
    yield* identity.sealingKey()
    const before = yield* db.select().from(InstanceIdentityTable).get()
    const signature = yield* identity.sign(Buffer.from("fixture"))
    expect(InstanceIdentityStore.verifySignature(original.networkID, Buffer.from("fixture"), signature)).toBe(true)
    yield* identity.backup()
    yield* identity.get()
    expect(yield* db.select().from(InstanceIdentityTable).get()).toEqual(before)
    expect(yield* CredentialRepair.scan([InstanceIdentityStore.repairSource(db)])).toEqual([])
  }),
)

it.effect("invalid identity secrets remain visible by path and cannot sign", () =>
  Effect.gen(function* () {
    const identity = yield* InstanceIdentityStore.Service
    const { db } = yield* Database.Service
    const original = yield* identity.get()
    yield* db.update(InstanceIdentityTable).set({ secret_key: "invalid", sealing_secret_key: "invalid" }).run()
    expect(yield* identity.get()).toBe(original)
    expect(yield* CredentialRepair.scan([InstanceIdentityStore.repairSource(db)])).toEqual([
      { path: "instance-identity:secret_key" },
      { path: "instance-identity:sealing_secret_key" },
    ])
    const exit = yield* identity.sign(Buffer.from("fixture")).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect((yield* db.select().from(InstanceIdentityTable).get())?.secret_key).toBe("invalid")
  }),
)
