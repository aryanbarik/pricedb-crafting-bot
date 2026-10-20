import { decodeFabricatorSlots, GCBackpackItem, getItemAttrValue, KS_KIT_DEFINDEXES } from './fabricatorSlots';

export interface CraftItem extends GCBackpackItem {
    original_id?: string | null;
    origin?: number;
}

export interface OutputExpectation {
    defindexes: number[];
    attributes: Record<string, number>;
    quality?: number;
    originalId?: string;
    newlyCreated?: boolean;
}

export interface CraftOperation {
    id: string;
    kind: string;
    inputIds: string[];
    beforeIds: string[];
    expected: OutputExpectation;
    state: 'pending' | 'completed' | 'held';
    outputId?: string;
    consumedIds?: string[];
    startedAt: string;
    retainedInputId?: string;
    candidateIds?: string[];
    partialFabricator?: {
        id: string;
        originalId: string;
        defindex: number;
        fulfilled: Record<string, number>;
        deferUntilRefresh?: boolean;
    };
}

export function originalItemId(item: CraftItem): string {
    return item.original_id && String(item.original_id) !== '0' ? String(item.original_id) : String(item.id);
}

export function recipeOutput(fabricator: CraftItem): OutputExpectation {
    const slot = decodeFabricatorSlots(fabricator).find(s => KS_KIT_DEFINDEXES.includes(s.itemDefIndex));
    if (!slot) throw new Error(`Cannot identify output recipe for fabricator ${fabricator.id}`);
    const values = slot.conditionsStr.split('|\x01\x02\x01\x03|\x01\x02\x01\x03|');
    const attributes: Record<string, number> = {};
    if (slot.conditionsStr && (values.length % 2 !== 0 || values.length < 2)) {
        throw new Error(`Malformed output recipe for fabricator ${fabricator.id}`);
    }
    for (let index = 0; index < values.length - 1; index += 2) {
        const key = Number(values[index]);
        const value = Number(values[index + 1]);
        if (!Number.isInteger(key) || !Number.isFinite(value)) throw new Error('Invalid recipe attribute');
        attributes[String(key)] = value;
    }
    // Some recipes keep the visual attributes on the fabricator itself.
    for (const key of [2012, 2013, 2014]) {
        const value = getItemAttrValue(fabricator, key);
        if (attributes[key] === undefined && value !== null) attributes[key] = value;
    }
    if (attributes[2025] === undefined) attributes[2025] = fabricator.def_index === 20003 ? 3 : 2;
    if (!Number.isSafeInteger(attributes[2012]) || attributes[2012] <= 0)
        throw new Error(`Recipe has no weapon target: ${fabricator.id}`);
    // Generic kits carry their tier dynamically; tier-specific kits may omit that static attribute.
    return { defindexes: KS_KIT_DEFINDEXES, attributes, newlyCreated: true };
}

export function matchesOutput(item: CraftItem, expected: OutputExpectation): boolean {
    if (!expected.defindexes.includes(item.def_index)) return false;
    if (expected.quality !== undefined && item.quality !== expected.quality) return false;
    if (expected.originalId && originalItemId(item) !== expected.originalId) return false;
    // A traded-in crafted item retains its original_id, while its current asset ID changes.
    // The GC protobuf's absent/zero original_id uses the current ID as its identity.
    if (expected.newlyCreated && originalItemId(item) !== String(item.id)) return false;
    return Object.entries(expected.attributes).every(([key, value]) => {
        let actual = getItemAttrValue(item, Number(key));
        // The GC omits schema-static attributes. GetPlayerItems expands them, which
        // hid this difference in the original fixtures. Only these concrete kit
        // definitions establish a tier; generic kits and weapons still require it.
        if (key === '2025' && actual === null) {
            if (item.def_index === 6523) actual = 2;
            if (item.def_index === 6526) actual = 3;
        }
        return actual === value || (value === 0 && actual === null);
    });
}

/** Stock kit application creates a base weapon and then modifies its asset ID.
 * Its original_id therefore need not equal its final ID. Keep this exception
 * specific to that operation, including historical journal records.
 */
export function matchesOperationOutput(item: CraftItem, operation: CraftOperation): boolean {
    if (operation.kind !== 'applyKSKitToBaseItem') return matchesOutput(item, operation.expected);
    if (operation.beforeIds.includes(originalItemId(item))) return false;
    return matchesOutput(item, { ...operation.expected, newlyCreated: false });
}

export function operationOutputs(
    operation: CraftOperation,
    backpack: CraftItem[],
    excludedIds: Set<string>
): CraftItem[] {
    const owned = new Set(backpack.map(item => String(item.id)));
    if (operation.inputIds.some(id => id !== operation.retainedInputId && owned.has(id))) return [];
    const before = new Set(operation.beforeIds);
    return backpack.filter(
        item =>
            (!before.has(String(item.id)) || String(item.id) === operation.retainedInputId) &&
            !excludedIds.has(String(item.id)) &&
            !excludedIds.has(originalItemId(item)) &&
            matchesOperationOutput(item, operation)
    );
}

export function operationPartialOutput(
    operation: CraftOperation,
    backpack: CraftItem[],
    excluded: Set<string>,
    afterRefresh = false
): CraftItem | undefined {
    const previous = operation.partialFabricator;
    if (!previous) return undefined;
    if (previous.deferUntilRefresh && !afterRefresh) return undefined;
    const original = backpack.find(item => String(item.id) === previous.id);
    if (original) {
        return decodeFabricatorSlots(original).some(
            slot =>
                !KS_KIT_DEFINDEXES.includes(slot.itemDefIndex) &&
                slot.numFulfilled > (previous.fulfilled[slot.attributeIndex] ?? 0)
        )
            ? original
            : undefined;
    }
    const replacements = backpack
        .filter(
            item =>
                item.def_index === previous.defindex &&
                !operation.beforeIds.includes(String(item.id)) &&
                !excluded.has(String(item.id)) &&
                originalItemId(item) === previous.originalId
        )
        .filter(item => {
            try {
                const output = recipeOutput(item);
                return Object.entries(operation.expected.attributes).every(
                    ([key, value]) => output.attributes[key] === value
                );
            } catch {
                return false;
            }
        });
    return replacements.length === 1 ? replacements[0] : undefined;
}

export interface ReturnAttempt {
    offerId: string;
    assetIds: string[];
    state: 'pending' | 'active' | 'delivered' | 'reconcile' | 'failed';
}

export interface RollbackAsset {
    assetid: string;
    rollback_new_assetid?: string;
    rollback_new_contextid?: string;
}

export function rollbackMappings(
    expectedIds: string[],
    assets: RollbackAsset[],
    ownedIds: Set<string>
): Record<string, string> {
    const expected = new Set(expectedIds);
    const result: Record<string, string> = {};
    for (const asset of assets) {
        if (!expected.has(String(asset.assetid))) continue;
        const replacement = asset.rollback_new_assetid;
        if (replacement && replacement !== '0' && asset.rollback_new_contextid === '2' && ownedIds.has(replacement)) {
            if (result[String(asset.assetid)] && result[String(asset.assetid)] !== replacement) {
                throw new Error('Conflicting rollback mappings');
            }
            result[String(asset.assetid)] = replacement;
        }
    }
    if (new Set(Object.values(result)).size !== Object.keys(result).length)
        throw new Error('Conflicting rollback mappings');
    return result;
}
