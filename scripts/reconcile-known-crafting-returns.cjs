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
        const offer = await new Promise((resolve, reject) => bot.manager.getOffer(returnId,
            (err, value) => err ? reject(err) : resolve(value)));
        if (offer.state !== 3 || offer.partner.getSteamID64() !== job.partnerSteamId || !offer.tradeID || offer.itemsToReceive.length)
            throw new Error('Return must be an accepted free transfer to the recorded customer');
        const receipt = await new Promise((resolve, reject) => offer.getExchangeDetails(true,
            (err, status, _time, _received, sent) => err ? reject(err) : resolve({ status, sent })));
        const given = (receipt.sent ?? []).map(asset => String(asset.assetid));
        const expected = [...job.returnAssetIds].sort();
        if (receipt.status !== 3 || !expected.length || JSON.stringify([...given].sort()) !== JSON.stringify(expected))
            throw new Error('Complete receipt must match the entire outstanding balance');
        if (receipt.sent.some(asset => !asset.new_assetid || asset.new_assetid === '0' || asset.new_contextid !== '2'))
            throw new Error('Missing destination asset IDs');
        if (apply) {
            const current = bot.handler.craftingJournal.get(source);
            if (!current || JSON.stringify([...current.returnAssetIds].sort()) !== JSON.stringify(expected))
                throw new Error('Balance changed during verification; rerun');
            offer.data('craftingServiceReturn', { assetIds: given, sourceOfferId: source });
            await bot.handler.reconcileReturnOffer(offer);
            if (bot.handler.craftingJournal.get(source)?.returnAssetIds.length)
                throw new Error('Receipt reconciliation did not clear the balance');
        }
        results.push({ source, returnId, customer: job.partnerSteamId, delivered: given, applied: apply });
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const pairs = args.filter(arg => arg !== '--apply').map(arg => {
        if (!/^\d+:\d+$/.test(arg)) throw new Error('Expected sourceOfferId:returnOfferId');
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
