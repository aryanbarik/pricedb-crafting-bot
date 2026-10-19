/* One-time receipt repair for returns omitted from Steam's historical offer listing.
 * Run in the VPS bot checkout: node scripts/reconcile-known-crafting-returns.cjs
 *   <sourceOfferId>:<acceptedReturnOfferId> ... [--apply]
 * Dry-run by default. Uses the running handler to keep memory and disk consistent.
 * Never creates, accepts, cancels, or sends a trade offer.
 */
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

async function reconcile(pairs, apply) {
    if (this.length !== 1) throw new Error('Expected exactly one running Bot instance');
    const bot = this[0];
    const results = [];
    for (const [source, returnId] of pairs) {
        const job = bot.handler.craftingJournal.get(source);
        if (!job) { results.push({ source, alreadyArchived: true }); continue; }
        if (job.operations?.some(op => op.state !== 'completed')) throw new Error('Unresolved GC work');
        // A trade ID works for old transfers whose offer has rotated out of Steam's
        // offer-history listing. Verify against Steam's completed exchange receipt.
        const expected = [...(job.returnAssetIds.length ? job.returnAssetIds : job.fabricatorAssetIds)].sort();
        if (!expected.length) throw new Error('Source has no outstanding assets');
        let given;
        let destination;
        let offer;
        if (returnId.startsWith('trade-')) {
            const tradeid = returnId.slice(6);
            const fs = process.mainModule.require('fs');
            const key = JSON.parse(fs.readFileSync('ecosystem.json')).apps[0].env.STEAM_API_KEY;
            const url = new URL('https://api.steampowered.com/IEconService/GetTradeStatus/v1/');
            url.searchParams.set('key', key);
            url.searchParams.set('tradeid', tradeid);
            const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`Steam receipt HTTP ${response.status}`);
            const trade = (await response.json()).response.trades?.[0];
            if (!trade || String(trade.tradeid) !== tradeid || trade.status !== 3)
                throw new Error('Trade receipt is not complete');
            destination = String(trade.steamid_other);
            given = trade.assets_given ?? [];
        } else {
            offer = await new Promise((resolve, reject) => bot.manager.getOffer(returnId,
                (err, value) => err ? reject(err) : resolve(value)));
            if (offer.state !== 3 || !offer.tradeID || offer.itemsToReceive.length)
                throw new Error('Return must be an accepted free transfer');
            destination = offer.partner.getSteamID64();
            const receipt = await new Promise((resolve, reject) => offer.getExchangeDetails(true,
                (err, status, _time, _received, sent) => err ? reject(err) : resolve({ status, sent })));
            if (receipt.status !== 3) throw new Error('Exchange receipt is not complete');
            given = receipt.sent ?? [];
        }
        // The configured owner may take custody when the customer cannot wait.
        if (![job.partnerSteamId, '76561198138534634'].includes(destination))
            throw new Error('Destination does not match the customer or configured owner');
        const sentIds = given.map(asset => String(asset.assetid));
        if (JSON.stringify([...sentIds].sort()) !== JSON.stringify(expected))
            throw new Error('Complete receipt must match the entire outstanding balance');
        if (given.some(asset => !asset.new_assetid || asset.new_assetid === '0' || asset.new_contextid !== '2'))
            throw new Error('Missing destination asset IDs');
        if (apply) {
            const current = bot.handler.craftingJournal.get(source);
            const balance = current?.returnAssetIds.length ? current.returnAssetIds : current?.fabricatorAssetIds;
            if (!current || JSON.stringify([...balance].sort()) !== JSON.stringify(expected))
                throw new Error('Balance changed during verification; rerun');
            if (current.returnAssetIds.length) {
                bot.handler.craftingJournal.recordDelivery(source, sentIds);
            } else {
                if (current.phase !== 'intake' || current.operations?.length)
                    throw new Error('Cannot close a source without a recorded return balance');
                bot.handler.craftingJournal.update(source, {
                    stage: 'completed', processingComplete: true,
                    fabricatorAssetIds: [], deliveredAssetIds: sentIds
                });
            }
            sentIds.forEach(id => bot.handler.craftingInFlightIds.delete(id));
            const held = (bot.handler.heldReturnItems.get(job.partnerSteamId) ?? []).filter(id => !sentIds.includes(id));
            if (held.length) bot.handler.heldReturnItems.set(job.partnerSteamId, held);
            else bot.handler.heldReturnItems.delete(job.partnerSteamId);
            if (bot.handler.craftingJournal.get(source))
                throw new Error('Receipt reconciliation did not archive the source');
        }
        results.push({ source, returnId, destination, customer: job.partnerSteamId, delivered: sentIds, applied: apply });
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const pairs = args.filter(arg => arg !== '--apply').map(arg => {
        if (!/^\d+:(?:\d+|trade-\d+)$/.test(arg)) throw new Error('Expected sourceOfferId:returnOfferId or sourceOfferId:trade-<id>');
        return arg.split(':');
    });
    if (!pairs.length) throw new Error('Provide at least one sourceOfferId:returnOfferId');
    const pid = Number(execFileSync('pm2', ['pid', 'autofab-tf2autobot'], { encoding: 'utf8' }).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Bot is not running');
    // Do not attach to, or close, an inspector opened by someone else.
    try {
        await fetch('http://127.0.0.1:9229/json', { signal: AbortSignal.timeout(1000) });
        throw new Error('Inspector already open');
    } catch (err) {
        if (err.message === 'Inspector already open') throw err;
    }
    process.kill(pid, 'SIGUSR1');
    let targets;
    for (let attempt = 0; attempt < 20; attempt++) {
        try { targets = await (await fetch('http://127.0.0.1:9229/json')).json(); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!targets?.length) throw new Error('Inspector did not start; check localhost port 9229');
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let nextId = 0;
    const pending = new Map();
    ws.on('message', data => {
        const response = JSON.parse(data);
        if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
        pending.set(id, response => {
            clearTimeout(timeout);
            if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.error ?? response.result.exceptionDetails)));
            else resolve(response.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
    });
    try {
        const prototype = await call('Runtime.evaluate', {
            expression: 'process.mainModule.require("./classes/Bot").default.prototype'
        });
        const objects = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
        const result = await call('Runtime.callFunctionOn', {
            objectId: objects.objects.objectId,
            functionDeclaration: reconcile.toString(),
            arguments: [{ value: pairs }, { value: apply }],
            awaitPromise: true,
            returnByValue: true
        });
        console.log(JSON.stringify(result.result.value, null, 2));
    } finally {
        await call('Runtime.evaluate', { expression: 'setTimeout(() => process.mainModule.require("inspector").close(), 100)' });
        ws.close();
    }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
