import SchemaManager from '@tf2autobot/tf2-schema';
import { GCBackpackItem } from '../fabricatorSlots';
import { resolveKitBatchTargets, resolveKitTarget } from '../kitTarget';

const schemaItems = [
    {
        defindex: 5732,
        name: 'Spy-cicle Launcher Killstreakifier Basic',
        item_name: 'Killstreak Kit',
        item_class: 'tool'
    },
    { defindex: 649, name: 'The Spy-Cicle', item_name: 'Spy-Cicle', item_class: 'tf_weapon_knife' },
    { defindex: 5794, name: 'Wrench Killstreakifier Basic', item_name: 'Killstreak Kit', item_class: 'tool' },
    { defindex: 197, name: 'Upgradeable TF_WEAPON_WRENCH', item_name: 'Wrench', item_class: 'tf_weapon_wrench' },
    { defindex: 6527, name: 'Killstreakifier Basic', item_name: 'Killstreak Kit', item_class: 'tool' },
    { defindex: 939, name: 'The Bat Outta Hell', item_name: 'Bat Outta Hell', item_class: 'tf_weapon_bat' }
];

const schema = {
    getItemByDefindex: (defindex: number) => schemaItems.find(item => item.defindex === defindex) ?? null,
    getItemByItemName: (name: string) => (name === 'Wrench' ? schemaItems.find(item => item.defindex === 197) : null),
    raw: { schema: { items: schemaItems } }
} as unknown as SchemaManager.Schema;

const kit = (id: string, defindex: number, attribute: GCBackpackItem['attribute'] = []): GCBackpackItem => ({
    id,
    def_index: defindex,
    quality: 6,
    attribute
});

describe('resolveKitTarget', () => {
    it('uses the received inventory SKU for Spy-Cicle despite the non-matching internal schema name', () => {
        expect(resolveKitTarget(kit('spy', 5732), '6527;6;uncraftable;kt-1;td-649', schema)).toEqual({
            targetDefindex: 649,
            source: 'sku'
        });
        expect(resolveKitTarget(kit('spy', 5732), undefined, schema).targetDefindex).toBeNull();
    });

    it('keeps the schema-name fallback for a per-weapon Wrench kit without an inventory SKU', () => {
        expect(resolveKitTarget(kit('wrench', 5794), undefined, schema)).toEqual({
            targetDefindex: 197,
            source: 'schema'
        });
    });

    it('prefers the GC target attribute on a generic kit', () => {
        expect(
            resolveKitTarget(kit('generic', 6527, [{ def_index: 2012, value: 939 }]), '6527;6;kt-1;td-939', schema)
        ).toEqual({
            targetDefindex: 939,
            source: 'attribute'
        });
    });

    it('fails closed if GC and inventory SKU identify different weapons', () => {
        const result = resolveKitTarget(
            kit('conflict', 6527, [{ def_index: 2012, value: 939 }]),
            '6527;6;kt-1;td-649',
            schema
        );
        expect(result.targetDefindex).toBeNull();
        expect(result.reason).toContain('conflicting target defindexes');
    });

    it('does not guess when a SKU target is missing or malformed and schema lookup fails', () => {
        expect(resolveKitTarget(kit('spy', 5732), undefined, schema).targetDefindex).toBeNull();
        expect(resolveKitTarget(kit('spy', 5732), '6527;6;kt-1;td-nope', schema).targetDefindex).toBeNull();
    });

    it('rejects an entire batch if one kit has no safe target', () => {
        const kits = [kit('generic', 6527, [{ def_index: 2012, value: 939 }]), kit('spy', 5732), kit('bad', 5732)];
        const lookupSku = (item: GCBackpackItem): string | undefined =>
            item.id === 'spy' ? '6527;6;kt-1;td-649' : undefined;
        const result = resolveKitBatchTargets(kits, lookupSku, schema);
        expect(result).toMatchObject({ failureIndex: 2 });
        expect(result.targets).toBeUndefined();

        const valid = resolveKitBatchTargets(kits.slice(0, 2), lookupSku, schema);
        expect(valid.targets?.map(target => target.targetDefindex)).toEqual([939, 649]);
    });
});
