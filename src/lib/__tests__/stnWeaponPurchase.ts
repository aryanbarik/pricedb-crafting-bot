import SchemaManager from '@tf2autobot/tf2-schema';
import TradeOfferManager, { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import {
    canAllocateDailyScrap,
    isAffordableStnWeapon,
    isStnReserveEligible,
    validateStnPurchaseOffer
} from '../stnWeaponPurchase';

describe('STN weapon purchase safeguards', () => {
    it('buys only an exact, stocked weapon priced at no more than one scrap', () => {
        const item = {
            full_name: 'The Sydney Sleeper',
            pricing: { sell: { keys: 0, metal: 0.11 } },
            stock: { level: 1 }
        };
        expect(isAffordableStnWeapon(item, item.full_name)).toBe(true);
        expect(isAffordableStnWeapon(item, 'The Blutsauger')).toBe(false);
        expect(isAffordableStnWeapon({ ...item, pricing: { sell: { keys: 0, metal: 0.22 } } }, item.full_name)).toBe(false);
        expect(isAffordableStnWeapon({ ...item, stock: { level: 0 } }, item.full_name)).toBe(false);
    });

    it('allows at most 45 one-scrap allocations per UTC day', () => {
        const now = new Date('2026-10-19T23:59:00Z');
        expect(canAllocateDailyScrap({ utcDay: '2026-10-19', allocatedScrap: 44 }, now)).toBe(true);
        expect(canAllocateDailyScrap({ utcDay: '2026-10-19', allocatedScrap: 45 }, now)).toBe(false);
        expect(canAllocateDailyScrap({ utcDay: '2026-10-18', allocatedScrap: 45 }, now)).toBe(true);
    });

    it('excludes base stock weapons and protected variants from STN reserve', () => {
        const items = new Map([
            [13, { name: 'TF_WEAPON_SCATTERGUN', item_class: 'tf_weapon_scattergun' }],
            [230, { name: 'The Sydney Sleeper', item_class: 'tf_weapon_sniperrifle' }]
        ]);
        const schema = { getItemByDefindex: (id: number) => items.get(id) ?? null } as unknown as SchemaManager.Schema;
        expect(isStnReserveEligible(13, schema, false)).toBe(false);
        expect(isStnReserveEligible(230, schema, false)).toBe(true);
        expect(isStnReserveEligible(230, schema, true)).toBe(false);
        expect(isStnReserveEligible(160, schema, false)).toBe(false);
    });

    it('rejects an unexpected partner, weapon, or payment in an incoming offer', () => {
        const offer = {
            id: '12345',
            partner: { getSteamID64: () => '76561198000000000' },
            state: TradeOfferManager.ETradeOfferState['Active'],
            itemsToReceive: [{ market_hash_name: 'The Sydney Sleeper', appid: 440 }],
            itemsToGive: [{ market_hash_name: 'Scrap Metal', appid: 440 }]
        } as unknown as TradeOffer;
        const expected = { offerId: '12345', stnBotId: '76561198000000000', fullName: 'The Sydney Sleeper' };
        expect(() => validateStnPurchaseOffer(offer, expected)).not.toThrow();
        expect(() => validateStnPurchaseOffer(offer, { ...expected, stnBotId: '76561198000000001' })).toThrow();
        offer.itemsToGive.push({ market_hash_name: 'Scrap Metal', appid: 440 } as typeof offer.itemsToGive[0]);
        expect(() => validateStnPurchaseOffer(offer, expected)).toThrow();
    });
});
