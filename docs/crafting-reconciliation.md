# Craft output and return reconciliation

Customer custody is recorded in `craftingJournal.json`. A GC operation records its source
offer, input IDs, pre-operation inventory, expected output attributes, and candidates before
its callback advances the batch. The recipe output slot is identified by kit defindex, never
by a fixed attribute index.

## Identifying outputs

The serial GC queue shares one observer for fabricator crafting and tool applications.
Listeners are installed before sending the request. A full result requires consumed inputs,
a matching output, and consistent item provenance. Traded-in kits retain their original item
identity and cannot become another operation's newly crafted result, even when the recipe
attributes are identical. Existing items, trade receipts, and other operations' candidates
are excluded. Candidate outputs are reserved while consumption events finish arriving.

In-place tool applications retain their weapon identity. Partial fabricators require actual
fulfillment progress or a recipe-matching replacement with the original identity. An operation
expected to finish the recipe does not treat an intermediate update as an immediate partial
result. Timeout recovery refreshes the GC snapshot and uses the same matchers; it never selects
the first new kit. Refreshes requested by return handlers are queued behind active operations.

An interrupted operation is reconciled rather than replayed. Unsubmitted inputs can be refunded;
uncertain inputs and output candidates remain reserved. A missing Steam receipt temporarily
quarantines arrivals outside the request's inventory snapshot until authoritative custody is
available. Other customer requests can continue.

## Tracking returns

Offer creation does not mean delivery. Each return records its source jobs and asset balance,
and successful sends record the Steam offer ID. Active offers are excluded from further retries.
If a restart occurs between sending and journaling the offer ID, active and historical Steam
offers are searched for the same customer and owed assets before another offer is created.

Failed exchanges are read with `getExchangeDetails(true)`. Verified bot-owned
`rollback_new_assetid` replacements update the durable balance and reservations. Missing IDs
remain unresolved. Accepted exchanges require a complete successful receipt before assets are
marked delivered; a partial delivery cannot close an unfinished batch. Holds and pending
attempts survive restarts and use the existing three-minute recovery sweep.

## Incident 9435221804

The first return incorrectly included three kits arriving in another component trade. Steam
rolled back two genuine outputs under new IDs. Three outputs were returned by automatic retry,
and the owner recovered the other five in accepted offer `9435404772`.

The one-time correction verifies all relevant Steam receipts, including the overlapping intake,
before archiving that customer's balance. It sends no offers. From the bot checkout:

```sh
node dist/scripts/reconcileReturn9435221804.js
# After backup, compilation, and stopping autofab-tf2autobot:
node dist/scripts/reconcileReturn9435221804.js --apply
```

The correction refuses changed balances or unexpected receipt states, backs up the journal,
and records its evidence in the archive. Older journal entries remain compatible; uncertain
historical jobs are not rewritten or replayed automatically.

## Static kit attributes and complete customer returns (2026-10-19)

The GC backpack omits schema-static killstreak tier 2025 on completed Specialized
(defindex 6523) and Professional (6526) kits. Steam's GetPlayerItems response expands
that attribute, so API-shaped fixtures concealed the mismatch. Output matching now
uses those two concrete definitions for the tier only when the dynamic attribute is
absent. Target, sheen, killstreaker, consumption, provenance, and ambiguity checks
still apply. Generic kit definitions and weapons require their actual tier attribute.
The Rescue Ranger incident (source 9435803618, output 17704257930) is covered by a
regression using the GC's float byte attributes with no tier attribute.

Crafting, kit application, and strangify completion now persist their return balance
before sending through one customer queue. A return waits for every accepted job for
that customer to finish and every operation to resolve. All outstanding assets must
be present, and any earlier return must settle before another is sent. Concurrent
customers remain independent. One combined return is associated with every source
job so website notifications and delivery receipts update the full batch.

Completion is persisted even when no output was recognized yet; reconciliation can
then recover it after a restart. Missing assets remain owed and block partial retries.
Manual administrator recovery commands retain their explicit override behavior.

When Steam's historical offer list omits an older accepted retry, use
`scripts/reconcile-known-crafting-returns.cjs <source>:<return>` on the VPS to
verify its exact receipt. `--apply` runs the existing receipt reconciliation in
the running bot, preserving both memory and disk. It requires a complete transfer
of the entire recorded balance to the original customer and sends no offers.

For an older delivery absent from offer history, pass `sourceOfferId:trade-<tradeid>`.
The tool fetches the complete Steam exchange receipt and requires an exact match
of the recorded return balance, or of all intake fabricators, to the customer or
the configured owner. Intake records are archived only after this proof.

## Stock weapon identities and prompt recovery (2026-10-20)

Applying a kit to a stock weapon creates a base item and modifies its asset ID. The
Fire Axe `17707156882` retains original ID `17707156881`; the held Wrenches show the
same behavior. Only `applyKSKitToBaseItem` permits unequal original/current IDs for
new outputs. Input consumption, expected attributes, before snapshots, received
assets and other operation reservations still apply. An unresolved trade receipt
quarantines its possible arrivals. Fabricator output provenance checks remain strict.
Later operation snapshots can uniquely identify later outputs; resolving those
claims can disambiguate earlier operations in the same pass. Competing sole claims
remain held rather than assigning the item by iteration order.

Recovery checks the current connected GC backpack before requesting a forced refresh.
Backoff limits reconnect requests, not matching available evidence. Debounced item
and backpack events schedule the existing combined-return sweep, and startup checks
held operations immediately. Active operations finish before held matching runs.
Forced refresh uses Steam's appQuit event and relaunches on the next event turn:
node-tf2 deliberately emits no disconnectedFromGC event for a normal app exit.
No journal migration or manual rewrite is required for existing held operations.
