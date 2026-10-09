import { ItemAttributes } from '@tf2autobot/tradeoffer-manager';
import SKU from '@tf2autobot/tf2-sku';
import { testPriceKey } from '../../../lib/tools/export';

/**
 * Attributes an item name cannot express — spells, strange parts, killstreak
 * effects and paint — drawn as pictographs on the tile that owns them.
 *
 * Position carries the category and shape carries the identity, the way
 * backpack.tf does it: a flame top-left is always the killstreaker, a ghost
 * bottom-left is always Exorcism. A slot with nothing to say draws nothing and
 * the others do not reflow into the gap, because a moved icon means a different
 * thing.
 *
 * Quality, australium and unusual effect all live in the sku and therefore in
 * the item name, so they are deliberately not drawn here.
 */
type IconSlot = 'killstreak' | 'parts' | 'spell1' | 'spell2';

export interface AttributeIcon {
    slot: IconSlot;
    glyph: string;
    color: string;
}

export interface TileAttributes {
    icons: AttributeIcon[];
    /** Hex for the paint swatch, drawn outside the icon grid. */
    paint?: string;
}

/** What the high-value scan knows. The killstreak *tier* is not in here — see below. */
export interface ScannedAttributes {
    /** Spell partial skus, ascending, so a re-render never shuffles the slots. */
    spells: string[];
    hasParts: boolean;
    /** `ks-3` */
    sheen?: string;
    /** `ke-2004` */
    killstreaker?: string;
    paint?: string;
}

export type ScannedMap = Record<string, ScannedAttributes>;

const PARTS_GLYPH = '\u{1F527}'; // 🔧
const PARTS_COLOR = '#CF6A32'; // Strange orange

const TIER_BASIC_GLYPH = '⭐'; // ⭐
const TIER_SPECIALIZED_GLYPH = '✨'; // ✨
/** A Basic killstreak has no sheen to borrow a colour from. */
const KILLSTREAK_NEUTRAL = '#9AA0A6';

/**
 * Sheens have an actual in-game colour, so the killstreak icon wears it. Keyed
 * by the partial sku the high-value scan stores (`sheensData` values).
 */
const SHEEN_COLORS: Record<string, string> = {
    'ks-1': '#C5B7A0', // Team Shine — team-coloured in game, neutral here
    'ks-2': '#E7B53B', // Deadly Daffodil
    'ks-3': '#CF7336', // Manndarin
    'ks-4': '#729E42', // Mean Green
    'ks-5': '#12A02C', // Agonizing Emerald
    'ks-6': '#A54EB0', // Villainous Violet
    'ks-7': '#FF69B4' // Hot Rod
};

/** Chosen for distinct silhouettes — that is all that survives at ~18 logical px. */
const KILLSTREAKER_GLYPHS: Record<string, string> = {
    'ke-2002': '\u{1F525}', // Fire Horns 🔥
    'ke-2003': '⚡', // Cerebral Discharge ⚡
    'ke-2004': '\u{1F32A}', // Tornado 🌪
    'ke-2005': '♨', // Flames ♨
    'ke-2006': '\u{1F4AB}', // Singularity 💫
    'ke-2007': '\u{1F4A5}', // Incinerator 💥
    'ke-2008': '\u{1F300}' // Hypno-Beam 🌀
};

/** Sixteen spells, six shapes — see spellKind(). */
const SPELL_GLYPHS: Record<string, string> = {
    's-1004': '\u{1F3A8}', // the five paint spells 🎨
    's-1005': '\u{1F463}', // the seven footprints 👣
    's-1006': '\u{1F50A}', // Voices from Below 🔊
    's-1007': '\u{1F383}', // Pumpkin Bombs 🎃
    's-1008': '\u{1F525}', // Halloween Fire 🔥
    's-1009': '\u{1F47B}' // Exorcism 👻
};

const SPELL_COLORS: Record<string, string> = {
    's-1006': '#7EA9D1', // Voices from Below — the spell's own description colour
    's-1007': '#D8741E', // Pumpkin Bombs — pumpkin orange
    's-1008': '#32CD32', // Halloween Fire — burns green in game, and separates it from Pumpkin Bombs
    's-1009': '#D6E4D0' // Exorcism — pale green-white
};

/**
 * The paint spells all share the 🎨 glyph, so colour is their only
 * discriminator. Each cycles through several hues in game; the one picked here
 * is the phase that is most recognisable *and* furthest from its neighbours.
 */
const PAINT_SPELL_COLORS: Record<string, string> = {
    's-1004-0': '#E7B53B', // Die Job — its Australium-gold phase; the blue phase would collide with Voices
    's-1004-1': '#7D4071', // Chromatic Corruption — A Deep Commitment to Purple, its stated resemblance
    's-1004-2': '#729E42', // Putrescent Pigmentation — mid-range green, away from Sinister's olive
    's-1004-3': '#C43A2E', // Spectral Spectrum — the RED team's deep-red end. Team is not knowable from
    //                        the sku, so one phase has to stand in for both.
    's-1004-4': '#808000' // Sinister Staining — Drably Olive, its stated resemblance
};

/** Spell purple, for anything with no colour of its own — Team Spirit and Headless Horseshoes carry an index, not a colour. */
const SPELL_FALLBACK = '#8650AC';

/** Paint suffixes are a pricing concept; tiles are keyed by the art sku. */
export function stripPaint(sku: string): string {
    return sku.replace(/;p\d+/, '');
}

function hexFromValue(value: number): string | undefined {
    if (!Number.isFinite(value) || value < 0 || value > 0xffffff) {
        return undefined;
    }

    return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * `p5801378` → `#5885A2`. The number the schema stores for a paint *is* its RGB
 * value, so no lookup table is needed to draw the swatch — only to name it.
 */
function paintHex(partialSku: string): string | undefined {
    return hexFromValue(Number.parseInt(partialSku.replace('p', ''), 10));
}

/**
 * Footprint spells encode their own paint in the trailing number, the same way
 * a paint does — but `s-1005-1` and `s-1005-2` are plain indices, so only a
 * value too large to be an index is treated as a colour.
 */
function footprintColor(partialSku: string): string {
    const value = Number.parseInt(partialSku.split('-')[2], 10);
    return (value > 0xffff && hexFromValue(value)) || SPELL_FALLBACK;
}

/** `s-1005-8421376` → `s-1005`: every spell sharing a defindex is the same kind of effect. */
function spellKind(partialSku: string): string {
    return partialSku.split('-').slice(0, 2).join('-');
}

function spellColor(partialSku: string): string {
    const kind = spellKind(partialSku);

    if (kind === 's-1004') {
        return PAINT_SPELL_COLORS[partialSku] ?? SPELL_FALLBACK;
    }

    if (kind === 's-1005') {
        return footprintColor(partialSku);
    }

    return SPELL_COLORS[kind] ?? SPELL_FALLBACK;
}

function keysOf(map: Record<string, boolean> | undefined): string[] {
    return map ? Object.keys(map).filter(key => key !== 'undefined') : [];
}

/**
 * Index one side of a trade's attributes, keyed by the sku its tile was built from.
 *
 * `items` is the map the high-value scan writes to `offer.data('highValue')`.
 * That scan records *every* attachment it finds, not only the ones the owner
 * asked to be alerted about, so it doubles as a complete attribute index — with
 * one blind spot, handled in `buildTileAttributes`.
 */
export function collectScanned(items: Record<string, ItemAttributes> | undefined): ScannedMap {
    const scanned: ScannedMap = {};

    if (!items) {
        return scanned;
    }

    for (const priceKey of Object.keys(items)) {
        const attributes = items[priceKey];
        const spells = keysOf(attributes.s).sort((a, b) => a.localeCompare(b));
        const paint = keysOf(attributes.p)[0];

        const entry: ScannedAttributes = {
            spells,
            hasParts: keysOf(attributes.sp).length > 0,
            sheen: keysOf(attributes.ks)[0],
            killstreaker: keysOf(attributes.ke)[0],
            paint: paint ? paintHex(paint) : undefined
        };

        // Several painted variants of one item collapse onto a single tile; the
        // first to claim the slot keeps it rather than the attributes stacking.
        const key = stripPaint(priceKey);
        if (!scanned[key] && Object.values(entry).some(v => (Array.isArray(v) ? v.length > 0 : Boolean(v)))) {
            scanned[key] = entry;
        }
    }

    return scanned;
}

/**
 * The killstreak tier has to come from the sku, not from the scan.
 *
 * `Inventory.highValue()` works by reading an item's Steam descriptions, and a
 * Basic killstreak weapon has no `Sheen:` or `Killstreaker:` line — so if it
 * carries no spell, part or paint either, it never enters the high-value map at
 * all. The sku always knows.
 */
function killstreakTier(sku: string): number {
    if (!testPriceKey(sku)) {
        return 0;
    }

    try {
        return SKU.fromString(sku).killstreak ?? 0;
    } catch (err) {
        return 0;
    }
}

function killstreakIcon(sku: string, scanned: ScannedAttributes | undefined): AttributeIcon | undefined {
    const sheen = scanned?.sheen;
    const killstreaker = scanned?.killstreaker;

    // A sku missing its `kt-` part but carrying a scanned effect still deserves
    // the icon; infer the tier the effect implies.
    const tier = killstreakTier(sku) || (killstreaker ? 3 : sheen ? 2 : 0);

    if (tier === 0) {
        return undefined;
    }

    const color = (sheen && SHEEN_COLORS[sheen]) || KILLSTREAK_NEUTRAL;

    // Star → sparkles → effect reads as an escalating tier before the colour
    // even registers. A Professional whose killstreaker the scan somehow missed
    // falls back to the Specialized shape rather than drawing nothing.
    const glyph =
        tier >= 3
            ? KILLSTREAKER_GLYPHS[killstreaker] ?? TIER_SPECIALIZED_GLYPH
            : tier === 2
            ? TIER_SPECIALIZED_GLYPH
            : TIER_BASIC_GLYPH;

    return { slot: 'killstreak', glyph, color };
}

/**
 * The finished icon set for one tile, merging the tier parsed from `sku` with
 * whatever the scan found. Returns undefined when there is nothing to draw.
 */
export function buildTileAttributes(sku: string, scanned?: ScannedAttributes): TileAttributes | undefined {
    const icons: AttributeIcon[] = [];

    const killstreak = killstreakIcon(sku, scanned);
    if (killstreak) {
        icons.push(killstreak);
    }

    if (scanned?.hasParts) {
        icons.push({ slot: 'parts', glyph: PARTS_GLYPH, color: PARTS_COLOR });
    }

    // Two slots is the game's own ceiling: an item carries at most one
    // paint-family spell and one effect spell.
    (scanned?.spells ?? []).slice(0, 2).forEach((partialSku, i) => {
        const glyph = SPELL_GLYPHS[spellKind(partialSku)];

        if (glyph) {
            icons.push({ slot: i === 0 ? 'spell1' : 'spell2', glyph, color: spellColor(partialSku) });
        }
    });

    if (icons.length === 0 && !scanned?.paint) {
        return undefined;
    }

    return { icons, paint: scanned?.paint };
}
