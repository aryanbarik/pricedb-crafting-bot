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
                forceFreshBackpack: jest.fn(async () => {
                    events.push('refresh');
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
        freshGCBackpack: jest.fn(async () => {
            events.push('read');
            return [{ id: 'result' }, { id: 'unmatched' }];
        }),
        releaseCraftingInFlight: jest.fn(),
        craftingInFlightIds: new Set<string>(),
        prepareCraftingOffer: jest.fn()
    };
    return { events, offer, handler };
}

test('killstreakify refreshes the GC before returning modified weapons and unmatched inputs', async () => {
    const { events, offer, handler } = fixture();
    await returnResults.call(
        handler,
        new SteamID('76561198164485484'),
        undefined,
        'source',
        ['kit', 'weapon', 'unmatched'],
        new Set(['kit', 'weapon']),
        ['result']
    );
    expect(events).toEqual(['refresh', 'read', 'create']);
    expect(offer.addMyItem.mock.calls).toEqual([
        [{ appid: 440, contextid: '2', assetid: 'result' }],
        [{ appid: 440, contextid: '2', assetid: 'unmatched' }]
    ]);
    expect(handler.bot.trades.sendOffer).toHaveBeenCalledWith(offer);
});

test('a failed GC refresh still attempts the return instead of abandoning customer assets', async () => {
    const { handler } = fixture();
    handler.bot.tf2gc.forceFreshBackpack.mockRejectedValue(new Error('GC timeout'));
    await returnResults.call(handler, new SteamID('76561198164485484'), undefined, 'source', [], new Set(), ['result']);
    expect(handler.bot.trades.sendOffer).toHaveBeenCalledTimes(1);
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
    expect(handler.bot.trades.sendOffer).toHaveBeenCalledTimes(1);
});
