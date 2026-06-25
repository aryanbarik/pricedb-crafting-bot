# Fabricator Crafting Service — Full Architecture Plan

## Problem

Steam allows only **one active Game Coordinator (GC) session per account**. The TF2 GC handles all in-game item operations including crafting. Running a separate autofabricator process on the same Steam account as tf2autobot causes them to kick each other off — only one can be connected at a time.

**Solution:** Integrate fabricator crafting directly into this tf2autobot fork. One process, one login, one GC session.

---

## What This Does

This fork adds a **Professional Killstreak Fabricator Crafting Service** to tf2autobot. Customers send a trade offer containing:
- 1× Professional Killstreak Fabricator (defindex 20003) or Specialized (20002)
- All required robot parts (defindex 5700–5707) for the unfilled slots
- Any required killstreak weapons (kt-2 Specialized weapons for Professional Fabricators)

The bot:
1. Detects the trade as a "crafting service" offer (bot gives nothing)
2. Validates all recipe slots can be fulfilled by the provided items
3. Accepts the trade
4. Waits for the GC backpack to sync (~5 seconds)
5. Sends `FulfillDynamicRecipeComponent` GC messages to the Steam GC (msg ID 1085)
6. Receives the completed Professional Killstreak Kit (msg ID 1086 confirmation)
7. Sends the kit back to the customer via a new trade offer

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
- `consumption_components`: array of `{ subject_item_id, attribute_index }` — one entry per input item, where `attribute_index` equals the recipe slot's attribute def_index (2000 for weapons, 2001-2005 for robot parts)

### `@tf2autobot/tf2` Patch

The `@tf2autobot/tf2` library does not expose `FulfillDynamicRecipeComponent`. This fork patches it via `patch-package`:
- Adds `TeamFortress2.prototype.fulfillDynamicRecipeComponent()` to `index.js`
- Adds a response handler for message 1086 (emits `'dynamicRecipeFulfilled'` event) to `handlers.js`
- Patch stored in `patches/@tf2autobot+tf2+X.Y.Z.patch`, applied automatically on `npm install`

If `@tf2autobot/tf2` ever adds this method natively, remove the patch file and the `postinstall` script entry.

---

## New Code Added

### `src/lib/fabricatorSlots.ts` (new file)

Self-contained slot-decode library. No tf2autobot internals — can survive tf2autobot version upgrades without changes.

- `decodeFabricatorSlots(item)` → `RecipeSlot[]`: Reads each GC attribute in range 2000–2099, decodes `value_bytes` using `CAttribute_DynamicRecipeComponent` proto, returns unfilled slots
- `validateFabricatorTrade(fabricator, otherItems, backpack)` → `{ valid, reason? }`: Checks that all unfilled recipe slots can be satisfied by items in `otherItems`
- `buildCraftComponents(slots, items, backpack)` → component array for the GC message

**Critical implementation notes:**
- `value_bytes` in live GC backpack is a raw `Buffer`; JSON-serialized form is `{type: 'Buffer', data: number[]}` — both must be handled
- Slot 2006 (output) must always be skipped — never sent as input
- Weapon matching: `parseRequiredAttrValue(conditionsStr, 2025)` returns the required killstreak tier; compare against the item's attr 2025 value

### `src/classes/TF2GC.ts` (modified)

Added `'craftFabricator'` job type to the existing serial job queue:
- `craftFabricator(fabricatorId, componentIds, callback)` — public method, enqueues job
- `handleCraftFabricatorJob(job)` — decodes slots, sends GC message, uses `listenForEvent('dynamicRecipeFulfilled')` to await response, calls callback with the new kit's asset ID

### `src/classes/MyHandler/MyHandler.ts` (modified)

Trade offer detection in `onNewTradeOffer`:
- If bot gives nothing AND trade contains a Fabricator item → validate recipe, accept as `'CRAFTING_SERVICE'`
- Invalid offers → decline with `'CRAFTING_SERVICE_INVALID: <reason>'`
- After acceptance: 5-second backpack sync wait → `TF2GC.craftFabricator()` → send kit back

---

## Deployment

### Initial setup on VPS
```bash
git clone https://github.com/aryanbarik/tf2autobot-pricedb.git
cd tf2autobot-pricedb
npm install          # patch-package runs automatically via postinstall
npm run build
cp options.json.example options.json  # fill in credentials
pm2 start dist/app.js --name tf2autobot
```

### After pulling updates
```bash
git pull
npm install          # re-applies patches if @tf2autobot/tf2 version unchanged
npm run build
pm2 restart tf2autobot
```

### If `@tf2autobot/tf2` upgrades and the patch conflicts
```bash
# After npm install fails on patch-package:
# 1. Manually re-apply the two-function patch to the new version
# 2. Run: npx patch-package @tf2autobot/tf2
# 3. Commit the updated patches/ file
```

---

## Testing

1. `npm install` completes without patch errors
2. `npm run build` compiles clean
3. **Happy path**: Send fabricator + all required parts → bot accepts → kit arrives back
4. **Missing parts**: Send fabricator + partial parts → bot declines with reason
5. **Normal trade**: Send a standard buy/sell offer → goes through normal price-check path unaffected
6. **Edge cases**: Partially pre-filled fabricator (some slots already fulfilled), multiple fabricators in one trade (reject — only one at a time)
