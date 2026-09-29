import { EconItem } from '@tf2autobot/tradeoffer-manager';
import SteamID from 'steamid';
import Bot from './Bot';
import Inventory from './Inventory';
import ApiCart from './Carts/ApiCart';

export type MvmSellCategory = 'robot-parts' | 'basic-kits' | 'specialized-fabricators' | 'botkillers';

export interface MvmSellItem {
    assetId: string;
    name: string;
    sku: string;
    category: MvmSellCategory;
    buyScrap: number;
}

function rawSku(item: EconItem, bot: Bot): string {
    return item.getSKU(bot.schema, false, false, false, false, []).sku;
}

function categoryFor(item: EconItem, sku: string, buyScrap: number): MvmSellCategory | null {
    const defindex = Number(sku.split(';')[0]);
    if (defindex >= 5700 && defindex <= 5707) return 'robot-parts';
    if (defindex === 6528) return 'basic-kits';
    if (defindex === 20002) return 'specialized-fabricators';
    const name = item.market_hash_name ?? item.market_name ?? item.name ?? '';
    if (/botkiller/i.test(name) && buyScrap < 27) return 'botkillers';
    return null;
}

async function inventoryFor(bot: Bot, steamId: string): Promise<Inventory> {
    const inventory = new Inventory(new SteamID(steamId), bot, 'their', bot.boundInventoryGetter);
    await inventory.fetch();
    return inventory;
}

function catalogFromInventory(bot: Bot, inventory: Inventory): MvmSellItem[] {
    const keyPrice = bot.pricelist.getKeyPrices.buy.metal;
    const remainingBySku = new Map<string, number>();
    const result: MvmSellItem[] = [];
    for (const item of inventory.getRawItems) {
        if (!item.tradable) continue;
        const sku = rawSku(item, bot);
        const entry = bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: true });
        if (!entry?.buy || entry.intent === 1) continue;
        let remaining = remainingBySku.get(sku);
        if (remaining === undefined) {
            remaining = bot.inventoryManager.amountCanTrade({ priceKey: sku, tradeIntent: 'buying' });
            remainingBySku.set(sku, remaining);
        }
        if (remaining <= 0) continue;
        const buyScrap = entry.buy.toValue(keyPrice);
        const category = categoryFor(item, sku, buyScrap);
        if (!category || buyScrap <= 0) continue;
        result.push({
            assetId: item.id,
            name: item.market_hash_name ?? item.market_name ?? item.name,
            sku,
            category,
            buyScrap
        });
        remainingBySku.set(sku, remaining - 1);
    }
    return result.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function getMvmSellCatalog(bot: Bot, steamId: string): Promise<MvmSellItem[]> {
    if (!/^7656119\d{10}$/.test(steamId)) throw new Error('Invalid Steam ID.');
    return catalogFromInventory(bot, await inventoryFor(bot, steamId));
}

export async function sendMvmSellOffer(
    bot: Bot,
    steamId: string,
    tradeUrl: string,
    assetIds: string[]
): Promise<{ offerId: string; payoutScrap: number }> {
    if (!/^7656119\d{10}$/.test(steamId)) throw new Error('Invalid Steam ID.');
    if (assetIds.length === 0 || assetIds.length > 200 || new Set(assetIds).size !== assetIds.length)
        throw new Error('Select 1 to 200 distinct MvM items.');
    const url = new URL(tradeUrl);
    const partner = url.searchParams.get('partner');
    if (url.hostname !== 'steamcommunity.com' || url.pathname !== '/tradeoffer/new/' || !partner)
        throw new Error('Invalid trade URL.');
    if (new SteamID(steamId).accountid.toString() !== partner)
        throw new Error('Trade URL does not match this Steam account.');

    const catalog = await getMvmSellCatalog(bot, steamId);
    const byId = new Map(catalog.map(item => [item.assetId, item]));
    const selected = assetIds.map(id => {
        const item = byId.get(id);
        if (!item) throw new Error('A selected item is no longer available at the shown price. Refresh the list.');
        return item;
    });
    const payoutScrap = selected.reduce((sum, item) => sum + item.buyScrap, 0);
    const cart = new ApiCart(tradeUrl, bot);
    cart.setCustomMessage('Sell MvM: review the selected items and metal payout before accepting.');
    const altered = await cart.constructOffer(
        { metal: payoutScrap },
        { items: selected.map(item => ({ assetid: item.assetId, sku: item.sku })) }
    );
    if (altered) throw new Error(altered);
    const status = await cart.sendOffer();
    const offer = cart.getOffer;
    if (!offer?.id) throw new Error('Steam did not return a trade offer ID.');
    if (status === 'pending') await bot.trades.acceptConfirmation(offer);
    return { offerId: offer.id, payoutScrap };
}
