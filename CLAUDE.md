# Claude Code — Project Notes for tf2autobot-pricedb Fork

This is a fork of [TF2-Price-DB/tf2autobot-pricedb](https://github.com/TF2-Price-DB/tf2autobot-pricedb) with a Professional Killstreak Fabricator Crafting Service integrated. See `fullbotplan.md` for the full architecture.

All crafting-related changes live on the `feature/fabricator-crafting` branch.

## Known-Good Rollback Point

**Tag `crafting-working-v1` (commit `bbecd81c`) — Pro KS Fabricator crafting confirmed working end-to-end on 2026-06-26.**

To restore: `git checkout crafting-working-v1`

What was confirmed working at this tag:
- Mode A: user sends fabricator + Spec KS weapons + robot parts → bot crafts → Pro KS Kit returned
- Output-spec slots (defidx ∈ {6526,6527,6528}) correctly skipped as non-inputs
- `value_bytes` for killstreak tier read as float32 LE (`readFloatLE`) — tier 2 = `[0,0,0,64]` = 2.0
- Refund flow works: on craft failure, all provided components are returned to the user

---

## The `@tf2autobot/tf2` Patch — How It Works and How to Maintain It

### What was patched and why

`@tf2autobot/tf2` (v1.3.9) does not expose `FulfillDynamicRecipeComponent` — the GC message required to craft fabricators. Two things were added:

1. **`index.js`** — `TeamFortress2.prototype.fulfillDynamicRecipeComponent(toolItemId, components)`: sends GC message 1085
2. **`handlers.js`** — handler for GC message 1086 response: emits `'dynamicRecipeFulfilled'` event with the result code

### How the patch is applied automatically

`patch-package` is installed as a devDependency. `package.json` has `"postinstall": "patch-package"`, which re-applies `patches/@tf2autobot+tf2+1.3.9.patch` every time `npm install` runs. The patch file is committed to git.

### When `@tf2autobot/tf2` upgrades

If a future `npm install` fails with a patch error like:
```
error: patch failed: node_modules/@tf2autobot/tf2/index.js:241
```

Do this:
1. Check if `@tf2autobot/tf2` now exposes `fulfillDynamicRecipeComponent` natively. If yes — delete `patches/@tf2autobot+tf2+*.patch` and remove `"postinstall": "patch-package"` from `package.json`. Done.
2. If not: manually re-apply the two additions to the new version of `index.js` and `handlers.js` (see the patch file for the exact diff), then run:
   ```bash
   npx patch-package @tf2autobot/tf2
   git add patches/
   git commit -m "chore: update @tf2autobot/tf2 patch for vX.Y.Z"
   ```

### What the patch adds (reference)

**`index.js`** — insert after `TeamFortress2.prototype.useItem`:
```js
TeamFortress2.prototype.fulfillDynamicRecipeComponent = function(toolItemId, components) {
    this._send(Language.FulfillDynamicRecipeComponent, Schema.CMsgFulfillDynamicRecipeComponent, {
        "tool_item_id": toolItemId,
        "consumption_components": components
    });
};
```

**`handlers.js`** — insert before the `// Professor Speks` block:
```js
handlers[Language.FulfillDynamicRecipeComponentResponse] = function(body) {
    let result = -1;
    try {
        if (ByteBuffer.isByteBuffer(body) && body.remaining() >= 4) {
            result = body.readInt32();
        }
    } catch (e) {}
    this.emit('dynamicRecipeFulfilled', result);
};
```

---

## Syncing with Upstream tf2autobot-pricedb

The upstream remote is `upstream` (https://github.com/TF2-Price-DB/tf2autobot-pricedb.git).

To pull in upstream changes:
```bash
git fetch upstream
git checkout feature/fabricator-crafting
git merge upstream/master
# Resolve any conflicts in src/classes/TF2GC.ts, MyHandler.ts, Options.ts
npm install   # re-apply patch
npm run build # verify clean build
```

The crafting code touches:
- `src/classes/Options.ts` — added `craftingServiceWhitelist` field (~line 2281 type, ~line 2607 reader)
- `src/classes/TF2GC.ts` — added `craftFabricator` job
- `src/classes/MyHandler/MyHandler.ts` — added detection block in `onNewTradeOffer` and post-accept trigger in `onTradeOfferChanged`
- `src/lib/fabricatorSlots.ts` — new file (no conflict risk)

The competitive buy pricer touches:
- `src/classes/Options.ts` — `pricelist.competitiveBuyPricer` (interface ~line 1400, DEFAULTS ~line 149)
- `src/schemas/options-json/options.ts` — matching schema block + entry in `pricelist.required`
- `src/classes/Bot.ts` — `startCompetitiveBuyPricer()`, interval field, cleanup in `halt()`
- `src/classes/MyHandler/MyHandler.ts` — one call in the ready sequence
- `src/lib/pricer/competitiveBuyPricer.ts` — new file (no conflict risk)

---

## Competitive Buy Pricer (`pricelist.competitiveBuyPricer`)

Prices configured SKUs off **competing backpack.tf buy orders** instead of the pricer. Built for
robot parts, which are crafting inputs rather than flip inventory — their value is what they
contribute to the kit the fabricator produces, not what they resell for. pricedb quotes a
market-maker spread (8 scrap buy / 9 scrap sell) which loses every fill to the people bidding the
full 9, who are buying inputs for the same reason we are.

```jsonc
"pricelist": {
  "competitiveBuyPricer": {
    "enable": true,
    "intervalMinutes": 15,
    "minOrders": 2,
    "items": [
      { "sku": "5705;6", "maxBuy": { "keys": 0, "metal": 1 } },
      { "sku": "5706;6", "maxBuy": { "keys": 0, "metal": 1 } },
      { "sku": "5707;6", "maxBuy": { "keys": 0, "metal": 1 } }
    ]
  }
}
```

Each cycle, per SKU: query bp.tf classifieds for buy listings → drop our own → group bids by price
level → take the highest level held by at least `minOrders` **distinct** steamids → cap at `maxBuy`
→ write via `pricelist.updatePrice({ emitChange: true })`, which drives the normal
`onPriceChange` → `Listings.checkByPriceKey` path so the bp.tf listing follows.

### Rules that are deliberate, not incidental

- **Configured entries MUST have `autoprice: false`.** That is what makes this module their only
  price writer — the pricer never touches a non-autopriced entry (`Pricelist.ts:569`, `:631`,
  `:1192`, `:1401`, `:1502`). An entry left on autoprice is skipped with a warning, because anything
  written would be overwritten moments later.
- **`minOrders` defaults to 2** so a single troll or fat-fingered buy order cannot drag the price up.
  A level backed by one steamid is not evidence of a market; a real move shows up as several people
  repricing. Multiple listings from the *same* steamid count once.
- **A SKU without `maxBuy` is skipped.** There is no default ceiling — an unbounded default is never
  the safe one.
- **A failed API call keeps the current price** and logs a warning. It must never fall back to the
  pricer, which would silently drop the bid back below the competition — the exact failure this
  exists to fix.
- **Clamping happens in the pricelist, not at listing creation.** Trade validation reads the
  pricelist entry, so clamping only the outgoing listing would advertise 1 ref and then value the
  incoming offer at 0.88, rejecting the very offers the buy order attracted.
- When the ceiling binds, it logs a warning — the market has moved past what a part is worth as a
  craft input, so the ceiling needs a human look.

### What production has NOT yet proven (as of 2026-08-07)

Every configured SKU currently sits **exactly at its ceiling**: the three Battle-Worn at 1 ref, the
two Pristine at 2.33 ref. So the only path production has exercised is `top >= ceiling → write
ceiling`. The module has been correct on every cycle since deploy, but a ceiling produces the right
number even when the computation feeding it is wrong — an error in the snapshot parse, the buy-side
filter, the steamid grouping, or the scrap conversion would all be masked as long as the clamp binds.

**The downward path is untested against live data.** `pickTopLevel` is unit-tested
(`src/lib/__tests__/competitiveBuyPricer.ts`) and the pure selection logic is sound, but the live
chain from `fetchBuyOrders` through to a *sub-ceiling* write has never run. Confidence in this module
should be read as "the clamp works", not "the pricing works".

The first real validation arrives when competing Battle-Worn bids drop below 1 ref. When that
happens, check `pm2 logs autofab-tf2autobot` for the `buy X -> Y scrap (top competing …)` debug line
and confirm `Y` tracks the actual top bid on bp.tf rather than sticking at 9 scrap or collapsing to
the pricedb price. Until then, do not treat a quiet log as evidence of correctness.

Related gap: the ceiling-hit warning is inside the `current !== target` branch, after the
`if (current === target) return;` early exit. Once a SKU is pinned at its ceiling, `target` stops
changing, so the warning **never fires** — including in the case it exists for, competitors bidding
past `maxBuy`. Right now that warning is unreachable for all five SKUs. Fix by hoisting the
`top > ceiling` check above the early return.

### Which backpack.tf endpoint, and why

Uses `/api/classifieds/listings/snapshot` with the **access token**. Do not switch this to
`/api/classifieds/search/v1` — search requires a backpack.tf **Premium subscription** and returns
`401 {"message":"This web API requires a Premium subscription"}` without one. That was tried first
and failed in production on 2026-08-02.

Consequences of snapshot: it returns a *sample* of listings for one item, both intents mixed (so the
buy filter happens client-side), and it keys off the **market name**, not a SKU string. Because it's
a sample rather than a ranked page, it can miss the true top bid — the ceiling is what bounds the
damage, not the completeness of the data. If a Premium subscription is ever bought, `search/v1` with
`intent=buy&page_size=30&fold=0` would be strictly better.

Credentials need no setup: `bot.options.bptfAccessToken` (and `bptfApiKey`) are populated at boot by
the bp.tf login (`src/classes/Bot.ts:1765-1766`), even though `options.json` and `ecosystem.json`
show them empty.

**Changing these entries live:** the bot holds the pricelist in memory and rewrites `pricelist.json`
on shutdown, so editing that file while it is running gets clobbered. Use `!update` via chat, or
`pm2 stop` → edit → `pm2 start`.

---

## Key Defindexes and Constants

| Item | Defindex |
|---|---|
| Specialized Fabricator | 20002 |
| Professional Fabricator | 20003 |
| Robot parts | 5700–5707 |
| Specialized KS Kit (output of Spec KS Fabricators) | **6523** |
| Professional KS Kit (output of Pro KS Fabricators) | **6526** |
| Specialized KS Kit (generic — may appear in `itemAcquired`) | 6527 |
| Basic KS Kit | 6528 |
| Mann Co. Supply Crate Key | SKU `5021;6` / market name `Mann Co. Supply Crate Key` |

Robot parts individually (resolved from `items_game.txt` tokens `TF_Item_Robits_Loot_01..08`; the
SKU is always `<defindex>;6`, built at `src/lib/fabricatorSlots.ts:401`):

| defindex | SKU | Name | Tier |
|---|---|---|---|
| 5700 | `5700;6` | Pristine Robot Currency Digester | Pristine |
| 5701 | `5701;6` | Pristine Robot Brainstorm Bulb | Pristine |
| 5702 | `5702;6` | Reinforced Robot Emotion Detector | Reinforced |
| 5703 | `5703;6` | Reinforced Robot Humor Suppression Pump | Reinforced |
| 5704 | `5704;6` | Reinforced Robot Bomb Stabilizer | Reinforced |
| 5705 | `5705;6` | Battle-Worn Robot Taunt Processor | Battle-Worn |
| 5706 | `5706;6` | Battle-Worn Robot KB-808 | Battle-Worn |
| 5707 | `5707;6` | Battle-Worn Robot Money Furnace | Battle-Worn |

Only 5700/5701 (the Pristine pair) carry the "rare Robot Part" description in the schema.

Recipe slot attribute def_indexes: 2000 (weapon), 2001+ (robot parts/other inputs, count varies per weapon — some recipes have 5, some have 6+), followed by one output-spec slot at whatever the next free index is.

**Output spec slots**: Slots whose `itemDefIndex` ∈ `[6523, 6526, 6527, 6528]` encode the fabricator's OUTPUT product, not an input. Filter these out in `decodeFabricatorSlots` consumers **using the itemDefIndex check only** — `KS_KIT_DEFINDEXES` is exported from `src/lib/fabricatorSlots.ts` as the single source of truth.

**Do NOT hardcode which attribute_index the output slot lands on.** A bug shipped where `SLOT_OUTPUT = 2006` was hardcoded and every consumer filtered `attributeIndex !== 2006` in addition to the itemDefIndex check. This worked for 5-ingredient recipes (output lands at 2006) but silently ate the 6th ingredient for recipes that need one (e.g. Specialized Killstreak Bat Kit Fabricator needs a Reinforced Robot Bomb Stabilizer at attr 2006, pushing the real output slot to 2007) — the bot never requested that ingredient from the customer and returned a partially-filled fabricator. Fixed 2026-07-06 by dropping the attribute-index check everywhere and relying solely on the itemDefIndex/`KS_KIT_DEFINDEXES` check, which is correct regardless of recipe length.

GC message IDs: 1085 (`FulfillDynamicRecipeComponent`), 1086 (`FulfillDynamicRecipeComponentResponse`).

---

## GC Attribute Data Types — Common Bug Source

When reading item attributes from the GC backpack (`this.bot.tf2.backpack`), type mismatches are a recurring source of bugs. Check these first when attribute comparisons fail:

### How `decodeProto` (node-tf2) handles fields

node-tf2's `decodeProto` merges `toObject({defaults: false})` and `toObject({defaults: true})`, then replaces any field that was **absent from the wire data** AND is a "replaceable default" with `null`. Replaceable defaults are: `0` (numbers), `false` (booleans), `''` (empty strings), empty Buffers.

Practical result for `CSOEconItemAttribute`:
- Field present in wire with value `2` → `attr.value = 2` (number)
- Field absent from wire (default = 0) → `attr.value = null` (NOT `0`)
- Empty `value_bytes` → `attr.value_bytes = null`
- Non-empty `value_bytes` → `attr.value_bytes = Buffer([...])`

### `value` vs `value_bytes` for simple attributes

`CSOEconItemAttribute` has two fields: `value` (uint32) and `value_bytes` (bytes). TF2 may send a value in either or both:

| Scenario | `attr.value` | `attr.value_bytes` |
|---|---|---|
| Simple attr, value set (e.g. kt-tier=2 in `value` field) | `2` (integer) | `null` |
| Simple attr, value in bytes only | `null` | `Buffer([0,0,0,64])` = float32 2.0 |
| Both present | `2` | `Buffer([0,0,0,64])` |

**`value_bytes` stores attribute values as float32 LE** — read with `buf.readFloatLE(0)`. For killstreak tier 2, the bytes are `[0x00, 0x00, 0x00, 0x40]` = IEEE 754 float 2.0, NOT `[0x02, 0x00, 0x00, 0x00]` (uint32 2). Do NOT use `readUInt32LE` — that returns `1073741824` for tier-2 weapons (the raw bit pattern of float 2.0), which never matches `2`.

The `value` field (proto uint32) and the `value_bytes` float32 both encode the same logical value — e.g. killstreak tier 2 — so `Number(attr.value) === buf.readFloatLE(0)` holds when both are present.

### Conditions string format

`CAttribute_DynamicRecipeComponent.attributes_string` format: `attrDefIndex<SEP>value<SEP>attrDefIndex2<SEP>value2`. Values are the **semantic integer** (e.g., `"2"` for kt-tier 2), matching the uint32 encoding in `value`/`value_bytes`.

**`<SEP>` is not three pipes.** It is `|` + `0x01 0x02 0x01 0x03` + `|` + `0x01 0x02 0x01 0x03` + `|` — see `RECIPE_CONDITION_SEP` at `src/lib/fabricatorSlots.ts:76`, which most editors and every previous version of this doc render as a harmless-looking `|||`. Anything hand-writing a conditions string with literal pipes produces a string that `split()` never divides, so `itemSatisfiesConditions` iterates zero conditions and returns its vacuous `true` — silently matching *every* candidate, e.g. a kt-1 weapon against a kt-2 slot. This bit the unit tests on 2026-08-08 and would bite production code the same way. Build the separator from the escape sequence (`'|\x01\x02\x01\x03|\x01\x02\x01\x03|'`), never by typing pipes.

### Item IDs

GC item IDs (`CSOEconItem.id`) are `uint64` — node-tf2 returns them as **strings** (via `{longs: String}`). Always `String(id)` before comparing. Never compare with `===` against a number literal.

---

## Standalone Reference Implementation

`aryanbarik/autofabricator` — the standalone bot that was built first to discover the GC protocol, validate the protobuf decode logic, and confirm crafting works. Use it to test GC behaviour in isolation without tf2autobot overhead. The `src/inventory.ts` there is the source of truth for slot-decode logic (now ported to `src/lib/fabricatorSlots.ts` here).
