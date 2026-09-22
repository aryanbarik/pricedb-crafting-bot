import { isExcludedCraftingReskinDefindex } from '../weaponExclusions';

describe('isExcludedCraftingReskinDefindex', () => {
    it.each([
        [160, 'Lugermorph'],
        [294, 'Lugermorph promotional variant'],
        [161, 'Big Kill'],
        [298, 'Iron Curtain'],
        [727, 'Black Rose'],
        [1100, 'Bread Bite'],
        [30665, 'Shooting Star'],
        [30666, 'C.A.P.P.E.R'],
        [30667, 'Batsaber']
    ])('excludes %i (%s)', (defindex: number) => {
        expect(isExcludedCraftingReskinDefindex(defindex)).toBe(true);
    });

    it.each([
        [13, 'Scattergun'],
        [18, 'Rocket Launcher'],
        [205, 'Pistol'],
        [298 + 1, 'unrelated neighboring defindex'],
        [1100 + 1, 'unrelated neighboring defindex']
    ])('allows %i (%s)', (defindex: number) => {
        expect(isExcludedCraftingReskinDefindex(defindex)).toBe(false);
    });
});
