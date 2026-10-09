# Dependency patches

`npm ci` and `npm install` apply these patches through the `postinstall` script.
Keep them when upgrading dependencies, or confirm the dependency includes the fix
before removing a patch.

## Steam outgoing offers (`@tf2autobot/tradeoffer-manager` 2.20.8)

New offers must omit `tradeofferid_countered`. The unpatched library includes it
with a null value, which is submitted as an empty form field. Steam's own trade
page only includes this parameter when countering an existing offer.

On 2026-10-09, the bot's outgoing crafting requests and an ordinary one-scrap
admin offer failed with HTTP 500 and Steam EResult 8 (`InvalidParam`). A fresh
web session failed identically. Removing only the empty counter-offer parameter
allowed the diagnostic offer to be created; it was immediately canceled.

The patch omits the parameter for new offers and retains the original offer ID
for counter offers. `src/classes/__tests__/tradeOfferSendPayload.ts` checks the
actual library request for both directions of a new offer and for a counter.

## TF2 crafting (`@tf2autobot/tf2` 1.4.0)

The TF2 patch supplies the GC recipe and item-application operations needed by
the crafting service. Preserve it independently of the trade-offer patch.
