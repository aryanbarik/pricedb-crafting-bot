import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';

export type CraftJobStage = 'accepted' | 'queued' | 'processing' | 'awaiting_components' | 'returning' | 'completed' | 'held';

export interface CraftJobRecord {
    offerId: string;
    partnerSteamId: string;
    phase: string;
    stage: CraftJobStage;
    receivedAssetIds: string[];
    fabricatorAssetIds: string[];
    returnAssetIds: string[];
    returnOfferId?: string;
    linkedOfferId?: string;
    updatedAt: string;
}

/**
 * Small write-ahead ledger for customer-owned items. Each change is atomically replaced on disk
 * before the caller continues. Never infer that a missing item was returned merely from the GC
 * backpack: the session can disconnect while Steam trades continue to settle.
 */
export default class CraftingJournal {
    private records: Record<string, CraftJobRecord> = {};
    private readonly archivedIds = new Set<string>();
    private readonly archivePath: string;

    constructor(private readonly filePath: string) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.archivePath = path.join(path.dirname(filePath), `${path.basename(filePath, '.json')}.archive.jsonl`);
        if (fs.existsSync(this.archivePath)) {
            const lines = fs.readFileSync(this.archivePath, 'utf8').split('\n');
            for (const line of lines) {
                if (!line) continue;
                const record = JSON.parse(line) as CraftJobRecord;
                if (!record || typeof record.offerId !== 'string' || record.stage !== 'completed') {
                    throw new Error(`Invalid crafting archive at ${this.archivePath}`);
                }
                this.archivedIds.add(record.offerId);
            }
        }
        if (!fs.existsSync(filePath)) return;
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`Invalid crafting journal at ${filePath}`);
        }
        for (const [id, value] of Object.entries(parsed)) {
            const record = value as CraftJobRecord;
            if (!record || record.offerId !== id ||
                !Array.isArray(record.receivedAssetIds) ||
                !Array.isArray(record.fabricatorAssetIds) ||
                !Array.isArray(record.returnAssetIds) ||
                typeof record.partnerSteamId !== 'string' ||
                !['accepted', 'queued', 'processing', 'awaiting_components', 'returning', 'completed', 'held'].includes(record.stage)) {
                throw new Error(`Invalid crafting journal record ${id}`);
            }
            this.records[id] = record;
        }
        // Migration and crash recovery: an archive append may have completed immediately
        // before the process stopped, leaving the same job in the active file.
        for (const record of Object.values(this.records)) {
            if (this.archivedIds.has(record.offerId)) {
                delete this.records[record.offerId];
            } else if (record.stage === 'completed') {
                this.archive(record);
                delete this.records[record.offerId];
            }
        }
        if (Object.keys(this.records).length !== Object.keys(parsed).length) {
            writeFileAtomic.sync(this.filePath, JSON.stringify(this.records));
        }
    }

    get(offerId: string): CraftJobRecord | undefined {
        return this.records[offerId];
    }

    hasHandled(offerId: string): boolean {
        return Boolean(this.records[offerId]) || this.archivedIds.has(offerId);
    }

    open(): CraftJobRecord[] {
        return Object.values(this.records);
    }

    recordAccepted(offerId: string, partnerSteamId: string, phase: string, fabricatorAssetIds: string[]): void {
        if (this.hasHandled(offerId)) return;
        this.save({
            offerId,
            partnerSteamId,
            phase,
            stage: 'accepted',
            receivedAssetIds: [],
            fabricatorAssetIds,
            returnAssetIds: [],
            updatedAt: new Date().toISOString()
        });
    }

    update(offerId: string, change: Partial<Omit<CraftJobRecord, 'offerId' | 'partnerSteamId'>>): void {
        const current = this.records[offerId];
        if (!current) throw new Error(`Crafting journal has no accepted offer ${offerId}`);
        const updated = { ...current, ...change, updatedAt: new Date().toISOString() };
        if (updated.stage === 'completed') {
            this.archive(updated);
            const next = { ...this.records };
            delete next[offerId];
            writeFileAtomic.sync(this.filePath, JSON.stringify(next));
            this.records = next;
        } else {
            this.save(updated);
        }
    }

    private archive(record: CraftJobRecord): void {
        if (this.archivedIds.has(record.offerId)) return;
        const fd = fs.openSync(this.archivePath, 'a');
        try {
            fs.writeFileSync(fd, JSON.stringify(record) + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        this.archivedIds.add(record.offerId);
    }

    private save(record: CraftJobRecord): void {
        const next = { ...this.records, [record.offerId]: record };
        writeFileAtomic.sync(this.filePath, JSON.stringify(next));
        this.records = next;
    }
}
