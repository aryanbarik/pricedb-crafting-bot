import fs from 'fs';
import os from 'os';
import path from 'path';
import CraftingJournal, { CraftJobRecord } from '../craftingJournal';

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
        expect(JSON.parse(archive.trim())).toMatchObject({
            offerId: 'offer-1',
            stage: 'completed',
            returnOfferId: 'return-1'
        });
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
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CraftJobRecord>;
        legacy.done.stage = 'completed';
        fs.writeFileSync(file, JSON.stringify(legacy));

        const reopened = new CraftingJournal(file);
        expect(reopened.hasHandled('done')).toBe(true);
        expect(reopened.get('done')).toBeUndefined();
        expect(reopened.open().map(job => job.offerId)).toEqual(['open']);
        expect(
            fs.readFileSync(path.join(dir, 'craftingJournal.archive.jsonl'), 'utf8').trim().split('\n')
        ).toHaveLength(1);
    });

    it('recovers an archive-first completion interrupted before active-file removal', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('done', 'partner-1', 'intake', []);
        const active = journal.get('done');
        fs.writeFileSync(
            path.join(dir, 'craftingJournal.archive.jsonl'),
            JSON.stringify({ ...active, stage: 'completed' }) + '\n'
        );

        const reopened = new CraftingJournal(file);
        expect(reopened.hasHandled('done')).toBe(true);
        expect(reopened.open()).toHaveLength(0);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    });

    it('fails closed on corrupt storage', () => {
        fs.writeFileSync(file, '{broken');
        expect(() => new CraftingJournal(file)).toThrow();
    });

    it('preserves rollback IDs and an undelivered balance across partial returns and restarts', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('source', 'customer', 'components', []);
        journal.addReturn('source', ['old-1', 'old-2', 'unchanged'], true);
        journal.recordReturnAttempt('source', {
            offerId: 'failed',
            assetIds: ['old-1', 'old-2', 'unchanged'],
            state: 'failed'
        });
        journal.remapAssets('source', { 'old-1': 'new-1', 'old-2': 'new-2' });
        journal.recordDelivery('source', ['unchanged']);
        const restored = new CraftingJournal(file);
        expect(restored.get('source')).toMatchObject({
            stage: 'held',
            returnAssetIds: ['new-1', 'new-2'],
            deliveredAssetIds: ['unchanged'],
            assetIdMappings: { 'old-1': 'new-1', 'old-2': 'new-2' }
        });
        restored.recordDelivery('source', ['unchanged']);
        expect(restored.get('source')?.returnAssetIds).toEqual(['new-1', 'new-2']);
        restored.recordDelivery('source', ['new-1', 'new-2']);
        expect(restored.get('source')).toBeUndefined();
        expect(new CraftingJournal(file).hasHandled('source')).toBe(true);
    });

    it('writes operation intent before results and never completes a job with unresolved operations', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('source', 'customer', 'components', ['fab']);
        journal.addOperation('source', {
            id: 'op',
            kind: 'craftFabricator',
            inputIds: ['fab', 'part'],
            beforeIds: ['fab', 'part'],
            state: 'pending',
            startedAt: 'now',
            expected: { defindexes: [6523], attributes: { 2012: 190, 2025: 2 }, newlyCreated: true }
        });
        expect(new CraftingJournal(file).get('source')?.operations?.[0].state).toBe('pending');
        journal.addReturn('source', ['leftover'], true);
        journal.recordDelivery('source', ['leftover']);
        expect(journal.get('source')?.stage).toBe('held');
        journal.finishOperation('source', 'op', 'kit', ['fab', 'part']);
        expect(new CraftingJournal(file).get('source')?.returnAssetIds).toEqual(['kit']);
        journal.recordDelivery('source', ['kit']);
        expect(journal.get('source')).toBeUndefined();
    });

    it('an early partial delivery cannot archive a batch that is still processing', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('source', 'customer', 'components', ['fab']);
        journal.addReturn('source', ['first-kit']);
        journal.recordDelivery('source', ['first-kit']);
        expect(journal.get('source')?.stage).toBe('held');
        journal.addReturn('source', ['last-kit'], true);
        journal.recordDelivery('source', ['last-kit']);
        expect(journal.get('source')).toBeUndefined();
    });

    it('rejects mapping cycles before writing and validates optional durable recovery fields', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('source', 'customer', 'components', []);
        journal.addReturn('source', ['one']);
        journal.remapAssets('source', { one: 'two' });
        expect(() => journal.remapAssets('source', { two: 'one' })).toThrow('Cyclic');
        expect(new CraftingJournal(file).get('source')?.assetIdMappings).toEqual({ one: 'two' });
        const records = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { returnAttempts?: unknown }>;
        records.source.returnAttempts = [{ offerId: 'bad', assetIds: 'not-an-array', state: 'active' }];
        fs.writeFileSync(file, JSON.stringify(records));
        expect(() => new CraftingJournal(file)).toThrow('Invalid return attempt');
    });

    it('follows a revised rollback receipt without losing the previously mapped balance', () => {
        const journal = new CraftingJournal(file);
        journal.recordAccepted('source', 'customer', 'components', []);
        journal.addReturn('source', ['old'], true);
        journal.remapAssets('source', { old: 'first-rollback-id' });
        journal.remapAssets('source', { old: 'final-rollback-id' });
        expect(new CraftingJournal(file).get('source')).toMatchObject({
            returnAssetIds: ['final-rollback-id'],
            assetIdMappings: { old: 'final-rollback-id', 'first-rollback-id': 'final-rollback-id' }
        });
    });
});
