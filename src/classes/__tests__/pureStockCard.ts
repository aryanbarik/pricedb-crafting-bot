jest.mock('../DiscordWebhook/tradeCard/itemImageCache', () => ({
    getItemIcon: jest.fn().mockResolvedValue(null)
}));

import renderPureStockCard from '../DiscordWebhook/tradeCard/renderPureStockCard';

test('renders a readable pure-stock card when currency icons are unavailable', async () => {
    const card = await renderPureStockCard(
        {
            key: 2,
            ref: 6,
            rec: 10,
            scrap: 11,
            refTotalInScrap: 95
        },
        'test-account'
    );

    expect(card).not.toBeNull();
    expect(card?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});
