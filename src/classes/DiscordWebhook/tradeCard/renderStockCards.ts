import { createCanvas } from '@napi-rs/canvas';

import { StockCardEntry, stockCardPageCount as pageCount } from './cardRenderProtocol';
import { qualityColorHex } from '../../../lib/tools/qualityColor';
import { getItemIcon } from './itemImageCache';
import { registerTradeCardFonts } from './renderTradeCard';
import {
    CARD_BG,
    CARD_BORDER,
    drawCountPill,
    drawIcon,
    fitText,
    FONT_REGULAR,
    FONT_SEMIBOLD,
    PILL_TEXT,
    roundedRect,
    TILE_FILL
} from './cardCanvas';

export { StockCardEntry } from './cardRenderProtocol';

const WIDTH = 960;
const PADDING = 24;
const GAP = 16;
const TILE_HEIGHT = 176;
const HEADER_HEIGHT = 70;
const TILE_BORDER_FALLBACK = 'rgba(255, 255, 255, 0.18)';

export function stockCardBorderColor(sku: string): string {
    return qualityColorHex[sku.split(';')[1]] ?? TILE_BORDER_FALLBACK;
}

export function stockCardPages(entries: StockCardEntry[], pageSize = 20): StockCardEntry[][] {
    return Array.from({ length: Math.ceil(entries.length / pageSize) }, (_, page) =>
        entries.slice(page * pageSize, (page + 1) * pageSize)
    );
}

export function stockCardPageCount(entries: StockCardEntry[], pageSize = 20): number {
    return pageCount(entries, pageSize);
}

export async function renderStockCardPage(
    entries: StockCardEntry[],
    accountName: string,
    title: string,
    pageIndex: number,
    pageSize = 20,
    showQualityBorders = true
): Promise<Buffer | null> {
    const pages = stockCardPages(entries, pageSize);
    const page = pages[pageIndex];
    if (page === undefined) return null;

    try {
        registerTradeCardFonts();
        const images = await Promise.all(page.map(entry => getItemIcon(entry.sku, accountName)));
        const columns = pageSize <= 8 ? 2 : 4;
        const tileWidth = (WIDTH - PADDING * 2 - GAP * (columns - 1)) / columns;
        const detailed = pageSize <= 8;
        const rows = Math.ceil(page.length / columns);
        const height = HEADER_HEIGHT + PADDING + TILE_HEIGHT * rows + GAP * Math.max(rows - 1, 0) + PADDING;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, WIDTH, height, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = `26px ${FONT_SEMIBOLD}`;
        ctx.fillStyle = PILL_TEXT;
        ctx.textAlign = 'left';
        ctx.fillText(title.toUpperCase(), PADDING, 43);
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.fillStyle = '#B8BEC9';
        ctx.textAlign = 'right';
        ctx.fillText(`PAGE ${pageIndex + 1}/${pages.length} · ${entries.length} ITEMS`, WIDTH - PADDING, 42);

        page.forEach((entry, index) => {
            const column = index % columns;
            const row = Math.floor(index / columns);
            const x = PADDING + column * (tileWidth + GAP);
            const y = HEADER_HEIGHT + PADDING + row * (TILE_HEIGHT + GAP);
            roundedRect(ctx, x, y, tileWidth, TILE_HEIGHT, 16);
            ctx.fillStyle = TILE_FILL;
            ctx.fill();
            ctx.strokeStyle = showQualityBorders ? stockCardBorderColor(entry.sku) : CARD_BORDER;
            ctx.lineWidth = showQualityBorders ? 2.5 : 1.5;
            ctx.stroke();
            drawIcon(
                ctx,
                images[index],
                detailed ? x + 18 : x + (tileWidth - 112) / 2,
                detailed ? y + 38 : y + 30,
                detailed ? 100 : 112
            );
            ctx.font = `18px ${FONT_REGULAR}`;
            ctx.fillStyle = PILL_TEXT;
            ctx.textAlign = detailed ? 'left' : 'center';
            ctx.textBaseline = 'alphabetic';
            if (detailed) {
                ctx.fillText(`SKU ${entry.sku}`, x + 12, y + 24);
                ctx.fillText(fitText(ctx, entry.name, FONT_REGULAR, 18, tileWidth - 150), x + 132, y + 78);
            } else {
                ctx.fillText(
                    fitText(ctx, entry.name, FONT_REGULAR, 18, tileWidth - 24),
                    x + tileWidth / 2,
                    y + TILE_HEIGHT - 20
                );
            }
            if (detailed && entry.details) {
                ctx.font = `16px ${FONT_REGULAR}`;
                ctx.fillStyle = '#B8BEC9';
                ctx.fillText(fitText(ctx, entry.details, FONT_REGULAR, 16, tileWidth - 150), x + 132, y + 108);
            }
            drawCountPill(ctx, x, y, tileWidth, TILE_HEIGHT, entry.amount, 'top');
        });
        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
