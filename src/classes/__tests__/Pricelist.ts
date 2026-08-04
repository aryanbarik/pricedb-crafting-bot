import Pricelist, { Entry, EntryData } from '../Pricelist';
import SchemaManager from '@tf2autobot/tf2-schema';
import { DEFAULTS } from '../Options';
import Currencies from '@tf2autobot/tf2-currencies';
import genPaths from '../../resources/paths';
import { init } from '../../lib/logger';
import { getPricer } from '../../lib/pricer/pricer';
import * as Options from '../Options';

jest.mock('../../lib/pricer/custom/custom-pricer-api');

it('can pricecheck', async () => {
    const paths = genPaths('test');
    init(paths, { debug: true, debugFile: false });
    const prices = getPricer({ pricerUrl: 'http://test.com' });
    const schemaManager = new SchemaManager({});
    const priceList = new Pricelist(prices, schemaManager.schema, DEFAULTS);
    const isUseCustomPricer = priceList.isUseCustomPricer;
    expect(priceList.maxAge).toEqual(8 * 60 * 60);
    await priceList.setupPricelist();
    expect(priceList.getKeyPrices).toEqual({
        src: isUseCustomPricer ? 'customPricer' : 'ptf',
        time: 1608739762,
        buy: new Currencies({ keys: 0, metal: 55.11 }),
        sell: new Currencies({ keys: 0, metal: 55.22 })
    });
    expect(priceList.getKeyPrice).toEqual({
        keys: 0,
        metal: 55.22
    });
    expect(await priceList.getItemPrices('5021;6')).toEqual({
        sku: '5021;6',
        currency: null,
        source: 'bptf',
        time: 1608739762,
        buy: new Currencies({ keys: 0, metal: 55.11 }),
        sell: new Currencies({ keys: 0, metal: 55.22 })
    });
    expect(priceList.getLength).toEqual(0);
    expect(priceList.getPrices).toEqual({});
    expect(priceList.hasPrice({ priceKey: '5021;6' })).toEqual(false);
    expect(priceList.getPrice({ priceKey: '5021;6' })).toBeNull();
    // expect(priceList.searchByName('Mann Co. Supply Crate Key')).toBeNull();
});

describe('USD-only entries (Mannco.store)', () => {
    // An entry priced only in USD used to leave buy/sell null, which crashed Listings.getDetails
    // and — worse — the checkAll sort, which runs over the whole pricelist at startup and ignores
    // `enabled`, so one such entry stopped the bot booting entirely.
    const usdOnly = (extra: Partial<EntryData> = {}): Entry => {
        const data: EntryData = {
            sku: '30042;5;u56',
            enabled: false,
            autoprice: false,
            min: 0,
            max: 1,
            intent: 1,
            sellUsd: 2160,
            ...extra
        };

        // eslint's TS program resolves the Entry constructor as `any` here (tsc does not); the
        // annotation is the real type.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const entry: Entry = new Entry(data, 'Kill-a-Watt Platinum Pickelhaube');
        return entry;
    };

    it('substitutes placeholder metal prices instead of leaving nulls', () => {
        const entry = usdOnly();

        expect(entry.buy).not.toBeNull();
        expect(entry.sell).not.toBeNull();
        expect(entry.sellUsd).toEqual(2160);
    });

    it('never bids anything on the buy side', () => {
        // A non-zero placeholder here would be read as willingness to pay by offer valuation,
        // which is NOT gated by intent — the bot would give away the difference.
        expect(usdOnly().buy.toValue(60)).toEqual(0);
    });

    it('prices the sell side out of reach rather than at zero', () => {
        // A zero placeholder would list the item for free if the entry were ever enabled.
        expect(usdOnly().sell.toValue(60)).toBeGreaterThan(new Currencies({ keys: 100, metal: 0 }).toValue(60));
    });

    it('keeps the placeholders inside the safe-integer range', () => {
        // MAX_SAFE_INTEGER as a sentinel would lose precision in the checkAll sort arithmetic.
        expect(Number.isSafeInteger(usdOnly().sell.toValue(60))).toBe(true);
    });

    it('survives the arithmetic that the checkAll sort performs', () => {
        const a = usdOnly();
        const b = usdOnly();

        expect(() => (b.buy.keys - a.buy.keys) * 60 + (b.buy.metal - a.buy.metal)).not.toThrow();
    });

    it('still leaves prices null when there is no price of any kind', () => {
        const data: EntryData = { sku: '5021;6', enabled: true, autoprice: true, min: 0, max: 1, intent: 0 };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const entry: Entry = new Entry(data, 'Mann Co. Supply Crate Key');

        expect(entry.buy).toBeNull();
        expect(entry.sell).toBeNull();
    });
});

it('can pricecheck detect custom pricers', () => {
    const paths = genPaths('test');
    let options = Options.loadOptions({
        steamAccountName: 'abc123',
        debug: true,
        debugFile: false,
        customPricerUrl: 'http://test.com'
    });
    init(paths, options);
    let prices = getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    });
    let schemaManager = new SchemaManager({});
    let priceList = new Pricelist(prices, schemaManager.schema, options);
    expect(priceList.isUseCustomPricer).toBeTruthy();

    options = Options.loadOptions({
        steamAccountName: 'abc123',
        debug: true,
        debugFile: false,
        customPricerUrl: 'https://pricedb.io'
    });
    prices = getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    });
    schemaManager = new SchemaManager({});
    priceList = new Pricelist(prices, schemaManager.schema, options);
    expect(priceList.isUseCustomPricer).toBeFalsy();

    options = Options.loadOptions({ steamAccountName: 'abc123', debug: true, debugFile: false, customPricerUrl: '' });
    prices = getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    });
    schemaManager = new SchemaManager({});
    priceList = new Pricelist(prices, schemaManager.schema, options);
    expect(priceList.isUseCustomPricer).toBeFalsy();

    options = Options.loadOptions({
        steamAccountName: 'abc123',
        debug: true,
        debugFile: false,
        customPricerUrl: 'https://pricedb.io/api'
    });
    prices = getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    });
    schemaManager = new SchemaManager({});
    priceList = new Pricelist(prices, schemaManager.schema, options);
    expect(priceList.isUseCustomPricer).toBeFalsy();

    options = Options.loadOptions({ steamAccountName: 'abc123', debug: true, debugFile: false, customPricerUrl: null });
    prices = getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    });
    schemaManager = new SchemaManager({});
    priceList = new Pricelist(prices, schemaManager.schema, options);
    expect(priceList.isUseCustomPricer).toBeFalsy();
});
