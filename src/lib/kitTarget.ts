import SchemaManager from '@tf2autobot/tf2-schema';
import { ATTR_TOOL_TARGET_ITEM, GCBackpackItem, getItemAttrValue } from './fabricatorSlots';
import { fixItem } from './items';
import { MinimumItem } from '../types/TeamFortress2';

export interface KitTargetResolution {
    targetDefindex: number | null;
    source: 'attribute' | 'sku' | 'schema' | null;
    reason?: string;
}

/** Resolve a GC kit's weapon target before attempting a potentially destructive apply. */
export function resolveKitTarget(
    kit: Pick<GCBackpackItem, 'def_index' | 'attribute'>,
    sku: string | null | undefined,
    schema: SchemaManager.Schema
): KitTargetResolution {
    const normalize = (defindex: number): number | null => {
        if (!Number.isSafeInteger(defindex) || defindex <= 0) return null;
        return fixItem({ defindex, quality: 6 } as MinimumItem, schema).defindex;
    };

    const attributeValue = getItemAttrValue(kit as GCBackpackItem, ATTR_TOOL_TARGET_ITEM);
    const attributeTarget = attributeValue === null ? null : normalize(attributeValue);
    const skuMatch = sku?.match(/(?:^|;)td-(\d+)(?:;|$)/);
    const skuTarget = skuMatch ? normalize(Number(skuMatch[1])) : null;

    if (attributeTarget !== null && skuTarget !== null && attributeTarget !== skuTarget) {
        return {
            targetDefindex: null,
            source: null,
            reason: `conflicting target defindexes: GC attribute=${attributeTarget}, inventory SKU=${skuTarget}`
        };
    }
    if (attributeTarget !== null) return { targetDefindex: attributeTarget, source: 'attribute' };
    if (skuTarget !== null) return { targetDefindex: skuTarget, source: 'sku' };

    // Older per-weapon Basic kits have no dynamic target attribute. Their internal schema
    // names usually work, but names like "Spy-cicle Launcher" do not match a weapon item.
    const schemaName = schema.getItemByDefindex(kit.def_index)?.name;
    const weaponName = schemaName?.replace(/\s*Killstreakifier(\s+\S+)?\s*$/i, '').trim();
    if (weaponName && weaponName !== schemaName) {
        const schemaTarget = normalize(schema.getItemByItemName(weaponName)?.defindex ?? 0);
        if (schemaTarget !== null) return { targetDefindex: schemaTarget, source: 'schema' };
    }

    return {
        targetDefindex: null,
        source: null,
        reason: `no valid GC attribute, inventory SKU target, or schema-name match (sku=${
            sku ?? 'unknown'
        }, schemaName=${schemaName ?? 'unknown'})`
    };
}

export type KitTargetBatchResolution =
    | {
          targets: { targetDefindex: number; source: 'attribute' | 'sku' | 'schema' }[];
          failureIndex?: never;
          reason?: never;
      }
    | { targets?: never; failureIndex: number; reason: string };

/** Preflight the whole batch so one unresolvable kit cannot fail after another was applied. */
export function resolveKitBatchTargets(
    kits: GCBackpackItem[],
    lookupSku: (kit: GCBackpackItem) => string | null | undefined,
    schema: SchemaManager.Schema
): KitTargetBatchResolution {
    const targets: { targetDefindex: number; source: 'attribute' | 'sku' | 'schema' }[] = [];
    for (let index = 0; index < kits.length; index++) {
        const resolution = resolveKitTarget(kits[index], lookupSku(kits[index]), schema);
        if (resolution.targetDefindex === null || resolution.source === null) {
            return { failureIndex: index, reason: resolution.reason ?? 'no valid target' };
        }
        targets.push({ targetDefindex: resolution.targetDefindex, source: resolution.source });
    }
    return { targets };
}
