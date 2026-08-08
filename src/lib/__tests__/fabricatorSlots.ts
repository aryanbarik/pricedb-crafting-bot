import { findBotComponents, GCBackpackItem, GCItemAttr, KS_KIT_DEFINDEXES } from '../fabricatorSlots';

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
