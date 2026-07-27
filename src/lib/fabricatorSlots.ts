import SKU from '@tf2autobot/tf2-sku';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Schema = require('../../node_modules/@tf2autobot/tf2/protobufs/generated/_load.js');

export const FABRICATOR_DEFINDEXES = [20002, 20003]; // Specialized, Professional

// Attribute def_index constants for recipe slots
const ATTR_KILLSTREAK_TIER = 2025;
// Every Killstreak Kit (all 4 tiers/defindexes below) is bound to one specific weapon defindex via
// this attribute ("tool_target_item" in items_game.txt, attribute index 2012) — unlike a
// Fabricator's own weapon *slot* (defidx=0, any weapon), a Kit itself is never weapon-agnostic.
// Applying a kit to a weapon whose defindex doesn't match this value is silently ignored by the GC
// (no response, no state change), which is what caused the "timed out waiting for kit application"
// failures — the pairing logic must match on this, not just take the next available weapon.
export const ATTR_TOOL_TARGET_ITEM = 2012;
// KS Kit defindexes — when a slot's itemDefIndex is one of these, it's an output specification, not an input
// 6523 = Specialized KS Kit (Spec KS Fabricator output), 6526 = Professional KS Kit (Pro KS Fabricator output)
export const KS_KIT_DEFINDEXES = [6523, 6526, 6527, 6528];

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
    // Separator is pipe + [0x01,0x02,0x01,0x03] + pipe (binary sequence appearing twice between key and value)
    const SEP = '|||';
    const parts = conditionsStr.split(SEP);
    for (let i = 0; i + 1 < parts.length; i += 2) {
        if (Number(parts[i]) === attrDefIndex) return Number(parts[i + 1]);
    }
    return null;
}

export function getItemAttrValue(item: GCBackpackItem, attrDefIndex: number): number | null {
    const attr = (item.attribute ?? []).find(a => a.def_index === attrDefIndex);
    if (!attr) return null;
    if (attr.value !== null && attr.value !== undefined) return Number(attr.value);
    const buf = toBuffer(attr.value_bytes);
    if (buf && buf.length >= 4) return buf.readFloatLE(0); // value_bytes stores float32 LE (e.g. [0,0,0,64]=2.0)
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
        s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired
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
        s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired
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
        s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired
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

/**
 * Derives the target weapon's display name from a fabricator's own item name, e.g.
 * "Specialized Killstreak Degreaser Kit Fabricator" -> "Degreaser".
 */
export function extractTargetWeaponName(fabItemName: string): string {
    return fabItemName
        .replace(/^(Professional|Specialized) Killstreak /, '')
        .replace(/ Kit Fabricator$/, '')
        .trim();
}

/**
 * Parses the killstreak tier (1=Killstreak, 2=Specialized, 3=Professional) implied by an
 * unapplied KS Kit's own item name, e.g. "Professional Killstreak Kit" -> 3.
 */
export function ksKitTierFromName(name: string): number | undefined {
    if (name.startsWith('Professional Killstreak ')) return 3;
    if (name.startsWith('Specialized Killstreak ')) return 2;
    if (name.startsWith('Killstreak ')) return 1;
    return undefined;
}

export interface PartnerComponentResult {
    /** Flat list of the trade partner's asset IDs to request, across all slots. */
    assetIds: string[];
    /** Human-readable descriptions of what could not be found, for messaging the partner. */
    missing: string[];
}

/**
 * Finds which of a trade partner's owned items satisfy the fabricator's unfilled recipe slots,
 * using SKU lookups against their inventory rather than a flat backpack array (the bot doesn't
 * own these items yet — this is used to build the follow-up "please send me these parts" offer).
 *
 * Unlike findBotComponents, this fills slots partially: if the partner owns 2 of 3 needed robot
 * parts, the 2 found are still requested rather than skipping the whole slot.
 *
 * For the weapon slot, tries a premade killstreak weapon of the right tier first, then falls back
 * to an unapplied KS Kit of the right tier + a matching plain weapon (both items are requested;
 * the existing accepted-offer pipeline already knows how to apply a kit it receives before craft).
 *
 * Pass a shared `usedIds` Set when matching multiple fabricators against the same partner
 * inventory in one batch, so the same physical item can't get claimed for two different
 * fabricators' slots. Defaults to a fresh Set for single-fabricator callers.
 */
export function findPartnerComponents(
    fabricator: GCBackpackItem,
    targetWeaponDefindex: number | null,
    kitDefindexByTier: Partial<Record<number, number>>,
    lookupSku: (sku: string, tradableOnly?: boolean) => string[],
    lookupKillstreakWeapon: (killstreakTier: number, tradableOnly?: boolean) => string[],
    usedIds: Set<string> = new Set()
): PartnerComponentResult {
    const slots = decodeFabricatorSlots(fabricator).filter(
        s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired
    );

    const assetIds: string[] = [];
    const missing: string[] = [];

    const takeFromSku = (sku: string): string | undefined => {
        const found = lookupSku(sku, true).find(id => !usedIds.has(id));
        if (found) usedIds.add(found);
        return found;
    };

    for (const slot of slots) {
        const needed = slot.numRequired - slot.numFulfilled;

        if (slot.itemDefIndex === 0) {
            // Weapon slot — itemDefIndex is 0 because the real recipe accepts ANY weapon with a
            // matching killstreak tier, not just the fabricator's own target weapon type.
            const requiredTier = parseRequiredAttrValue(slot.conditionsStr, ATTR_KILLSTREAK_TIER) ?? 2;
            let foundForSlot = 0;
            for (let k = 0; k < needed; k++) {
                const premadeId = lookupKillstreakWeapon(requiredTier, true).find(id => !usedIds.has(id));
                if (premadeId) {
                    usedIds.add(premadeId);
                    assetIds.push(premadeId);
                    foundForSlot++;
                    continue;
                }

                if (targetWeaponDefindex === null) continue;

                const kitDefindex = kitDefindexByTier[requiredTier];
                if (kitDefindex === undefined) continue;
                const kitSku = SKU.fromObject({ defindex: kitDefindex, quality: 6 });
                const weaponSku = SKU.fromObject({ defindex: targetWeaponDefindex, quality: 6 });
                const kitId = takeFromSku(kitSku);
                if (!kitId) continue;
                const weaponId = takeFromSku(weaponSku);
                if (!weaponId) {
                    usedIds.delete(kitId);
                    continue;
                }
                assetIds.push(kitId, weaponId);
                foundForSlot++;
            }
            if (foundForSlot < needed) {
                missing.push(`${needed - foundForSlot}× kt-${requiredTier} weapon (or kit + weapon)`);
            }
        } else {
            // Robot part slot
            const sku = SKU.fromObject({ defindex: slot.itemDefIndex, quality: 6 });
            let foundForSlot = 0;
            for (let k = 0; k < needed; k++) {
                const id = takeFromSku(sku);
                if (!id) break;
                assetIds.push(id);
                foundForSlot++;
            }
            if (foundForSlot < needed) {
                missing.push(`${needed - foundForSlot}× defindex ${slot.itemDefIndex}`);
            }
        }
    }

    return { assetIds, missing };
}
