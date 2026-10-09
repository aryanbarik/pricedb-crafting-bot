import { calculateFifoProfit, getFifoCostBasis } from '../InventoryCostBasis';

const entry = {
    costKeys: 8,
    costMetal: 10,
    diffKeys: 1,
    diffMetal: 2
};

describe('FIFO profit convention', () => {
    it('uses the same cost basis as the stored aggregate profit for a positive diff', () => {
        expect(getFifoCostBasis(entry)).toEqual({ keys: 7, metal: 8 });
        expect(calculateFifoProfit({ keys: 12, metal: 14 }, entry)).toEqual({ keys: 5, metal: 6 });
    });

    it('handles a negative diff without reversing the realised-profit sign', () => {
        const underpay = { ...entry, diffKeys: -1, diffMetal: -2 };

        expect(getFifoCostBasis(underpay)).toEqual({ keys: 9, metal: 12 });
        expect(calculateFifoProfit({ keys: 12, metal: 14 }, underpay)).toEqual({ keys: 3, metal: 2 });
    });
});
