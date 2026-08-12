---
name: audit-logs
description: Audit the live crafting bot's logs on the VPS for failures, stuck items and Steam problems. Use when asked to "audit logs", check on the bot, investigate a failed trade or craft, or find out why a customer didn't get their items.
---

# Auditing the crafting bot's logs

The bot runs on a VPS reachable as `ssh tf2bot`. Everything below is read-only.

## Where things are

| | |
|---|---|
| Checkout | `/root/my-patch/pricedb-crafting-bot` (the **real** one — `/root/tf2autobot-pricedb` is a decoy) |
| pm2 process | `autofab-tf2autobot` |
| Live log | `logs/out.log` — **rotates at midnight UTC**, prior days are `out__YYYY-MM-DD_00-00-00.log` |
| Error log | `logs/err.log` — append-only across restarts, so old entries sit above new ones |

Log lines carry ANSI colour codes. Strip them or greps and column counts misbehave:

```bash
sed -E 's/\x1b\[[0-9;]*m//g'
```

Rotation is the most common mistake: an incident spanning midnight lives in **two** files. Check
timestamps before concluding something didn't happen.

## First decide which kind of audit this is

**Scoped (the common case).** A feature or bugfix is in flight and the question is "did my change
work?" Trace only that — the specific trade or code path, whether it behaved as intended, and any
anomaly that bears on it. Then stop. Do **not** append uptime, restart counts, capacity or unrelated
warnings; padding the answer with clean-but-irrelevant metrics buries the verdict the user is
actually waiting for. Skip to "Tracing one trade end to end".

**Broad.** An unprompted "audit logs" with nothing in flight, or an explicit ask for overall health.
Run the whole sweep below.

If unsure, look at what was last deployed. If it was minutes ago and we have been iterating on it,
the audit is scoped.

## Start here (broad audits)

```bash
ssh tf2bot 'date -u; pm2 list | grep -E "autofab-tf2autobot|name"; ss -ltn | grep 3001; curl -s -m 5 http://127.0.0.1:3001/health'
```

`↺` is the restart count — if it is climbing, the bot is crashlooping and that is the story. The
HTTP API binding on 3001 is the readiness signal; **do not** wait a fixed interval or grep the log
for a startup marker, which will match an older run and return instantly.

## The sweep (broad audits)

Noise filters matter — the `excluding uncraftable/Festive` debug lines can be hundreds per trade.

```bash
cd /root/my-patch/pricedb-crafting-bot/logs

# 1. Crafting service: the spine of any incident
grep -E 'craftingService\] (Intake|Craft|Sent|Partial|Parts|Return|Nothing|Held)' out.log \
  | sed -E 's/\x1b\[[0-9;]*m//g' | grep -viE 'excluding (uncraftable|Festive)' | cut -c1-190 | tail -40

# 2. Errors and warnings
grep -E '(error|warn):' out.log | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-190 | tail -40

# 3. Steam connection health
grep -E 'Unhandled Steam error|Successfully reconnected|Failed to reconnect|Deferring Steam' out.log \
  | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-110

# 4. Stuck items — should normally be empty
grep -iE 'Held [0-9]+ item|heldReturn|retryreturn|retryintake|unaccounted' out.log \
  | sed -E 's/\x1b\[[0-9;]*h//g' | cut -c1-190 | tail -20

# 5. Capacity (has been the tightest constraint; cap is 1100)
grep -o 'Total items: [0-9]*/1100' out.log | uniq -c | tail -10
```

## Tracing one trade end to end

Offer IDs thread the whole story. Given one, or a customer steamid64:

```bash
grep -E '<offerid>|<steamid64>' out.log | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-200
```

A healthy crafting flow looks like:

```
Sent intake request-offer  ->  accepted
Intake backpack diff (attempt 1): N new item(s)
Intake: sent components offer <id> (N item(s), missing: ...)   <- accepted
Craft plan: N fab(s) to attempt
Craft succeeded for fab <id> — kit <id>     (or "Partial fill for fab ...")
Sending return offer ... -> accepted
```

Any step present but the next absent localises the fault immediately.

**Single vs batch matters.** One fabricator in a trade takes `handleCraftingIntake`, which logs
`missing: ...` explicitly. Two or more take `handleCraftingIntakeBatch`, which does **not**. When
setting up a test, send exactly one fabricator to keep that line.

## Reading the failures you will actually hit

| Symptom | What it means |
|---|---|
| `ensureFreshBackpack: no GC session, backpack is a stale snapshot` | Normal. The GC session lapsed and is being re-established. Absence of this line means the session was live. |
| `Could not refresh the GC backpack ... Timed out` | GC unreachable. Usually Steam-side; check for `EResult` errors nearby. |
| `EYldRefreshAppIfNecessary(440) failed with EResult 55` | Steam's TF2 item server is down. Offers get cancelled spuriously; not a bot bug. |
| `Unhandled Steam error ... NoConnection` | Connection dropped. Recovery is automatic (5 attempts, backoff). Only worth flagging if it needs **more than one attempt** or exhausts all five. |
| `Deferring Steam recovery for N minutes during weekly maintenance` | Upstream behaviour, Tuesdays 13:00–17:15 Pacific. The bot deliberately sits out the window. Not a fault. |
| `Craft plan: 0 fab(s) to attempt, 1 with no matching components` | The parts that arrived did not satisfy any slot. |
| `Partial fill for fab <id>` | Not a failure — components are banked inside the fabricator and it returns closer to done. |
| `Failed to add null (<assetid>) to sell automatically` | A dict keyed by asset id instead of SKU. Fixed in `5a8a0dfb`; a recurrence means a new unbounded/unresolved dict. |
| `Invalid Form Body: content must be N or fewer in length` | A message whose length scales with inventory or offer size. Both 2000 and 4000 caps have been seen. |

## Traps that have produced wrong conclusions before

- **A dead offer is not a delivered offer.** `sendOffer` resolving only means Steam *created* the
  offer. `cancelTime` (15 min) withdraws anything unaccepted. Always confirm `Active -> Accepted`;
  a 15-minute gap ending in `Canceled` means the items are still in the bot.
- **`err.log` is append-only.** An entry above a startup banner belongs to an older process. Check
  the pid.
- **Silence can be a rejected message, not an absent event.** Discord rejects oversized payloads, so
  a command can execute perfectly and appear to do nothing. Check for `Failed to send message to
  Discord` before concluding a feature did not run.
- **Steam asset IDs change on trade.** IDs from a customer's pre-trade inventory will not match the
  bot's backpack.
- **`GetPlayerItems` omits Normal-quality (stock) items** and returns 503 for private inventories.

## Useful cross-checks

Whether items are genuinely still held, independent of the bot's own view:

```bash
ssh tf2bot "cd /root/my-patch/pricedb-crafting-bot && python3 - <<'PY'
import json,urllib.request
env=json.load(open('ecosystem.json'))['apps'][0]['env']
key=env.get('STEAM_API_KEY')
sid='<steamid64>'
d=json.load(urllib.request.urlopen(f'https://api.steampowered.com/IEconItems_440/GetPlayerItems/v1/?key={key}&steamid={sid}',timeout=25))['result']
items=d.get('items',[])
print('items',len(items),'slots',d.get('num_backpack_slots'))
PY"
```

Read the key inside the script; never echo it.

To distinguish "Steam is broken" from "our VPS is broken":

```bash
ssh tf2bot 'ping -c 3 -W 2 8.8.8.8 | tail -2; curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -m 8 https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/; pm2 list'
```

Other pm2 processes staying up while the bot flaps points at the Steam CM socket specifically,
which is separate infrastructure from the Web API.

## Reporting

Lead with the answer, not the method. State what broke, cite the timestamped log lines that show
it, and separate **verified** from **inferred** — several past conclusions were wrong because a
plausible story was reported as fact.

On a **scoped** audit the answer is a verdict on the change: did it do what it was meant to, shown
by the lines that prove it. Nothing else belongs there. On a **broad** audit, if nothing is wrong,
say so plainly with the one or two numbers that back it rather than narrating every clean check.

Quiet logs are not proof of correctness: a code path that never executed produces no output, which
looks identical to one that ran perfectly.
