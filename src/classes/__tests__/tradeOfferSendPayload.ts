import TradeOfferManager from '@tf2autobot/tradeoffer-manager';

describe('Steam outgoing offer payload', () => {
    let manager: TradeOfferManager;
    let post: jest.SpyInstance;

    beforeEach(() => {
        manager = new TradeOfferManager({ pollInterval: -1 });
        // Capture the real library's final request without contacting Steam.
        const community = (manager as unknown as { _community: { httpRequestPost: () => void } })._community;
        post = jest.spyOn(community, 'httpRequestPost').mockImplementation(() => undefined);
    });

    afterEach(() => {
        post.mockRestore();
        manager.shutdown();
    });

    test.each(['give', 'receive'])('new %s offers omit the counter-offer field', side => {
        const offer = manager.createOffer('76561198138534634', 'test-token');
        const item = { appid: 440, contextid: '2', assetid: '123456789' };
        if (side === 'give') offer.addMyItem(item);
        else offer.addTheirItem(item);
        offer.send(jest.fn());

        expect(post).toHaveBeenCalledTimes(1);
        const [url, request] = post.mock.calls[0] as [string, { form: Record<string, string> }];
        expect(url).toBe('https://steamcommunity.com/tradeoffer/new/send');
        expect(request.form).not.toHaveProperty('tradeofferid_countered');
        expect(request.form.partner).toBe('76561198138534634');
        expect(JSON.parse(request.form.trade_offer_create_params)).toEqual({ trade_offer_access_token: 'test-token' });
        const payload = JSON.parse(request.form.json_tradeoffer) as {
            me: { assets: unknown[] };
            them: { assets: unknown[] };
        };
        expect(payload[side === 'give' ? 'me' : 'them'].assets).toEqual([{ ...item, amount: 1 }]);
    });

    test('counter offers still identify the original offer', () => {
        const incoming = manager.createOffer('76561198138534634');
        incoming.id = '987654321';
        incoming.state = 2; // Active incoming offer
        incoming.isOurOffer = false;
        const counter = incoming.counter();
        counter.addMyItem({ appid: 440, contextid: '2', assetid: '123456789' });
        counter.send(jest.fn());

        const [, request] = post.mock.calls[0] as [string, { form: Record<string, string> }];
        expect(request.form.tradeofferid_countered).toBe(incoming.id);
    });
});
