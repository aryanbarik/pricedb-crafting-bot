import {
    findBotComponents,
    findPartnerComponents,
    GCBackpackItem,
    GCItemAttr,
    KS_KIT_DEFINDEXES
} from '../fabricatorSlots';

interface RecipeComponentProto {
    def_index: number;
    num_required: number;
    num_fulfilled: number;
    attributes_string: string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Schema = require('../../../node_modules/@tf2autobot/tf2/protobufs/generated/_load.js') as {
    CAttribute_DynamicRecipeComponent: {
        encode(message: RecipeComponentProto): { finish(): Uint8Array };
    };
};

const ATTR_KILLSTREAK_TIER = 2025;

/**
 * The real condition separator, which is NOT three pipes: it is a pipe, the byte sequence
 * 0x01 0x02 0x01 0x03, a pipe, that sequence again, and a final pipe. Most editors and the
 * project docs render it as "|||", so a fixture written with literal pipes silently produces a
 * conditions string that never splits — every condition is then skipped and itemSatisfiesConditions
 * returns its vacuous `true`, matching a kt-1 weapon to a kt-2 slot. Build conditions with cond().
 */
const RECIPE_CONDITION_SEP = '|\x01\x02\x01\x03|\x01\x02\x01\x03|';

const cond = (attrDefIndex: number, value: number): string => `${attrDefIndex}${RECIPE_CONDITION_SEP}${value}`;

/**
 * Encodes a recipe slot the same way the GC does, so these tests exercise the real
 * decodeFabricatorSlots path rather than a hand-rolled stand-in of it.
 */
function slot(
    attributeIndex: number,
    fields: { defIndex?: number; required?: number; fulfilled?: number; conditions?: string }
): GCItemAttr {
    const encoded = Schema.CAttribute_DynamicRecipeComponent.encode({
        def_index: fields.defIndex ?? 0,
        num_required: fields.required ?? 1,
        num_fulfilled: fields.fulfilled ?? 0,
        attributes_string: fields.conditions ?? ''
    }).finish();

    return { def_index: attributeIndex, value_bytes: Buffer.from(encoded) };
}

function fab(slots: GCItemAttr[]): GCBackpackItem {
    return { id: 'FAB', def_index: 20003, quality: 6, attribute: slots };
}

function part(id: string, defIndex: number, opts: { uncraftable?: boolean } = {}): GCBackpackItem {
    return { id, def_index: defIndex, quality: 6, flag_cannot_craft: opts.uncraftable };
}

function weapon(id: string, tier: number, opts: { uncraftable?: boolean } = {}): GCBackpackItem {
    return {
        id,
        def_index: 205,
        quality: 6,
        flag_cannot_craft: opts.uncraftable,
        attribute: [{ def_index: ATTR_KILLSTREAK_TIER, value: tier }]
    };
}

const ids = (r: { components: { subject_item_id: string }[] }): string[] => r.components.map(c => c.subject_item_id);

describe('findBotComponents', () => {
    describe('without options (existing behaviour must not shift)', () => {
        it('fills every unfilled slot from the backpack', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 2 }), slot(2001, { defIndex: 5705, required: 1 })]);
            const result = findBotComponents(f, [part('a', 5703), part('b', 5703), part('c', 5705)]);

            expect(ids(result).sort()).toEqual(['a', 'b', 'c']);
            expect(result.missing).toEqual([]);
        });

        it('reports a shortfall instead of silently under-filling', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 3 })]);
            const result = findBotComponents(f, [part('a', 5703)]);

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual(['2× defindex 5703']);
        });

        it('never claims an item for more than one slot', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 1 }), slot(2001, { defIndex: 5703, required: 1 })]);
            const result = findBotComponents(f, [part('only', 5703)]);

            expect(ids(result)).toEqual(['only']);
            expect(result.missing).toEqual(['1× defindex 5703']);
        });
    });

    describe('excludeIds', () => {
        it('will not spend an excluded item, and reports the slot as missing', () => {
            // The reserved item is the ONLY candidate — so if exclusion were ignored this would
            // return it, which is exactly the "bot ate another customer's parts" failure.
            const f = fab([slot(2000, { defIndex: 5703, required: 1 })]);
            const result = findBotComponents(f, [part('reserved', 5703)], {
                excludeIds: new Set(['reserved'])
            });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual(['1× defindex 5703']);
        });

        it('falls through to a non-excluded candidate', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 1 })]);
            const result = findBotComponents(f, [part('reserved', 5703), part('free', 5703)], {
                excludeIds: new Set(['reserved'])
            });

            expect(ids(result)).toEqual(['free']);
            expect(result.missing).toEqual([]);
        });

        it('applies to weapon slots too, not just robot parts', () => {
            const f = fab([slot(2000, { defIndex: 0, required: 1, conditions: cond(2025, 2) })]);
            const result = findBotComponents(f, [weapon('reserved', 2)], {
                excludeIds: new Set(['reserved'])
            });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual(['1× kt-2 killstreak weapon']);
        });
    });

    describe('alreadyCovered (the top-up gap)', () => {
        it('fills only the remainder when a slot is partly covered', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 3 })]);
            const result = findBotComponents(f, [part('a', 5703), part('b', 5703), part('c', 5703)], {
                alreadyCovered: new Map([[2000, 2]])
            });

            expect(result.components).toHaveLength(1);
            expect(result.missing).toEqual([]);
        });

        it('skips a fully covered slot WITHOUT reporting it missing', () => {
            // This is the whole point of the top-up: the customer supplied the weapon, so an empty
            // bot backpack must still be a success. Treating it as missing would hard-fail the craft.
            const f = fab([slot(2000, { defIndex: 0, required: 1, conditions: cond(2025, 2) })]);
            const result = findBotComponents(f, [], { alreadyCovered: new Map([[2000, 1]]) });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual([]);
        });

        it('treats over-coverage as covered rather than going negative', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 1 })]);
            const result = findBotComponents(f, [part('a', 5703)], { alreadyCovered: new Map([[2000, 5]]) });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual([]);
        });

        it('covers one slot while still filling its neighbours', () => {
            // The realistic admin case: weapon supplied in the trade, robot parts owed by the bot.
            const f = fab([
                slot(2000, { defIndex: 0, required: 1, conditions: cond(2025, 2) }),
                slot(2001, { defIndex: 5703, required: 2 })
            ]);
            const result = findBotComponents(f, [part('p1', 5703), part('p2', 5703)], {
                alreadyCovered: new Map([[2000, 1]])
            });

            expect(ids(result).sort()).toEqual(['p1', 'p2']);
            expect(result.components.every(c => c.attribute_index === 2001)).toBe(true);
            expect(result.missing).toEqual([]);
        });

        it('keys coverage by attributeIndex, not by slot order', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 1 }), slot(2007, { defIndex: 5705, required: 1 })]);
            const result = findBotComponents(f, [part('a', 5703), part('b', 5705)], {
                alreadyCovered: new Map([[2007, 1]])
            });

            expect(ids(result)).toEqual(['a']);
            expect(result.missing).toEqual([]);
        });
    });

    describe('regressions that have bitten before', () => {
        it.each(KS_KIT_DEFINDEXES)('never requests the output-spec slot (defindex %i)', kitDefIndex => {
            // Slots carrying a KS Kit defindex encode the recipe's OUTPUT. A previous bug filtered
            // these by hardcoded attribute_index instead, which ate the 6th ingredient of longer
            // recipes. The filter must key off the defindex alone, at any attribute index.
            const f = fab([
                slot(2001, { defIndex: 5703, required: 1 }),
                slot(2002, { defIndex: kitDefIndex, required: 1 })
            ]);
            const result = findBotComponents(f, [part('a', 5703), part('kit', kitDefIndex)], {
                alreadyCovered: new Map()
            });

            expect(ids(result)).toEqual(['a']);
            expect(result.missing).toEqual([]);
        });

        it('still refuses Non-Craftable items when options are passed', () => {
            const f = fab([slot(2000, { defIndex: 5703, required: 1 })]);
            const result = findBotComponents(f, [part('nc', 5703, { uncraftable: true })], {
                excludeIds: new Set(),
                alreadyCovered: new Map()
            });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual(['1× defindex 5703']);
        });

        it('matches robot parts on defindex alone, ignoring schema-static conditions', () => {
            // Checking conditions on a robot-part slot made it unmatchable 100% of the time: the
            // condition describes a schema property that never appears in per-instance attributes.
            const f = fab([slot(2000, { defIndex: 5701, required: 1, conditions: cond(2022, 1) })]);
            const result = findBotComponents(f, [part('pristine', 5701)], { excludeIds: new Set() });

            expect(ids(result)).toEqual(['pristine']);
        });

        it('matches weapon slots on killstreak tier, and rejects the wrong tier', () => {
            const f = fab([slot(2000, { defIndex: 0, required: 1, conditions: cond(2025, 2) })]);

            expect(ids(findBotComponents(f, [weapon('kt2', 2)]))).toEqual(['kt2']);
            expect(findBotComponents(f, [weapon('kt1', 1)]).missing).toEqual(['1× kt-2 killstreak weapon']);
        });
    });

    describe('allowPartial (bank what the bot has, report the rest)', () => {
        it('takes what a short slot can supply instead of skipping it', () => {
            // The case that prompted this: the bot held 2 of 3 and banked none of them.
            const f = fab([slot(2000, { defIndex: 5701, required: 3 })]);
            const result = findBotComponents(f, [part('a', 5701), part('b', 5701)], { allowPartial: true });

            expect(ids(result).sort()).toEqual(['a', 'b']);
            expect(result.missing).toEqual(['1× defindex 5701']);
        });

        it('reports the same shortfall whether or not partial is on', () => {
            // `missing` means "how many more the bot must acquire", so it must not move just
            // because the available ones were banked. Only the components differ.
            const f = fab([slot(2000, { defIndex: 5701, required: 3 })]);
            const backpack = [part('a', 5701), part('b', 5701)];

            expect(findBotComponents(f, backpack).missing).toEqual(['1× defindex 5701']);
            expect(findBotComponents(f, backpack, { allowPartial: true }).missing).toEqual(['1× defindex 5701']);
            expect(findBotComponents(f, backpack).components).toEqual([]);
            expect(findBotComponents(f, backpack, { allowPartial: true }).components).toHaveLength(2);
        });

        it('banks nothing but still reports when a slot has no candidates', () => {
            const f = fab([slot(2000, { defIndex: 5701, required: 2 })]);
            const result = findBotComponents(f, [], { allowPartial: true });

            expect(result.components).toEqual([]);
            expect(result.missing).toEqual(['2× defindex 5701']);
        });

        it('partially fills weapon slots too, not just robot parts', () => {
            const f = fab([slot(2000, { defIndex: 0, required: 2, conditions: cond(2025, 2) })]);
            const result = findBotComponents(f, [weapon('ks', 2)], { allowPartial: true });

            expect(ids(result)).toEqual(['ks']);
            expect(result.missing).toEqual(['1× kt-2 killstreak weapon']);
        });

        it('fills one slot fully, another partly, and skips a covered one', () => {
            // The realistic depot order: some slots the bot can cover, some it can't, and some the
            // fabricator already arrived carrying.
            const f = fab([
                slot(2000, { defIndex: 0, required: 2, conditions: cond(2025, 2) }),
                slot(2001, { defIndex: 5707, required: 2 }),
                slot(2002, { defIndex: 5704, required: 1, fulfilled: 1 })
            ]);
            const result = findBotComponents(f, [part('f1', 5707), part('f2', 5707)], { allowPartial: true });

            expect(ids(result).sort()).toEqual(['f1', 'f2']);
            expect(result.missing).toEqual(['2× kt-2 killstreak weapon']);
        });

        it('still respects alreadyCovered, excludeIds and Non-Craftable', () => {
            const f = fab([slot(2000, { defIndex: 5701, required: 2 })]);

            expect(
                findBotComponents(f, [part('a', 5701)], { allowPartial: true, alreadyCovered: new Map([[2000, 2]]) })
            ).toEqual({ components: [], missing: [] });

            expect(
                findBotComponents(f, [part('a', 5701), part('nope', 5701)], {
                    allowPartial: true,
                    excludeIds: new Set(['nope'])
                }).missing
            ).toEqual(['1× defindex 5701']);

            expect(
                findBotComponents(f, [part('nc', 5701, { uncraftable: true })], { allowPartial: true }).components
            ).toEqual([]);
        });
    });

    describe('forward compatibility: bot stocking killstreak weapons', () => {
        it('fills an uncovered weapon slot from the bot once it holds a kt-2 weapon', () => {
            // Nothing needs to change in the implementation for this to start working — the day a
            // kt-2 weapon is in the backpack, the existing weapon-slot branch picks it up. This
            // pins that so a future "robot parts only" shortcut cannot regress it.
            const f = fab([
                slot(2000, { defIndex: 0, required: 1, conditions: cond(2025, 2) }),
                slot(2001, { defIndex: 5703, required: 1 })
            ]);
            const result = findBotComponents(f, [weapon('ks', 2), part('p', 5703)]);

            expect(ids(result).sort()).toEqual(['ks', 'p']);
            expect(result.missing).toEqual([]);
        });
    });
});

/**
 * The kit + weapon fallback had no coverage at all before this block, which is how it shipped
 * unreachable: it built a bare `6527;6` SKU that no real Killstreak Kit ever carries (they look
 * like `6527;6;uncraftable;kt-1;td-452`), so the exact-match inventory lookup never found one.
 */
describe('findPartnerComponents — kit + weapon fallback for the weapon slot', () => {
    const WEAPON_DEFINDEX = 205; // Upgradeable Rocket Launcher

    /** A fabricator whose only open slot is a weapon slot of the given tier. */
    const weaponSlotFab = (tier: number, required = 1): GCBackpackItem =>
        fab([slot(2000, { defIndex: 0, required, conditions: cond(ATTR_KILLSTREAK_TIER, tier) })]);

    /** Stands in for the partner's inventory: exact SKU to asset ids, like Inventory.findBySKU. */
    const inventory =
        (skuToIds: Record<string, string[]>) =>
        (sku: string): string[] =>
            skuToIds[sku] ?? [];

    const noPremade = (): string[] => [];
    const shortfall = (n: number, tier: number): string => `${n}× kt-${tier} weapon (or kit + weapon)`;

    it('requests the kit and the weapon it targets', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1'] }),
            noPremade,
            () => [{ id: 'KIT1', targetDefindex: WEAPON_DEFINDEX }]
        );

        expect(result.assetIds).toEqual(['KIT1', 'W1']);
        expect(result.missing).toEqual([]);
    });

    it("pairs on the KIT's target, not the fabricator's — the bug this replaces", () => {
        // The fabricator carries no target weapon at all here. Under the old implementation that
        // alone (`targetWeaponDefindex === null`) skipped the fallback outright.
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({ '200;6': ['SCATTERGUN'] }),
            noPremade,
            () => [{ id: 'KIT_SCATTERGUN', targetDefindex: 200 }]
        );

        expect(result.assetIds).toEqual(['KIT_SCATTERGUN', 'SCATTERGUN']);
        expect(result.missing).toEqual([]);
    });

    it('prefers a ready-made killstreak weapon and leaves the kit alone', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1'] }),
            () => ['PREMADE'],
            () => [{ id: 'KIT1', targetDefindex: WEAPON_DEFINDEX }]
        );

        expect(result.assetIds).toEqual(['PREMADE']);
    });

    it('reports the slot missing when the kit has no weapon to go on', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({}), // partner owns the kit but not the weapon
            noPremade,
            () => [{ id: 'KIT1', targetDefindex: WEAPON_DEFINDEX }]
        );

        expect(result.assetIds).toEqual([]);
        expect(result.missing).toEqual([shortfall(1, 2)]);
    });

    it('skips an unusable kit and keeps looking rather than giving up on the first', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1'] }),
            noPremade,
            () => [
                { id: 'KIT_NO_WEAPON', targetDefindex: 18 }, // partner owns no defindex-18 weapon
                { id: 'KIT_USABLE', targetDefindex: WEAPON_DEFINDEX }
            ]
        );

        expect(result.assetIds).toEqual(['KIT_USABLE', 'W1']);
        expect(result.missing).toEqual([]);
    });

    it('mixes a ready-made weapon and a kit pair to fill a two-weapon slot', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2, 2),
            inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1'] }),
            () => ['PREMADE'],
            () => [{ id: 'KIT1', targetDefindex: WEAPON_DEFINDEX }]
        );

        expect(result.assetIds).toEqual(['PREMADE', 'KIT1', 'W1']);
        expect(result.missing).toEqual([]);
    });

    it('will not claim the same kit for two fabricators sharing a usedIds set', () => {
        const usedIds = new Set<string>();
        const inv = inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1', 'W2'] });
        const kits = (): { id: string; targetDefindex: number }[] => [{ id: 'KIT1', targetDefindex: WEAPON_DEFINDEX }];

        const first = findPartnerComponents(weaponSlotFab(2), inv, noPremade, kits, usedIds);
        const second = findPartnerComponents(weaponSlotFab(2), inv, noPremade, kits, usedIds);

        expect(first.assetIds).toEqual(['KIT1', 'W1']);
        expect(second.assetIds).toEqual([]);
        expect(second.missing).toEqual([shortfall(1, 2)]);
    });

    it('ignores kits of the wrong killstreak tier', () => {
        const result = findPartnerComponents(
            weaponSlotFab(2),
            inventory({ [`${WEAPON_DEFINDEX};6`]: ['W1'] }),
            noPremade,
            // The closure is asked for tier 2; a correct implementation never sees a tier-1 kit.
            tier => (tier === 1 ? [{ id: 'BASIC_KIT', targetDefindex: WEAPON_DEFINDEX }] : [])
        );

        expect(result.assetIds).toEqual([]);
        expect(result.missing).toEqual([shortfall(1, 2)]);
    });
});
