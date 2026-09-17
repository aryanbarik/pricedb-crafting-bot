import fs from 'fs';
import os from 'os';
import path from 'path';
import CraftingJournal from '../craftingJournal';

describe('CraftingJournal', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofab-craft-journal-'));
        file = path.join(dir, 'craftingJournal.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('persists accepted receipts and transitions across restart', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('offer-1', '76561198135282692', 'components', ['fab-1']);
        journal.update('offer-1', { stage: 'queued', receivedAssetIds: ['part-1', 'part-2'] });

        const reopened = new CraftingJournal(file);
        expect(reopened.get('offer-1')).toMatchObject({
            stage: 'queued',
            receivedAssetIds: ['part-1', 'part-2'],
            fabricatorAssetIds: ['fab-1']
        });

        reopened.update('offer-1', { stage: 'returning', returnAssetIds: ['kit-1'], returnOfferId: 'return-1' });
        expect(new CraftingJournal(file).open()).toHaveLength(1);
        reopened.update('offer-1', { stage: 'completed' });
        expect(new CraftingJournal(file).open()).toHaveLength(0);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
        const archive = fs.readFileSync(path.join(dir, 'craftingJournal.archive.jsonl'), 'utf8');
        expect(JSON.parse(archive.trim())).toMatchObject({ offerId: 'offer-1', stage: 'completed', returnOfferId: 'return-1' });
        expect(new CraftingJournal(file).hasHandled('offer-1')).toBe(true);
        reopened.recordAccepted('offer-1', 'another-partner', 'intake', []);
        expect(reopened.open()).toHaveLength(0);
    });

    it('keeps each accepted offer exactly once', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('offer-1', 'partner-1', 'intake', ['fab-1']);
        journal.recordAccepted('offer-1', 'partner-2', 'components', ['fab-2']);
        expect(journal.open()).toHaveLength(1);
        expect(journal.get('offer-1')?.partnerSteamId).toBe('partner-1');
    });

    it('migrates completed legacy jobs while preserving open ones', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('done', 'partner-1', 'intake', []);
        journal.recordAccepted('open', 'partner-2', 'components', ['fab-1']);
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
        legacy.done.stage = 'completed';
        fs.writeFileSync(file, JSON.stringify(legacy));

        const reopened = new CraftingJournal(file);
        expect(reopened.hasHandled('done')).toBe(true);
        expect(reopened.get('done')).toBeUndefined();
        expect(reopened.open().map(job => job.offerId)).toEqual(['open']);
        expect(fs.readFileSync(path.join(dir, 'craftingJournal.archive.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('recovers an archive-first completion interrupted before active-file removal', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('done', 'partner-1', 'intake', []);
        const active = journal.get('done');
        fs.writeFileSync(path.join(dir, 'craftingJournal.archive.jsonl'), JSON.stringify({ ...active, stage: 'completed' }) + '\n');

        const reopened = new CraftingJournal(file);
        expect(reopened.hasHandled('done')).toBe(true);
        expect(reopened.open()).toHaveLength(0);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    });

    it('fails closed on corrupt storage', () => {
        fs.writeFileSync(file, '{broken');
        expect(() => new CraftingJournal(file)).toThrow();
    });
});
