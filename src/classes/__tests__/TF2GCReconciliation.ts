import { EventEmitter } from 'events';
import TF2GC from '../TF2GC';
import Bot from '../Bot';
import { CraftItem, OutputExpectation } from '../../lib/craftingReconciliation';

jest.mock('../../lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

interface Observer {
    observeOperation(
        job: { type: string; allowPartial?: boolean },
        ids: string[],
        expected: OutputExpectation,
        send: () => void,
        callback: (err: Error | null, id?: string) => void,
        fabricator?: CraftItem
    ): void;
    finishedProcessingJob(err?: Error): void;
    refreshBackpackSession(): Promise<void>;
}

const expected: OutputExpectation = { defindexes: [6523], attributes: { 2012: 190, 2025: 2 }, newlyCreated: true };
const kit = (id: string, original = id): CraftItem => ({
    id,
    original_id: original,
    quality: 6,
    def_index: 6523,
    attribute: [
        { def_index: 2012, value: 190 },
        { def_index: 2025, value: 2 }
    ]
});

function fixture() {
    const tf2 = Object.assign(new EventEmitter(), {
        backpack: [{ id: 'fab', def_index: 20002, quality: 6 }] as CraftItem[]
    });
    const handler = {
        beginCraftingOperation: jest.fn(() => 'source'),
        finishCraftingOperation: jest.fn(),
        reserveCraftingCandidates: jest.fn(),
        craftingOutputExclusions: jest.fn(() => new Set<string>()),
        onTF2QueueCompleted: jest.fn()
    };
    const gc = new TF2GC({
        tf2,
        handler,
        schema: { getItemByDefindex: () => ({ item_name: 'Shotgun' }) }
    } as unknown as Bot);
    const observer = gc as unknown as Observer;
    const completed = jest.spyOn(observer, 'finishedProcessingJob').mockImplementation(() => undefined);
    jest.spyOn(observer, 'refreshBackpackSession').mockResolvedValue(undefined);
    return { tf2, handler, observer, completed };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('listeners and durable intent exist before send, including synchronous GC responses', () => {
    const { tf2, handler, observer, completed } = fixture();
    const callback = jest.fn();
    observer.observeOperation(
        { type: 'craftFabricator' },
        ['fab'],
        expected,
        () => {
            expect(handler.beginCraftingOperation).toHaveBeenCalledTimes(1);
            expect(tf2.listenerCount('itemAcquired')).toBe(1);
            tf2.backpack = [kit('result')];
            tf2.emit('itemAcquired', kit('result'));
        },
        callback
    );
    jest.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledWith(null, 'result', false);
    expect(handler.finishCraftingOperation).toHaveBeenCalledWith('source', expect.any(String), 'result', ['fab']);
    tf2.emit('itemAcquired', kit('result'));
    jest.advanceTimersByTime(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(tf2.listenerCount('itemAcquired')).toBe(0);
});

test('incoming identical kits cannot settle a craft, and out-of-order removal completes it once', () => {
    const { tf2, observer } = fixture();
    const callback = jest.fn();
    observer.observeOperation({ type: 'craftFabricator' }, ['fab'], expected, () => undefined, callback);
    tf2.backpack.push(kit('incoming', 'customer-kit'));
    tf2.emit('itemAcquired', kit('incoming', 'customer-kit'));
    jest.advanceTimersByTime(1);
    expect(callback).not.toHaveBeenCalled();
    tf2.backpack.push(kit('output'));
    tf2.emit('itemAcquired', kit('output'));
    jest.advanceTimersByTime(1);
    expect(callback).not.toHaveBeenCalled();
    tf2.backpack = tf2.backpack.filter(item => item.id !== 'fab');
    tf2.emit('itemRemoved', { id: 'fab' });
    jest.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, 'output', false);
});

test('timeout retains an unresolved operation instead of claiming the first of two matching kits', async () => {
    const { tf2, handler, observer } = fixture();
    const callback = jest.fn();
    observer.observeOperation({ type: 'craftFabricator' }, ['fab'], expected, () => undefined, callback);
    tf2.backpack = [kit('one'), kit('two')];
    await jest.advanceTimersByTimeAsync(30001);
    expect(callback).toHaveBeenCalledWith(expect.any(Error), undefined, false);
    expect(handler.finishCraftingOperation).toHaveBeenCalledWith('source', expect.any(String), undefined, ['fab']);
});

test('a genuine partial fill requires changed fulfillment on the original fabricator', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require('../../../node_modules/@tf2autobot/tf2/protobufs/generated/_load.js') as {
        CAttribute_DynamicRecipeComponent: { encode(value: object): { finish(): Uint8Array } };
    };
    const fab = (fulfilled: number): CraftItem => ({
        id: 'fab',
        original_id: 'fab',
        def_index: 20002,
        quality: 6,
        attribute: [
            {
                def_index: 2001,
                value_bytes: Buffer.from(
                    schema.CAttribute_DynamicRecipeComponent.encode({
                        def_index: 5705,
                        num_required: 2,
                        num_fulfilled: fulfilled
                    }).finish()
                )
            }
        ]
    });
    const { tf2, observer } = fixture();
    const callback = jest.fn();
    tf2.backpack = [fab(0)];
    observer.observeOperation(
        { type: 'craftFabricator', allowPartial: true },
        ['fab'],
        expected,
        () => undefined,
        callback,
        fab(0)
    );
    tf2.emit('itemChanged', fab(0), fab(0));
    jest.advanceTimersByTime(1);
    expect(callback).not.toHaveBeenCalled();
    tf2.backpack = [fab(1)];
    tf2.emit('itemChanged', fab(0), fab(1));
    jest.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledWith(null, 'fab', true);
});

test('a requested GC refresh waits behind the active operation', async () => {
    const gc = new TF2GC({
        inventoryManager: { getInventory: {} },
        handler: { onTF2QueueCompleted: jest.fn() }
    } as unknown as Bot);
    const queue = gc as unknown as Observer & {
        processingQueue: boolean;
        jobs: { type: string }[];
        connectToGC(): Promise<void>;
    };
    jest.spyOn(queue, 'connectToGC').mockResolvedValue(undefined);
    const refresh = jest.spyOn(queue, 'refreshBackpackSession').mockResolvedValue(undefined);
    queue.processingQueue = true;
    queue.jobs = [{ type: 'craftFabricator' }];
    const promise = gc.forceFreshBackpack();
    expect(refresh).not.toHaveBeenCalled();
    queue.finishedProcessingJob();
    await promise;
    expect(refresh).toHaveBeenCalledTimes(1);
});

test('refresh relaunches after appQuit without a GC disconnect and waits for backpackLoaded', async () => {
    const client = Object.assign(new EventEmitter(), { gamesPlayed: jest.fn() });
    const tf2 = Object.assign(new EventEmitter(), { haveGCSession: true });
    let quitting = false;
    client.gamesPlayed.mockImplementation(() => {
        quitting = true;
        tf2.haveGCSession = false;
        client.emit('appQuit', 440);
        quitting = false;
    });
    const updateSteamGamePresence = jest.fn(() => {
        expect(quitting).toBe(false);
        tf2.haveGCSession = true;
        tf2.emit('backpackLoaded');
    });
    const gc = new TF2GC({ client, tf2, updateSteamGamePresence } as unknown as Bot) as unknown as Observer;
    const refresh = gc.refreshBackpackSession();
    expect(updateSteamGamePresence).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await refresh;
    expect(updateSteamGamePresence).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('appQuit')).toBe(0);
    expect(tf2.listenerCount('backpackLoaded')).toBe(0);
});

test('refresh timeout cleans listeners even when Steam never supplies a new backpack', async () => {
    const client = Object.assign(new EventEmitter(), { gamesPlayed: jest.fn() });
    const tf2 = Object.assign(new EventEmitter(), { haveGCSession: true });
    client.gamesPlayed.mockImplementation(() => client.emit('appQuit', 440));
    const updateSteamGamePresence = jest.fn();
    const gc = new TF2GC({ client, tf2, updateSteamGamePresence } as unknown as Bot) as unknown as Observer;
    const result = expect(gc.refreshBackpackSession()).rejects.toThrow('Timed out');
    await jest.advanceTimersByTimeAsync(30001);
    await result;
    expect(updateSteamGamePresence).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('appQuit')).toBe(0);
    expect(tf2.listenerCount('backpackLoaded')).toBe(0);
});
