// eslint-disable-next-line @typescript-eslint/no-var-requires
const Schema = require('../../node_modules/@tf2autobot/tf2/protobufs/generated/_load.js');

export const FABRICATOR_DEFINDEXES = [20002, 20003]; // Specialized, Professional

// Attribute def_index constants for recipe slots
const SLOT_OUTPUT = 2006;
const ATTR_KILLSTREAK_TIER = 2025;

export interface RecipeSlot {
    attributeIndex: number; // equals the attribute_index field in CMsgFulfillDynamicRecipeComponent
    itemDefIndex: number;   // required item defindex; 0 = any weapon matching conditionsStr
    numRequired: number;
    numFulfilled: number;
    conditionsStr: string;  // e.g. "2025|||2" for kt-2 weapons
}

export interface GCItemAttr {
    def_index: number;
    value?: string | number | null;
    float_value?: number | null;
    value_bytes?: Buffer | { type: string; data: number[] };
}

export interface GCBackpackItem {
    id: string;
    def_index: number;
    quality: number;
    flag_cannot_craft?: boolean;
    attribute?: GCItemAttr[];
}

function toBuffer(raw: Buffer | { type: string; data: number[] } | undefined): Buffer | null {
    if (!raw) return null;
    if (Buffer.isBuffer(raw)) return raw as unknown as Buffer;
    if (typeof raw === 'object' && 'data' in raw) return Buffer.from((raw as { data: number[] }).data);
    return null;
}

export function decodeFabricatorSlots(item: GCBackpackItem): RecipeSlot[] {
    const slots: RecipeSlot[] = [];
    for (const attr of item.attribute ?? []) {
        if (attr.def_index < 2000 || attr.def_index > 2099) continue;
        const buf = toBuffer(attr.value_bytes);
        if (!buf || buf.length === 0) continue;
        let decoded: any;
        try {
            decoded = Schema.CAttribute_DynamicRecipeComponent.decode(buf);
        } catch {
            continue;
        }
        slots.push({
            attributeIndex: attr.def_index,
            itemDefIndex: decoded.def_index ?? 0,
            numRequired: decoded.num_required ?? 0,
            numFulfilled: decoded.num_fulfilled ?? 0,
            conditionsStr: decoded.attributes_string ?? '',
        });
    }
    return slots;
}

function parseRequiredAttrValue(conditionsStr: string, attrDefIndex: number): number | null {
    const parts = conditionsStr.split('|||');
    for (let i = 0; i + 1 < parts.length; i += 2) {
        if (Number(parts[i]) === attrDefIndex) return Number(parts[i + 1]);
    }
    return null;
}

function getItemAttrValue(item: GCBackpackItem, attrDefIndex: number): number | null {
    const attr = (item.attribute ?? []).find(a => a.def_index === attrDefIndex);
    if (!attr) return null;
    if (attr.value !== null && attr.value !== undefined) return Number(attr.value);
    const buf = toBuffer(attr.value_bytes);
    if (buf && buf.length >= 4) return buf.readUInt32LE(0);
    return null;
}

export interface TradeValidationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Validates that all unfilled fabricator slots can be satisfied by items in tradeItems.
 * backpack is the bot's current GC backpack (used only for reading attr values).
 */
export function validateFabricatorTrade(
    fabricator: GCBackpackItem,
    tradeItems: GCBackpackItem[]
): TradeValidationResult {
    const slots = decodeFabricatorSlots(fabricator);
    if (slots.length === 0) {
        return { valid: false, reason: 'could not decode fabricator recipe slots' };
    }

    const unfilledSlots = slots.filter(
        s => s.attributeIndex !== SLOT_OUTPUT && s.numFulfilled < s.numRequired
    );
    if (unfilledSlots.length === 0) {
        return { valid: false, reason: 'fabricator is already fully filled' };
    }

    const available = [...tradeItems.filter(i => i.id !== fabricator.id)];
    const usedIds = new Set<string>();

    for (const slot of unfilledSlots) {
        const needed = slot.numRequired - slot.numFulfilled;

        if (slot.itemDefIndex === 0) {
            // Weapon slot
            const requiredTier = parseRequiredAttrValue(slot.conditionsStr, ATTR_KILLSTREAK_TIER) ?? 2;
            const candidates = available.filter(
                i => !usedIds.has(i.id) && getItemAttrValue(i, ATTR_KILLSTREAK_TIER) === requiredTier
            );
            if (candidates.length < needed) {
                return {
                    valid: false,
                    reason: `need ${needed} kt-${requiredTier} weapon(s) for slot ${slot.attributeIndex}, found ${candidates.length}`,
                };
            }
            for (let k = 0; k < needed; k++) usedIds.add(candidates[k].id);
        } else {
            // Robot part slot
            const candidates = available.filter(
                i => !usedIds.has(i.id) && i.def_index === slot.itemDefIndex
            );
            if (candidates.length < needed) {
                return {
                    valid: false,
                    reason: `need ${needed}× defindex ${slot.itemDefIndex} for slot ${slot.attributeIndex}, found ${candidates.length}`,
                };
            }
            for (let k = 0; k < needed; k++) usedIds.add(candidates[k].id);
        }
    }

    return { valid: true };
}

/**
 * Builds the components array for CMsgFulfillDynamicRecipeComponent.
 * Each item in componentItems is mapped to its recipe slot via defindex / weapon tier.
 */
export function buildCraftComponents(
    fabricator: GCBackpackItem,
    componentItems: GCBackpackItem[]
): { subject_item_id: string; attribute_index: number }[] {
    const slots = decodeFabricatorSlots(fabricator).filter(
        s => s.attributeIndex !== SLOT_OUTPUT && s.numFulfilled < s.numRequired
    );

    const result: { subject_item_id: string; attribute_index: number }[] = [];
    const slotCounts = new Map<number, number>(); // attributeIndex → assigned count

    for (const item of componentItems) {
        if (item.id === fabricator.id) continue;

        // Find the matching slot for this item
        const slot = slots.find(s => {
            const assigned = slotCounts.get(s.attributeIndex) ?? 0;
            if (assigned >= s.numRequired - s.numFulfilled) return false;
            if (s.itemDefIndex === 0) {
                // Weapon slot — match by killstreak tier in conditionsStr
                const requiredTier = parseRequiredAttrValue(s.conditionsStr, ATTR_KILLSTREAK_TIER) ?? 2;
                return getItemAttrValue(item, ATTR_KILLSTREAK_TIER) === requiredTier;
            }
            return item.def_index === s.itemDefIndex;
        });

        if (slot) {
            result.push({ subject_item_id: item.id, attribute_index: slot.attributeIndex });
            slotCounts.set(slot.attributeIndex, (slotCounts.get(slot.attributeIndex) ?? 0) + 1);
        }
    }

    return result;
}

export interface BotComponentResult {
    components: { subject_item_id: string; attribute_index: number }[];
    missing: string[];
}

/**
 * Scans the bot's own GC backpack to find items that fill each unfilled recipe slot.
 * botBackpack should exclude the fabricator itself and any payment keys.
 */
export function findBotComponents(
    fabricator: GCBackpackItem,
    botBackpack: GCBackpackItem[]
): BotComponentResult {
    const slots = decodeFabricatorSlots(fabricator).filter(
        s => s.attributeIndex !== SLOT_OUTPUT && s.numFulfilled < s.numRequired
    );

    const components: { subject_item_id: string; attribute_index: number }[] = [];
    const missing: string[] = [];
    const usedIds = new Set<string>();

    for (const slot of slots) {
        const needed = slot.numRequired - slot.numFulfilled;

        if (slot.itemDefIndex === 0) {
            // Weapon slot
            const requiredTier = parseRequiredAttrValue(slot.conditionsStr, ATTR_KILLSTREAK_TIER) ?? 2;
            const candidates = botBackpack.filter(
                i => !usedIds.has(i.id) && getItemAttrValue(i, ATTR_KILLSTREAK_TIER) === requiredTier
            );
            if (candidates.length < needed) {
                missing.push(`${needed - candidates.length}× kt-${requiredTier} killstreak weapon`);
                continue;
            }
            for (let k = 0; k < needed; k++) {
                components.push({ subject_item_id: candidates[k].id, attribute_index: slot.attributeIndex });
                usedIds.add(candidates[k].id);
            }
        } else {
            // Robot part slot
            const candidates = botBackpack.filter(
                i => !usedIds.has(i.id) && i.def_index === slot.itemDefIndex
            );
            if (candidates.length < needed) {
                missing.push(`${needed - candidates.length}× defindex ${slot.itemDefIndex}`);
                continue;
            }
            for (let k = 0; k < needed; k++) {
                components.push({ subject_item_id: candidates[k].id, attribute_index: slot.attributeIndex });
                usedIds.add(candidates[k].id);
            }
        }
    }

    return { components, missing };
}
