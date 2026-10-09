import { createCanvas } from '@napi-rs/canvas';

import {
    CARD_BG,
    CARD_BORDER,
    drawIcon,
    FONT_REGULAR,
    FONT_SEMIBOLD,
    PILL_TEXT,
    roundedRect,
    TILE_FILL
} from './cardCanvas';
import { getItemIcon } from './itemImageCache';
import { registerTradeCardFonts } from './renderTradeCard';

export default async function renderRateCard(
    buy: string,
    sell: string,
    source: string,
    accountName: string
): Promise<Buffer | null> {
    try {
        registerTradeCardFonts();
        const icon = await getItemIcon('5021;6', accountName);
        const canvas = createCanvas(720, 190);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, 720, 190, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();
        roundedRect(ctx, 22, 22, 146, 146, 16);
        ctx.fillStyle = TILE_FILL;
        ctx.fill();
        drawIcon(ctx, icon, 42, 42, 106);
        ctx.fillStyle = PILL_TEXT;
        ctx.font = `28px ${FONT_SEMIBOLD}`;
        ctx.fillText('KEY RATE', 194, 55);
        ctx.font = `22px ${FONT_REGULAR}`;
        ctx.fillText(`Buy  ${buy}`, 194, 96);
        ctx.fillText(`Sell  ${sell}`, 194, 130);
        ctx.fillStyle = '#B8BEC9';
        ctx.font = `18px ${FONT_REGULAR}`;
        ctx.fillText(`Source  ${source}`, 194, 158);
        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
