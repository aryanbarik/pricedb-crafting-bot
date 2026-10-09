import { TradeOffer, ItemsDict, OurTheirItemsDict, ItemsValue } from '@tf2autobot/tradeoffer-manager';
import Bot from '../../classes/Bot';
import SKU from '@tf2autobot/tf2-sku';
import { ValueDiff, replace, testPriceKey } from '../tools/export';

export const pureEmoji = new Map<string, string>();
pureEmoji
    .set('5021;6', '<:tf2key:813050393793658930>')
    .set('5002;6', '<:tf2refined:813050808605212672>')
    .set('5001;6', '<:tf2reclaimed:813048057352421417>')
    .set('5000;6', '<:tf2scrap:813048057577996348>');

export interface NetOverpay {
    /** Positive when the partner overpaid us, negative when we underpaid. */
    scrap: number;
    keyRate: number;
}

/**
 * How far the trade landed either side of even, in scrap.
 *
 * Returns null when the offer carries no value data at all — admin trades and
 * gifts, where "profit" is not a meaningful figure.
 */
export function getNetOverpay(offer: TradeOffer, bot: Bot): NetOverpay | null {
    const tradeValue = offer.data('value') as ItemsValue | undefined;
    if (!tradeValue) {
        return null;
    }

    return {
        scrap: (tradeValue.their?.total ?? 0) - (tradeValue.our?.total ?? 0),
        keyRate: tradeValue.rate ?? bot.pricelist.getKeyPrice.metal
    };
}

/**
 * Overpay only reads as profit on an offer we received and accepted. On offers
 * the bot itself constructed, the two sides are our own numbers on both ends.
 */
export function isNetOverpayRelevant(type: string, isOfferSent: boolean | undefined): boolean {
    return ['summary-accepted', 'review-admin'].includes(type) && !isOfferSent;
}

/**
 * The `3 → 2/5` note that follows an item in a summary.
 *
 * The direction is the non-obvious part. By the time a `summary-accepted` is
 * built the inventory *already reflects the completed trade*, so the reported
 * stock is the new one and the old is reconstructed from it — `current + amount`
 * for what we gave away, `current - amount` for what came in. An in-process
 * summary is the mirror image: the reported stock is the old one and the new is
 * projected. Any other type describes no change and gets a bare count.
 */
export function stockChangeText(bot: Bot, priceKey: string, which: string, type: string, amount: number): string {
    const entry = bot.pricelist.getPriceBySkuOrAsset({ priceKey, onlyEnabled: false });
    const currentStock = bot.inventoryManager.getInventory.getAmount({
        priceKey,
        includeNonNormalized: true,
        tradableOnly: true
    });

    const accepted = type === 'summary-accepted';
    const inProcess = ['review-admin', 'summary-accepting', 'summary-countering'].includes(type);

    const ours = which === 'our';
    const direction = ours ? 1 : -1;
    const oldStock = accepted ? currentStock + direction * amount : currentStock;
    const newStock = inProcess ? currentStock - direction * amount : currentStock;

    const limit = entry ? `/${entry.max}` : '';

    const transition = accepted || inProcess ? `${oldStock} → ` : '';
    return `${transition}${newStock}${limit}`;
}

export function summarizeToChat(
    offer: TradeOffer,
    bot: Bot,
    type: SummarizeType,
    withLink: boolean,
    value: ValueDiff,
    isSteamChat: boolean,
    isOfferSent: boolean | undefined = undefined,
    isAcceptedWithEscrow: boolean | undefined = undefined
): string {
    const generatedSummary = summarize(offer, bot, type, withLink);

    const cT = bot.options.tradeSummary.customText;
    const cTSummary = isSteamChat
        ? cT.summary.steamChat
            ? cT.summary.steamChat
            : 'Summary'
        : cT.summary.discordWebhook
        ? cT.summary.discordWebhook
        : '__**Summary**__';

    const cTAsked = isSteamChat
        ? cT.asked.steamChat
            ? cT.asked.steamChat
            : '• Asked:'
        : cT.asked.discordWebhook
        ? cT.asked.discordWebhook
        : '**• Asked:**';

    const cTOffered = isSteamChat
        ? cT.offered.steamChat
            ? cT.offered.steamChat
            : '• Offered:'
        : cT.offered.discordWebhook
        ? cT.offered.discordWebhook
        : '**• Offered:**';

    const cTProfit = isSteamChat
        ? cT.profitFromOverpay.steamChat
            ? cT.profitFromOverpay.steamChat
            : '📈 Profit from overpay:'
        : cT.profitFromOverpay.discordWebhook
        ? cT.profitFromOverpay.discordWebhook
        : '📈 ***Profit from overpay:***';

    const cTLoss = isSteamChat
        ? cT.lossFromUnderpay.steamChat
            ? cT.lossFromUnderpay.steamChat
            : '📉 Loss from underpay:'
        : cT.lossFromUnderpay.discordWebhook
        ? cT.lossFromUnderpay.discordWebhook
        : '📉 ***Loss from underpay:***';

    const isCountered = offer.data('processCounterTime') !== undefined;
    const reply =
        `\n\n${cTSummary}${
            isOfferSent !== undefined
                ? ` (${isOfferSent ? 'chat' : `offer${isCountered ? ' - countered' : ''}`})${isAcceptedWithEscrow ? ' - Trade Hold' : ''}`
                : ''
        }\n` +
        `${cTAsked} ${generatedSummary.asked}` +
        `\n${cTOffered} ${generatedSummary.offered}` +
        '\n──────────────────────' +
        (['summary-accepted', 'review-admin'].includes(type) && !isOfferSent
            ? value.diff > 0
                ? `\n${cTProfit} ${value.diffRef} ref` + (value.diffRef >= value.rate ? ` (${value.diffKey})` : '')
                : value.diff < 0
                ? `\n${cTLoss} ${value.diffRef} ref` + (value.diffRef >= value.rate ? ` (${value.diffKey})` : '')
                : ''
            : '');

    return reply;
}

type SummarizeType =
    | 'summary-accepted'
    | 'declined'
    | 'review-partner'
    | 'review-admin'
    | 'summary-accepting'
    | 'summary-countering';

import Currencies from '@tf2autobot/tf2-currencies';

export default function summarize(
    offer: TradeOffer,
    bot: Bot,
    type: SummarizeType,
    withLink: boolean
): { asked: string; offered: string } {
    const value = offer.data('value') as ItemsValue;
    const items = (offer.data('dict') as ItemsDict) || { our: null, their: null };
    const showStockChanges = bot.options.tradeSummary.showStockChanges;

    const ourCount = items.our ? Object.keys(items.our).length : 0;
    const theirCount = items.their ? Object.keys(items.their).length : 0;

    const isCompressSummary = (ourCount > 15 && theirCount > 15) || ourCount + theirCount > 28; // Estimate until limit reached

    if (!value) {
        // If trade with ADMINS or Gift
        return {
            asked: getSummary(items.our, bot, 'our', type, withLink, showStockChanges, isCompressSummary),
            offered: getSummary(items.their, bot, 'their', type, withLink, showStockChanges, isCompressSummary)
        };
    } else {
        // If trade with trade partner
        const opening = showStockChanges ? '〚' : ' (';
        const closing = showStockChanges ? '〛' : ')';
        return {
            asked:
                `${new Currencies(value.our).toString()}` +
                `${opening}${getSummary(
                    items.our,
                    bot,
                    'our',
                    type,
                    withLink,
                    showStockChanges,
                    isCompressSummary
                )}${closing}`,
            offered:
                `${new Currencies(value.their).toString()}` +
                `${opening}${getSummary(
                    items.their,
                    bot,
                    'their',
                    type,
                    withLink,
                    showStockChanges,
                    isCompressSummary
                )}${closing}`
        };
    }
}

function getSummary(
    dict: OurTheirItemsDict,
    bot: Bot,
    which: string,
    type: string,
    withLink: boolean,
    showStockChanges: boolean,
    isCompressSummary: boolean
): string {
    if (dict === null) {
        return 'unknown items';
    }

    const summary: string[] = [];
    const properName = bot.options.tradeSummary.showProperName;

    for (const priceKey in dict) {
        if (!Object.prototype.hasOwnProperty.call(dict, priceKey)) {
            continue;
        }

        const entry = bot.pricelist.getPriceBySkuOrAsset({ priceKey, onlyEnabled: false });
        const isTF2Items = testPriceKey(priceKey);

        // compatible with pollData from before v3.0.0 / before v2.2.0 and/or v3.0.0 or later ↓
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: Object is possibly 'null'.
        const amount = typeof dict[priceKey] === 'object' ? (dict[priceKey]['amount'] as number) : dict[priceKey];
        const sku =
            type === 'summary-accepted' ? (entry?.sku ?? priceKey).replace(/;p\d+/, '') : entry?.sku ?? priceKey;

        let generateName: string;
        if (isTF2Items) {
            try {
                const itemName = bot.schema.getName(SKU.fromString(sku), properName);
                generateName = itemName ? `${itemName}${entry?.id ? ` - ${entry.id}` : ''}` : priceKey;
            } catch (e) {
                // If SKU parsing fails or schema lookup fails, use priceKey
                generateName = priceKey;
            }
        } else {
            generateName = priceKey; // Non-TF2 items
        }
        const name = properName ? generateName : replace.itemName(generateName || 'unknown');

        if (showStockChanges) {
            // Extracted rather than inlined twice: the Discord trade summary
            // builds the same note from its own item list, and the two must not
            // be able to drift apart.
            const stock = stockChangeText(bot, priceKey, which, type, amount);

            if (withLink && isTF2Items) {
                summary.push(
                    `[${
                        bot.options.tradeSummary.showPureInEmoji
                            ? pureEmoji.has(sku)
                                ? pureEmoji.get(sku)
                                : name
                            : name
                    }](https://pricedb.io/item/${sku})${amount > 1 ? ` x${amount}` : ''} (${stock})`
                );
            } else {
                summary.push(
                    `${name}${amount > 1 ? ` x${amount}` : ''}${
                        ['review-partner', 'declined'].includes(type) ? '' : ` (${stock})`
                    }`
                );
            }
        } else {
            if (withLink && isTF2Items) {
                summary.push(
                    `[${
                        bot.options.tradeSummary.showPureInEmoji
                            ? pureEmoji.has(sku)
                                ? pureEmoji.get(sku)
                                : name
                            : name
                    }](https://pricedb.io/item/${sku})${amount > 1 ? ` x${amount}` : ''}`
                );
            } else {
                summary.push(name + (amount > 1 ? ` x${amount}` : ''));
            }
        }
    }

    const summaryCount = summary.length;

    if (summaryCount === 0) {
        return 'nothing';
    }

    if (withLink) {
        let left = 0;

        if (isCompressSummary) {
            if (summaryCount > 15) {
                left = summaryCount - 15;
                summary.splice(15);
            }
        }

        return summary.join(', ') + (left > 0 ? ` and ${left} more items.` : '');
    } else {
        return summary.join(', ');
    }
}
