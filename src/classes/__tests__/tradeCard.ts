import { createCanvas } from '@napi-rs/canvas';
import { isValidPng } from '../DiscordWebhook/tradeCard/itemImageCache';
import { selectTiles } from '../DiscordWebhook/tradeCard/renderTradeCard';

function realPng(): Buffer {
    const canvas = createCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 8);
    return canvas.toBuffer('image/png');
}

/**
 * sku.pricedb.io answers 200 OK for everything, so these guards are the only
 * thing standing between a bad sku and a corrupt tile. The HTML fixture is the
 * shape of the real response for `160;11;australium`.
 */
describe('isValidPng', () => {
    const html = Buffer.from('<!DOCTYPE html><html><head><title>PriceDB</title></head><body></body></html>');

    it('accepts a real PNG served as image/png', () => {
        expect(isValidPng(realPng(), 'image/png')).toBe(true);
    });

    it('tolerates charset parameters on the content type', () => {
        expect(isValidPng(realPng(), 'image/png; charset=binary')).toBe(true);
        expect(isValidPng(realPng(), 'IMAGE/PNG')).toBe(true);
    });

    it('rejects the HTML homepage pricedb.io returns for an unknown sku', () => {
        expect(isValidPng(html, 'text/html; charset=utf-8')).toBe(false);
    });

    it('rejects HTML even when the content type claims it is an image', () => {
        expect(isValidPng(html, 'image/png')).toBe(false);
    });

    it('rejects a real PNG served under a non-image content type', () => {
        expect(isValidPng(realPng(), 'text/html; charset=utf-8')).toBe(false);
    });

    it('rejects a missing content type', () => {
        expect(isValidPng(realPng(), undefined)).toBe(false);
    });

    it('rejects an empty body', () => {
        expect(isValidPng(Buffer.alloc(0), 'image/png')).toBe(false);
    });

    it('rejects a body over the 2 MB ceiling', () => {
        const oversized = Buffer.concat([realPng(), Buffer.alloc(2 * 1024 * 1024)]);
        expect(isValidPng(oversized, 'image/png')).toBe(false);
    });

    it('rejects a truncated buffer that cannot hold the magic bytes', () => {
        expect(isValidPng(Buffer.from([0x89, 0x50, 0x4e]), 'image/png')).toBe(false);
    });
});

describe('selectTiles', () => {
    const KEY = '5021;6';
    const REF = '5002;6';
    const REC = '5001;6';
    const SCRAP = '5000;6';

    // Unit worth in scrap; anything unlisted is worthless for ordering purposes.
    const values: { [sku: string]: number } = {
        '378;5;u13': 9000,
        '30769;5;u3013': 4000,
        '199;11;kt-3': 500,
        '5;6': 20
    };
    const valueOf = (sku: string): number => values[sku] ?? 0;

    it('reports an empty side rather than rendering a blank band', () => {
        expect(selectTiles({}, valueOf, 4)).toEqual([{ kind: 'empty' }]);
        expect(selectTiles(null, valueOf, 4)).toEqual([{ kind: 'empty' }]);
    });

    it('orders items by unit value so the headline item always earns a slot', () => {
        const tiles = selectTiles({ '5;6': 1, '378;5;u13': 1, '199;11;kt-3': 1 }, valueOf, 4);
        expect(tiles.map(t => t.sku)).toEqual(['378;5;u13', '199;11;kt-3', '5;6']);
    });

    it('collapses each pure currency into one tile and puts them after the items', () => {
        const tiles = selectTiles({ [REF]: 11, [KEY]: 2, '378;5;u13': 1 }, valueOf, 4);
        expect(tiles.map(t => t.sku)).toEqual(['378;5;u13', KEY, REF]);
        expect(tiles.map(t => t.amount)).toEqual([1, 2, 11]);
    });

    it('orders pure key → ref → rec → scrap', () => {
        const tiles = selectTiles({ [SCRAP]: 1, [REC]: 2, [REF]: 3, [KEY]: 4 }, valueOf, 4);
        expect(tiles.map(t => t.sku)).toEqual([KEY, REF, REC, SCRAP]);
    });

    it('spends the last slot on an overflow chip counting hidden skus, not quantities', () => {
        const tiles = selectTiles(
            { '378;5;u13': 1, '30769;5;u3013': 1, '199;11;kt-3': 1, '5;6': 3, [KEY]: 2 },
            valueOf,
            4
        );
        expect(tiles).toHaveLength(4);
        expect(tiles.slice(0, 3).map(t => t.sku)).toEqual(['378;5;u13', '30769;5;u3013', '199;11;kt-3']);
        // `5;6` and the key did not fit: two skus, five physical items. The chip
        // reports two, matching the item list under the card.
        expect(tiles[3]).toEqual({ kind: 'overflow', hidden: 2 });
    });

    it('does not add an overflow chip when the items exactly fill the slots', () => {
        const tiles = selectTiles({ '378;5;u13': 1, '199;11;kt-3': 1, '5;6': 1, [KEY]: 1 }, valueOf, 4);
        expect(tiles).toHaveLength(4);
        expect(tiles.every(t => t.kind === 'item')).toBe(true);
    });

    it('reads the pre-v3.0.0 poll data shape where the amount was an object', () => {
        const legacy = { '378;5;u13': { amount: 3 } } as never;
        const tiles = selectTiles(legacy, valueOf, 4);
        expect(tiles).toEqual([{ kind: 'item', sku: '378;5;u13', amount: 3, quality: '5' }]);
    });

    it('skips entries with a non-positive amount', () => {
        const tiles = selectTiles({ '378;5;u13': 0, '199;11;kt-3': 2 }, valueOf, 4);
        expect(tiles.map(t => t.sku)).toEqual(['199;11;kt-3']);
    });

    it('falls back to the empty tile when every entry is skipped', () => {
        expect(selectTiles({ '378;5;u13': 0 }, valueOf, 4)).toEqual([{ kind: 'empty' }]);
    });

    it('extracts the SKU quality for the tile border', () => {
        const tiles = selectTiles({ '378;5;u13': 1, '199;11;kt-3': 1, [KEY]: 1 }, valueOf, 4);
        expect(tiles.map(t => t.quality)).toEqual(['5', '11', '6']);
    });

    it('strips the paint suffix, which the art endpoint does not understand', () => {
        const tiles = selectTiles({ '199;11;kt-3;p5801378': 1 }, valueOf, 4);
        expect(tiles[0].sku).toBe('199;11;kt-3');
    });

    it('leaves quality undefined for non-TF2 price keys instead of throwing', () => {
        const tiles = selectTiles({ 'some-asset-id': 1 }, valueOf, 4);
        expect(tiles[0].quality).toBeUndefined();
        expect(tiles[0].kind).toBe('item');
    });
});
