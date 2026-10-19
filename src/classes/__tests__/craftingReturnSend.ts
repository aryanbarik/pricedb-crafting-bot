import { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import Trades from '../Trades';

jest.mock('../../lib/logger', () => ({ __esModule: true, default: { debug: jest.fn(), error: jest.fn() } }));

test('a journal failure after Steam creates an offer must not become another send attempt', async () => {
    const offer = {
        id: 'created',
        itemsToGive: [{ assetid: 'kit', appid: 440, contextid: '2', amount: 1 }],
        itemsToReceive: [],
        partner: { getSteamID64: () => '76561198164485484' },
        data: jest.fn(),
        log: jest.fn()
    };
    const context = {
        bot: {
            handler: {
                trackCraftingReturn: jest.fn(() => {
                    throw new Error('Disk write failed');
                })
            }
        },
        validateItem: jest.fn(),
        reserveOfferItems: jest.fn(),
        sendOfferRetry: jest.fn().mockResolvedValue('sent'),
        moveReservationToOfferId: jest.fn(),
        scheduleOfferExpiry: jest.fn(),
        releaseOfferItems: jest.fn()
    };
    await expect(Trades.prototype.sendOffer.call(context, offer as unknown as TradeOffer)).resolves.toBe('sent');
    expect(context.sendOfferRetry).toHaveBeenCalledTimes(1);
    expect(context.moveReservationToOfferId).toHaveBeenCalledTimes(1);
    expect(context.releaseOfferItems).not.toHaveBeenCalled();
});
