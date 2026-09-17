import { isRobotPartSku } from '../robotPartListingPolicy';

describe('robot-part listing policy', () => {
    it('allows only robot-part defindexes', () => {
        for (let defindex = 5700; defindex <= 5707; defindex++) {
            expect(isRobotPartSku(`${defindex};6`)).toBe(true);
        }
        expect(isRobotPartSku('6527;6;uncraftable;kt-1;td-214')).toBe(false);
        expect(isRobotPartSku('20003;6')).toBe(false);
        expect(isRobotPartSku('5021;6')).toBe(false);
        expect(isRobotPartSku(undefined)).toBe(false);
    });
});
