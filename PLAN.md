# Notes / Deferred Ideas

## Steam datacenter IP block on intake inventory fetches (2026-07-25)

`steamcommunity.com/inventory/{id}/440/2` is hard-blocked/heavily rate-limited from this VPS's
IP range. Confirmed as the root cause of a customer's fabricator intake failing at 14:46 (3/3
retry attempts exhausted) — the same underlying block already worked around on the website side
via ExpressLoad (see `autofabricator-web/server/expressLoad.ts`).

**Option 1 — done.** Added `src/lib/expressLoadInventory.ts`: after the existing 3-attempt native
`Inventory.fetch()` retry loop in both intake paths (`MyHandler.ts` — `handleCraftingIntake` and
`handleCraftingIntakeBatch`) exhausts its attempts, the bot now tries ExpressLoad once before
giving up and returning the customer's fabricator(s). On success, a new `Inventory` is built via
the public `Inventory.fromItems(...)` factory (the native `setItems` setter is private, so the
existing instance can't be mutated in place — `theirInventory` is now `let`, reassigned to the new
instance). Requires `EXPRESSLOAD_API_KEY` in `.env`; if unset, the fallback silently no-ops and
behavior is unchanged from before.

**Option 3 — deferred, not started.** A cheap (~$4-6/mo) proxy VPS in a different provider/region,
used solely to route `steamcommunity.com` inventory calls through an IP that isn't
blocked/rate-limited, as a second layer of resilience independent of any third-party paid API. Not
implemented — noted here in case ExpressLoad's cost or reliability becomes a problem later.
