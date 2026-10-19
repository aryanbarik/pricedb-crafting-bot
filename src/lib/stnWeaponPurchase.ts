import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import TradeOfferManager, { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import type Bot from '../classes/Bot';
import log from './logger';
import { GCBackpackItem } from './fabricatorSlots';
import { isBaseWeaponDefindex } from './items';
import { isExcludedCraftingReskinDefindex, isFestiveWeaponDefindex } from './weaponExclusions';
import SchemaManager from '@tf2autobot/tf2-schema';

const MAX_WEAPON_PRICE_METAL = 0.11;
const POLL_INTERVAL_MS = 2500;
const PURCHASE_TIMEOUT_MS = 120000;
const DAILY_SCRAP_LIMIT = 45; // 5 refined
const RESERVE_INTERVAL_MS = 15 * 60 * 1000;
const FAILED_TARGET_RETRY_MS = 6 * 60 * 60 * 1000;

type Purchase = {
    stage: 'requesting' | 'pending';
    targetDefindex: number;
    fullName: string;
    beforeIds: string[];
    startedAt: number;
    tradeId?: number;
    stnBotId?: string;
    offerId?: string;
};
type PurchaseState = { pending: Purchase | null; utcDay: string; allocatedScrap: number };

export function utcPurchaseDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

export function canAllocateDailyScrap(state: Pick<PurchaseState, 'utcDay' | 'allocatedScrap'>, now: Date): boolean {
    return state.utcDay !== utcPurchaseDay(now) || state.allocatedScrap < DAILY_SCRAP_LIMIT;
}

export function isStnReserveEligible(defindex: number, schema: SchemaManager.Schema, festive: boolean): boolean {
    return !isBaseWeaponDefindex(defindex, schema) && !isExcludedCraftingReskinDefindex(defindex) && !festive;
}

type StnResponse<T> = { success: number; result?: T; item?: ItemDetails['item']; error?: string };
type ItemDetails = {
    item: {
        full_name: string;
        pricing: { sell: { keys: number; metal: number } };
        stock: { level: number; level_for_quick_buy?: number };
    };
};
type TradeDetails = { tradeDetails: { id: number; bot: string } };
type TradeStatus = { trade: { state: number; tradeOfferId?: number } };

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isAffordableStnWeapon(details: ItemDetails['item'], requestedName: string): boolean {
    const sell = details?.pricing?.sell;
    const stock = details?.stock;
    return (
        details.full_name === requestedName &&
        sell?.keys === 0 &&
        Number.isFinite(sell.metal) &&
        sell.metal >= 0 &&
        sell.metal <= MAX_WEAPON_PRICE_METAL &&
        (stock?.level_for_quick_buy ?? stock?.level ?? 0) >= 1
    );
}

export function validateStnPurchaseOffer(
    offer: TradeOffer,
    expected: { offerId: string; stnBotId: string; fullName: string },
    requireActive = true
): void {
    if (
        String(offer.id) !== expected.offerId ||
        offer.partner.getSteamID64() !== expected.stnBotId ||
        (requireActive && offer.state !== TradeOfferManager.ETradeOfferState['Active'])
    ) {
        throw new Error('STN offer identity or state did not match the purchase');
    }
    if (
        offer.itemsToReceive.length !== 1 ||
        offer.itemsToReceive[0].market_hash_name !== expected.fullName ||
        offer.itemsToReceive[0].appid !== 440
    ) {
        throw new Error('STN offer did not contain exactly the requested weapon');
    }
    if (
        offer.itemsToGive.length > 1 ||
        offer.itemsToGive.some(item => item.market_hash_name !== 'Scrap Metal' || item.appid !== 440)
    ) {
        throw new Error('STN offer exceeded the one-scrap payment limit');
    }
}

/**
 * Buys only one plain weapon at a time, for a bot-owned Basic Kit. A persisted request blocks
 * another purchase after a crash or ambiguous STN response, avoiding duplicate spending.
 * The key must belong to this bot's Steam account; STN sends its offer to the key owner.
 */
export default class StnWeaponPurchase {
    private readonly api: AxiosInstance;
    private pending: Purchase | null = null;
    private running = false;
    private state: PurchaseState = { pending: null, utcDay: utcPurchaseDay(new Date()), allocatedScrap: 0 };
    private reserveTimer: NodeJS.Timeout | null = null;
    private reserveRunning = false;
    private readonly failedTargets = new Map<number, number>();

    constructor(private readonly bot: Bot, key: string, private readonly statePath: string) {
        this.api = axios.create({ baseURL: 'https://api.stntrading.eu', timeout: 15000 });
        this.key = key;
        try {
            const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PurchaseState;
            if (!saved || typeof saved.utcDay !== 'string' || !Number.isSafeInteger(saved.allocatedScrap) ||
                saved.allocatedScrap < 0 || !('pending' in saved)) {
                throw new Error('Invalid STN purchase state');
            }
            this.state = saved;
            this.pending = saved.pending;
            if (this.pending) {
                log.warn('[stn] Found an unresolved purchase from a previous process. Automatic buying is paused until it is reconciled.');
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error(`Cannot read STN purchase state: ${(err as Error).message}`);
            }
        }
    }

    private readonly key: string;

    private save(purchase: Purchase | null): void {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const temporary = `${this.statePath}.tmp`;
        this.state.pending = purchase;
        fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
        fs.renameSync(temporary, this.statePath);
        this.pending = purchase;
    }

    private allocateDailyScrap(): void {
        const today = utcPurchaseDay(new Date());
        if (this.state.utcDay !== today) {
            this.state.utcDay = today;
            this.state.allocatedScrap = 0;
        }
        if (!canAllocateDailyScrap(this.state, new Date())) {
            throw new Error('STN daily purchase limit of 5 refined has been reached');
        }
        // Reserve the maximum cost before requesting a trade. Even an ambiguous or failed
        // request consumes this allowance, so retries cannot overspend after a restart.
        this.state.allocatedScrap++;
    }

    /** Keep one plain, craftable copy of each eligible non-stock weapon in the bot backpack. */
    startReserve(): void {
        if (this.reserveTimer) return;
        this.reserveTimer = setInterval(() => { void this.replenishReserve(); }, RESERVE_INTERVAL_MS);
        this.reserveTimer.unref();
        void this.replenishReserve();
    }

    stopReserve(): void {
        if (this.reserveTimer) clearInterval(this.reserveTimer);
        this.reserveTimer = null;
    }

    private async replenishReserve(): Promise<void> {
        if (this.reserveRunning || this.running || this.pending || this.bot.isHalted) return;
        this.reserveRunning = true;
        try {
            const backpack = (((this.bot.tf2 as unknown as { backpack: GCBackpackItem[] }).backpack) ?? []);
            const rawById = new Map(this.bot.inventoryManager.getInventory.getRawItems.map(item => [String(item.id), item]));
            const now = Date.now();
            for (const item of this.bot.schema.getCraftableWeaponsSchema()) {
                const defindex = item.defindex;
                if (!isStnReserveEligible(defindex, this.bot.schema, isFestiveWeaponDefindex(defindex, this.bot)) ||
                    (this.failedTargets.get(defindex) ?? 0) > now) continue;
                const hasPlain = backpack.some(weapon =>
                    weapon.def_index === defindex && weapon.quality === 6 && !weapon.flag_cannot_craft &&
                    !(weapon.attribute ?? []).some(attr =>
                        [186, 834, 2025, 1004, 1005, 1006, 1007, 1008, 1009].includes(attr.def_index)
                    ) && rawById.get(String(weapon.id))?.tradable !== false &&
                    !this.bot.handler.isCraftingAssetReserved(String(weapon.id)) &&
                    !this.bot.trades.isInTrade(String(weapon.id))
                );
                if (hasPlain) continue;
                if (!canAllocateDailyScrap(this.state, new Date())) return;
                try {
                    await this.buy(defindex, item.item_name);
                    log.info(`[stn] Restored plain weapon reserve: ${item.item_name}`);
                } catch (err) {
                    this.failedTargets.set(defindex, Date.now() + FAILED_TARGET_RETRY_MS);
                    log.warn(`[stn] Could not replenish ${item.item_name}: ${(err as Error).message}`);
                }
                // One purchase attempt per cycle limits API credits and avoids a trade storm.
                return;
            }
        } finally {
            this.reserveRunning = false;
        }
    }

    private async get<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<StnResponse<T>> {
        try {
            const response = await this.api.get<StnResponse<T>>(endpoint, {
                params: { apikey: this.key, ...params }
            });
            return response.data;
        } catch (err) {
            // Axios errors include config.url/params, which contain the API key. Never log them.
            throw new Error(`STN ${endpoint} failed (HTTP ${axios.isAxiosError(err) ? err.response?.status ?? 'network' : 'network'})`);
        }
    }

    private async post<T>(endpoint: string, fullRequest: object): Promise<StnResponse<T>> {
        try {
            const form = new URLSearchParams({ fullRequest: JSON.stringify(fullRequest) });
            const response = await this.api.post<StnResponse<T>>(endpoint, form.toString(), {
                params: { apikey: this.key },
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            return response.data;
        } catch (err) {
            throw new Error(`STN ${endpoint} failed (HTTP ${axios.isAxiosError(err) ? err.response?.status ?? 'network' : 'network'})`);
        }
    }

    /** Keep STN's offer out of the normal trading evaluator while this purchase is active. */
    shouldHoldIncomingOffer(offer: TradeOffer): boolean {
        return (
            this.pending !== null &&
            this.pending.stnBotId !== undefined &&
            offer.partner.getSteamID64() === this.pending.stnBotId &&
            (!this.pending.offerId || String(offer.id) === this.pending.offerId)
        );
    }

    private validateOffer(offer: TradeOffer, purchase: Purchase, requireActive = true): void {
        validateStnPurchaseOffer(offer, {
            offerId: purchase.offerId ?? '',
            stnBotId: purchase.stnBotId ?? '',
            fullName: purchase.fullName
        }, requireActive);
    }

    private getOfferIncludingCompleted(offerId: string): Promise<TradeOffer | null> {
        return new Promise((resolve, reject) => {
            this.bot.manager.getOffer(offerId, (err, offer) => {
                if (err) reject(new Error(`Steam could not load STN offer ${offerId}: ${err.message}`));
                else resolve(offer ?? null);
            });
        });
    }

    async buy(targetDefindex: number, fullName: string): Promise<string> {
        if (this.pending || this.running) throw new Error('An STN purchase is already pending or needs reconciliation');
        this.running = true;
        try {
            const quoted = await this.get<ItemDetails['item']>('/GetItemDetails/v1', { full_name: fullName });
            const item = quoted.item;
            if (quoted.success !== 1 || !item) {
                throw new Error(`STN could not quote ${fullName}: ${quoted.error ?? 'price unavailable'}`);
            }
            if (!isAffordableStnWeapon(item, fullName)) {
                throw new Error(`STN ${fullName} is unavailable or costs more than ${MAX_WEAPON_PRICE_METAL} ref`);
            }

            const backpack = (((this.bot.tf2 as unknown as { backpack: GCBackpackItem[] }).backpack) ?? []);
            const purchase: Purchase = {
                stage: 'requesting', targetDefindex, fullName,
                beforeIds: backpack.map(entry => String(entry.id)), startedAt: Date.now()
            };
            this.allocateDailyScrap();
            this.save(purchase);
            const requested = await this.post<TradeDetails>('/RequestItemTrade/v1', {
                request_type: 'quick_buy',
                quick_buy: { app_ctx_id: '440_2', full_name: fullName, amount: 1 }
            });
            const details = requested.result?.tradeDetails;
            if (requested.success !== 1 || !details || !Number.isSafeInteger(details.id) || !/^\d{17}$/.test(details.bot)) {
                // STN explicitly declined the request, so no trade was created.
                if (requested.success === 0) this.save(null);
                throw new Error(`STN rejected ${fullName}: ${requested.error ?? 'invalid trade response'}`);
            }
            purchase.stage = 'pending';
            purchase.tradeId = details.id;
            purchase.stnBotId = details.bot;
            this.save(purchase);
            log.info(`[stn] Requested one ${fullName} for ${MAX_WEAPON_PRICE_METAL} ref or less; trade ${details.id}`);

            const deadline = Date.now() + PURCHASE_TIMEOUT_MS;
            let accepted = false;
            while (Date.now() < deadline) {
                const status = await this.get<TradeStatus>('/GetTradeStatus/v1', { id: details.id });
                if (status.success !== 1 || !status.result?.trade) throw new Error('STN purchase status unavailable');
                const { state, tradeOfferId } = status.result.trade;
                if (state === 15 || state === 20) {
                    this.save(null);
                    throw new Error(`STN purchase ended without a trade (state ${state})`);
                }
                if (tradeOfferId && !purchase.offerId) {
                    purchase.offerId = String(tradeOfferId);
                    this.save(purchase);
                }
                if (purchase.offerId && !accepted && state !== 2) {
                    const offer = await this.bot.trades.getOffer(purchase.offerId).catch(() => null);
                    if (offer) {
                        this.validateOffer(offer, purchase);
                        await this.bot.trades.applyActionToOffer('accept', 'STN_CRAFT_WEAPON', {}, offer);
                        accepted = true;
                    }
                }
                if (state === 2 && purchase.offerId) {
                    // Trades.getOffer intentionally hides non-active offers, so read the
                    // manager directly to obtain the completed offer's exchange receipt.
                    const completedOffer = await this.getOfferIncludingCompleted(purchase.offerId).catch(() => null);
                    if (completedOffer) this.validateOffer(completedOffer, purchase, false);
                    const receiptId = completedOffer ? await new Promise<string | null>(resolve => {
                        completedOffer.getExchangeDetails(false, (err, _status, _time, received) => {
                            const items = received ?? [];
                            resolve(err || items.length !== 1 ? null : String(items[0].new_assetid ?? '') || null);
                        });
                    }) : null;
                    const current = (((this.bot.tf2 as unknown as { backpack: GCBackpackItem[] }).backpack) ?? []);
                    const weapon = current.find(entry =>
                        receiptId === String(entry.id) && !purchase.beforeIds.includes(String(entry.id)) &&
                        entry.def_index === targetDefindex && entry.quality === 6 && !entry.flag_cannot_craft &&
                        !(entry.attribute ?? []).some(attr =>
                            [186, 834, 2025, 1004, 1005, 1006, 1007, 1008, 1009].includes(attr.def_index)
                        )
                    );
                    if (weapon) {
                        this.save(null);
                        log.info(`[stn] Received craftable ${fullName} as bot item ${weapon.id}`);
                        return String(weapon.id);
                    }
                }
                await sleep(POLL_INTERVAL_MS);
            }
            throw new Error(`STN purchase ${details.id} did not complete within two minutes; manual reconciliation required`);
        } finally {
            this.running = false;
        }
    }
}
