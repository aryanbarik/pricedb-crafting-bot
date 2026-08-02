import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import dayjs from 'dayjs';
import Bot from '../../classes/Bot';
import { apiRequest } from '../apiRequest';
import log from '../logger';

/**
 * Prices configured SKUs off the highest competing buy order on backpack.tf rather than off the
 * pricer.
 *
 * Robot parts are crafting inputs, not flip inventory, so their value is what they contribute to
 * the kit that comes out of the fabricator — not what they resell for. The pricer quotes a
 * market-maker spread (8 scrap buy / 9 scrap sell) which loses every fill to the people bidding the
 * full 9, who are buying inputs exactly like we are. This matches those bids, under a hard ceiling.
 *
 * Configured entries must have `autoprice: false`; that is what makes this module their only price
 * writer, since the pricer never touches a non-autopriced entry.
 */

/**
 * The snapshot endpoint, not `/classifieds/search/v1` — search requires a backpack.tf Premium
 * subscription and returns 401 without one. Snapshot is free, authenticates with the access token
 * rather than the API key, and returns a sample of current listings for one item.
 */
const SNAPSHOT_URL = 'https://backpack.tf/api/classifieds/listings/snapshot';

export interface CompetingOrder {
    steamid: string;
    /** Price in scrap, so levels can be compared and grouped as integers. */
    value: number;
}

interface SnapshotResponse {
    listings?: {
        steamid?: string;
        intent?: string;
        currencies?: { keys?: number; metal?: number };
    }[];
}

/**
 * The highest price level that at least `minOrders` *distinct* people are bidding.
 *
 * Anyone can post one silly buy order, so a level backed by a single steamid is not evidence of a
 * market. Requiring corroboration means a lone outlier is ignored while a genuine move — which
 * shows up as several people repricing — is followed.
 *
 * Returns null when nothing qualifies, which callers must treat as "leave the price alone".
 */
export function pickTopLevel(orders: CompetingOrder[], minOrders: number): number | null {
    const holdersByValue = new Map<number, Set<string>>();

    for (const order of orders) {
        if (!holdersByValue.has(order.value)) {
            holdersByValue.set(order.value, new Set());
        }
        holdersByValue.get(order.value).add(order.steamid);
    }

    let top: number | null = null;

    holdersByValue.forEach((holders, value) => {
        if (holders.size >= minOrders && (top === null || value > top)) {
            top = value;
        }
    });

    return top;
}

/**
 * Fetch competing buy orders for a SKU, excluding our own.
 *
 * Throws on failure rather than returning an empty array — an empty array is indistinguishable from
 * "nobody is bidding", and callers must not reprice off a failed request.
 */
export async function fetchBuyOrders(bot: Bot, sku: string): Promise<CompetingOrder[]> {
    const token = bot.options.bptfAccessToken;

    if (!token) {
        throw new Error('no backpack.tf access token available yet');
    }

    const name = bot.schema.getName(SKU.fromString(sku), false);
    const ourSteamID = bot.client.steamID ? bot.client.steamID.getSteamID64() : null;
    const keyPrice = bot.pricelist.getKeyPrice.metal;

    const response = await apiRequest<SnapshotResponse>({
        method: 'GET',
        url: SNAPSHOT_URL,
        params: {
            token,
            appid: 440,
            sku: name // snapshot keys off the market name, not a SKU string
        }
    });

    const listings = response?.listings ?? [];

    // Snapshot returns both intents, so the buy filter has to happen here.
    const orders = listings.reduce<CompetingOrder[]>((orders, listing) => {
        if (listing.intent !== 'buy' || !listing.steamid || listing.steamid === ourSteamID || !listing.currencies) {
            return orders;
        }

        const value = new Currencies({
            keys: listing.currencies.keys ?? 0,
            metal: listing.currencies.metal ?? 0
        }).toValue(keyPrice);

        if (value > 0) {
            orders.push({ steamid: listing.steamid, value });
        }

        return orders;
    }, []);

    log.debug(
        `competitiveBuyPricer: ${sku} (${name}) snapshot returned ${listings.length} listing(s), ` +
            `${orders.length} competing buy order(s)`
    );

    return orders;
}

/** Reprice a single configured SKU. Never throws; failures leave the existing price untouched. */
export async function refreshOne(
    bot: Bot,
    config: { sku: string; maxBuy: { keys: number; metal: number } },
    minOrders: number
): Promise<void> {
    const { sku, maxBuy } = config;
    const entry = bot.pricelist.getPrice({ priceKey: sku });

    if (entry === null) {
        log.warn(`competitiveBuyPricer: ${sku} is not in the pricelist, skipping`);
        return;
    }

    if (entry.autoprice) {
        // The pricer would immediately overwrite anything written here.
        log.warn(`competitiveBuyPricer: ${sku} has autoprice enabled, skipping (set autoprice=false)`);
        return;
    }

    const keyPrice = bot.pricelist.getKeyPrice.metal;
    const ceiling = new Currencies(maxBuy).toValue(keyPrice);

    let orders: CompetingOrder[];

    try {
        orders = await fetchBuyOrders(bot, sku);
    } catch (err) {
        // Deliberately keep the current price. Falling back to the pricer here would silently drop
        // the bid back below the competition, which is the exact failure this module exists to fix.
        log.warn(`competitiveBuyPricer: failed to fetch buy orders for ${sku}, keeping current price`, err);
        return;
    }

    const top = pickTopLevel(orders, minOrders);

    if (top === null) {
        log.debug(`competitiveBuyPricer: no price level for ${sku} had ${minOrders}+ orders, keeping current price`);
        return;
    }

    const target = Math.min(top, ceiling);
    const current = entry.buy === null ? null : entry.buy.toValue(keyPrice);

    if (current === target) {
        return;
    }

    const newBuy = Currencies.toCurrencies(target, keyPrice);
    const entryData = entry.getJSON();
    entryData.buy = newBuy.toJSON();
    entryData.time = dayjs().unix();

    try {
        await bot.pricelist.updatePrice({ priceKey: sku, entryData, emitChange: true });

        log.debug(
            `competitiveBuyPricer: ${sku} buy ${current ?? 'none'} -> ${target} scrap ` +
                `(top competing ${top}, ceiling ${ceiling}, ${orders.length} orders seen)`
        );

        if (top > ceiling) {
            // Worth surfacing: the market has moved past what we decided a part is worth as a craft
            // input, so we are now deliberately uncompetitive and the ceiling needs a human look.
            log.warn(
                `competitiveBuyPricer: ${sku} capped at ceiling — competitors are bidding ${top} scrap ` +
                    `but maxBuy is ${ceiling}. Review whether the ceiling is still right.`
            );
        }
    } catch (err) {
        log.warn(`competitiveBuyPricer: failed to update price for ${sku}`, err);
    }
}

/** Reprice every configured SKU. Never throws. */
export async function refreshAll(bot: Bot): Promise<void> {
    const config = bot.options.pricelist?.competitiveBuyPricer;

    if (!config?.enable) {
        return;
    }

    const items = config.items ?? [];

    if (items.length === 0) {
        return;
    }

    const minOrders = config.minOrders ?? 2;

    for (const item of items) {
        await refreshOne(bot, item, minOrders);
    }
}
