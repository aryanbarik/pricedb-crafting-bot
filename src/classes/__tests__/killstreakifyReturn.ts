import SteamID from 'steamid';
import MyHandler from '../MyHandler/MyHandler';

jest.mock('../../lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));

const returnResults = (
    MyHandler.prototype as unknown as {
        returnKillstreakifyResults: (
            partner: SteamID,
            token: string | undefined,
            sourceOfferId: string,
            receivedIds: string[],
            consumedIds: Set<string>,
            resultIds: string[]
        ) => Promise<void>;
    }
).returnKillstreakifyResults;

function fixture() {
    const events: string[] = [];
    const offer = { id: 'return-offer', addMyItem: jest.fn(), setMessage: jest.fn() };
    const handler = {
        bot: {
            tf2gc: {
                forceFreshBackpack: jest.fn(() => {
                    events.push('refresh');
                    return Promise.resolve();
                })
            },
            manager: {
                createOffer: jest.fn(() => {
                    events.push('create');
                    return offer;
                })
            },
            trades: { sendOffer: jest.fn(() => Promise.resolve('sent')), acceptConfirmation: jest.fn() },
            messageAdmins: jest.fn()
        },
        craftingJournal: { get: jest.fn() },
        reconcileCraftingOperations: jest.fn().mockResolvedValue(undefined),
        freshGCBackpack: jest.fn(() => {
            events.push('read');
            return Promise.resolve([{ id: 'result' }, { id: 'unmatched' }]);
        }),
        releaseCraftingInFlight: jest.fn(),
        craftingInFlightIds: new Set<string>(),
        prepareCraftingOffer: jest.fn(),
        queueCompletedCraftingReturn: jest.fn().mockResolvedValue(undefined)
    };
    return { events, offer, handler };
}

test('killstreakify keeps modified weapons and unmatched inputs queued without an unconditional GC reset', async () => {
    const { events, handler } = fixture();
    await returnResults.call(
        handler,
        new SteamID('76561198164485484'),
        undefined,
        'source',
        ['kit', 'weapon', 'unmatched'],
        new Set(['kit', 'weapon']),
        ['result']
    );
    expect(events).toEqual([]);
    expect(handler.queueCompletedCraftingReturn).toHaveBeenCalledWith('source', ['result', 'unmatched']);
    expect(handler.bot.trades.sendOffer).not.toHaveBeenCalled();
});

test('a known modified weapon is queued without depending on the current GC snapshot', async () => {
    const { handler } = fixture();
    handler.freshGCBackpack.mockRejectedValue(new Error('GC timeout'));
    await returnResults.call(handler, new SteamID('76561198164485484'), undefined, 'source', [], new Set(), ['result']);
    expect(handler.queueCompletedCraftingReturn).toHaveBeenCalledWith('source', ['result']);
    expect(handler.freshGCBackpack).not.toHaveBeenCalled();
});

test('returning unchanged inputs does not reset the GC', async () => {
    const { handler } = fixture();
    await returnResults.call(
        handler,
        new SteamID('76561198164485484'),
        undefined,
        'source',
        ['unmatched'],
        new Set(),
        []
    );
    expect(handler.bot.tf2gc.forceFreshBackpack).not.toHaveBeenCalled();
    expect(handler.queueCompletedCraftingReturn).toHaveBeenCalledTimes(1);
});
