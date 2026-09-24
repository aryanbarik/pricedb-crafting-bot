import Inventory from '../Inventory';
import Bot from '../Bot';

jest.mock('../Pricelist', () => ({ __esModule: true, default: class Pricelist {} }));

test('reconciles stale robot-part IDs without changing unrelated inventory', () => {
    const inventory = new Inventory('76561199865157561', {} as Bot, 'our', () => undefined);
    inventory.addItem('5706;6', 'stale-kb808');
    inventory.addItem('5706;6', 'current-kb808');
    inventory.addItem('5705;6', 'stale-taunt');
    inventory.addItem('5021;6', 'key');

    const changed = inventory.reconcileRobotPartStock(
        new Map([
            ['5706;6', new Set(['current-kb808', 'new-kb808'])],
            ['5705;6', new Set<string>()]
        ])
    );

    expect(changed.sort()).toEqual(['5705;6', '5706;6']);
    expect(inventory.findBySKU('5706;6').sort()).toEqual(['current-kb808', 'new-kb808']);
    expect(inventory.findBySKU('5705;6')).toEqual([]);
    expect(inventory.findBySKU('5021;6')).toEqual(['key']);
});
