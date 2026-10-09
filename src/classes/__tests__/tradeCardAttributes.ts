import { buildTileAttributes, collectScanned, ScannedAttributes } from '../DiscordWebhook/tradeCard/itemAttributes';

/** Shorthand: what `buildTileAttributes` drew, as `slot → colour`. */
function slots(sku: string, scanned?: ScannedAttributes): Record<string, string> {
    const attributes = buildTileAttributes(sku, scanned);
    const map: Record<string, string> = {};

    for (const icon of attributes?.icons ?? []) {
        map[icon.slot] = icon.color;
    }

    return map;
}

function glyphs(sku: string, scanned?: ScannedAttributes): Record<string, string> {
    const attributes = buildTileAttributes(sku, scanned);
    const map: Record<string, string> = {};

    for (const icon of attributes?.icons ?? []) {
        map[icon.slot] = icon.glyph;
    }

    return map;
}

describe('collectScanned', () => {
    it('returns nothing when there is no high value data', () => {
        expect(collectScanned(undefined)).toEqual({});
        expect(collectScanned({})).toEqual({});
    });

    it('reads every attribute family off one item', () => {
        const scanned = collectScanned({
            '378;5;u13': {
                s: { 's-1009-1': true },
                sp: { 'sp-13': false },
                ks: { 'ks-3': true },
                ke: { 'ke-2004': false },
                p: { p5322826: false }
            }
        });

        expect(scanned['378;5;u13']).toEqual({
            spells: ['s-1009-1'],
            hasParts: true,
            sheen: 'ks-3',
            killstreaker: 'ke-2004',
            // 5322826 === 0x51384A (Violent Violet) — the sku suffix *is* the RGB triple.
            paint: '#51384a'
        });
    });

    it('sorts spells so a re-render never shuffles the slots', () => {
        const scanned = collectScanned({
            '199;11': { s: { 's-1007-1': true, 's-1004-3': true } }
        });

        expect(scanned['199;11'].spells).toEqual(['s-1004-3', 's-1007-1']);
    });

    it('keys by the art sku so a painted variant lands on its tile', () => {
        const scanned = collectScanned({ '199;11;p5322826': { s: { 's-1009-1': true } } });

        expect(Object.keys(scanned)).toEqual(['199;11']);
    });

    it('ignores an item whose attribute maps are all empty', () => {
        expect(collectScanned({ '199;11': { s: {}, sp: {}, isFull: true } })).toEqual({});
    });

    it('drops a paint value that is not a colour', () => {
        expect(collectScanned({ '199;11': { p: { pnope: true } } })).toEqual({});
    });
});

describe('buildTileAttributes — killstreak tier', () => {
    // The tier lives in the sku, not in the scan: a Basic killstreak weapon has
    // no Sheen or Killstreaker description line, so it may never reach the scan
    // at all.
    it('stars a Basic killstreak the scan never saw', () => {
        expect(glyphs('199;11;kt-1')).toEqual({ killstreak: '⭐' });
        expect(slots('199;11;kt-1')).toEqual({ killstreak: '#9AA0A6' });
    });

    it('sparkles a Specialized killstreak and tints it with the sheen', () => {
        const scanned: ScannedAttributes = { spells: [], hasParts: false, sheen: 'ks-3' };

        expect(glyphs('199;11;kt-2', scanned)).toEqual({ killstreak: '✨' });
        expect(slots('199;11;kt-2', scanned)).toEqual({ killstreak: '#CF7336' });
    });

    it('draws the killstreaker itself for Professional', () => {
        const scanned: ScannedAttributes = {
            spells: [],
            hasParts: false,
            sheen: 'ks-6',
            killstreaker: 'ke-2004'
        };

        // Tornado, in Villainous Violet.
        expect(glyphs('199;11;kt-3', scanned)).toEqual({ killstreak: '\u{1F32A}' });
        expect(slots('199;11;kt-3', scanned)).toEqual({ killstreak: '#A54EB0' });
    });

    it('falls back to the Specialized shape when a Professional’s killstreaker is missing', () => {
        const scanned: ScannedAttributes = { spells: [], hasParts: false, sheen: 'ks-2' };

        expect(glyphs('199;11;kt-3', scanned)).toEqual({ killstreak: '✨' });
    });

    it('infers the tier from the scan when the sku carries no kt part', () => {
        expect(glyphs('199;11', { spells: [], hasParts: false, sheen: 'ks-1' })).toEqual({ killstreak: '✨' });
        expect(glyphs('199;11', { spells: [], hasParts: false, killstreaker: 'ke-2002' })).toEqual({
            killstreak: '\u{1F525}'
        });
    });

    it('draws no killstreak icon for a plain item', () => {
        expect(buildTileAttributes('199;11')).toBeUndefined();
        expect(buildTileAttributes('199;11', { spells: [], hasParts: false })).toBeUndefined();
    });

    it('survives a sku it cannot parse, keeping what the scan did find', () => {
        expect(buildTileAttributes('not-a-sku', { spells: [], hasParts: false, paint: '#51384a' })).toEqual({
            icons: [],
            paint: '#51384a'
        });
    });
});

describe('buildTileAttributes — slots', () => {
    it('puts each attribute family in its own fixed slot', () => {
        const attributes = buildTileAttributes('199;11;kt-3', {
            spells: ['s-1004-3', 's-1009-1'],
            hasParts: true,
            sheen: 'ks-3',
            killstreaker: 'ke-2002',
            paint: '#51384a'
        });

        expect(attributes.icons.map(i => i.slot)).toEqual(['killstreak', 'parts', 'spell1', 'spell2']);
        expect(attributes.paint).toBe('#51384a');
    });

    it('leaves a slot empty rather than letting its neighbours slide over', () => {
        const attributes = buildTileAttributes('199;11', { spells: ['s-1009-1'], hasParts: false });

        expect(attributes.icons.map(i => i.slot)).toEqual(['spell1']);
    });

    it('caps at the two spells the game itself allows', () => {
        const attributes = buildTileAttributes('199;11', {
            spells: ['s-1004-0', 's-1007-1', 's-1009-1'],
            hasParts: false
        });

        expect(attributes.icons).toHaveLength(2);
        expect(attributes.icons.map(i => i.glyph)).toEqual(['\u{1F3A8}', '\u{1F383}']);
    });

    it('draws a paint swatch on an item with nothing else', () => {
        expect(buildTileAttributes('199;11', { spells: [], hasParts: false, paint: '#ffffff' })).toEqual({
            icons: [],
            paint: '#ffffff'
        });
    });

    it('ignores a spell defindex it has no icon for', () => {
        expect(buildTileAttributes('199;11', { spells: ['s-9999-1'], hasParts: false })).toBeUndefined();
    });
});

describe('buildTileAttributes — spell colours', () => {
    function spellColor(partialSku: string): string {
        return buildTileAttributes('199;11', { spells: [partialSku], hasParts: false }).icons[0].color;
    }

    it('gives each paint spell its own hue, since they share the palette glyph', () => {
        expect(spellColor('s-1004-0')).toBe('#E7B53B'); // Die Job
        expect(spellColor('s-1004-1')).toBe('#7D4071'); // Chromatic Corruption
        expect(spellColor('s-1004-2')).toBe('#729E42'); // Putrescent Pigmentation
        expect(spellColor('s-1004-3')).toBe('#C43A2E'); // Spectral Spectrum
        expect(spellColor('s-1004-4')).toBe('#808000'); // Sinister Staining
    });

    it('reads a footprint’s colour out of its own partial sku', () => {
        // 5322826 === 0x51384A (Violent Violet Footprints).
        expect(spellColor('s-1005-5322826')).toBe('#51384a');
        expect(spellColor('s-1005-8421376')).toBe('#808000'); // Gangreen
    });

    it('treats a small trailing number as an index, not a colour', () => {
        // Team Spirit and Headless Horseshoes are numbered, not painted.
        expect(spellColor('s-1005-1')).toBe('#8650AC');
        expect(spellColor('s-1005-2')).toBe('#8650AC');
    });

    it('colours the fixed-hue spells', () => {
        expect(spellColor('s-1006-1')).toBe('#7EA9D1'); // Voices from Below
        expect(spellColor('s-1007-1')).toBe('#D8741E'); // Pumpkin Bombs
        expect(spellColor('s-1008-1')).toBe('#32CD32'); // Halloween Fire — it burns green
        expect(spellColor('s-1009-1')).toBe('#D6E4D0'); // Exorcism
    });
});
