import { GCBackpackItem, getItemAttrValue } from './fabricatorSlots';

export interface DepotKitPair {
    kitId: string;
    weaponId: string;
    targetDefindex: number;
}

/**
 * Pick one bot-owned Basic Kit and its matching plain, craftable weapon. Kit craftability is
 * deliberately irrelevant; only the weapon becomes a fabricator ingredient.
 */
export function findDepotBasicKitPair(
    backpack: GCBackpackItem[],
    excludedIds: ReadonlySet<string>,
    isBasicKit: (kit: GCBackpackItem) => boolean,
    resolveTarget: (kit: GCBackpackItem) => number | null,
    isSafeWeapon: (weapon: GCBackpackItem) => boolean
): DepotKitPair | null {
    for (const kit of backpack) {
        if (!isBasicKit(kit) || excludedIds.has(String(kit.id))) continue;
        const targetDefindex = resolveTarget(kit);
        if (targetDefindex === null) continue;
        const weapon = backpack.find(
            item =>
                item.def_index === targetDefindex &&
                item.quality === 6 &&
                !item.flag_cannot_craft &&
                getItemAttrValue(item, 2025) === null &&
                !excludedIds.has(String(item.id)) &&
                isSafeWeapon(item)
        );
        if (weapon) return { kitId: String(kit.id), weaponId: String(weapon.id), targetDefindex };
    }
    return null;
}
