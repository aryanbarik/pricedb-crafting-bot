import Bot from './Bot';
import log from '../lib/logger';
import { decodeFabricatorSlots, buildCraftComponents, findBotComponents, GCBackpackItem, KS_KIT_DEFINDEXES } from '../lib/fabricatorSlots';

export enum Attributes {
    Paint = 1031,
    CustomTexture = 1051,
    MakersMark = 1053,
    Killstreak = 1094,
    GiftedBy = 2570,
    Festivizer = 2572
}

export type TokenType = 'class' | 'slot';
export type SubTokenType =
    | 'scout'
    | 'soldier'
    | 'pyro'
    | 'demoman'
    | 'heavy'
    | 'engineer'
    | 'medic'
    | 'sniper'
    | 'spy'
    | 'primary'
    | 'secondary'
    | 'melee'
    | 'pda2';

type Job = {
    type:
        | 'smelt'
        | 'combine'
        | 'combineWeapon'
        | 'combineClassWeapon'
        | 'use'
        | 'delete'
        | 'sort'
        | 'removeAttributes'
        | 'craftToken'
        | 'craftFabricator'
        | 'applyKSKit'
        | 'applyKSKitToBaseItem'
        | 'applyStrangifier';
    baseitemDefIndex?: number;
    defindex?: number;
    sku?: string;
    skus?: string[];
    assetid?: string;
    assetids?: string[];
    fabricatorId?: string;
    componentIds?: string[];
    selfFill?: boolean;
    excludeIds?: string[];
    kitId?: string;
    weaponId?: string;
    strangifierId?: string;
    tokenType?: TokenType;
    subTokenType?: SubTokenType;
    sortType?: number;
    attribute?: Attributes;
    callback?: (err?: Error) => void;
    fabricatorCallback?: (
        err: Error | null,
        result?: { kitId?: string; partialFabId?: string; selfFilledIds?: string[]; stillMissing?: string[] }
    ) => void;
    kitCallback?: (err: Error | null, resultWeaponId?: string) => void;
    strangifyCallback?: (err: Error | null, resultWeaponId?: string) => void;
};

type ListenForEvent =
    | [string, (...args: any[]) => void, (err: Error) => void]
    | [
          string,
          (...args: any[]) => { success: boolean; clearTimeout?: boolean },
          (...args: any[]) => void,
          (err: Error) => void
      ];

export default class TF2GC {
    private processingQueue = false;

    private startedProcessing = false;

    private jobs: Job[] = [];

    constructor(private readonly bot: Bot) {
        this.bot = bot;
    }

    smeltMetal(defindex: 5001 | 5002, callback?: (err: Error | null) => void): void {
        if (![5001, 5002].includes(defindex)) {
            return;
        }

        log.debug('Enqueueing smelt job for ' + String(defindex));

        this.newJob({ type: 'smelt', defindex: defindex, callback: callback });
    }

    combineMetal(defindex: 5000 | 5001, callback?: (err: Error | null) => void): void {
        if (![5000, 5001].includes(defindex)) {
            return;
        }

        log.debug('Enqueueing combine job for ' + String(defindex));

        this.newJob({ type: 'combine', defindex: defindex, callback: callback });
    }

    combineWeapon(sku: string, callback?: (err: Error | null) => void): void {
        if (!this.bot.craftWeapons.includes(sku)) {
            return;
        }

        log.debug('Enqueueing combine weapon job for ' + sku);

        this.newJob({ type: 'combineWeapon', sku: sku, callback: callback });
    }

    combineClassWeapon(skus: string[], callback?: (err: Error | null) => void): void {
        skus.forEach(sku => {
            if (!this.bot.craftWeapons.includes(sku)) {
                return;
            }
        });

        log.debug('Enqueueing combine class weapon job for ' + skus.join(', '));

        this.newJob({ type: 'combineClassWeapon', skus: skus, callback: callback });
    }

    useItem(assetid: string, callback?: (err: Error | null) => void): void {
        log.debug('Enqueueing use job for ' + assetid);

        this.newJob({ type: 'use', assetid: assetid, callback: callback });
    }

    deleteItem(assetid: string, callback?: (err: Error | null) => void): void {
        log.debug('Enqueueing delete job for ' + assetid);

        this.newJob({ type: 'delete', assetid: assetid, callback: callback });
    }

    sortInventory(type: number, callback?: (err: Error | null) => void): void {
        log.debug('Enqueueing sort job');

        this.newJob({ type: 'sort', sortType: type, callback: callback });
    }

    removeAttributes(
        sku: string,
        assetid: string,
        attribute: Attributes,
        callback?: (err: Error | null) => void
    ): void {
        log.debug(`Enqueueing removeAttributes (${attribute}) job for ` + assetid);

        this.newJob({ type: 'removeAttributes', sku: sku, assetid: assetid, callback: callback });
    }

    craftToken(
        assetids: string[],
        tokenType: TokenType,
        subTokenType: SubTokenType,
        callback?: (err: Error | null) => void
    ): void {
        log.debug(`Enqueueing craftToken (${tokenType} - ${subTokenType}) job for ` + assetids.join(','));

        this.newJob({ type: 'craftToken', assetids, tokenType, subTokenType, callback: callback });
    }

    /**
     * `options.selfFill` lets the bot top the recipe up from its own backpack after the supplied
     * componentIds are placed — `options.excludeIds` is what it must not spend while doing so.
     *
     * This used to be a union-typed second parameter (`string[] | callback`) so a caller could omit
     * componentIds entirely. Nothing ever called it that way, and a third meaning would have made
     * the overload unreadable, so it is a plain options object now.
     */
    craftFabricator(
        fabricatorId: string,
        options: { componentIds?: string[]; selfFill?: boolean; excludeIds?: string[] },
        fabricatorCallback?: (
            err: Error | null,
            result?: { kitId?: string; partialFabId?: string; selfFilledIds?: string[]; stillMissing?: string[] }
        ) => void
    ): void {
        const { componentIds, selfFill, excludeIds } = options;
        const provided = componentIds?.length ?? 0;
        const reserved = excludeIds?.length ?? 0;
        const selfFillNote = selfFill ? `, self-fill enabled, ${reserved} id(s) reserved` : '';
        log.debug(
            `Enqueueing craftFabricator job for fabricator ${fabricatorId} (${provided} provided component(s)${selfFillNote})`
        );
        this.newJob({
            type: 'craftFabricator',
            fabricatorId,
            componentIds,
            selfFill,
            excludeIds,
            fabricatorCallback
        });
    }

    applyKSKit(kitId: string, weaponId: string, cb: (err: Error | null, resultWeaponId?: string) => void): void {
        log.debug(`Enqueueing applyKSKit job: kit ${kitId} → weapon ${weaponId}`);
        this.newJob({ type: 'applyKSKit', kitId, weaponId, kitCallback: cb });
    }

    /**
     * Applies a Killstreak Kit to a BASE item — a stock weapon of Normal quality, which every
     * account is granted and which therefore has no CSOEconItem and no asset id to address. The GC
     * takes a defindex instead, via a separate message (1091, ApplyBaseItemXifier) from the one used
     * for ordinary items (1082, ApplyXifier). This is what the in-game "Show Stock Items" checkbox
     * switches the item picker over to.
     *
     * The base item is NOT consumed: the GC promotes a copy to Unique and delivers it as a brand new
     * item, leaving the stock weapon in place. The kit is consumed as usual.
     */
    applyKSKitToBaseItem(
        kitId: string,
        baseitemDefIndex: number,
        cb: (err: Error | null, resultWeaponId?: string) => void
    ): void {
        log.debug(`Enqueueing applyKSKitToBaseItem job: kit ${kitId} → base item defindex ${baseitemDefIndex}`);
        this.newJob({ type: 'applyKSKitToBaseItem', kitId, baseitemDefIndex, kitCallback: cb });
    }

    applyStrangifier(strangifierId: string, weaponId: string, cb: (err: Error | null, resultWeaponId?: string) => void): void {
        log.debug(`Enqueueing applyStrangifier job: strangifier ${strangifierId} → weapon ${weaponId}`);
        this.newJob({ type: 'applyStrangifier', strangifierId, weaponId, strangifyCallback: cb });
    }

    private newJob(job: Job): void {
        this.jobs.push(job);
        this.handleJobQueue();
    }

    private handleJobQueue(): void {
        if (this.processingQueue) {
            // Already handling queue
            return;
        }

        if (this.jobs.length === 0) {
            // Queue is empty

            if (this.startedProcessing) {
                // Done processing queue

                this.startedProcessing = false;

                this.bot.handler.onTF2QueueCompleted();
            }
            return;
        }

        this.processingQueue = true;

        const job = this.jobs[0];

        if (!this.canProcessJobWeapon(job) || !this.canProcessJob(job)) {
            log.debug("Can't handle job", { job });
        }

        this.startedProcessing = true;

        // Ensuring TF2 GC connection...

        void this.connectToGC()
            .then(() => {
                let func;

                if (job.type === 'combineWeapon') {
                    func = this.handleCraftJobWeapon.bind(this, job);
                } else if (job.type === 'combineClassWeapon') {
                    func = this.handleCraftJobClassWeapon.bind(this, job);
                } else if (['smelt', 'combine'].includes(job.type)) {
                    func = this.handleCraftJob.bind(this, job);
                } else if (['use', 'delete', 'removeAttributes'].includes(job.type)) {
                    func = this.handleUseOrDeleteOrRemoveAttributesJob.bind(this, job);
                } else if (job.type === 'sort') {
                    func = this.handleSortJob.bind(this, job);
                } else if (job.type === 'craftToken') {
                    func = this.handleCraftTokenJob.bind(this, job);
                } else if (job.type === 'craftFabricator') {
                    func = this.handleCraftFabricatorJob.bind(this, job);
                } else if (job.type === 'applyKSKit') {
                    func = this.handleApplyKSKitJob.bind(this, job);
                } else if (job.type === 'applyKSKitToBaseItem') {
                    func = this.handleApplyKSKitToBaseItemJob.bind(this, job);
                } else if (job.type === 'applyStrangifier') {
                    func = this.handleApplyStrangifierJob.bind(this, job);
                }

                if (func) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                    func();
                } else {
                    this.finishedProcessingJob(new Error('Unknown job type'));
                }
            })
            .catch((err: Error) => {
                this.finishedProcessingJob(err);
            });
    }

    private handleCraftJob(job: Job): void {
        if (!this.canProcessJob(job)) {
            return this.finishedProcessingJob(new Error("Can't process job"));
        }

        const inventory = this.bot.inventoryManager.getInventory;

        const assetids = inventory
            .findBySKU(String(job.defindex) + ';6', true)
            .filter(assetid => !this.bot.trades.isInTrade(assetid));

        const ids = assetids.splice(0, job.type === 'smelt' ? 1 : 3);

        log.debug(`Sending ${job.type} request`);
        this.bot.tf2.craft(ids);

        const gainDefindex = job.defindex + (job.type === 'smelt' ? -1 : 1);
        const gainSKU = String(gainDefindex) + ';6';
        this.listenForEvent(
            'craftingComplete',
            (recipe: number, itemsGained: string[]) => {
                // Remove items used for recipe
                ids.forEach(assetid => inventory.removeItem(assetid));

                // Add items gained
                log.debug('itemsGained', itemsGained);
                itemsGained.forEach(assetid => inventory.addItem(gainSKU, assetid));

                this.finishedProcessingJob();
            },
            err => {
                this.finishedProcessingJob(err);
            }
        );
    }

    private handleCraftTokenJob(job: Job): void {
        const inventory = this.bot.inventoryManager.getInventory;

        log.debug(`Sending craft token (${job.tokenType} - ${job.subTokenType}) request`);
        // recipe reference: https://github.com/DontAskM8/TF2-Crafting-Recipe/blob/c9201943c81e26e4feb3f96945c8fbfe5c7186dc/craftRecipe.json
        // credit @Preport
        this.bot.tf2.craft(job.assetids, job.tokenType === 'class' ? 7 : 8);

        let gainSKU = '';
        if (job.tokenType === 'class') {
            switch (job.subTokenType) {
                case 'scout':
                    gainSKU = '5003;6';
                    break;
                case 'soldier':
                    gainSKU = '5005;6';
                    break;
                case 'pyro':
                    gainSKU = '5009;6';
                    break;
                case 'demoman':
                    gainSKU = '5006;6';
                    break;
                case 'heavy':
                    gainSKU = '5007;6';
                    break;
                case 'engineer':
                    gainSKU = '5011;6';
                    break;
                case 'medic':
                    gainSKU = '5008;6';
                    break;
                case 'sniper':
                    gainSKU = '5004;6';
                    break;
                case 'spy':
                    gainSKU = '5010;6';
            }
        } else {
            switch (job.subTokenType) {
                case 'primary':
                    gainSKU = '5012;6';
                    break;
                case 'secondary':
                    gainSKU = '5013;6';
                    break;
                case 'melee':
                    gainSKU = '5014;6';
                    break;
                case 'pda2':
                    gainSKU = '5018;6';
                    break;
            }
        }

        this.listenForEvent(
            'craftingComplete',
            (recipe: number, itemsGained: string[]) => {
                // Remove items used for recipe
                job.assetids.forEach(assetid => inventory.removeItem(assetid));

                // Add items gained
                log.debug('itemsGained', itemsGained);
                itemsGained.forEach(assetid => inventory.addItem(gainSKU, assetid));

                this.finishedProcessingJob();
            },
            err => {
                this.finishedProcessingJob(err);
            }
        );
    }

    private handleCraftFabricatorJob(job: Job): void {
        const backpack = (this.bot.tf2 as any).backpack as TF2GCItem[];
        const FABRICATOR_DEFINDEXES = [20002, 20003];

        // Asset IDs change when a trade completes — try original ID first, then fall back to defindex search
        let fabricator = backpack?.find(i => i.id === job.fabricatorId);
        if (!fabricator) {
            const candidates = (backpack ?? []).filter(i => FABRICATOR_DEFINDEXES.includes(i.def_index));
            if (candidates.length === 1) {
                fabricator = candidates[0];
                log.debug(`craftFabricator: original ID ${job.fabricatorId} changed after trade; found by defindex as ${fabricator.id}`);
            } else if (candidates.length > 1) {
                log.warn(`craftFabricator: fabricator ${job.fabricatorId} not found by ID; ${candidates.length} candidates by defindex, ambiguous`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error('Fabricator not found in backpack (ambiguous — multiple fabricators)'));
                return this.finishedProcessingJob(new Error('Fabricator not found (ambiguous)'));
            } else {
                log.warn(`craftFabricator: fabricator ${job.fabricatorId} not found in backpack`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error('Fabricator not found in backpack'));
                return this.finishedProcessingJob(new Error('Fabricator not found'));
            }
        }

        let components: { subject_item_id: string; attribute_index: number }[];

        if (job.componentIds?.length) {
            // Mode A: use provided component IDs — MyHandler resolves new IDs via itemAcquired before this runs
            const componentItems = job.componentIds
                .map(id => backpack.find(i => i.id === id))
                .filter((i): i is TF2GCItem => i !== undefined) as unknown as GCBackpackItem[];

            if (componentItems.length !== job.componentIds.length) {
                const missing = job.componentIds.length - componentItems.length;
                log.warn(`craftFabricator [Mode A]: ${missing} component ID(s) not found in backpack`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error(`${missing} component item(s) not found in backpack`));
                return this.finishedProcessingJob(new Error('Component items not found'));
            }

            // Diagnostic: log attr 2025 (killstreak tier) for each non-part component
            const ROBOT_PART_DEFINDEXES = [5700, 5701, 5702, 5703, 5704, 5705, 5706, 5707];
            for (const item of componentItems) {
                if (!ROBOT_PART_DEFINDEXES.includes(item.def_index as unknown as number)) {
                    const attrs = (item as unknown as GCBackpackItem).attribute ?? [];
                    const tier = attrs.find(a => a.def_index === 2025);
                    log.debug(`craftFabricator [Mode A] weapon candidate ${(item as any).id} defidx=${item.def_index}: attr2025=${JSON.stringify(tier)}, all_attrs=${JSON.stringify(attrs.map(a => ({ d: a.def_index, v: a.value, vb: (a as any).value_bytes })))}`);
                }
            }
            components = buildCraftComponents(fabricator as unknown as GCBackpackItem, componentItems);

            // Diagnostic: robot parts were previously excluded from all attribute logging, making
            // it impossible to see WHY one intermittently fails a slot's condition (e.g. attribute
            // 2022, "loot rarity", required on some robot-part slots — see fabricatorSlots.ts's
            // itemSatisfiesConditions). Logs raw attr 2022 data alongside whether
            // buildCraftComponents actually matched the item, so a live mismatch can be read
            // directly from logs instead of reconstructed from slot-count arithmetic.
            const matchedComponentIds = new Set(components.map(c => c.subject_item_id));
            for (const item of componentItems) {
                if (ROBOT_PART_DEFINDEXES.includes(item.def_index as unknown as number)) {
                    const attrs = (item as unknown as GCBackpackItem).attribute ?? [];
                    const rarity = attrs.find(a => a.def_index === 2022);
                    log.debug(`craftFabricator [Mode A] robot part ${(item as any).id} defidx=${item.def_index}: matched=${matchedComponentIds.has((item as any).id)}, attr2022=${JSON.stringify(rarity)}, all_attrs=${JSON.stringify(attrs.map(a => ({ d: a.def_index, v: a.value, vb: (a as any).value_bytes })))}`);
                }
            }

            if (components.length === 0 && !job.selfFill) {
                log.warn(`craftFabricator [Mode A]: no components could be mapped for fabricator ${fabricator.id}`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error('Provided items did not match any recipe slots'));
                return this.finishedProcessingJob(new Error('No components matched'));
            }
            // Under self-fill this is recoverable rather than fatal: the supplied items matching
            // nothing just means every slot is still open for the bot's own stock to cover below.
        } else if (job.selfFill) {
            components = [];
        } else {
            // Mode B: find matching items from the bot's own existing inventory. Reachable only
            // without selfFill, which is to say: not from the trade pipeline today.
            const botItems = backpack.filter(i => i.id !== fabricator!.id) as unknown as GCBackpackItem[];
            const { components: found, missing } = findBotComponents(fabricator as unknown as GCBackpackItem, botItems);
            if (missing.length > 0) {
                const msg = `Bot is missing parts: ${missing.join(', ')}`;
                log.warn(`craftFabricator [Mode B]: ${msg}`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error(msg));
                return this.finishedProcessingJob(new Error(msg));
            }
            components = found;
        }

        // Validate all required recipe slots are covered before sending to GC
        const allSlots = decodeFabricatorSlots(fabricator as unknown as GCBackpackItem);
        // `have` and `stillNeeds` matter as much as `need`: a fabricator can arrive part-filled, so
        // "missing 1 of need 2" is ambiguous between "found nothing" and "found one, wanted two"
        // without them. That ambiguity cost a debugging round trip on 2026-08-08.
        const slotSummary = allSlots
            .filter(s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex))
            .map(s => ({
                attr: s.attributeIndex,
                defidx: s.itemDefIndex,
                need: s.numRequired,
                have: s.numFulfilled,
                stillNeeds: s.numRequired - s.numFulfilled,
                cond: s.conditionsStr
            }));
        log.debug(`[craftFabricator] Recipe slots: ${JSON.stringify(slotSummary)}`);
        const unfilledSlots = allSlots.filter(s => !KS_KIT_DEFINDEXES.includes(s.itemDefIndex) && s.numFulfilled < s.numRequired);
        const coveredCounts = new Map<number, number>();
        for (const c of components) {
            coveredCounts.set(c.attribute_index, (coveredCounts.get(c.attribute_index) ?? 0) + 1);
        }
        // Self-fill: top the recipe up from the bot's own stock for whatever the supplied items
        // left open. coveredCounts is exactly the "already covered" input findBotComponents needs,
        // so the slot arithmetic lives in one place rather than being recomputed here.
        let selfFilledIds: string[] = [];
        let stillMissing: string[] = [];
        if (job.selfFill) {
            const excludeSet = new Set<string>(job.excludeIds ?? []);
            const donorPool = backpack.filter(i => i.id !== fabricator.id && !excludeSet.has(i.id));

            // Bank whatever the bot can cover rather than refusing outright when something is
            // short. Ingredients go INTO the fabricator and come back with it, so a partial fill
            // returns it closer to done instead of spending anything for nothing.
            const { components: topUp, missing } = findBotComponents(
                fabricator as unknown as GCBackpackItem,
                donorPool,
                { excludeIds: excludeSet, alreadyCovered: coveredCounts, allowPartial: true }
            );

            if (components.length === 0 && topUp.length === 0) {
                // Nothing to send. The GC ignores an empty recipe fulfilment and simply never
                // replies, so this would surface as a 30s timeout rather than an answer.
                const msg = `Bot is missing parts: ${missing.join(', ')}`;
                log.warn(`craftFabricator [self-fill]: nothing could be filled — ${msg}`);
                if (job.fabricatorCallback) job.fabricatorCallback(new Error(msg));
                return this.finishedProcessingJob(new Error(msg));
            }

            stillMissing = missing;
            selfFilledIds = topUp.map(c => c.subject_item_id);
            components = [...components, ...topUp];
            for (const c of topUp) {
                coveredCounts.set(c.attribute_index, (coveredCounts.get(c.attribute_index) ?? 0) + 1);
            }
            log.info(
                `craftFabricator [self-fill]: filled ${topUp.length} slot(s) from the bot's own stock ` +
                    `(${selfFilledIds.join(', ')})` +
                    (missing.length > 0 ? `; still short: ${missing.join(', ')}` : '')
            );
        }

        const incompleteSlots = unfilledSlots.filter(
            s => (coveredCounts.get(s.attributeIndex) ?? 0) < (s.numRequired - s.numFulfilled)
        );
        if (incompleteSlots.length > 0) {
            log.debug(`craftFabricator: partial fill — ${incompleteSlots.length} slot(s) not fully covered; proceeding with available components`);
        }

        // Snapshot kit IDs the bot already owns so the timeout fallback can find only NEWLY crafted kits
        const preExistingKitIds = new Set<string>(
            ((this.bot.tf2 as any).backpack as TF2GCItem[] ?? [])
                .filter(i => KS_KIT_DEFINDEXES.includes(i.def_index))
                .map(i => String(i.id))
        );
        // Snapshot fabricator IDs the bot already owns so a NEW fabricator-defindex item appearing
        // after this craft (the GC sometimes re-issues a partially-filled fabricator under a new id
        // instead of updating it in place via itemChanged/SO_Update) can be told apart from one that
        // was already there.
        const preExistingFabIds = new Set<string>(
            ((this.bot.tf2 as any).backpack as TF2GCItem[] ?? [])
                .filter(i => FABRICATOR_DEFINDEXES.includes(i.def_index))
                .map(i => String(i.id))
        );

        log.debug(`Sending FulfillDynamicRecipeComponent for fabricator ${fabricator.id} with ${components.length} component(s)`);
        (this.bot.tf2 as any).fulfillDynamicRecipeComponent(fabricator.id, components);

        // Listen for full craft (itemAcquired = kit) OR partial fill (itemChanged = fab updated in place).
        // Use raw listeners with a 30-second timeout (listenForEvent is hardcoded to 10s, too short).
        let settled = false;
        const fabricatorId = String(fabricator.id);

        const cleanup = (): void => {
            this.bot.tf2.removeListener('itemAcquired', onItemAcquired);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            this.bot.tf2.removeListener('itemChanged', onItemChanged);
            this.bot.tf2.removeListener('disconnectedFromGC', onDisconnected);
        };

        const onItemAcquired = (item: TF2GCItem): void => {
            log.debug(`craftFabricator: itemAcquired defindex=${item.def_index} id=${item.id}`);
            if (KS_KIT_DEFINDEXES.includes(item.def_index)) {
                if (settled) return;
                settled = true;
                clearTimeout(kitTimeout);
                cleanup();
                log.debug(`craftFabricator: received kit ${item.id} (defindex ${item.def_index})`);
                if (job.fabricatorCallback) {
                    job.fabricatorCallback(null, { kitId: String(item.id), selfFilledIds, stillMissing });
                }
                this.finishedProcessingJob();
                return;
            }
            if (FABRICATOR_DEFINDEXES.includes(item.def_index) && !preExistingFabIds.has(String(item.id))) {
                // Partial fill — GC re-issued the fabricator under a new id instead of updating it
                // in place. Use the NEW id, not the stale original one.
                if (settled) return;
                settled = true;
                clearTimeout(kitTimeout);
                cleanup();
                log.debug(`craftFabricator: partial fill — fab re-issued as new id ${item.id} (was ${fabricatorId})`);
                if (job.fabricatorCallback) {
                    job.fabricatorCallback(null, { partialFabId: String(item.id), selfFilledIds, stillMissing });
                }
                this.finishedProcessingJob();
            }
        };

        const onItemChanged = (oldItem: TF2GCItem, newItem: TF2GCItem): void => {
            if (String(newItem.id) !== fabricatorId) return;
            if (settled) return;
            settled = true;
            clearTimeout(kitTimeout);
            cleanup();
            log.debug(`craftFabricator: partial fill — fab ${fabricatorId} updated in place`);
            if (job.fabricatorCallback) {
                job.fabricatorCallback(null, { partialFabId: fabricatorId, selfFilledIds, stillMissing });
            }
            this.finishedProcessingJob();
        };

        const onDisconnected = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(kitTimeout);
            cleanup();
            const err = new Error('Disconnected from TF2 GC');
            if (job.fabricatorCallback) job.fabricatorCallback(err);
            this.finishedProcessingJob(err);
        };

        const kitTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            // Last-chance: is the fab still present (partial fill event missed) or gone (full craft event missed)?
            const currentBackpack = (this.bot.tf2 as any).backpack as TF2GCItem[];
            const updatedFab = currentBackpack?.find(i => String(i.id) === fabricatorId);
            if (!updatedFab) {
                // Fab gone — full craft succeeded but itemAcquired was missed; look for the new kit
                const newKit = currentBackpack?.find(
                    i => KS_KIT_DEFINDEXES.includes(i.def_index) && !preExistingKitIds.has(String(i.id))
                );
                if (newKit) {
                    log.debug(`craftFabricator: timeout — fab gone, found kit ${newKit.id} in backpack`);
                    if (job.fabricatorCallback) {
                        job.fabricatorCallback(null, { kitId: String(newKit.id), selfFilledIds, stillMissing });
                    }
                } else {
                    // No new kit either — check whether the fabricator was re-issued under a new id
                    // (partial fill) before declaring hard failure.
                    const newFab = currentBackpack?.find(
                        i => FABRICATOR_DEFINDEXES.includes(i.def_index) && !preExistingFabIds.has(String(i.id))
                    );
                    if (newFab) {
                        log.debug(`craftFabricator: timeout — fab gone, found re-issued fab ${newFab.id} in backpack (partial fill)`);
                        if (job.fabricatorCallback) {
                            job.fabricatorCallback(null, {
                                partialFabId: String(newFab.id),
                                selfFilledIds,
                                stillMissing
                            });
                        }
                    } else {
                        const err = new Error('Timed out — fabricator gone but no kit found');
                        log.warn(`craftFabricator: ${err.message} (fab ${fabricatorId})`);
                        if (job.fabricatorCallback) job.fabricatorCallback(err);
                    }
                }
            } else {
                // Fab still present — partial fill happened but itemChanged was missed
                log.debug(`craftFabricator: timeout — fab ${fabricatorId} still present, treating as partial fill`);
                if (job.fabricatorCallback) {
                    job.fabricatorCallback(null, { partialFabId: fabricatorId, selfFilledIds, stillMissing });
                }
            }
            this.finishedProcessingJob();
        }, 30000);

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemAcquired', onItemAcquired);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemChanged', onItemChanged);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('disconnectedFromGC', onDisconnected);
    }

    private handleApplyKSKitJob(job: Job): void {
        const backpack = (this.bot.tf2 as any).backpack as TF2GCItem[];

        const kit = backpack?.find(i => i.id === job.kitId);
        if (!kit) {
            const err = new Error(`applyKSKit: kit ${job.kitId} not found in backpack`);
            log.warn(err.message);
            if (job.kitCallback) job.kitCallback(err);
            return this.finishedProcessingJob(err);
        }
        const weapon = backpack?.find(i => i.id === job.weaponId);
        if (!weapon) {
            const err = new Error(`applyKSKit: weapon ${job.weaponId} not found in backpack`);
            log.warn(err.message);
            if (job.kitCallback) job.kitCallback(err);
            return this.finishedProcessingJob(err);
        }

        let settled = false;
        const originalWeaponId = String(weapon.id);

        const cleanup = (): void => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            this.bot.tf2.removeListener('itemAcquired', onItemAcquired);
            // @ts-ignore
            this.bot.tf2.removeListener('itemChanged', onItemChanged);
            this.bot.tf2.removeListener('disconnectedFromGC', onDisconnected);
            // @ts-ignore
            this.bot.tf2.removeListener('applyXifierResponse', onXifierResponse);
        };

        // Log the GC response code — 0 typically means accepted
        const onXifierResponse = (result: number): void => {
            log.debug(`applyKSKit: applyXifierResponse result=${result} (kit ${kit.id})`);
        };
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.once('applyXifierResponse', onXifierResponse);

        log.debug(`applyKSKit: applying kit ${kit.id} to weapon ${weapon.id} via ApplyXifier`);
        (this.bot.tf2 as any).applyStrangifierOrUnusualifier(weapon.id, kit.id);

        // Catches weapon created as a new GC item (kit consumed + new weapon spawned)
        const onItemAcquired = (item: TF2GCItem): void => {
            const ktAttr = ((item as unknown as GCBackpackItem).attribute ?? []).find(a => a.def_index === 2025);
            if (!ktAttr) return;
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            log.debug(`applyKSKit: new KS weapon acquired ${item.id} (defidx ${item.def_index})`);
            if (job.kitCallback) job.kitCallback(null, String(item.id));
            this.finishedProcessingJob();
        };

        // Catches weapon modified in-place via SO_Update (same ID, new kt-tier attribute)
        const onItemChanged = (oldItem: TF2GCItem, newItem: TF2GCItem): void => {
            if (String(newItem.id) !== originalWeaponId) return;
            const hasKt = ((newItem as unknown as GCBackpackItem).attribute ?? []).some(a => a.def_index === 2025);
            if (!hasKt) return;
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            log.debug(`applyKSKit: weapon ${originalWeaponId} modified in-place with kt attr`);
            if (job.kitCallback) job.kitCallback(null, originalWeaponId);
            this.finishedProcessingJob();
        };

        const onDisconnected = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            const err = new Error('Disconnected from TF2 GC during kit application');
            if (job.kitCallback) job.kitCallback(err);
            this.finishedProcessingJob(err);
        };

        const applyTimeout = setTimeout(() => {
            if (settled) return;
            // Last-chance check: weapon modified in-place but event was missed
            const updatedWeapon = ((this.bot.tf2 as any).backpack as TF2GCItem[])?.find(i => i.id === originalWeaponId);
            const hasKt = updatedWeapon
                ? ((updatedWeapon as unknown as GCBackpackItem).attribute ?? []).some(a => a.def_index === 2025)
                : false;
            settled = true;
            cleanup();
            if (hasKt) {
                log.debug(`applyKSKit: weapon ${originalWeaponId} modified in place (caught at timeout)`);
                if (job.kitCallback) job.kitCallback(null, originalWeaponId);
                this.finishedProcessingJob();
            } else {
                const err = new Error(`applyKSKit: timed out waiting for kit application on weapon ${originalWeaponId}`);
                log.warn(err.message);
                if (job.kitCallback) job.kitCallback(err);
                this.finishedProcessingJob(err);
            }
        }, 30000);

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemAcquired', onItemAcquired);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemChanged', onItemChanged);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('disconnectedFromGC', onDisconnected);
    }

    /**
     * Applies a kit to a stock (Normal-quality) weapon, addressed by defindex rather than asset id.
     *
     * Differs from handleApplyKSKitJob in three ways, all forced by what a base item is:
     *
     * - There is nothing to look up in the backpack for the target. Stock weapons are granted to
     *   every account and are not economy items, so they never appear in the SO cache. Confirmed
     *   here: `!dumpattrs name=Scattergun` finds nothing, and GetPlayerItems returns no quality-0
     *   items across inventories of 198, 1,064 and 2,842 items.
     * - Success can ONLY arrive as itemAcquired. The GC promotes a copy to Unique and delivers it as
     *   a new item, leaving the stock weapon untouched, so there is no in-place itemChanged to watch
     *   and no original id to re-check at timeout.
     * - There is no response message to wait on. Valve defines k_EMsgGCApplyXifierResponse (1083)
     *   for ordinary items but nothing paired with 1091, so a rejected request is silent and shows
     *   up only as the timeout below.
     */
    private handleApplyKSKitToBaseItemJob(job: Job): void {
        const backpack = (this.bot.tf2 as any).backpack as TF2GCItem[];

        const kit = backpack?.find(i => i.id === job.kitId);
        if (!kit) {
            const err = new Error(`applyKSKitToBaseItem: kit ${job.kitId} not found in backpack`);
            log.warn(err.message);
            if (job.kitCallback) job.kitCallback(err);
            return this.finishedProcessingJob(err);
        }
        if (job.baseitemDefIndex === undefined) {
            const err = new Error('applyKSKitToBaseItem: no base item defindex given');
            log.warn(err.message);
            if (job.kitCallback) job.kitCallback(err);
            return this.finishedProcessingJob(err);
        }

        let settled = false;

        const cleanup = (): void => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            this.bot.tf2.removeListener('itemAcquired', onItemAcquired);
            this.bot.tf2.removeListener('disconnectedFromGC', onDisconnected);
        };

        log.debug(
            `applyKSKitToBaseItem: applying kit ${kit.id} to base item defindex ${job.baseitemDefIndex} via ApplyBaseItemXifier`
        );
        (this.bot.tf2 as any).applyToolToBaseItem(kit.id, job.baseitemDefIndex);

        const onItemAcquired = (item: TF2GCItem): void => {
            const ktAttr = ((item as unknown as GCBackpackItem).attribute ?? []).find(a => a.def_index === 2025);
            if (!ktAttr) return;
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            log.debug(
                `applyKSKitToBaseItem: new KS weapon acquired ${item.id} (defidx ${item.def_index}) from base item ${job.baseitemDefIndex}`
            );
            if (job.kitCallback) job.kitCallback(null, String(item.id));
            this.finishedProcessingJob();
        };

        const onDisconnected = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            const err = new Error('Disconnected from TF2 GC during base-item kit application');
            if (job.kitCallback) job.kitCallback(err);
            this.finishedProcessingJob(err);
        };

        const applyTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            // Silence here is ambiguous by design — with no response message, a defindex the GC
            // rejected looks exactly like one it never received. The stock/"Upgradeable" defindex
            // pair (Scattergun 13 vs 200) is the first thing to suspect if this fires.
            const err = new Error(
                `applyKSKitToBaseItem: timed out waiting for a new killstreak weapon from base item defindex ${job.baseitemDefIndex} (kit ${job.kitId}) — the GC sends no response to 1091, so this may mean the defindex was rejected`
            );
            log.warn(err.message);
            if (job.kitCallback) job.kitCallback(err);
            this.finishedProcessingJob(err);
        }, 30000);

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemAcquired', onItemAcquired);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('disconnectedFromGC', onDisconnected);
    }

    private handleApplyStrangifierJob(job: Job): void {
        const backpack = (this.bot.tf2 as any).backpack as TF2GCItem[];

        const strangifier = backpack?.find(i => i.id === job.strangifierId);
        if (!strangifier) {
            const err = new Error(`applyStrangifier: strangifier ${job.strangifierId} not found in backpack`);
            log.warn(err.message);
            if (job.strangifyCallback) job.strangifyCallback(err);
            return this.finishedProcessingJob(err);
        }
        const weapon = backpack?.find(i => i.id === job.weaponId);
        if (!weapon) {
            const err = new Error(`applyStrangifier: weapon ${job.weaponId} not found in backpack`);
            log.warn(err.message);
            if (job.strangifyCallback) job.strangifyCallback(err);
            return this.finishedProcessingJob(err);
        }

        let settled = false;
        const originalWeaponId = String(weapon.id);

        const cleanup = (): void => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            this.bot.tf2.removeListener('itemAcquired', onItemAcquired);
            // @ts-ignore
            this.bot.tf2.removeListener('itemChanged', onItemChanged);
            this.bot.tf2.removeListener('disconnectedFromGC', onDisconnected);
            // @ts-ignore
            this.bot.tf2.removeListener('applyXifierResponse', onXifierResponse);
        };

        // Log the GC response code — 0 typically means accepted
        const onXifierResponse = (result: number): void => {
            log.debug(`applyStrangifier: applyXifierResponse result=${result} (strangifier ${strangifier.id})`);
        };
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.once('applyXifierResponse', onXifierResponse);

        log.debug(`applyStrangifier: applying strangifier ${strangifier.id} to weapon ${weapon.id} via ApplyXifier`);
        (this.bot.tf2 as any).applyStrangifierOrUnusualifier(weapon.id, strangifier.id);

        // Strangifying makes the weapon Strange quality (11) — either a new GC item is spawned
        // (strangifier consumed + new weapon issued) or the same item is updated in-place.
        const isStrange = (item: TF2GCItem): boolean => (item as unknown as { quality?: number }).quality === 11;

        // Catches weapon created as a new GC item (strangifier consumed + new weapon spawned)
        const onItemAcquired = (item: TF2GCItem): void => {
            if (!isStrange(item)) return;
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            log.debug(`applyStrangifier: new Strange weapon acquired ${item.id} (defidx ${item.def_index})`);
            if (job.strangifyCallback) job.strangifyCallback(null, String(item.id));
            this.finishedProcessingJob();
        };

        // Catches weapon modified in-place via SO_Update (same ID, quality changed to Strange)
        const onItemChanged = (oldItem: TF2GCItem, newItem: TF2GCItem): void => {
            if (String(newItem.id) !== originalWeaponId) return;
            if (!isStrange(newItem)) return;
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            log.debug(`applyStrangifier: weapon ${originalWeaponId} modified in-place to Strange quality`);
            if (job.strangifyCallback) job.strangifyCallback(null, originalWeaponId);
            this.finishedProcessingJob();
        };

        const onDisconnected = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(applyTimeout);
            cleanup();
            const err = new Error('Disconnected from TF2 GC during strangifier application');
            if (job.strangifyCallback) job.strangifyCallback(err);
            this.finishedProcessingJob(err);
        };

        const applyTimeout = setTimeout(() => {
            if (settled) return;
            // Last-chance check: weapon modified in-place but event was missed
            const updatedWeapon = ((this.bot.tf2 as any).backpack as TF2GCItem[])?.find(i => i.id === originalWeaponId);
            const strange = updatedWeapon ? isStrange(updatedWeapon) : false;
            settled = true;
            cleanup();
            if (strange) {
                log.debug(`applyStrangifier: weapon ${originalWeaponId} modified in place (caught at timeout)`);
                if (job.strangifyCallback) job.strangifyCallback(null, originalWeaponId);
                this.finishedProcessingJob();
            } else {
                const err = new Error(`applyStrangifier: timed out waiting for strangifier application on weapon ${originalWeaponId}`);
                log.warn(err.message);
                if (job.strangifyCallback) job.strangifyCallback(err);
                this.finishedProcessingJob(err);
            }
        }, 30000);

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemAcquired', onItemAcquired);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('itemChanged', onItemChanged);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on('disconnectedFromGC', onDisconnected);
    }

    private handleCraftJobWeapon(job: Job): void {
        if (!this.canProcessJobWeapon(job)) {
            return this.finishedProcessingJob(new Error("Can't process weapon crafting job"));
        }

        const inventory = this.bot.inventoryManager.getInventory;

        const assetids = inventory.findBySKU(job.sku, true).filter(assetid => !this.bot.trades.isInTrade(assetid));

        const ids = assetids.splice(0, 2);
        log.debug('Sending weapon craft request');
        this.bot.tf2.craft(ids);

        const gainSKU = '5000;6';
        this.listenForEvent(
            'craftingComplete',
            (recipe: number, itemsGained: string[]) => {
                // Remove items used for recipe
                ids.forEach(assetid => inventory.removeItem(assetid));

                // Add items gained
                log.debug('itemsGained', itemsGained);
                itemsGained.forEach(assetid => inventory.addItem(gainSKU, assetid));

                this.finishedProcessingJob();
            },
            err => {
                this.finishedProcessingJob(err);
            }
        );
    }

    private handleCraftJobClassWeapon(job: Job): void {
        if (!this.canProcessJobWeapon(job)) {
            return this.finishedProcessingJob(new Error("Can't process class weapon crafting job"));
        }

        const inventory = this.bot.inventoryManager.getInventory;
        const assetids1 = inventory.findBySKU(job.skus[0], true).filter(assetid => !this.bot.trades.isInTrade(assetid));
        const assetids2 = inventory.findBySKU(job.skus[1], true).filter(assetid => !this.bot.trades.isInTrade(assetid));

        const id1 = assetids1[0];
        const id2 = assetids2[0];
        log.debug('Sending weapon craft request');
        this.bot.tf2.craft([id1, id2]);

        const gainSKU = '5000;6';
        this.listenForEvent(
            'craftingComplete',
            (recipe: number, itemsGained: string[]) => {
                // Remove items used for recipe
                inventory.removeItem(id1);
                inventory.removeItem(id2);

                // Add items gained
                log.debug('itemsGained', itemsGained);
                itemsGained.forEach(assetid => inventory.addItem(gainSKU, assetid));

                this.finishedProcessingJob();
            },
            err => {
                this.finishedProcessingJob(err);
            }
        );
    }

    private handleUseOrDeleteOrRemoveAttributesJob(job: Job): void {
        log.debug('Sending ' + job.type + ' request');

        if (job.type === 'use') {
            this.bot.tf2.useItem(job.assetid);
        } else if (job.type === 'delete') {
            this.bot.tf2.deleteItem(job.assetid);
        } else if (job.type === 'removeAttributes') {
            try {
                this.bot.tf2.removeItemAttribute(job.assetid, job.attribute);
            } catch (err) {
                return this.finishedProcessingJob(
                    new Error(
                        `Unable to process removeAttributes (${job.attribute}) job for ${job.sku} (${
                            job.assetid
                        }): ${JSON.stringify(err)}`
                    )
                );
            }
        }

        let timeoutDelete: NodeJS.Timeout;

        const cancelDelete = this.listenForEvent(
            'itemRemoved',
            (item: TF2GCItem) => {
                clearTimeout(timeoutDelete);
                timeoutDelete = setTimeout(() => {
                    // 1 second after the last item removed, we will mark the job as finished
                    cancelDelete();
                    this.finishedProcessingJob();
                }, 1000);

                log.debug('itemRemoved', item);

                this.bot.inventoryManager.getInventory.removeItem(item.id);

                // Clear fail timeout
                return { success: false, clearTimeout: true };
            },
            () => {
                this.finishedProcessingJob();
            },
            err => {
                if (err.message === 'Canceled') {
                    // Was canceled because of timeout
                    this.finishedProcessingJob();
                } else {
                    // Job failed
                    this.finishedProcessingJob(err);
                }
            }
        );

        if (['use', 'removeAttributes'].includes(job.type)) {
            let timeoutUse: NodeJS.Timeout;
            const cancelUse = this.listenForEvent(
                'itemAcquired',
                (item: TF2GCItem) => {
                    clearTimeout(timeoutUse);
                    timeoutUse = setTimeout(() => {
                        // 1 second after the last item acquired, we will mark the job as finished
                        cancelUse();
                        this.finishedProcessingJob();
                    }, 1000);

                    const sku = job.type === 'removeAttributes' ? job.sku : `${item.def_index};${item.quality}`;

                    log.debug('itemAcquired', {
                        sku,
                        assetid: item.id,
                        item
                    });

                    // this is fine
                    const isNotTradable = item.attribute.some(attr => attr.def_index === 153);

                    this.bot.inventoryManager.getInventory[isNotTradable ? 'addNonTradableItem' : 'addItem'](
                        sku,
                        item.id
                    );

                    // Clear fail timeout
                    return { success: false, clearTimeout: true };
                },
                () => {
                    this.finishedProcessingJob();
                },
                err => {
                    if (err.message === 'Canceled') {
                        // Was canceled because of timeout
                        this.finishedProcessingJob();
                    } else {
                        // Job failed
                        this.finishedProcessingJob(err);
                    }
                }
            );
        }
    }

    private handleSortJob(job: Job): void {
        log.debug('Sending sort request');

        this.bot.tf2.sortBackpack(job.sortType);
        let timeout: NodeJS.Timeout;

        const cancel = this.listenForEvent(
            'itemChanged',
            () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    // 1 second after the last item has changed we will mark the job as finished
                    cancel();
                    this.finishedProcessingJob();
                }, 1000);

                // Clear fail timeout
                return { success: false, clearTimeout: true };
            },
            () => {
                this.finishedProcessingJob();
            },
            err => {
                if (err.message === 'Canceled') {
                    // Was canceled because of timeout
                    this.finishedProcessingJob();
                } else {
                    // Job failed
                    this.finishedProcessingJob(err);
                }
            }
        );
    }

    /**
     * Listens for GC event
     *
     * @remarks Calls onSuccess function when event has been emitted.
     *
     * @param event - Event to listen for
     * @param onSuccess - Function to call when the event is emitted
     * @param onFail - Function to call when canceled, timed out, or disconnected from GC
     *
     * @returns Call this function to cancel
     */
    private listenForEvent(
        event: string,
        onSuccess: (...args: any[]) => void,
        onFail: (err: Error) => void
    ): () => void;

    /**
     * Listens for GC event
     *
     * @remarks Calls iterator every time event is emittet, if iterator returns success=true
     * then onSuccess is called with the values from the event.
     *
     * @param event - Event to listen for
     * @param iterator - Function to call when event is emitted
     * @param onSuccess - Function to call on success
     * @param onFail - Function to call when canceled, timed out, or disconnected from GC
     *
     * @returns Call this function to cancel
     */
    private listenForEvent(
        event: string,
        iterator: (...args: any[]) => { success: boolean; clearTimeout?: boolean },
        onSuccess: (...args: any[]) => void,
        onFail: (err: Error) => void
    ): () => void;

    private listenForEvent(...args: ListenForEvent): () => void {
        const event = args[0];
        const iterator =
            args.length === 4
                ? args[1]
                : function (): {
                      success: boolean;
                      clearTimeout?: boolean;
                  } {
                      return { success: true };
                  };
        const successCallback = args.length === 4 ? args[2] : args[1];
        const failCallback = args.length === 4 ? args[3] : args[2];

        function onEvent(...args: any[]): void {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            const response = iterator(...args);

            if (response.success) {
                removeListeners();
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                successCallback(...args);
            } else if (response.clearTimeout === true) {
                clearTimeout(timeout);
            }
        }

        function onDisconnected(): void {
            removeListeners();

            failCallback(new Error('Disconnected from TF2 GC'));
        }

        function onTimeout(): void {
            removeListeners();

            failCallback(new Error('Timed out'));
        }

        function onCancel(): void {
            removeListeners();

            failCallback(new Error('Canceled'));
        }

        const removeListeners = (): void => {
            clearTimeout(timeout);
            this.bot.tf2.removeListener(event, onEvent);
            this.bot.tf2.removeListener('disconnectedFromGC', onDisconnected);
        };

        const timeout = setTimeout(onTimeout, 10000);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.bot.tf2.on(event, onEvent);

        return onCancel;
    }

    private finishedProcessingJob(err: Error | null = null): void {
        const job = this.jobs.splice(0, 1)[0];

        if (job !== undefined && job.callback) {
            job.callback(err);
        }

        this.processingQueue = false;

        this.handleJobQueue();
    }

    private canProcessJob(job: Job): boolean {
        const inventory = this.bot.inventoryManager.getInventory;

        if (['smelt', 'combine'].includes(job.type)) {
            const assetids = inventory
                .findBySKU(String(job.defindex) + ';6', true)
                .filter(assetid => !this.bot.trades.isInTrade(assetid));

            const assetidsCount = assetids.length;

            return (job.type === 'smelt' && assetidsCount > 0) || (job.type === 'combine' && assetidsCount >= 3);
        } else if (['use', 'delete'].includes(job.type)) {
            return inventory.findByAssetid(job.assetid) !== null;
        }

        return true;
    }

    private canProcessJobWeapon(job: Job): boolean {
        const inventory = this.bot.inventoryManager.getInventory;
        if (job.type === 'combineWeapon') {
            const assetids = inventory.findBySKU(job.sku, true).filter(assetid => !this.bot.trades.isInTrade(assetid));

            return job.type === 'combineWeapon' && assetids.length >= 2;
        } else if (job.type === 'combineClassWeapon') {
            const assetids1 = inventory
                .findBySKU(job.skus[0], true)
                .filter(assetid => !this.bot.trades.isInTrade(assetid));
            const assetids2 = inventory
                .findBySKU(job.skus[1], true)
                .filter(assetid => !this.bot.trades.isInTrade(assetid));

            return job.type === 'combineClassWeapon' && assetids1.length >= 1 && assetids2.length >= 1;
        }
        return true;
    }

    /**
     * Resolves once `bot.tf2.backpack` can be trusted to describe what the bot actually owns.
     *
     * node-tf2 assigns `backpack` exactly once per GC session, from SOCacheSubscribed
     * (`handlers.js:154`), and thereafter only mutates it in response to itemAcquired /
     * itemChanged / itemRemoved. When the GC session ends it clears `haveGCSession` and emits
     * `disconnectedFromGC` but leaves `backpack` untouched — so the array silently stops tracking
     * reality instead of emptying or flagging itself. Every read after that point looks completely
     * normal and returns the last snapshot, however old.
     *
     * That is not theoretical: on 2026-08-10 the session lapsed during a 7.5h idle stretch, the
     * backpack froze at 705 items, and 28 fabricators a customer had just traded in were invisible
     * to the intake diff. It reported "0 new items" three times and abandoned them, while Steam's
     * own inventory API showed all 733 items present. Retrying for longer could never have helped —
     * no session means no events means nothing to observe.
     *
     * `haveGCSession` is the only signal node-tf2 offers, so anything deciding item ownership has
     * to consult it first. Waiting on `backpackLoaded` rather than `connectedToGC` is deliberate:
     * ClientWelcome fires first and only proves a session exists, while SOCacheSubscribed is what
     * actually replaces the array we are about to read.
     */
    ensureFreshBackpack(): Promise<void> {
        if (this.bot.tf2.haveGCSession) {
            // Live session — incremental item events have been keeping the array current.
            return Promise.resolve();
        }

        log.debug('ensureFreshBackpack: no GC session, backpack is a stale snapshot — reconnecting');

        // Subscribed before connectToGC resolves, because SOCacheSubscribed can arrive in the same
        // tick as ClientWelcome; registering afterwards would miss it and stall until the timeout.
        const backpackLoaded = new Promise<void>((resolve, reject) => {
            this.listenForEvent(
                'backpackLoaded',
                () => resolve(),
                (err: Error) => reject(err)
            );
        });

        return this.connectToGC().then(() => backpackLoaded);
    }

    private connectToGC(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.isConnectedToGC) {
                // Not playing TF2
                this.bot.client.gamesPlayed(440);
            }

            if (this.bot.tf2.haveGCSession) {
                // Already connected to TF2 GC
                return resolve();
            }

            const bot = this.bot;

            this.listenForEvent(
                'connectedToGC',
                () => {
                    // running connectToGC iterator...
                    return { success: true };
                },
                () => {
                    // onSuccess connectToGC.
                    resolve();
                },
                () => {
                    // onFail connectToGC.
                    bot.client.gamesPlayed([]);
                    bot.updateSteamGamePresence();
                    reject(new Error('Could not connect to TF2 GC, restarting TF2..'));
                }
            );
        });
    }

    private get isConnectedToGC(): boolean {
        return this.bot.client._playingAppIds.some(game => game == 440);
    }
}

interface TF2GCItem {
    attribute: Attribute[];
    equipped_state: any[];
    id: string;
    account_id: number;
    inventory: number;
    def_index: number;
    quantity: number;
    level: number;
    quality: number;
    flags: number;
    origin: number;
    custom_name: string | null;
    custom_desc: string | null;
    interior_item: any | null;
    in_use: boolean;
    style: number;
    original_id: string | null;
    contains_equipped_state: boolean | null;
    contains_equipped_state_v2: boolean | null;
    position: number;
}

interface Attribute {
    def_index: number;
    value: any;
    value_bytes: {
        type: string;
        data: number[];
    };
}
