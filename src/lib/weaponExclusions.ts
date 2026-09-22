import { EconItem } from '@tf2autobot/tradeoffer-manager';
import Bot from '../classes/Bot';

// Business rule: these 3 Halloween Spells make a weapon unusable as a crafting-service component,
// regardless of the bot's own highValue.spells config (which only flags spells for pricing/accept
// purposes, and may not include all — or any — of these). Matched against the exact display names
// used by spellsData in lib/data.ts.
const EXCLUDED_HALLOWEEN_SPELLS = new Set(['pumpkin bombs', 'halloween fire', 'exorcism']);

// Promotional reskins must never be consumed as automatic crafting inputs. They are technically
// valid recipe weapons, but are worth more than their ordinary equivalents. This also blocks Kits
// targeting them, preventing the service from creating a Killstreak reskin and consuming it later.
const EXCLUDED_CRAFTING_RESKIN_DEFINDEXES = new Set([
    160, // Lugermorph
    294, // Lugermorph (Poker Night promotional variant)
    161, // Big Kill
    298, // Iron Curtain
    727, // Black Rose
    1100, // Bread Bite
    30665, // Shooting Star
    30666, // C.A.P.P.E.R
    30667 // Batsaber
]);

export function isExcludedCraftingReskinDefindex(defindex: number): boolean {
    return EXCLUDED_CRAFTING_RESKIN_DEFINDEXES.has(defindex);
}

/**
 * Checks a weapon's raw Steam trade-asset descriptions for any of the 3 excluded Halloween
 * Spells. Mirrors the exact parsing Inventory.ts's own highValue() uses to find a spell
 * description ("Halloween: <name> (spell only active during event)", color 7ea9d1) — but checks
 * the spell name directly against a fixed exclusion list instead of the bot's configurable
 * highValue spell names, since a customer's own inventory only exposes raw EconItem descriptions
 * before Inventory reduces items down to its SKU-keyed Dict (which loses this per-instance data).
 */
export function hasExcludedHalloweenSpell(item: Pick<EconItem, 'descriptions'>): boolean {
    for (const content of item.descriptions ?? []) {
        if (
            content.value.startsWith('Halloween:') &&
            content.value.endsWith('(spell only active during event)') &&
            content.color === '7ea9d1'
        ) {
            const spellName = content.value.substring(10, content.value.length - 32).trim();
            if (EXCLUDED_HALLOWEEN_SPELLS.has(spellName.toLowerCase())) return true;
        }
    }
    return false;
}

/**
 * A "Festive" weapon (e.g. "Festive Rocket Launcher") is a distinct schema defindex from its
 * normal counterpart, not a modifier on the same defindex — confirmed against Steam's own item
 * schema (GetSchemaItems): every Festive variant's item_name literally starts with "Festive ".
 * Distinct from ";festive" in a SKU string, which instead marks a Festivized (giftapult) weapon —
 * a real modifier attachable to any weapon, and NOT excluded by this business rule.
 */
export function isFestiveWeaponDefindex(defindex: number, bot: Bot): boolean {
    const schemaItem = (bot.schema as any).getItemByDefindex?.(defindex) as { item_name?: string } | undefined;
    return schemaItem?.item_name?.startsWith('Festive ') ?? false;
}
