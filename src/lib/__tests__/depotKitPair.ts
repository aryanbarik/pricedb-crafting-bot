import { GCBackpackItem } from '../fabricatorSlots';
import { findDepotBasicKitPair } from '../depotKitPair';

const item = (id: string, defindex: number, attrs: GCBackpackItem['attribute'] = []): GCBackpackItem => ({
    id,
    def_index: defindex,
    quality: 6,
    attribute: attrs
});

describe('findDepotBasicKitPair', () => {
    const sydneyKit = { ...item('kit-sydney', 6527, [{ def_index: 2012, value: 230 }]), flag_cannot_craft: true };
    const blutsaugerKit = { ...item('kit-blut', 6527, [{ def_index: 2012, value: 36 }]), flag_cannot_craft: true };
    const target = (kit: GCBackpackItem): number | null =>
        Number(kit.attribute?.find(attr => attr.def_index === 2012)?.value ?? 0) || null;
    const isBasicKit = (kit: GCBackpackItem): boolean => kit.def_index === 6527;
    const safe = (): boolean => true;

    it('pairs a non-craftable Basic Kit only with its matching craftable plain weapon', () => {
        const backpack = [sydneyKit, item('wrong', 36), item('sydney', 230)];
        expect(findDepotBasicKitPair(backpack, new Set(), isBasicKit, target, safe)).toEqual({
            kitId: 'kit-sydney',
            weaponId: 'sydney',
            targetDefindex: 230
        });
    });

    it('skips non-craftable, already-killstreaked, and reserved weapons', () => {
        const nonCraftable = { ...item('uncraftable', 230), flag_cannot_craft: true };
        const killstreaked = item('already-ks', 230, [{ def_index: 2025, value: 1 }]);
        expect(
            findDepotBasicKitPair([sydneyKit, nonCraftable, killstreaked], new Set(), isBasicKit, target, safe)
        ).toBeNull();
        expect(
            findDepotBasicKitPair([sydneyKit, item('reserved', 230)], new Set(['reserved']), isBasicKit, target, safe)
        ).toBeNull();
    });

    it('moves to another kit when the first has no safe matching weapon', () => {
        const backpack = [sydneyKit, blutsaugerKit, item('blut', 36), item('sydney', 230)];
        expect(
            findDepotBasicKitPair(backpack, new Set(), isBasicKit, target, weapon => weapon.id !== 'sydney')
        ).toEqual({
            kitId: 'kit-blut',
            weaponId: 'blut',
            targetDefindex: 36
        });
    });

    it('skips reserved kits and unresolved targets', () => {
        const backpack = [sydneyKit, blutsaugerKit, item('blut', 36)];
        expect(findDepotBasicKitPair(backpack, new Set(['kit-sydney']), isBasicKit, target, safe)?.kitId).toBe(
            'kit-blut'
        );
        expect(findDepotBasicKitPair(backpack, new Set(), isBasicKit, () => null, safe)).toBeNull();
    });

    it('allows legacy per-weapon Basic Kits when the schema normalizes them', () => {
        const legacy = item('legacy-kit', 5794, [{ def_index: 2012, value: 197 }]);
        expect(
            findDepotBasicKitPair([legacy, item('wrench', 197)], new Set(), kit => kit.def_index === 5794, target, safe)
        ).toEqual({ kitId: 'legacy-kit', weaponId: 'wrench', targetDefindex: 197 });
    });
});
