import SteamID from 'steamid';
import Bot from './Bot';
import Inventory from './Inventory';

export interface BankItem { assetId: string; name: string }
export interface BankCatalog {
    yours: BankItem[];
    ours: BankItem[];
    yourMetal: Record<string, number>;
    ourMetal: Record<string, number>;
}

const METAL: Record<string, number> = { '5000;6': 1, '5001;6': 3, '5002;6': 9 };
const MAX_WEAPONS = 50;
const NO_KIT_WEAPONS = new Set([42, 140, 159]); // Sandvich, Wrangler, Dalokohs Bar

function rawSku(item: any, bot: Bot): string {
    return item.getSKU(bot.schema, false, false, false, false, []).sku;
}

export function isEligible(item: any, bot: Bot): boolean {
    if (!item.tradable) return false;
    const sku = rawSku(item, bot);
    if (!/^\d+;6$/.test(sku) || item.name !== item.market_name) return false;
    if (!bot.craftWeapons.includes(sku)) return false;
    const defindex = Number(sku.split(';')[0]);
    if (NO_KIT_WEAPONS.has(defindex)) return false;
    const schemaItem = bot.schema.getItemByDefindex(defindex);
    if (schemaItem?.item_name?.startsWith('Festive ')) return false;
    if (item.descriptions?.some((description: { value?: string }) => description.value?.startsWith('Halloween:'))) return false;
    return schemaItem?.capabilities?.can_killstreakify === true;
}

function available(item: any, bot: Bot, ours: boolean): boolean {
    return item.tradable && (!ours || (!bot.trades.isInTrade(item.id) && !bot.handler.isCraftingAssetReserved(item.id)));
}

function metalAssets(inventory: Inventory, bot: Bot, ours: boolean): Record<string, string[]> {
    const result: Record<string, string[]> = { '5000;6': [], '5001;6': [], '5002;6': [] };
    for (const item of inventory.getRawItems) {
        if (!available(item, bot, ours)) continue;
        const sku = rawSku(item, bot);
        if (Object.prototype.hasOwnProperty.call(METAL, sku)) result[sku].push(item.id);
    }
    return result;
}

function counts(assets: Record<string, string[]>): Record<string, number> {
    return Object.fromEntries(Object.entries(assets).map(([sku, ids]) => [sku, ids.length]));
}

async function inventories(bot: Bot, steamId: string): Promise<{ yours: Inventory; ours: Inventory }> {
    const yours = new Inventory(new SteamID(steamId), bot, 'their', bot.boundInventoryGetter);
    await yours.fetch();
    return { yours, ours: bot.inventoryManager.getInventory };
}

export async function getBankCatalog(bot: Bot, steamId: string): Promise<BankCatalog> {
    const { yours, ours } = await inventories(bot, steamId);
    const list = (inventory: Inventory, isOurs: boolean): BankItem[] =>
        inventory.getRawItems.filter(item => available(item, bot, isOurs) && isEligible(item, bot))
            .map(item => ({ assetId: item.id, name: item.market_name ?? item.name }))
            .sort((a, b) => a.name.localeCompare(b.name) || a.assetId.localeCompare(b.assetId));
    return {
        yours: list(yours, false),
        ours: list(ours, true),
        yourMetal: counts(metalAssets(yours, bot, false)),
        ourMetal: counts(metalAssets(ours, bot, true))
    };
}

// Bounded exact-change search. A single refined metal can cover a smaller purchase
// only when the other side can return the difference in real metal items.
function combinations(assets: Record<string, string[]>, limit: number): Map<number, string[]> {
    const solutions = new Map<number, string[]>([[0, []]]);
    for (const [sku, value] of Object.entries(METAL)) {
        for (const id of assets[sku]) {
            for (const [amount, chosen] of [...solutions.entries()].sort((a, b) => b[0] - a[0])) {
                const next = amount + value;
                if (next > limit || chosen.includes(id)) continue;
                const proposal = [...chosen, id];
                if (!solutions.has(next) || proposal.length < solutions.get(next).length) solutions.set(next, proposal);
            }
        }
    }
    return solutions;
}

export function chooseMetal(
    payer: Record<string, string[]>,
    changeSide: Record<string, string[]>,
    priceScrap: number
): { paid: string[]; change: string[] } {
    const payments = combinations(payer, priceScrap + 9);
    const change = combinations(changeSide, 9);
    for (let total = priceScrap; total <= priceScrap + 9; total++) {
        const paid = payments.get(total);
        const returned = change.get(total - priceScrap);
        if (paid && returned) return { paid, change: returned };
    }
    throw new Error('The required metal or exact change is not available. Try a different number of weapons.');
}

export async function sendBankOffer(
    bot: Bot,
    steamId: string,
    tradeUrl: string,
    sellAssetIds: string[],
    buyAssetIds: string[]
): Promise<string> {
    if (!/^7656119\d{10}$/.test(steamId)) throw new Error('Invalid Steam ID.');
    const url = new URL(tradeUrl);
    if (url.hostname !== 'steamcommunity.com' || url.pathname !== '/tradeoffer/new/') throw new Error('Invalid trade URL.');
    const partner = url.searchParams.get('partner');
    const token = url.searchParams.get('token');
    if (!partner || !token || new SteamID(steamId).accountid.toString() !== partner) throw new Error('Trade URL does not match this Steam account.');
    const chosen = [...sellAssetIds, ...buyAssetIds];
    if (chosen.length === 0 || chosen.length > MAX_WEAPONS || chosen.some(id => !/^\d{1,20}$/.test(id)) ||
        new Set(chosen).size !== chosen.length) throw new Error('Select 1 to 50 distinct weapons.');
    const net = buyAssetIds.length - sellAssetIds.length;
    if (net % 2 !== 0) throw new Error('The net weapon count must be even because each weapon costs 0.5 scrap.');

    const { yours, ours } = await inventories(bot, steamId);
    const validate = (inventory: Inventory, ids: string[], isOurs: boolean): any[] => ids.map(id => {
        const item = inventory.getRawItems.find(candidate => candidate.id === id);
        if (!item || !available(item, bot, isOurs) || !isEligible(item, bot)) {
            throw new Error('A selected weapon is no longer available or eligible. Refresh the list.');
        }
        return item;
    });
    const selling = validate(yours, sellAssetIds, false);
    const buying = validate(ours, buyAssetIds, true);
    const yourMetal = metalAssets(yours, bot, false);
    const ourMetal = metalAssets(ours, bot, true);
    const metal = net > 0 ? chooseMetal(yourMetal, ourMetal, net / 2)
        : net < 0 ? chooseMetal(ourMetal, yourMetal, -net / 2)
        : { paid: [], change: [] };
    const byId = new Map([...yours.getRawItems, ...ours.getRawItems].map(item => [item.id, item]));
    const giveIds = [...buying.map(item => item.id), ...(net < 0 ? metal.paid : metal.change)];
    const receiveIds = [...selling.map(item => item.id), ...(net > 0 ? metal.paid : metal.change)];
    const offer = bot.manager.createOffer(steamId, token);
    const dict = { our: {} as Record<string, number>, their: {} as Record<string, number> };
    const add = (ids: string[], side: 'our' | 'their') => {
        for (const id of ids) {
            const item = byId.get(id);
            if (!item) throw new Error('An item changed while building the trade. Refresh the list.');
            const sku = rawSku(item, bot);
            const ok = side === 'our'
                ? offer.addMyItem({ appid: 440, contextid: '2', assetid: id })
                : offer.addTheirItem({ appid: 440, contextid: '2', assetid: id });
            if (!ok) throw new Error('Steam could not add an item to the offer. Refresh the list.');
            dict[side][sku] = (dict[side][sku] ?? 0) + 1;
        }
    };
    add(giveIds, 'our');
    add(receiveIds, 'their');
    offer.data('dict', dict);
    offer.data('isApiTrade', true);
    offer.data('weaponBank', true);
    offer.setMessage('Weapon bank: 0.5 scrap per weapon. Check every item before accepting.');
    const status = await bot.trades.sendOffer(offer);
    if (status === 'pending') await bot.trades.acceptConfirmation(offer);
    return offer.id;
}
