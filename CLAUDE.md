# Claude Code — Project Notes for tf2autobot-pricedb Fork

This is a fork of [TF2-Price-DB/tf2autobot-pricedb](https://github.com/TF2-Price-DB/tf2autobot-pricedb) with a Professional Killstreak Fabricator Crafting Service integrated. See `fullbotplan.md` for the full architecture.

All crafting-related changes live on the `feature/fabricator-crafting` branch.

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

---

## Key Defindexes and Constants

| Item | Defindex |
|---|---|
| Specialized Fabricator | 20002 |
| Professional Fabricator | 20003 |
| Robot parts | 5700–5707 |
| Professional KS Kit | 6526 |
| Specialized KS Kit | 6527 |
| Basic KS Kit | 6528 |
| Mann Co. Supply Crate Key | SKU `5021;6` / market name `Mann Co. Supply Crate Key` |

Recipe slot attribute def_indexes: 2000 (weapon), 2001–2005 (robot parts), 2006 (output — skip).

GC message IDs: 1085 (`FulfillDynamicRecipeComponent`), 1086 (`FulfillDynamicRecipeComponentResponse`).

---

## Standalone Reference Implementation

`aryanbarik/autofabricator` — the standalone bot that was built first to discover the GC protocol, validate the protobuf decode logic, and confirm crafting works. Use it to test GC behaviour in isolation without tf2autobot overhead. The `src/inventory.ts` there is the source of truth for slot-decode logic (now ported to `src/lib/fabricatorSlots.ts` here).
