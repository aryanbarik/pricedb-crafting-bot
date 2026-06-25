# Fabricator Crafting Service — Full Architecture Plan

## Problem

Steam allows only **one active Game Coordinator (GC) session per account**. The TF2 GC handles all in-game item operations including crafting. Running a separate autofabricator process on the same Steam account as tf2autobot causes them to kick each other off — only one can be connected at a time.

**Solution:** Integrate fabricator crafting directly into this tf2autobot fork. One process, one login, one GC session.

---

## What This Does

This fork adds a **Professional Killstreak Fabricator Crafting Service** to tf2autobot. Two modes of operation:

### Mode A — Self-service (whitelisted users only)
Customer sends: fabricator + robot parts + killstreak weapons, bot gives nothing.
Bot crafts using the exact items provided, sends only the kit back. **No key payment required.**

Whitelist is configured in `options.json` → `craftingServiceWhitelist`. Bot admins are automatically whitelisted.

### Mode B — Convenience service (anyone)
Customer sends: fabricator + 2 Mann Co. Supply Crate Keys, bot gives nothing.
Bot sources robot parts from its **own inventory**, keeps the 2 keys as payment (~1.8 key cost), sends kit back.

### Detection logic (in `onNewTradeOffer`)
```
Bot gives nothing + fabricator in trade:
  1. Sender whitelisted AND non-key items present → Mode A (use provided components)
  2. ≥2 keys present (regardless of whitelist) → Mode B (bot uses own parts)
  3. Neither → fall through to normal tf2autobot price check
```

### Common flow (both modes)
1. Bot detects crafting service trade, accepts it
2. Waits 5 seconds for GC backpack to sync
3. Sends `FulfillDynamicRecipeComponent` GC message (msg ID 1085)
4. Receives completed Professional Killstreak Kit (msg ID 1086 confirmation)
5. Sends kit back via new trade offer
6. On failure: refunds all received items (fabricator + components or fabricator + keys) with error message

Normal trading activity (buy/sell via pricelist) is completely unaffected.

---

## Repository Structure

| Repo | Purpose |
|---|---|
| `aryanbarik/autofabricator` | Standalone reference implementation — used to discover the GC protocol and test crafting in isolation |
| `aryanbarik/tf2autobot-pricedb` | **This repo** — production service with crafting integrated into tf2autobot |

---

## Key Technical Background

### The Dynamic Recipe System

Fabricators use TF2's "dynamic recipe" system, not the standard crafting API. Each fabricator item has GC attributes in the range def_index 2000–2006 whose `value_bytes` contains a serialized `CAttribute_DynamicRecipeComponent` protobuf:

- **Attr 2000**: Weapon slot — requires N killstreak weapons matching a conditions string (e.g. `"2025|||2"` = kt-2 tier)
- **Attrs 2001–2005**: Robot part slots — each requires N copies of a specific item defindex
- **Attr 2006**: Output slot — defines the resulting kit; never sent as input

The GC message `FulfillDynamicRecipeComponent` (1085) takes:
- `tool_item_id`: the fabricator's asset ID
- `consumption_components`: array of `{ subject_item_id, attribute_index }` — one entry per input item, where `attribute_index` equals the recipe slot's attribute def_index (2000 for weapons, 2001–2005 for robot parts)

### `@tf2autobot/tf2` Patch

The `@tf2autobot/tf2` library does not expose `FulfillDynamicRecipeComponent`. This fork patches it via `patch-package`:
- Adds `TeamFortress2.prototype.fulfillDynamicRecipeComponent()` to `index.js`
- Adds a response handler for message 1086 (emits `'dynamicRecipeFulfilled'` event) to `handlers.js`
- Patch stored in `patches/@tf2autobot+tf2+1.3.9.patch`, applied automatically on `npm install` via the `postinstall` script

See `CLAUDE.md` for full upgrade/maintenance instructions.

---

## New Code Added

### `src/lib/fabricatorSlots.ts` (new file)

Self-contained slot-decode library. No tf2autobot internals — isolated enough to survive tf2autobot version upgrades without changes.

Key exports:
- `decodeFabricatorSlots(item)` → `RecipeSlot[]`: Decodes `value_bytes` using `CAttribute_DynamicRecipeComponent` proto for each GC attribute in range 2000–2099
- `validateFabricatorTrade(fabricator, otherItems)` → `{ valid, reason? }`: Checks trade items satisfy all unfilled slots (used for pre-acceptance validation if needed)
- `buildCraftComponents(fabricator, componentItems)` → component array for the GC message (Mode A)
- `findBotComponents(fabricator, botBackpack)` → `{ components, missing[] }`: Scans bot's own inventory for matching parts (Mode B)

**Critical implementation notes:**
- `value_bytes` in live GC backpack is a raw `Buffer`; JSON-serialized form is `{type: 'Buffer', data: number[]}` — `toBuffer()` handles both
- Slot 2006 (output) must always be skipped — never sent as input
- Weapon matching: `parseRequiredAttrValue(conditionsStr, 2025)` returns required killstreak tier; compare against item's attr 2025 value

### `src/classes/TF2GC.ts` (modified)

Added `'craftFabricator'` job type to the existing serial job queue:
- `craftFabricator(fabricatorId, componentIds?, callback?)` — public method, enqueues job
  - With `componentIds`: Mode A — uses provided item IDs (already in bot's backpack after trade)
  - Without `componentIds`: Mode B — calls `findBotComponents()` to source from bot's own backpack
- `handleCraftFabricatorJob(job)` — branches on Mode A/B, sends GC message, uses `listenForEvent('dynamicRecipeFulfilled')` to await response, then `listenForEvent('itemAcquired')` to capture the kit asset ID

### `src/classes/MyHandler/MyHandler.ts` (modified)

- **`onNewTradeOffer`**: crafting service detection block (whitelist + key check) before normal price analysis
- **`onTradeOfferChanged`**: post-acceptance trigger — 5s delay, calls `tf2gc.craftFabricator()`, sends kit back or refunds on failure

### `src/classes/Options.ts` (modified)

Added `craftingServiceWhitelist?: string[]` field (reads from `options.json`).

---

## Configuration (`options.json`)

```json
{
  "craftingServiceWhitelist": ["76561198XXXXXXXXX"],
  "admins": [{ "steamID": "76561198YYYYYYYYY" }]
}
```

- `admins` entries are automatically whitelisted for Mode A (no need to duplicate in `craftingServiceWhitelist`)
- `craftingServiceWhitelist` is for additional trusted users who aren't full bot admins

---

## Deployment

### Initial setup on VPS
```bash
git clone https://github.com/aryanbarik/tf2autobot-pricedb.git
cd tf2autobot-pricedb
git checkout feature/fabricator-crafting
npm install          # patch-package runs automatically via postinstall
npm run build
cp options.json.example options.json  # fill in credentials + craftingServiceWhitelist
pm2 start dist/app.js --name tf2autobot
```

### After pulling updates
```bash
git pull
npm install          # re-applies patches if @tf2autobot/tf2 version unchanged
npm run build
pm2 restart tf2autobot
```

---

## Testing

1. `npm install` completes without patch errors
2. `npm run build` compiles clean
3. **Mode A**: whitelisted user sends fabricator + robot parts → bot accepts → kit returned, parts consumed
4. **Mode B**: anyone sends fabricator + 2 keys → bot accepts, uses own parts → kit returned, keys kept
5. **Non-whitelisted with components only**: falls through to price check (likely declined)
6. **Mode B, bot out of parts**: craft fails → fabricator + keys refunded
7. **Normal trade**: standard buy/sell → price-check path unaffected
