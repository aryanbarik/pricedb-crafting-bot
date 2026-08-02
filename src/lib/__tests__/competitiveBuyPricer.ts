import { pickTopLevel, CompetingOrder } from '../pricer/competitiveBuyPricer';

const order = (steamid: string, value: number): CompetingOrder => ({ steamid, value });

describe('pickTopLevel', () => {
    it('ignores a lone outlier and returns the corroborated level', () => {
        // One person bidding 5 ref (45 scrap) against four people at 1 ref (9 scrap).
        const orders = [order('troll', 45), order('a', 9), order('b', 9), order('c', 9), order('d', 9)];

        expect(pickTopLevel(orders, 2)).toEqual(9);
    });

    it('follows a genuine move once enough people are at the higher level', () => {
        const orders = [order('a', 10), order('b', 10), order('c', 10), order('d', 9), order('e', 9)];

        expect(pickTopLevel(orders, 2)).toEqual(10);
    });

    it('does not count the same person twice', () => {
        // One person with two listings at 12 must not qualify that level on their own.
        const orders = [order('a', 12), order('a', 12), order('b', 9), order('c', 9)];

        expect(pickTopLevel(orders, 2)).toEqual(9);
    });

    it('returns null when no level has enough orders', () => {
        expect(pickTopLevel([order('a', 9), order('b', 10)], 2)).toBeNull();
    });

    it('returns null for no orders at all', () => {
        expect(pickTopLevel([], 2)).toBeNull();
    });

    it('accepts any single order when minOrders is 1', () => {
        expect(pickTopLevel([order('a', 9)], 1)).toEqual(9);
    });
});
