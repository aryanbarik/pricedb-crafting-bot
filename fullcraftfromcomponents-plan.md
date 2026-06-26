# Plan: Multi-Fabricator Support

## Context

The current crafting service uses `offer.itemsToReceive.find(...)` to detect a single fabricator per trade. When multiple fabricators are present (e.g. 2× Spec KS fabs + 1× Pro KS fab), only the first is detected; the rest are treated as components, then filtered out of `newCompIds` by the fabricator-defindex exclusion, and silently dropped. The post-accept flow crafts exactly one fabricator and returns one kit.

The desired behavior: craft ALL fabricators that have enough components, return all resulting kits (+ any uncraftable fabs and leftover components) in one trade offer.

Additionally, the GC confirmed crafting a Spec KS fabricator succeeded but the 20s `itemAcquired` timeout fired first — increase to 30s.

---

## Changes

### 1. Detection — `src/classes/MyHandler/MyHandler.ts` (~line 786)

Change `find` → `filter` to collect all fabricators:

```typescript
const fabricatorItems = (offer.itemsToReceive as any[]).filter(
    (item: any) => typeof item.market_hash_name === 'string' && item.market_hash_name.includes('Fabricator')
);
if (fabricatorItems.length > 0) {
    const fabricatorAssetIds = fabricatorItems.map((i: any) => String(i.assetid));
    const otherItems = (offer.itemsToReceive as any[]).filter(
        (item: any) => !fabricatorAssetIds.includes(String(item.assetid))
    );
    const componentItems = otherItems.filter(...); // same key exclusion as before
    ...
    offer.data('craftingService', { fabricatorAssetIds, componentAssetIds, kitAssetIds, preTradeIds });
}
```

Update the `craftingService` type annotation in `onTradeOfferChanged` to use `fabricatorAssetIds: string[]`.

### 2. Post-accept — `src/classes/MyHandler/MyHandler.ts` (~line 2388)

Replace the single-fabricator resolution with a multi-fab greedy assignment:

```
const FABRICATOR_DEFINDEXES = [20002, 20003];

// All new fabricators, sorted: Spec KS (20002) first, Pro KS (20003) second
const newFabs = newItems
    .filter(i => FABRICATOR_DEFINDEXES.includes(i.def_index))
    .sort((a, b) => a.def_index - b.def_index);

// Shared component pool — all non-fab new items
let availablePool = newItems.filter(i => !FABRICATOR_DEFINDEXES.includes(i.def_index));

const craftPlan: { fabId: string; componentIds: string[] }[] = [];
const uncraftableFabIds: string[] = [];

for (const fab of newFabs) {
    const components = buildCraftComponents(fab, availablePool);

    // Check every unfilled slot is fully covered
    const slots = decodeFabricatorSlots(fab).filter(s => s.attributeIndex !== 2006 && !KS_KIT_OUT.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired);
    const covered = new Map<number, number>();
    for (const c of components) covered.set(c.attribute_index, (covered.get(c.attribute_index) ?? 0) + 1);
    const allCovered = slots.every(s => (covered.get(s.attributeIndex) ?? 0) >= s.numRequired - s.numFulfilled);

    if (allCovered && components.length > 0) {
        const usedIds = new Set(components.map(c => c.subject_item_id));
        craftPlan.push({ fabId: String(fab.id), componentIds: [...usedIds] });
        availablePool = availablePool.filter(i => !usedIds.has(String(i.id)));
    } else {
        uncraftableFabIds.push(String(fab.id));
    }
}
const leftoverComponentIds = availablePool.map(i => String(i.id));
```

Then craft each entry in `craftPlan` sequentially:

```
const resultKitIds: string[] = [];
let planIndex = 0;

const craftNext = () => {
    if (planIndex >= craftPlan.length) {
        // All done — send back kits + uncraftable fabs + leftovers
        sendResults();
        return;
    }
    const { fabId, componentIds } = craftPlan[planIndex++];
    this.bot.tf2gc.craftFabricator(fabId, componentIds, (err, kitId) => {
        if (err || !kitId) {
            log.warn(`[craftingService] Craft failed for fab ${fabId}: ${err?.message}`);
            uncraftableFabIds.push(fabId); // treat as uncraftable; components consumed/lost
        } else {
            resultKitIds.push(kitId);
        }
        craftNext();
    });
};
craftNext();
```

`sendResults()` builds ONE trade offer containing:
- All `resultKitIds` (kits produced)
- All `uncraftableFabIds` (fabs that couldn't be crafted — components not consumed)
- All `leftoverComponentIds` (components not assigned to any fab)

If `craftPlan.length === 0` (nothing craftable): full refund of `allNewIds`.

### 3. Timeout — `src/classes/TF2GC.ts` (`handleCraftFabricatorJob`)

Change `20000` → `30000` in the `kitTimeout` setTimeout call.

### 4. Return offer message

Update from hardcoded "Professional Killstreak Kit" to a dynamic summary:
```typescript
const kitCount = resultKitIds.length;
const refundCount = uncraftableFabIds.length + leftoverComponentIds.length;
let msg = `Crafted ${kitCount} kit(s).`;
if (refundCount > 0) msg += ` ${uncraftableFabIds.length} fabricator(s) could not be crafted — returned with leftover components.`;
```

---

## Files to Modify

| File | Change |
|---|---|
| `src/classes/MyHandler/MyHandler.ts` | Detection: `find` → `filter`; type: `fabricatorAssetIds[]`; post-accept: greedy multi-fab assignment + sequential craft loop + combined return offer |
| `src/classes/TF2GC.ts` | `kitTimeout`: 20000 → 30000 |

Reuse existing: `buildCraftComponents`, `decodeFabricatorSlots` (already imported in MyHandler.ts).

---

## Not in this plan (future)

The full chain (Spec KS fab → kit → apply to weapon → use KS weapon in Pro KS fab) requires target weapons in the same trade. The `applyKSKit` job already exists; the chaining logic in `onTradeOfferChanged` needs to feed kit IDs from Spec KS fab crafts into `applyKSKit` calls before Pro KS fab crafts. Deferred until target weapons can be reliably detected and matched.

---

## Verification

1. Send 2× Spec KS fabs + 1× Pro KS fab + all their robot parts + 2× kt-1 weapons (enough for both Spec KS fabs but no kt-2 weapons for the Pro KS fab).
2. Expected: both Spec KS kits crafted, Pro KS fab returned uncrafted + leftover components, all in one return offer.
3. Send 1× Spec KS fab with full robot parts + weapon — expect 1 kit, no leftover items.
4. Check log for `[craftingService] Craft plan: N fab(s) craftable, M uncraftable`.
