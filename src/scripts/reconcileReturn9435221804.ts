/* eslint-disable no-console */
// One-time, receipt-verified correction for the overlapping batches on 2026-10-19.
// Dry run by default. --apply requires a stopped bot and the compiled journal class.
import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import CraftingJournal, { CraftJobRecord } from '../lib/craftingJournal';

interface SteamAsset {
    assetid: string;
    new_assetid?: string;
    rollback_new_assetid?: string;
}
interface SteamTrade {
    status: number;
    steamid_other: string;
    assets_given: SteamAsset[];
    assets_received: SteamAsset[];
}
interface SteamOffer {
    accountid_other: number;
    trade_offer_state: number;
    is_our_offer: boolean;
    tradeid: string;
}

const source = '9435221804';
const customer = '76561198164485484';
const original = [
    '17703050604',
    '17703050617',
    '17703050634',
    '17703050640',
    '17703050651',
    '17703050658',
    '17703050666',
    '17703050680'
];
const incoming = ['17703050634', '17703050640', '17703050651'];
const automatic = ['17703050658', '17703050666', '17703050680'];
const recovered = ['17703051734', '17703051738', '17703050641', '17703050697', '17703050707'];
const journalPath = path.resolve('files/mushroomluver420/craftingJournal.json');
const config = JSON.parse(fs.readFileSync('ecosystem.json', 'utf8')) as { apps: { env: { STEAM_API_KEY: string } }[] };
const env = config.apps[0].env;
const sameSet = (left: string[], right: string[]) => assert.deepEqual([...left].sort(), [...right].sort());

async function api<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.steampowered.com/IEconService/${method}/v1/`);
    for (const [key, value] of Object.entries({ key: env.STEAM_API_KEY, ...params })) url.searchParams.set(key, value);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Steam ${method} returned HTTP ${response.status}`);
    return ((await response.json()) as { response: T }).response;
}

async function receipt(id: string, state: number, status: number): Promise<SteamTrade> {
    const offer = (await api<{ offer: SteamOffer }>('GetTradeOffer', { tradeofferid: id })).offer;
    assert.equal(offer.trade_offer_state, state, `Unexpected offer state ${id}`);
    assert.equal((BigInt(offer.accountid_other) + 76561197960265728n).toString(), customer);
    assert.equal(offer.is_our_offer, true);
    const trade = (await api<{ trades: SteamTrade[] }>('GetTradeStatus', { tradeid: offer.tradeid })).trades[0];
    assert.equal(trade.status, status, `Unexpected exchange status ${id}`);
    assert.equal(trade.steamid_other, customer);
    return trade;
}

async function main() {
    const failed = await receipt('9435222971', 6, 4);
    const retry = await receipt('9435225023', 3, 3);
    const manual = await receipt('9435404772', 3, 3);
    const overlap = await receipt('9435221822', 3, 3);
    sameSet(
        failed.assets_given.map(item => item.assetid),
        original
    );
    sameSet(
        retry.assets_given.map(item => item.assetid),
        automatic
    );
    sameSet(
        manual.assets_given.map(item => item.assetid),
        recovered
    );
    sameSet(
        overlap.assets_received.map(item => item.new_assetid).filter(id => incoming.includes(id)),
        incoming
    );
    const mappings = Object.fromEntries(
        failed.assets_given
            .filter(item => item.rollback_new_assetid)
            .map(item => [item.assetid, item.rollback_new_assetid])
    );
    assert.deepEqual(mappings, { 17703050604: '17703051734', 17703050617: '17703051738' });
    const records = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, CraftJobRecord>;
    if (!records[source]) {
        const archive = fs.readFileSync(journalPath.replace('.json', '.archive.jsonl'), 'utf8');
        const archived = archive
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as CraftJobRecord);
        assert(archived.some(record => record.offerId === source && record.stage === 'completed'));
        console.log('Already reconciled; no changes.');
        return;
    }
    assert.equal(records[source].partnerSteamId, customer);
    assert.equal(records[source].stage, 'held');
    sameSet(records[source].returnAssetIds, original);
    console.log(
        'Verified: three automatic and five manual returns were accepted; three old claims were incoming ingredients.'
    );
    if (!process.argv.includes('--apply')) {
        console.log('Dry run only. Stop the bot and use --apply to archive the corrected balance. No trades are sent.');
        return;
    }
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })) as {
        name: string;
        pm2_env: { status: string };
    }[];
    assert(
        processes.some(process => process.name === 'autofab-tf2autobot' && process.pm2_env.status === 'stopped'),
        'Stop autofab-tf2autobot before changing its journal'
    );
    const backup = `${journalPath}.before-9435221804-${Date.now()}`;
    fs.copyFileSync(journalPath, backup, fs.constants.COPYFILE_EXCL);
    const journal = new CraftingJournal(journalPath);
    journal.update(source, {
        stage: 'completed',
        processingComplete: true,
        returnAssetIds: [],
        deliveredAssetIds: [...automatic, ...recovered],
        assetIdMappings: mappings,
        returnAttempts: [
            { offerId: '9435222971', assetIds: original, state: 'failed' },
            { offerId: '9435225023', assetIds: automatic, state: 'delivered' },
            { offerId: '9435404772', assetIds: recovered, state: 'delivered' }
        ],
        reconciliationEvidence: {
            offerIds: ['9435222971', '9435221822', '9435225023', '9435404772'],
            note: 'Steam receipts verify two rollback IDs, three falsely claimed incoming ingredients, and accepted delivery of all eight actual outputs via automatic retry and owner-authorized manual recovery.'
        }
    });
    console.log(`Reconciled ${source}; archived verified delivery. Backup: ${backup}`);
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Recovery verification failed');
    process.exitCode = 1;
});
