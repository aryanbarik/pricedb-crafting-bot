import Bot from '../Bot';
import { cardLabel } from '../DiscordWebhook/tradeCard/renderTradeCard';
import { collectStatReadings, StatMeta } from '../DiscordWebhook/tradeCard/offerFacts';

// Real canvas module present; the tests here only touch the stat builders, so
// keep the bot minimal like tradeCardPreview's.

const KEY = '5021;6';

function meta(): StatMeta {
    return {
        timeTakenToComplete: 4200,
        timeTakenToProcessOrConstruct: 3200,
        timeTakenToCounterOffer: 2600,
        isOfferSent: false
    };
}

function makeBot(t: { detailed?: boolean; showMs?: boolean }): Bot {
    const keyPrice = { keys: 0, metal: 60 };
    return {
        options: {
            tradeSummary: {
                showDetailedTimeTaken: t.detailed ?? true,
                showTimeTakenInMS: t.showMs === true
            },
            discordWebhook: { tradeSummary: { misc: { showKeyRate: true, showPureStock: true, showInventory: true } } }
        },
        pricelist: {
            getKeyPrice: { metal: 60 },
            getKeyPrices: { buy: keyPrice, sell: { keys: 0, metal: 61 }, src: 'ptf' },
            isUseCustomPricer: false,
            getPrice: () => null
        },
        handler: {
            autokeys: {
                isEnabled: true,
                getActiveStatus: true,
                getOverallStatus: { isBankingKeys: false, isBuyingKeys: true }
            }
        },
        tf2: { backpackSlots: 2500 },
        craftWeapons: [],
        schema: { getName: () => `Item ${KEY}` },
        inventoryManager: {
            getInventory: {
                getTotalItems: 1234,
                getCurrencies: () => ({
                    [KEY]: new Array(3).fill(''),
                    '5002;6': new Array(12).fill(''),
                    '5001;6': new Array(1).fill(''),
                    '5000;6': new Array(0).fill('')
                })
            }
        }
    } as unknown as Bot;
}

describe('collectStatReadings', () => {
    it('gates each reading on its own misc.* toggle', () => {
        const bot = makeBot({});
        const all = collectStatReadings(bot, meta());
        expect(all.map(r => r.kind)).toEqual(['keyRate', 'pureStock', 'totalItems', 'timeTaken']);

        expect(collectStatReadings(bot, meta()).slice(0, 4)).toHaveLength(4);
    });

    it('builds three time rows when detailed, one when not', () => {
        const detailed = collectStatReadings(makeBot({ detailed: true }), meta());
        const taken = detailed.find(r => r.kind === 'timeTaken');
        expect(taken?.kind).toBe('timeTaken');
        if (taken?.kind === 'timeTaken') {
            expect(taken.rows.map(([caption]) => caption)).toEqual(['To process', 'To counter', 'To complete']);
            // The raw ms is carried so the card and the text agree on it.
            expect(taken.rows[2][2]).toBe(4200);
            expect(taken.detailed).toBe(true);
        }

        const collapsed = collectStatReadings(makeBot({ detailed: false }), meta()).find(r => r.kind === 'timeTaken');
        if (collapsed?.kind === 'timeTaken') {
            expect(collapsed.rows.map(([caption]) => caption)).toEqual(['To complete']);
            expect(collapsed.detailed).toBe(false);
        }
    });

    it('omits time rows whose measurement is absent', () => {
        const taken = collectStatReadings(makeBot({}), {
            timeTakenToComplete: 4200
        }).find(r => r.kind === 'timeTaken');
        if (taken?.kind === 'timeTaken') {
            expect(taken.rows.map(([caption]) => caption)).toEqual(['To complete']);
        }
    });

    it('flags showMs for the card to render the exact count', () => {
        const taken = collectStatReadings(makeBot({ showMs: true }), meta()).find(r => r.kind === 'timeTaken');
        if (taken?.kind === 'timeTaken') {
            expect(taken.showMs).toBe(true);
            expect(taken.rows[0][2]).toBe(3200);
        }
    });
});

describe('cardLabel', () => {
    it('maps a customText label to card-safe caps', () => {
        expect(cardLabel('🔑 Key rate:', 'KEY RATE')).toBe('KEY RATE');
        expect(cardLabel('**My rate:**', 'KEY RATE')).toBe('MY RATE');
        expect(cardLabel('Total Items', 'TOTAL ITEMS')).toBe('TOTAL ITEMS');
        expect(cardLabel('key rate', 'KEY RATE')).toBe('KEY RATE');
    });

    it('strips markdown metacharacters and a trailing colon', () => {
        expect(cardLabel('**🔑 Key rate:**', 'KEY RATE')).toBe('KEY RATE');
        expect(cardLabel('~struck~ rate:', 'RATE')).toBe('STRUCK RATE');
    });

    it('falls back when nothing survives', () => {
        expect(cardLabel('🔑🔑🔑', 'KEY RATE')).toBe('KEY RATE');
        expect(cardLabel('', 'KEY RATE')).toBe('KEY RATE');
        expect(cardLabel('***', 'KEY RATE')).toBe('KEY RATE');
    });
});
