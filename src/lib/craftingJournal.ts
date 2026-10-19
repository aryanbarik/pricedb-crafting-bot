import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { CraftOperation, ReturnAttempt } from './craftingReconciliation';

export type CraftJobStage =
    | 'accepted'
    | 'queued'
    | 'processing'
    | 'awaiting_components'
    | 'returning'
    | 'completed'
    | 'held';

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
    operations?: CraftOperation[];
    deliveredAssetIds?: string[];
    assetIdMappings?: Record<string, string>;
    returnAttempts?: ReturnAttempt[];
    reconciliationAlerted?: boolean;
    reconciliationEvidence?: { offerIds: string[]; note: string };
    processingComplete?: boolean;
    returnStartedAt?: string;
    receiptPending?: boolean;
    receiptSnapshotIds?: string[];
    rollbackCandidateIds?: string[];
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
            if (
                !record ||
                record.offerId !== id ||
                !Array.isArray(record.receivedAssetIds) ||
                !Array.isArray(record.fabricatorAssetIds) ||
                !Array.isArray(record.returnAssetIds) ||
                typeof record.partnerSteamId !== 'string' ||
                !['accepted', 'queued', 'processing', 'awaiting_components', 'returning', 'completed', 'held'].includes(
                    record.stage
                )
            ) {
                throw new Error(`Invalid crafting journal record ${id}`);
            }
            if (
                record.operations !== undefined &&
                (!Array.isArray(record.operations) ||
                    record.operations.some(
                        op =>
                            !op ||
                            typeof op.id !== 'string' ||
                            !Array.isArray(op.inputIds) ||
                            !Array.isArray(op.beforeIds) ||
                            !op.inputIds.every(value => typeof value === 'string') ||
                            !op.beforeIds.every(value => typeof value === 'string') ||
                            !['pending', 'completed', 'held'].includes(op.state) ||
                            !op.expected ||
                            !Array.isArray(op.expected.defindexes) ||
                            typeof op.expected.attributes !== 'object' ||
                            op.expected.attributes === null
                    ))
            ) {
                throw new Error(`Invalid crafting operation journal ${id}`);
            }
            if (
                record.returnAttempts !== undefined &&
                (!Array.isArray(record.returnAttempts) ||
                    record.returnAttempts.some(
                        attempt =>
                            !attempt ||
                            typeof attempt.offerId !== 'string' ||
                            !Array.isArray(attempt.assetIds) ||
                            !attempt.assetIds.every(value => typeof value === 'string') ||
                            !['pending', 'active', 'delivered', 'reconcile', 'failed'].includes(attempt.state)
                    ))
            ) {
                throw new Error(`Invalid return attempt journal ${id}`);
            }
            if (
                (record.deliveredAssetIds !== undefined &&
                    (!Array.isArray(record.deliveredAssetIds) ||
                        !record.deliveredAssetIds.every(value => typeof value === 'string'))) ||
                (record.assetIdMappings !== undefined &&
                    (!record.assetIdMappings ||
                        typeof record.assetIdMappings !== 'object' ||
                        Array.isArray(record.assetIdMappings) ||
                        !Object.values(record.assetIdMappings).every(value => typeof value === 'string')))
            ) {
                throw new Error(`Invalid return custody journal ${id}`);
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
            operations: [],
            processingComplete: false,
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

    addOperation(offerId: string, operation: CraftOperation): void {
        const record = this.records[offerId];
        if (!record) throw new Error(`Unknown craft job ${offerId}`);
        if ((record.operations ?? []).some(op => op.id === operation.id)) return;
        this.update(offerId, { operations: [...(record.operations ?? []), operation] });
    }

    finishOperation(offerId: string, operationId: string, outputId?: string, consumedIds: string[] = []): void {
        const record = this.records[offerId];
        if (!record) return;
        const existing = record.operations?.find(op => op.id === operationId);
        if (!existing) throw new Error(`Unknown crafting operation ${operationId}`);
        if (existing.state === 'completed') return;
        const operations = (record.operations ?? []).map(op =>
            op.id === operationId
                ? { ...op, state: outputId ? ('completed' as const) : ('held' as const), outputId, consumedIds }
                : op
        );
        const remaining = record.returnAssetIds.filter(id => !consumedIds.includes(id));
        this.update(offerId, {
            operations,
            returnAssetIds: [...new Set([...remaining, ...(outputId ? [outputId] : [])])]
        });
    }

    addReturn(offerId: string, assetIds: string[], processingComplete = false): void {
        const record = this.records[offerId];
        if (!record) return;
        const delivered = new Set(record.deliveredAssetIds ?? []);
        this.update(offerId, {
            stage: 'returning',
            returnStartedAt: record.returnStartedAt ?? new Date().toISOString(),
            processingComplete: processingComplete ? true : record.processingComplete,
            returnAssetIds: [...new Set([...record.returnAssetIds, ...assetIds])].filter(id => !delivered.has(id))
        });
    }

    recordReturnAttempt(offerId: string, attempt: ReturnAttempt): void {
        const record = this.records[offerId];
        if (!record) return;
        const attempts = (record.returnAttempts ?? []).filter(a => a.offerId !== attempt.offerId);
        this.update(offerId, { returnOfferId: attempt.offerId, returnAttempts: [...attempts, attempt] });
    }

    remapAssets(offerId: string, mappings: Record<string, string>): void {
        const record = this.records[offerId];
        if (!record) return;
        const combined = { ...record.assetIdMappings, ...mappings };
        for (const [oldId, replacement] of Object.entries(mappings)) {
            let previous = oldId;
            const seen = new Set<string>();
            while (record.assetIdMappings?.[previous] && !seen.has(previous)) {
                seen.add(previous);
                previous = record.assetIdMappings[previous];
            }
            if (previous !== oldId && previous !== replacement) combined[previous] = replacement;
        }
        const remap = (id: string): string => {
            const seen = new Set<string>();
            while (combined[id]) {
                if (seen.has(id)) throw new Error('Cyclic asset-ID mapping');
                seen.add(id);
                id = combined[id];
            }
            return id;
        };
        Object.keys(combined).forEach(remap);
        this.update(offerId, {
            assetIdMappings: combined,
            returnAssetIds: [...new Set(record.returnAssetIds.map(remap))],
            operations: record.operations?.map(op => ({
                ...op,
                outputId: op.outputId ? remap(op.outputId) : undefined
            }))
        });
    }

    recordDelivery(offerId: string, assetIds: string[]): void {
        const record = this.records[offerId];
        if (!record) return;
        const delivered = new Set([...(record.deliveredAssetIds ?? []), ...assetIds]);
        const remaining = record.returnAssetIds.filter(id => !delivered.has(id));
        const uncertain = (record.operations ?? []).some(op => op.state !== 'completed');
        const fabricatorAssetIds =
            record.phase === 'intake'
                ? record.fabricatorAssetIds.filter(id => !delivered.has(id))
                : record.fabricatorAssetIds;
        const waitingForComponents = record.phase === 'intake' && fabricatorAssetIds.length > 0;
        this.update(offerId, {
            deliveredAssetIds: [...delivered],
            returnAssetIds: remaining,
            fabricatorAssetIds,
            stage:
                remaining.length === 0 && !uncertain && !waitingForComponents && record.processingComplete !== false
                    ? 'completed'
                    : waitingForComponents && remaining.length === 0
                    ? 'awaiting_components'
                    : 'held'
        });
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
