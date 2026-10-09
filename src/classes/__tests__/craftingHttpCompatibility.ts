import http from 'http';
import { AddressInfo } from 'net';
import HttpManager from '../HttpManager';
import Bot from '../Bot';
import Options from '../Options';

jest.mock('../Carts/ApiCart');
jest.mock('../WeaponBank');
jest.mock('../MvmSell');
jest.mock('../../lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

class TestHttpManager extends HttpManager {
    get application() {
        return this.app;
    }
}

const steamId = '76561198135282692';
const requestBody = {
    steamId,
    tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=175016964&token=test-token',
    fabricatorAssetIds: ['17645949083'],
    componentAssetIds: ['17645949100'],
    sourcing: 'customer'
};
const metadata = new Map<string, unknown>();
const offer = {
    id: '123456789',
    data: jest.fn((key: string, value?: unknown) => {
        if (value !== undefined) metadata.set(key, value);
        return metadata.get(key);
    }),
    addTheirItem: jest.fn(),
    setMessage: jest.fn()
};
const bot = {
    tf2: { backpack: [{ id: 'existing-bot-item' }] },
    isAdmin: jest.fn(() => false),
    manager: { createOffer: jest.fn(() => offer) },
    trades: {
        sendOffer: jest.fn(() => Promise.resolve('sent')),
        acceptConfirmation: jest.fn(() => Promise.resolve(undefined)),
        getOffer: jest.fn(() =>
            Promise.resolve({
                id: '123456789',
                state: 3,
                data: jest.fn(),
                partner: { getSteamID64: () => steamId },
                itemsToGive: [],
                itemsToReceive: [{ assetid: '17645949083' }]
            })
        )
    }
};
let server: http.Server;
let baseUrl: string;

beforeAll(done => {
    const manager = new TestHttpManager({ apiKey: 'test-key' } as Options, bot as unknown as Bot);
    server = http.createServer(manager.application);
    server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        done();
    });
});
afterAll(done => {
    server.close(done);
});
beforeEach(() => {
    jest.clearAllMocks();
    metadata.clear();
    bot.isAdmin.mockReturnValue(false);
    bot.trades.sendOffer.mockResolvedValue('sent');
});

async function post(body: Record<string, unknown>, key = 'test-key') {
    const response = await fetch(`${baseUrl}/api/crafting/request-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
    });
    return {
        status: response.status,
        body: (await response.json()) as { success: boolean; offerId?: string; error?: string }
    };
}

test('site combined requests preserve exact asset IDs and craft metadata', async () => {
    expect(await post(requestBody)).toEqual({ status: 200, body: { success: true, offerId: offer.id } });
    expect(bot.manager.createOffer).toHaveBeenCalledWith(steamId, 'test-token');
    expect(offer.addTheirItem.mock.calls).toEqual([
        [{ appid: 440, contextid: '2', assetid: '17645949083' }],
        [{ appid: 440, contextid: '2', assetid: '17645949100' }]
    ]);
    expect(metadata.get('craftingService')).toEqual({
        fabricatorAssetIds: requestBody.fabricatorAssetIds,
        componentAssetIds: requestBody.componentAssetIds,
        kitAssetIds: [],
        preTradeIds: ['existing-bot-item']
    });
});

test('legacy intake preserves explicit weapon ingredient selections', async () => {
    expect(
        (await post({ ...requestBody, componentAssetIds: undefined, allowedWeaponIngredientAssetIds: ['17645949160'] }))
            .status
    ).toBe(200);
    expect(metadata.get('craftingService')).toEqual({
        phase: 'intake',
        fabricatorAssetIds: requestBody.fabricatorAssetIds,
        preTradeIds: ['existing-bot-item'],
        allowedWeaponIngredientAssetIds: ['17645949160']
    });
});

test('depot sourcing remains admin-only and uses the self-fill pipeline', async () => {
    expect((await post({ ...requestBody, sourcing: 'depot' })).status).toBe(403);
    expect(bot.trades.sendOffer).not.toHaveBeenCalled();
    bot.isAdmin.mockReturnValue(true);
    expect((await post({ ...requestBody, sourcing: 'depot', componentAssetIds: undefined })).status).toBe(200);
    expect(metadata.get('craftingService')).toEqual({
        fabricatorAssetIds: requestBody.fabricatorAssetIds,
        componentAssetIds: [],
        kitAssetIds: [],
        preTradeIds: ['existing-bot-item'],
        adminSelfFill: true
    });
});

test('pending offers receive mobile confirmation before responding to the site', async () => {
    bot.trades.sendOffer.mockResolvedValue('pending');
    expect((await post(requestBody)).status).toBe(200);
    expect(bot.trades.acceptConfirmation).toHaveBeenCalledWith(offer);
});

test('unauthorized, overlapping, and oversized requests never send an offer', async () => {
    expect((await post(requestBody, 'wrong-key')).status).toBe(403);
    expect((await post({ ...requestBody, componentAssetIds: requestBody.fabricatorAssetIds })).status).toBe(400);
    expect(
        (await post({ ...requestBody, componentAssetIds: Array.from({ length: 250 }, (_, i) => String(i + 1)) })).status
    ).toBe(400);
    expect(bot.trades.sendOffer).not.toHaveBeenCalled();
});

test('Steam send failures remain failed requests and never report an offer ID', async () => {
    bot.trades.sendOffer.mockRejectedValue(new Error('Steam InvalidParam (8)'));
    expect(await post(requestBody)).toEqual({ status: 500, body: { success: false, error: 'Steam InvalidParam (8)' } });
});

test('the status URL used by the site remains compatible with upstream aliases', async () => {
    for (const path of ['/api/trade/status/123456789', '/api/trade/123456789/status', '/api/trade/123456789']) {
        const response = await fetch(baseUrl + path, { headers: { Authorization: 'Bearer test-key' } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            success: true,
            offerId: '123456789',
            isAccepted: true,
            partner: steamId
        });
    }
});
