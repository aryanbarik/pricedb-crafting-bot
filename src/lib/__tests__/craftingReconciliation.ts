import { CraftItem, CraftOperation, operationOutputs, recipeOutput, rollbackMappings } from '../craftingReconciliation';

jest.mock('../logger', () => ({ __esModule: true, default: { debug: jest.fn() } }));

const attributes = (target = 190, sheen = 6) => [
    { def_index: 2012, value: target },
    { def_index: 2025, value: 2 },
    { def_index: 2014, value: sheen }
];
const kit = (id: string, original = id): CraftItem => ({
    id,
    original_id: original,
    def_index: 6523,
    quality: 6,
    attribute: attributes()
});
const operation: CraftOperation = {
    id: 'op-a',
    kind: 'craftFabricator',
    inputIds: ['fab-a', 'part-a'],
    beforeIds: ['fab-a', 'part-a', 'existing'],
    state: 'pending',
    startedAt: '2026-10-19T01:13:32Z',
    expected: { defindexes: [6523, 6527], attributes: { 2012: 190, 2025: 2, 2014: 6 }, newlyCreated: true }
};

test('overlapping trade kits with identical attributes are not craft outputs', () => {
    const received = kit('incoming-b', 'customer-original');
    expect(operationOutputs(operation, [received, kit('crafted-a')], new Set())).toEqual([kit('crafted-a')]);
});

test('waits for consumed inputs and excludes snapshots, receipts, claimed outputs and wrong variants', () => {
    const output = kit('crafted-a');
    expect(operationOutputs(operation, [output, { id: 'fab-a', def_index: 20002, quality: 6 }], new Set())).toEqual([]);
    const wrong = { ...kit('wrong'), attribute: attributes(190, 4) };
    expect(
        operationOutputs(
            operation,
            [kit('existing'), kit('receipt'), kit('claimed'), wrong, output],
            new Set(['receipt', 'claimed'])
        )
    ).toEqual([output]);
});

test('ambiguous outputs remain explicit instead of selecting the first item', () => {
    expect(operationOutputs(operation, [kit('one'), kit('two')], new Set())).toHaveLength(2);
});

test('an in-place application requires consumption and the expected original weapon identity', () => {
    const apply: CraftOperation = {
        ...operation,
        inputIds: ['tool', 'weapon'],
        retainedInputId: 'weapon',
        beforeIds: ['tool', 'weapon'],
        expected: { defindexes: [190], attributes: { 2025: 2 }, originalId: 'lineage' }
    };
    const weapon: CraftItem = {
        id: 'weapon',
        original_id: 'lineage',
        def_index: 190,
        quality: 6,
        attribute: attributes()
    };
    expect(operationOutputs(apply, [weapon], new Set())).toEqual([weapon]);
    expect(operationOutputs(apply, [{ ...weapon, original_id: 'another-customer' }], new Set())).toEqual([]);
    expect(operationOutputs(apply, [weapon, { id: 'tool', def_index: 6527, quality: 6 }], new Set())).toEqual([]);
});

test('recipe matching reads the output slot at its actual index with float attributes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require('../../../node_modules/@tf2autobot/tf2/protobufs/generated/_load.js') as {
        CAttribute_DynamicRecipeComponent: {
            encode(value: { def_index: number; num_required: number; attributes_string: string }): {
                finish(): Uint8Array;
            };
        };
    };
    const sep = '|\x01\x02\x01\x03|\x01\x02\x01\x03|';
    const bytes = Buffer.from(
        schema.CAttribute_DynamicRecipeComponent.encode({
            def_index: 6523,
            num_required: 1,
            attributes_string: ['2012', '190', '2025', '2', '2014', '6'].join(sep)
        }).finish()
    );
    const expected = recipeOutput({
        id: 'fab',
        def_index: 20002,
        quality: 6,
        attribute: [{ def_index: 2007, value_bytes: bytes }]
    });
    expect(expected.attributes).toEqual({ 2012: 190, 2025: 2, 2014: 6 });
});

test('rollback mappings only replace this offer’s assets with verified bot-owned IDs', () => {
    const receipt = [
        { assetid: 'old-1', rollback_new_assetid: 'new-1', rollback_new_contextid: '2' },
        { assetid: 'old-2', rollback_new_assetid: 'new-2', rollback_new_contextid: '2' },
        { assetid: 'unrelated', rollback_new_assetid: 'other', rollback_new_contextid: '2' }
    ];
    expect(rollbackMappings(['old-1', 'old-2', 'unchanged'], receipt, new Set(['new-1', 'other']))).toEqual({
        'old-1': 'new-1'
    });
    expect(rollbackMappings(['old-1'], receipt, new Set())).toEqual({});
});

// Captured GC shape from the held Rescue Ranger and Specialized kit incidents.
// GetPlayerItems includes 2025, but CSOEconItem only sends dynamic attributes.
function floatAttr(def_index: number, value: number) {
    const value_bytes = Buffer.alloc(4);
    value_bytes.writeFloatLE(value);
    return { def_index, value: null, value_bytes };
}

test.each([
    [6526, 3, 997, 3, 2004],
    [6523, 2, 412, 1, 0],
    [6523, 2, 40, 5, 0],
    [6523, 2, 528, 7, 0]
])('recognizes GC kit %i with its static tier omitted', (defindex, tier, target, sheen, effect) => {
    const output: CraftItem = {
        id: 'output',
        original_id: null,
        def_index: defindex,
        quality: 6,
        attribute: [floatAttr(2012, target), floatAttr(2014, sheen), ...(effect ? [floatAttr(2013, effect)] : [])]
    };
    const op = {
        ...operation,
        expected: {
            defindexes: [6523, 6526, 6527],
            newlyCreated: true,
            attributes: { 2012: target, 2014: sheen, 2013: effect, 2025: tier }
        }
    };
    expect(operationOutputs(op, [output], new Set())).toEqual([output]);
    expect(operationOutputs(op, [{ ...output, def_index: 6527 }], new Set())).toEqual([]);
    expect(operationOutputs(op, [{ ...output, def_index: tier === 3 ? 6523 : 6526 }], new Set())).toEqual([]);
    expect(
        operationOutputs(op, [{ ...output, attribute: [...output.attribute, floatAttr(2025, 1)] }], new Set())
    ).toEqual([]);
    expect(operationOutputs(op, [{ ...output, original_id: 'traded-in' }], new Set())).toEqual([]);
});
