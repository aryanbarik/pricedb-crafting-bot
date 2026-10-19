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
