import fs from 'fs';
import os from 'os';
import path from 'path';
import SteamID from 'steamid';
import { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import MyHandler from '../MyHandler/MyHandler';
import CraftingJournal from '../../lib/craftingJournal';
import { CraftItem, CraftOperation } from '../../lib/craftingReconciliation';

jest.mock('../../lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));
jest.mock('../../lib/craftingWebsiteApi', () => ({
    fetchTradeUrlToken: jest.fn().mockResolvedValue(undefined),
    notifyReturnOffer: jest.fn().mockResolvedValue(undefined)
}));

interface ReturnHandler {
    queueCompletedCraftingReturn: (source: string, ids: string[]) => Promise<void>;
    reconcileCraftingOperations: (forceRefresh?: boolean) => Promise<void>;
    craftingJournal: CraftingJournal;
    craftingInFlightIds: Set<string>;
    heldReturnItems: Map<string, string[]>;
    freshGCBackpack: () => Promise<CraftItem[]>;
    reconcileReturnOffer: (offer: TradeOffer) => Promise<void>;
    releaseCraftingInFlight: (ids: string[]) => void;
    retryHeldReturn: (partner: string) => Promise<string>;
    reconcileCraftingReturns: () => Promise<void>;
    discoverUntrackedReturns: () => Promise<void>;
    reconcileMissingCraftReceipts: () => Promise<void>;
    isCraftingAssetReserved: (id: string) => boolean;
    prepareCraftingOffer: (offer: TradeOffer, giveIds: string[], receiveIds: string[]) => void;
    bot: { tf2gc: { forceFreshBackpack: jest.Mock }; messageAdmins: jest.Mock };
}

let directory: string;
let handler: ReturnHandler;
const customer = new SteamID('76561198164485484');
const items = (ids: string[]): CraftItem[] => ids.map(id => ({ id, original_id: id, def_index: 6523, quality: 6 }));

function offer(id: string, assetIds: string[], state: number, sent: object[], status = 3, error?: Error): TradeOffer {
    const data = new Map<string, unknown>([['craftingServiceReturn', { assetIds, sourceOfferId: 'source' }]]);
    return {
        id,
        partner: customer,
        state,
        itemsToGive: assetIds.map(assetid => ({ assetid })),
        itemsToReceive: [],
        tradeID: `trade-${id}`,
        data: (key: string, value?: unknown) => {
            if (value !== undefined) data.set(key, value);
            return data.get(key);
        },
        getExchangeDetails: (_failed: boolean, callback: (...args: unknown[]) => void) =>
            callback(error, status, new Date(), [], sent)
    } as unknown as TradeOffer;
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'return-reconciliation-'));
    const journal = new CraftingJournal(path.join(directory, 'journal.json'));
    journal.recordAccepted('source', customer.getSteamID64(), 'components', []);
    handler = Object.create(MyHandler.prototype) as ReturnHandler;
    handler.craftingJournal = journal;
    handler.craftingInFlightIds = new Set();
    handler.heldReturnItems = new Map();
    handler.releaseCraftingInFlight = jest.fn();
    handler.freshGCBackpack = jest.fn().mockResolvedValue([]);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test('canceled eight-item return maps rollback assets and retains every unresolved item', async () => {
    const ids = ['old-1', 'old-2', 'missing-1', 'missing-2', 'missing-3', 'same-1', 'same-2', 'same-3'];
    handler.craftingJournal.addReturn('source', ids);
    handler.freshGCBackpack = jest.fn().mockResolvedValue(items(['new-1', 'new-2', 'same-1', 'same-2', 'same-3']));
    const failed = offer(
        'failed',
        ids,
        6,
        [
            { assetid: 'old-1', rollback_new_assetid: 'new-1', rollback_new_contextid: '2' },
            { assetid: 'old-2', rollback_new_assetid: 'new-2', rollback_new_contextid: '2' }
        ],
        4
    );
    await handler.reconcileReturnOffer(failed);
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual([
        'new-1',
        'new-2',
        'missing-1',
        'missing-2',
        'missing-3',
        'same-1',
        'same-2',
        'same-3'
    ]);
    const retry = offer(
        'retry',
        ['same-1', 'same-2', 'same-3'],
        3,
        ['same-1', 'same-2', 'same-3'].map(assetid => ({ assetid, new_assetid: `customer-${assetid}` }))
    );
    await handler.reconcileReturnOffer(retry);
    await handler.reconcileReturnOffer(retry);
    const restored = new CraftingJournal(path.join(directory, 'journal.json'));
    expect(restored.get('source')?.returnAssetIds).toEqual(['new-1', 'new-2', 'missing-1', 'missing-2', 'missing-3']);
    expect(restored.get('source')?.deliveredAssetIds).toEqual(['same-1', 'same-2', 'same-3']);
    expect(restored.get('source')?.stage).toBe('held');
});

test('accepted state without a complete exchange receipt cannot establish delivery', async () => {
    handler.craftingJournal.addReturn('source', ['kit']);
    await expect(handler.reconcileReturnOffer(offer('return', ['kit'], 3, [], 3))).rejects.toThrow(
        'Incomplete return receipt'
    );
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['kit']);
    expect(handler.craftingJournal.get('source')?.returnAttempts?.[0].state).toBe('reconcile');
});

test('Steam receipt failures preserve balances and reservations for another reconciliation pass', async () => {
    handler.craftingJournal.addReturn('source', ['kit']);
    handler.craftingInFlightIds.add('kit');
    await expect(
        handler.reconcileReturnOffer(offer('return', ['kit'], 6, [], 4, new Error('Steam unavailable')))
    ).rejects.toThrow('Steam unavailable');
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['kit']);
    expect(handler.craftingInFlightIds.has('kit')).toBe(true);
});

test('active and unconfirmed return offers remain tracked without reporting delivery', async () => {
    handler.craftingJournal.addReturn('source', ['kit']);
    await handler.reconcileReturnOffer(offer('return', ['kit'], 9, []));
    expect(handler.craftingJournal.get('source')?.returnAttempts).toEqual([
        { offerId: 'return', assetIds: ['kit'], state: 'active' }
    ]);
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['kit']);
});

test('concurrent retries hold the entire balance when any item is missing', async () => {
    handler.craftingJournal.addReturn('source', ['present', 'missing'], true);
    handler.craftingJournal.update('source', { stage: 'held' });
    handler.heldReturnItems.set(customer.getSteamID64(), ['present', 'missing']);
    handler.freshGCBackpack = jest.fn().mockResolvedValue(items(['present']));
    handler.reconcileCraftingReturns = jest.fn().mockResolvedValue(undefined);
    const outgoing = { id: 'retry', addMyItem: jest.fn(), setMessage: jest.fn() };
    const sendOffer = jest.fn().mockResolvedValue('sent');
    Object.assign(handler, {
        retryingReturnPartners: new Set(),
        prepareCraftingOffer: jest.fn(),
        bot: { manager: { createOffer: jest.fn(() => outgoing) }, trades: { sendOffer } }
    });
    const results = await Promise.all([
        handler.retryHeldReturn(customer.getSteamID64()),
        handler.retryHeldReturn(customer.getSteamID64())
    ]);
    expect(sendOffer).not.toHaveBeenCalled();
    expect(results.some(value => value.includes('already running'))).toBe(true);
    expect(handler.heldReturnItems.get(customer.getSteamID64())).toEqual(['present', 'missing']);
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['present', 'missing']);
});

test('an entirely missing balance remains held for later receipt reconciliation', async () => {
    handler.craftingJournal.update('source', { stage: 'held', processingComplete: true });
    handler.heldReturnItems.set(customer.getSteamID64(), ['missing']);
    Object.assign(handler, { retryingReturnPartners: new Set() });
    handler.reconcileCraftingReturns = jest.fn().mockResolvedValue(undefined);
    expect(await handler.retryHeldReturn(customer.getSteamID64())).toContain('nothing was discarded');
    expect(handler.heldReturnItems.get(customer.getSteamID64())).toEqual(['missing']);
});

test('restart discovers a return accepted before its offer ID was journaled', async () => {
    handler.craftingJournal.addReturn('source', ['kit'], true);
    const accepted = offer('discovered', ['kit'], 3, [{ assetid: 'kit', new_assetid: 'customer-kit' }]);
    const getOffers = jest.fn(
        (_filter: number, _cutoff: Date, callback: (err: Error | null, sent: TradeOffer[]) => void) =>
            callback(null, [accepted])
    );
    Object.assign(handler, { bot: { manager: { getOffers } } });
    await handler.discoverUntrackedReturns();
    expect(handler.craftingJournal.get('source')?.returnAttempts?.[0].offerId).toBe('discovered');
    await handler.reconcileReturnOffer(accepted);
    expect(handler.craftingJournal.get('source')).toBeUndefined();
    expect(getOffers).toHaveBeenCalledTimes(1);
});

test('a failed discovery lookup cannot turn an unknown return into a duplicate offer', async () => {
    handler.craftingJournal.addReturn('source', ['kit'], true);
    handler.craftingJournal.update('source', { returnStartedAt: '2026-01-01T00:00:00Z' });
    Object.assign(handler, {
        bot: {
            manager: {
                getOffers: (_filter: number, _cutoff: Date, callback: (err: Error) => void) =>
                    callback(new Error('Steam unavailable'))
            }
        }
    });
    await expect(handler.discoverUntrackedReturns()).rejects.toThrow('Steam unavailable');
    expect(handler.craftingJournal.get('source')?.stage).toBe('returning');
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['kit']);
});

test('a delayed complete receipt recovers exact inputs without replaying a GC operation', async () => {
    handler.craftingJournal.update('source', { stage: 'held', receiptPending: true });
    const incoming = offer('source', [], 3, []);
    Object.assign(incoming, {
        itemsToReceive: [{ assetid: 'customer-old' }],
        getExchangeDetails: (_failed: boolean, callback: (...args: unknown[]) => void) =>
            callback(null, 3, new Date(), [{ appid: 440, new_contextid: '2', new_assetid: 'new-input' }], [])
    });
    Object.assign(handler, {
        bot: {
            manager: {
                getOffer: (_id: string, callback: (err: Error | null, value: TradeOffer) => void) =>
                    callback(null, incoming)
            },
            messageAdmins: jest.fn()
        }
    });
    handler.freshGCBackpack = jest.fn().mockResolvedValue(items(['new-input']));
    await handler.reconcileMissingCraftReceipts();
    expect(handler.craftingJournal.get('source')).toMatchObject({
        receiptPending: false,
        stage: 'held',
        processingComplete: true,
        receivedAssetIds: ['new-input'],
        returnAssetIds: ['new-input']
    });
    expect(handler.heldReturnItems.get(customer.getSteamID64())).toEqual(['new-input']);
});

test('unidentified customer custody quarantines new arrivals until the receipt is recovered', () => {
    Object.assign(handler, { heldIntakeFabricators: new Map() });
    handler.craftingJournal.update('source', {
        receiptPending: true,
        receiptSnapshotIds: ['old-stock'],
        stage: 'held'
    });
    expect(handler.isCraftingAssetReserved('unknown-arrival')).toBe(true);
    expect(handler.isCraftingAssetReserved('old-stock')).toBe(false);
    handler.craftingJournal.update('source', { receiptPending: false, receivedAssetIds: ['customer-input'] });
    expect(handler.isCraftingAssetReserved('unknown-arrival')).toBe(false);
    expect(handler.isCraftingAssetReserved('customer-input')).toBe(true);
});

test.each([0, 1, 2, 10])('an unsettled exchange status %i cannot trigger another return', async status => {
    handler.craftingJournal.addReturn('source', ['kit'], true);
    handler.freshGCBackpack = jest.fn().mockResolvedValue(items(['kit']));
    await handler.reconcileReturnOffer(offer('return', ['kit'], 3, [{ assetid: 'kit' }], status));
    expect(handler.craftingJournal.get('source')?.returnAttempts?.[0].state).toBe('reconcile');
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(['kit']);
    expect(handler.freshGCBackpack).not.toHaveBeenCalled();
});

test('manual recovery persists both known and previously untracked assets before sending', () => {
    handler.craftingJournal.addReturn('source', ['known'], true);
    Object.assign(handler, { craftingDict: jest.fn(() => ({ our: {}, their: {} })) });
    const recovery = offer('manual', ['known', 'untracked'], 2, []);
    handler.prepareCraftingOffer(recovery, ['known', 'untracked'], []);
    const entries = handler.craftingJournal.open();
    expect(entries.find(job => job.phase === 'return-recovery')).toMatchObject({
        partnerSteamId: customer.getSteamID64(),
        returnAssetIds: ['untracked'],
        processingComplete: true
    });
    const metadata = recovery.data('craftingServiceReturn') as { sourceOfferIds: string[] };
    expect(metadata.sourceOfferIds).toContain('source');
});

test('a rollback ID absent from the GC snapshot is reserved and refreshed before retry', async () => {
    handler.craftingJournal.addReturn('source', ['old'], true);
    handler.freshGCBackpack = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(items(['replacement']));
    const refresh = jest.fn().mockResolvedValue(undefined);
    Object.assign(handler, { bot: { tf2gc: { forceFreshBackpack: refresh } } });
    await handler.reconcileReturnOffer(
        offer(
            'failed',
            ['old'],
            6,
            [{ assetid: 'old', rollback_new_assetid: 'replacement', rollback_new_contextid: '2' }],
            4
        )
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(handler.craftingJournal.get('source')).toMatchObject({
        returnAssetIds: ['replacement'],
        rollbackCandidateIds: ['replacement'],
        assetIdMappings: { old: 'replacement' }
    });
});

function setupBatchReturns(ids: string[]) {
    const outgoing = offer('combined', ids, 2, []);
    const addMyItem = jest.fn();
    Object.assign(outgoing, { addMyItem, setMessage: jest.fn() });
    const sendOffer = jest.fn().mockResolvedValue('sent');
    Object.assign(handler, {
        retryingReturnPartners: new Set(),
        craftingDict: jest.fn(() => ({ our: {}, their: {} })),
        bot: {
            manager: { createOffer: jest.fn(() => outgoing) },
            trades: { sendOffer },
            tf2gc: { forceFreshBackpack: jest.fn().mockResolvedValue(undefined) },
            sendMessage: jest.fn(),
            messageAdmins: jest.fn()
        }
    });
    handler.reconcileCraftingReturns = jest.fn().mockResolvedValue(undefined);
    handler.freshGCBackpack = jest.fn().mockResolvedValue(items(ids));
    return { outgoing, sendOffer, addMyItem };
}

const heldOperation: CraftOperation = {
    id: 'rescue',
    kind: 'craftFabricator',
    state: 'held',
    startedAt: '2026-10-19T08:41:30Z',
    inputIds: ['fab', 'component'],
    beforeIds: ['fab', 'component'],
    expected: { defindexes: [6526], attributes: { 2012: 997, 2014: 3, 2013: 2004, 2025: 3 }, newlyCreated: true }
};

test('two accepted jobs for one customer wait and send all results in one offer', async () => {
    const { outgoing, sendOffer, addMyItem } = setupBatchReturns(['kit-a', 'kit-b']);
    handler.craftingJournal.recordAccepted('second', customer.getSteamID64(), 'components', []);
    await handler.queueCompletedCraftingReturn('source', ['kit-a']);
    expect(sendOffer).not.toHaveBeenCalled();
    expect(handler.craftingJournal.get('source')).toMatchObject({
        processingComplete: true,
        returnAssetIds: ['kit-a']
    });
    await handler.queueCompletedCraftingReturn('second', ['kit-b']);
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(addMyItem).toHaveBeenCalledWith({ appid: 440, contextid: '2', assetid: 'kit-a' });
    expect(addMyItem).toHaveBeenCalledWith({ appid: 440, contextid: '2', assetid: 'kit-b' });
    expect(outgoing.data('craftingServiceReturn')).toMatchObject({ sourceOfferIds: ['source', 'second'] });
});

test('an unresolved operation blocks even when some outputs are ready, then recovers together', async () => {
    const { sendOffer, addMyItem } = setupBatchReturns(['ready', 'rescue-kit']);
    handler.craftingJournal.addOperation('source', heldOperation);
    await handler.queueCompletedCraftingReturn('source', ['ready']);
    expect(sendOffer).not.toHaveBeenCalled();
    handler.craftingJournal.finishOperation('source', 'rescue', 'rescue-kit', ['fab', 'component']);
    await handler.retryHeldReturn(customer.getSteamID64());
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(addMyItem).toHaveBeenCalledTimes(2);
});

test('an unrelated customer with pending work does not block a complete return', async () => {
    const { sendOffer } = setupBatchReturns(['ready']);
    handler.craftingJournal.recordAccepted('other', '76561198135282692', 'components', []);
    await handler.queueCompletedCraftingReturn('source', ['ready']);
    expect(sendOffer).toHaveBeenCalledTimes(1);
});

test('an old fabricator awaiting components does not block a separate completed batch', async () => {
    const { sendOffer } = setupBatchReturns(['ready']);
    handler.craftingJournal.recordAccepted('old', customer.getSteamID64(), 'intake', ['old-fab']);
    handler.craftingJournal.update('old', { stage: 'awaiting_components' });
    await handler.queueCompletedCraftingReturn('source', ['ready']);
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(handler.craftingJournal.get('old')).toMatchObject({ stage: 'awaiting_components', fabricatorAssetIds: ['old-fab'] });
});

test('one fresh snapshot reconciles multiple held operations and retains their return claims', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    Object.assign(handler, {
        bot: { tf2gc: { forceFreshBackpack: refresh }, messageAdmins: jest.fn() },
        craftingRefreshInFlight: null,
        nextCraftingRefreshAt: 0,
        craftingRefreshFailures: 0
    });
    handler.reconcileMissingCraftReceipts = jest.fn().mockResolvedValue(undefined);
    const second = { ...heldOperation, id: 'second', inputIds: ['fab-2'], beforeIds: ['fab-2'], expected: { defindexes: [6523], attributes: {}, newlyCreated: true } };
    handler.craftingJournal.addOperation('source', heldOperation);
    handler.craftingJournal.addOperation('source', second);
    const attrs = [
        [2012, 997], [2014, 3], [2013, 2004]
    ].map(([def_index, value]) => ({ def_index, value }));
    handler.freshGCBackpack = jest.fn().mockResolvedValue([
        { id: 'rescue-kit', def_index: 6526, quality: 6, attribute: attrs },
        { id: 'other-kit', def_index: 6523, quality: 6 }
    ]);
    await handler.reconcileCraftingOperations(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(handler.craftingJournal.get('source')?.operations?.map(op => op.outputId)).toEqual(['rescue-kit', 'other-kit']);
    expect(handler.craftingJournal.get('source')?.returnAssetIds).toEqual(expect.arrayContaining(['rescue-kit', 'other-kit']));
});

test('held reconciliation backs off after timeouts and preserves all reservations', async () => {
    let now = Date.parse('2026-10-20T17:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const refresh = jest.fn().mockRejectedValue(new Error('GC timeout'));
    Object.assign(handler, {
        bot: { tf2gc: { forceFreshBackpack: refresh }, messageAdmins: jest.fn() },
        craftingRefreshInFlight: null,
        nextCraftingRefreshAt: 0,
        craftingRefreshFailures: 0
    });
    handler.reconcileMissingCraftReceipts = jest.fn().mockResolvedValue(undefined);
    handler.craftingJournal.addOperation('source', heldOperation);
    handler.craftingInFlightIds.add('fab');
    handler.freshGCBackpack = jest.fn().mockResolvedValue([]);
    await handler.reconcileCraftingOperations(true);
    await handler.reconcileCraftingOperations(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    now += 3 * 60 * 1000;
    await handler.reconcileCraftingOperations(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    now += 3 * 60 * 1000;
    await handler.reconcileCraftingOperations(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(handler.craftingJournal.get('source')?.operations?.[0].state).toBe('held');
    expect(handler.craftingInFlightIds.has('fab')).toBe(true);
    jest.restoreAllMocks();
});

test('no held operation means no forced GC refresh', async () => {
    const refresh = jest.fn();
    Object.assign(handler, { bot: { tf2gc: { forceFreshBackpack: refresh } } });
    handler.reconcileMissingCraftReceipts = jest.fn().mockResolvedValue(undefined);
    await handler.reconcileCraftingOperations(true);
    expect(refresh).not.toHaveBeenCalled();
});

test('a zero-output held job records completion, survives restart, and identifies the live GC Rescue Ranger kit', async () => {
    const { sendOffer } = setupBatchReturns([]);
    handler.craftingJournal.addOperation('source', heldOperation);
    await handler.queueCompletedCraftingReturn('source', []);
    expect(sendOffer).not.toHaveBeenCalled();
    handler.craftingJournal = new CraftingJournal(path.join(directory, 'journal.json'));
    expect(handler.craftingJournal.get('source')?.processingComplete).toBe(true);
    const attribute = [
        [2012, 997],
        [2014, 3],
        [2013, 2004]
    ].map(([def_index, value]) => {
        const value_bytes = Buffer.alloc(4);
        value_bytes.writeFloatLE(value);
        return { def_index, value: null, value_bytes };
    });
    handler.freshGCBackpack = jest
        .fn()
        .mockResolvedValue([{ id: 'rescue-kit', def_index: 6526, quality: 6, attribute }]);
    handler.reconcileMissingCraftReceipts = jest.fn().mockResolvedValue(undefined);
    await handler.reconcileCraftingOperations();
    expect(handler.craftingJournal.get('source')?.operations?.[0]).toMatchObject({
        state: 'completed',
        outputId: 'rescue-kit'
    });
    await handler.retryHeldReturn(customer.getSteamID64());
    expect(sendOffer).toHaveBeenCalledTimes(1);
});

test('historical held claims discover an accepted retry even without saved poll metadata', async () => {
    handler.craftingJournal.addReturn('source', ['old-kit'], true);
    handler.craftingJournal.update('source', { stage: 'held' });
    const accepted = offer('historical', ['old-kit'], 3, [{ assetid: 'old-kit', new_assetid: 'customer-kit' }]);
    Object.assign(handler, {
        bot: {
            manager: {
                getOffers: (
                    _filter: number,
                    _cutoff: Date,
                    callback: (err: Error | null, sent: TradeOffer[]) => void
                ) => callback(null, [accepted])
            }
        }
    });
    await handler.discoverUntrackedReturns();
    await handler.reconcileReturnOffer(accepted);
    expect(handler.craftingJournal.get('source')).toBeUndefined();
});

test('restart discovers one combined return spanning multiple source jobs', async () => {
    handler.craftingJournal.addReturn('source', ['kit-a'], true);
    handler.craftingJournal.recordAccepted('second', customer.getSteamID64(), 'components', []);
    handler.craftingJournal.addReturn('second', ['kit-b'], true);
    const accepted = offer(
        'combined',
        ['kit-a', 'kit-b'],
        3,
        ['kit-a', 'kit-b'].map(assetid => ({ assetid, new_assetid: `customer-${assetid}` }))
    );
    Object.assign(handler, {
        bot: {
            manager: {
                getOffers: (
                    _filter: number,
                    _cutoff: Date,
                    callback: (err: Error | null, sent: TradeOffer[]) => void
                ) => callback(null, [accepted])
            }
        }
    });
    await handler.discoverUntrackedReturns();
    await handler.reconcileReturnOffer(accepted);
    expect(handler.craftingJournal.open()).toHaveLength(0);
});

test('a new accepted job during inventory refresh prevents sending the earlier result alone', async () => {
    const { sendOffer } = setupBatchReturns(['kit-a']);
    handler.craftingJournal.addReturn('source', ['kit-a'], true);
    handler.craftingJournal.update('source', { stage: 'held' });
    handler.freshGCBackpack = jest.fn().mockImplementation(() => {
        handler.craftingJournal.recordAccepted('new-job', customer.getSteamID64(), 'components', []);
        return Promise.resolve(items(['kit-a']));
    });
    expect(await handler.retryHeldReturn(customer.getSteamID64())).toContain('Waiting for all');
    expect(sendOffer).not.toHaveBeenCalled();
});
