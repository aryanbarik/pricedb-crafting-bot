import axios from 'axios';
import { createCanvas } from '@napi-rs/canvas';

import { CARD_BG, CARD_BORDER, FONT_SEMIBOLD, roundedRect } from './cardCanvas';
import { registerTradeCardFonts } from './renderTradeCard';

interface HistoryPoint {
    time: number;
    buy: { keys: number; metal: number };
    sell: { keys: number; metal: number };
}

const WIDTH = 960;
const HEIGHT = 360;
const PAD = 56;
const BUY = '#00C896';
const SELL = '#FF4D4F';
const PLOT_BG = '#202D40';
const GRID = 'rgba(151, 169, 194, 0.12)';

/** Draw the latest 15 PriceDB buy/sell records in current-rate ref equivalent. */
export default async function renderSkuChart(sku: string, keyRate: number): Promise<Buffer | null> {
    try {
        const response = await axios.get<HistoryPoint[]>(
            `https://pricedb.io/api/item-history/${encodeURIComponent(sku)}`,
            {
                timeout: 5000
            }
        );
        const history = response.data.filter(point => Number.isFinite(point.time)).slice(-15);
        if (history.length === 0) return null;

        registerTradeCardFonts();
        const values = history.flatMap(point => [
            point.buy.keys * keyRate + point.buy.metal,
            point.sell.keys * keyRate + point.sell.metal
        ]);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const first = history[0].time;
        const last = history[history.length - 1].time;
        const span = last - first || 1;
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, WIDTH, HEIGHT, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();
        const plot = { x: PAD + 40, y: 26, width: WIDTH - PAD - 56, height: HEIGHT - 82 };
        ctx.fillStyle = PLOT_BG;
        ctx.fillRect(plot.x, plot.y, plot.width, plot.height);

        for (let i = 0; i <= 4; i++) {
            const y = plot.y + (plot.height * i) / 4;
            const value = max - (range * i) / 4;
            ctx.strokeStyle = GRID;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(plot.x, y);
            ctx.lineTo(plot.x + plot.width, y);
            ctx.stroke();
            ctx.fillStyle = '#B8BEC9';
            ctx.textAlign = 'left';
            ctx.fillText(`${value.toFixed(2)} ref`, 10, y + 5);
        }

        for (let i = 0; i <= 5; i++) {
            const x = plot.x + (plot.width * i) / 5;
            const time = new Date((first + (span * i) / 5) * 1000);
            ctx.strokeStyle = GRID;
            ctx.beginPath();
            ctx.moveTo(x, plot.y);
            ctx.lineTo(x, plot.y + plot.height);
            ctx.stroke();
            ctx.fillStyle = '#9AA9BE';
            ctx.textAlign = 'center';
            ctx.fillText(
                `${time.getDate().toString().padStart(2, '0')}/${(time.getMonth() + 1).toString().padStart(2, '0')}`,
                x,
                HEIGHT - 22
            );
        }

        const pointAt = (point: HistoryPoint, value: (point: HistoryPoint) => number): [number, number] => [
            plot.x + ((point.time - first) / span) * plot.width,
            plot.y + ((max - value(point)) / range) * plot.height
        ];
        const drawLine = (color: string, value: (point: HistoryPoint) => number): void => {
            ctx.fillStyle = `${color}22`;
            ctx.beginPath();
            history.forEach((point, index) => {
                const [x, y] = pointAt(point, value);
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            const [lastX] = pointAt(history[history.length - 1], value);
            const [firstX] = pointAt(history[0], value);
            ctx.lineTo(lastX, plot.y + plot.height);
            ctx.lineTo(firstX, plot.y + plot.height);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            history.forEach((point, index) => {
                const [x, y] = pointAt(point, value);
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        };
        drawLine(BUY, point => point.buy.keys * keyRate + point.buy.metal);
        drawLine(SELL, point => point.sell.keys * keyRate + point.sell.metal);
        ctx.font = `16px ${FONT_SEMIBOLD}`;
        ctx.fillStyle = BUY;
        ctx.textAlign = 'left';
        ctx.fillText('● Buy Price', plot.x, 18);
        ctx.fillStyle = SELL;
        ctx.fillText('● Sell Price', plot.x + 100, 18);
        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
