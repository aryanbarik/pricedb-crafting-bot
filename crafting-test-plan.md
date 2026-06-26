# Crafting Service — Test Plan

## Pro KS Fabricator Recipe Facts

- A Professional KS Fabricator requires **up to 2 Specialized KS weapons** and **some number of robot parts** as inputs.
- The weapons can be **any weapon** — they do not need to be a specific weapon (e.g. Bazaar Bargain is not required).
- The weapons only need to have **Specialized Killstreak** applied (killstreak tier = 2). Any unique, stat-clock, etc. weapon with Spec KS qualifies.
- A Professional KS Fabricator **never requires a Professional KS Kit as an input**. The kit is the OUTPUT.
- The slot with `defidx` matching a KS Kit defindex (6526/6527/6528) is an **output specification slot**, not an input — it describes what kit the fabricator will produce.

## Test Cases

### Test 1: Standard Pro KS Fabricator (Mode A — user provides all components)
**Send:** Fabricator + 2× any Spec KS weapons + correct robot parts. Message must contain "craft".

**Expected:** Bot crafts, sends back the Pro KS Kit + refund of any excess items.

### Test 2: Fabricator only, missing weapons
**Send:** Fabricator + correct robot parts but no weapons. Message contains "craft".

**Expected:** Bot declines with message like `need 2×kt-2 weapon(s) for slot 2000, found 0`.

### Test 3: Wrong killstreak tier weapon
**Send:** Fabricator + 2× Basic KS weapons (tier 1) + parts. Message contains "craft".

**Expected:** Bot declines — tier 1 weapons don't match kt-2 condition.

### Test 4: No "craft" keyword in message
**Send:** Fabricator + components but message has no "craft" keyword.

**Expected:** Trade falls through to normal admin/price-check handling, NOT the crafting service.

## Notes

- The conditions string for the weapon slot looks like `2025<binary_sep>2` where `2025` is the killstreak tier attribute and `2` is Specialized tier.
- Robot part slots have explicit defindexes (5700–5707 range).
- Slot `attributeIndex = 2006` is always output — skip it.
- Slots whose `itemDefIndex` ∈ `[6526, 6527, 6528]` are also output specs — skip them as inputs.
