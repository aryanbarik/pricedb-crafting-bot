jest.mock('../Inventory', () => ({ __esModule: true, default: jest.fn() }));

import { chooseMetal, duplicateWeaponAssetIds, isEligible } from '../WeaponBank';
import Bot from '../Bot';
import { EconItem } from '@tf2autobot/tradeoffer-manager';

const emptyMetal = () => ({ '5000;6': [] as string[], '5001;6': [] as string[], '5002;6': [] as string[] });

describe('weapon bank eligibility', () => {
    const bot = {
        craftWeapons: ['414;6', '527;6', '739;6', '22;6', '42;6', '46;6', '140;6', '159;6', '405;6'],
        schema: {
            getItemByDefindex: (id: number) => ({
                item_name: id === 22 ? 'Festive Rocket Launcher' : 'Rocket Launcher',
                capabilities: { can_killstreakify: true }
            })
        }
    } as unknown as Bot;
    const weapon = (sku: string, overrides: Record<string, unknown> = {}) =>
        ({
            tradable: true,
            name: 'Rocket Launcher',
            market_name: 'Rocket Launcher',
            getSKU: () => ({ sku }),
            ...overrides
        } as unknown as EconItem);

    test('allows only plain tradable Unique weapons with listed Killstreak Kits', () => {
        expect(isEligible(weapon('414;6'), bot)).toBe(true);
        expect(isEligible(weapon('527;6'), bot)).toBe(true);
        expect(isEligible(weapon('739;6'), bot)).toBe(true);
        expect(isEligible(weapon('42;6'), bot)).toBe(false);
        expect(isEligible(weapon('46;6'), bot)).toBe(false);
        expect(isEligible(weapon('140;6'), bot)).toBe(false);
        expect(isEligible(weapon('159;6'), bot)).toBe(false);
        expect(isEligible(weapon('405;6'), bot)).toBe(false);
        expect(isEligible(weapon('22;6'), bot)).toBe(false);
        expect(isEligible(weapon('414;6', { descriptions: [{ value: 'Halloween: Exorcism' }] }), bot)).toBe(false);
        expect(isEligible(weapon('414;6', { descriptions: [{ value: 'A normal description' }] }), bot)).toBe(true);
        expect(isEligible(weapon('414;11'), bot)).toBe(false);
        expect(isEligible(weapon('414;6;uncraftable'), bot)).toBe(false);
        expect(isEligible(weapon('414;6;kt-1'), bot)).toBe(false);
        expect(isEligible(weapon('414;6', { tradable: false }), bot)).toBe(false);
        expect(isEligible(weapon('414;6', { name: 'Renamed Rocket Launcher' }), bot)).toBe(false);
    });

    test('keeps one Unique copy and marks the remaining copies as duplicates', () => {
        const items = [
            weapon('414;6', { id: 'unique-1' }),
            weapon('414;6', { id: 'unique-2' }),
            weapon('414;6', { id: 'unique-3' })
        ];
        expect(duplicateWeaponAssetIds(items, bot)).toEqual(['unique-2', 'unique-3']);
    });

    test('marks every Unique copy as duplicate when a tradable Strange copy exists', () => {
        const items = [
            weapon('414;6', { id: 'unique-1' }),
            weapon('414;6', { id: 'unique-2' }),
            weapon('414;11', { id: 'strange-1' })
        ];
        expect(duplicateWeaponAssetIds(items, bot)).toEqual(['unique-1', 'unique-2']);
    });
});

describe('weapon bank metal balancing', () => {
    test('pays one scrap for two weapons', () => {
        const payer = { ...emptyMetal(), '5000;6': ['scrap-1'] };
        expect(chooseMetal(payer, emptyMetal(), 1)).toEqual({ paid: ['scrap-1'], change: [] });
    });

    test('uses refined and returns exact change', () => {
        const payer = { ...emptyMetal(), '5002;6': ['ref-1'] };
        const change = { ...emptyMetal(), '5001;6': ['rec-1', 'rec-2'], '5000;6': ['scrap-1', 'scrap-2'] };
        expect(chooseMetal(payer, change, 1)).toEqual({
            paid: ['ref-1'],
            change: ['scrap-1', 'scrap-2', 'rec-1', 'rec-2']
        });
    });

    test('rejects payment when exact change is unavailable', () => {
        const payer = { ...emptyMetal(), '5002;6': ['ref-1'] };
        expect(() => chooseMetal(payer, emptyMetal(), 1)).toThrow('exact change');
    });

    test('uses reclaimed metal without change for six weapons', () => {
        const payer = { ...emptyMetal(), '5001;6': ['rec-1'] };
        expect(chooseMetal(payer, emptyMetal(), 3)).toEqual({ paid: ['rec-1'], change: [] });
    });
});
