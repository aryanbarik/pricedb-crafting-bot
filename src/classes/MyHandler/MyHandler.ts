import SKU from '@tf2autobot/tf2-sku';
import { EClanRelationship, EFriendRelationship, EPersonaState } from 'steam-user';
import TradeOfferManager, {
    TradeOffer,
    PollData,
    ItemsDict,
    Meta,
    WrongAboutOffer,
    Prices,
    Items,
    CustomError,
    ActionType
} from '@tf2autobot/tradeoffer-manager';

import pluralize from 'pluralize';
import SteamID from 'steamid';
import Currencies from '@tf2autobot/tf2-currencies';
import { UnknownDictionary } from '../../types/common';

import { accepted, declined, cancelled, acceptEscrow, invalid } from './offer/notify/export-notify';
import { processAccepted, updateListings, PriceCheckQueue } from './offer/accepted/exportAccepted';
import processDeclined from './offer/processDeclined';
import { sendReview } from './offer/review/export-review';
import { keepMetalSupply, craftDuplicateWeapons, craftClassWeapons } from './utils/export-utils';

import { Blocked, BPTFGetUserInfo } from './interfaces';

import Handler, { OnRun } from '../Handler';
import Bot from '../Bot';
import Pricelist, { Entry, PricesDataObject, PricesObject } from '../Pricelist';
import Commands from '../Commands/Commands';
import CartQueue from '../Carts/CartQueue';
import Inventory from '../Inventory';
import TF2Inventory from '../TF2Inventory';
import Autokeys from '../Autokeys/Autokeys';

import { Paths } from '../../resources/paths';
import log from '../../lib/logger';
import * as files from '../../lib/files';
import { exponentialBackoff } from '../../lib/helpers';
import { fetchInventoryViaExpressLoad } from '../../lib/expressLoadInventory';
import { fetchTradeUrlToken, notifyComponentOffer } from '../../lib/craftingWebsiteApi';
import { hasExcludedHalloweenSpell, isFestiveWeaponDefindex } from '../../lib/weaponExclusions';

import { noiseMakers } from '../../lib/data';
import { sendAlert } from '../DiscordWebhook/export';
import { summarize, uptime, getHighValueItems, testPriceKey } from '../../lib/tools/export';

import genPaths from '../../resources/paths';
import IPricer from '../IPricer';
import Options, { OfferType } from '../Options';
import SteamTradeOfferManager from '@tf2autobot/tradeoffer-manager';
import filterAxiosError from '@tf2autobot/filter-axios-error';

import sendTf2SystemMessage from '../DiscordWebhook/sendTf2SystemMessage';
import sendTf2DisplayNotification from '../DiscordWebhook/sendTf2DisplayNotification';
import sendTf2ItemBroadcast from '../DiscordWebhook/sendTf2ItemBroadcast';
import { apiRequest } from '../../lib/apiRequest';
import {
    decodeFabricatorSlots,
    buildCraftComponents,
    findPartnerComponents,
    extractTargetWeaponName,
    ksKitTierFromName,
    KS_KIT_DEFINDEXES,
    FABRICATOR_DEFINDEXES,
    ATTR_TOOL_TARGET_ITEM,
    getItemAttrValue
} from '../../lib/fabricatorSlots';

const filterReasons = (reasons: string[]) => {
    const filtered = new Set(reasons);
    return [...filtered];
};


export default class MyHandler extends Handler {
    readonly commands: Commands;

    readonly autokeys: Autokeys;

    readonly cartQueue: CartQueue;

    private groupsStore: string[];

    private get opt(): Options {
        return this.bot.options;
    }

    private get groups(): string[] {
        if (this.groupsStore === undefined) {
            const groups = this.opt.groups;

            if (groups !== null && Array.isArray(groups)) {
                groups.forEach(groupID64 => {
                    if (!new SteamID(groupID64).isValid()) {
                        throw new Error(`Invalid group SteamID64 "${groupID64}"`);
                    }
                });

                this.groupsStore = groups;
                return groups;
            }
        } else {
            return this.groupsStore;
        }
    }

    private friendsToKeepStore: string[];

    get friendsToKeep(): string[] {
        if (this.friendsToKeepStore === undefined) {
            const friendsToKeep = this.opt.keep.concat(this.bot.getAdmins.map(steamID => steamID.getSteamID64()));

            if (friendsToKeep !== null && Array.isArray(friendsToKeep)) {
                friendsToKeep.forEach(steamID64 => {
                    if (!new SteamID(steamID64).isValid()) {
                        throw new Error(`Invalid SteamID64 "${steamID64}"`);
                    }
                });

                this.friendsToKeepStore = friendsToKeep;
                return friendsToKeep;
            }
        } else {
            return this.friendsToKeepStore;
        }
    }

    private get minimumScrap(): number {
        return this.opt.crafting.metals.minScrap;
    }

    private get minimumReclaimed(): number {
        return this.opt.crafting.metals.minRec;
    }

    private get combineThreshold(): number {
        return this.opt.crafting.metals.threshold;
    }

    get dupeCheckEnabled(): boolean {
        return this.opt.offerReceived.duped.enableCheck;
    }

    get minimumKeysDupeCheck(): number {
        return this.opt.offerReceived.duped.minKeys;
    }

    get isWeaponsAsCurrency(): { enable: boolean; withUncraft: boolean } {
        return {
            enable: this.opt.miscSettings.weaponsAsCurrency.enable,
            withUncraft: this.opt.miscSettings.weaponsAsCurrency.withUncraft
        };
    }

    private get invalidValueException(): number {
        return Currencies.toScrap(this.opt.offerReceived.invalidValue.exceptionValue.valueInRef);
    }

    private hasInvalidValueException = false;

    get customGameName(): string {
        const customGameName = this.opt.miscSettings.game.presence?.customName;
        return customGameName ? customGameName : `TF2Autobot`;
    }

    private get isCraftingManual(): boolean {
        return this.opt.crafting.manual;
    }

    private get isDeletingUntradableJunk(): boolean {
        return this.opt.miscSettings.deleteUntradableJunk.enable;
    }

    private isPremium = false;

    private botName = '';

    private botAvatarURL = '';

    private botSteamID: SteamID;

    get getBotInfo(): BotInfo {
        return { name: this.botName, avatarURL: this.botAvatarURL, steamID: this.botSteamID, premium: this.isPremium };
    }

    recentlySentMessage: UnknownDictionary<number> = {};

    private sentSummary: UnknownDictionary<boolean> = {};

    private resetSentSummaryTimeout: NodeJS.Timeout;

    // fabricator assetid -> partner steamID64, for fabricators stuck at the intake step
    // after exhausting inventory-fetch retries. Populated in handleCraftingIntake, consumed
    // by retryHeldIntake (wired to the admin-only !retryintake command).
    private heldIntakeFabricators = new Map<string, string>();

    // Backpack IDs of fabricators already claimed by an intake trade's backpack-diff resolution.
    // When a customer sends several single-fabricator intake offers close together, each offer's
    // preTradeIds snapshot is taken at OFFER CREATION time — if a sibling offer's fabricator lands
    // in the backpack before this offer's own 5s-later diff check runs, that sibling's item shows
    // up as an extra "new" fabricator too, tripping the expectedCount mismatch below ("Ambiguous
    // fabricator match") even though nothing is actually wrong. Excluding already-claimed IDs here
    // prevents one offer's diff from re-matching another's fabricator.
    private claimedIntakeFabricatorIds = new Set<string>();

    // partner steamID64 -> asset IDs sitting in the bot's backpack awaiting return, for any
    // outgoing crafting-service offer (components request, refund, or final results) that
    // exhausted its send retries. Populated wherever such a send permanently fails, consumed by
    // retryHeldReturn (wired to the admin-only !retryreturn command).
    private heldReturnItems = new Map<string, string[]>();

    // Backpack IDs the bot is holding on someone else's behalf: received in a crafting trade but not
    // yet crafted away or returned. Only self-fill reads this, and only to avoid spending a
    // customer's components on the admin's fabricator. The GC job queue is serial, so it is not
    // needed for the selection window itself — it covers the much longer gap between "trade
    // accepted" and "results offer accepted", during which a second trade can arrive.
    // In-memory like the three maps above, so a restart forgets it; the pricelist stock floor in
    // buildSelfFillExcludeIds is the backstop for that.
    private craftingInFlightIds = new Set<string>();

    private paths: Paths;

    get getPaths(): Paths {
        return this.paths;
    }

    private isUpdating = false;

    set isUpdatingStatus(setStatus: boolean) {
        this.isUpdating = setStatus;
    }

    private retryRequest: NodeJS.Timeout;

    private poller: NodeJS.Timeout;

    private refreshTimeout: NodeJS.Timeout;

    private classWeaponsTimeout: NodeJS.Timeout;

    private pollDataInterval: NodeJS.Timeout;

    private heldItemsRetryInterval: NodeJS.Timeout;

    private retryingHeldItems = false;

    constructor(public bot: Bot, private priceSource: IPricer) {
        super(bot);

        this.commands = new Commands(bot, priceSource);
        this.cartQueue = new CartQueue(bot);
        this.autokeys = new Autokeys(bot);

        this.paths = genPaths(this.opt.steamAccountName);

        PriceCheckQueue.setBot(this.bot);
        PriceCheckQueue.setRequestCheckFn(this.priceSource.requestCheck.bind(this.priceSource));
    }

    onRun(): Promise<OnRun> {
        this.poller = setInterval(() => {
            this.recentlySentMessage = {};
        }, 1000);

        return Promise.all([
            files.readFile(this.paths.files.pricelist, true),
            files.readFile(this.paths.files.loginAttempts, true),
            files.readFile(this.paths.files.pollData, true),
            files.readFile(this.paths.files.blockedList, true)
        ]).then(
            ([pricelist, loginAttempts, pollData, blockedList]: [PricesDataObject, number[], PollData, Blocked]) => {
                return { pricelist, loginAttempts, pollData, blockedList };
            }
        );
    }

    onReady(): void {
        log.info(
            `TF2Autobot v${process.env.BOT_VERSION} is ready | ${pluralize(
                'item',
                this.bot.pricelist.getLength,
                true
            )} in pricelist | Listings cap: ${String(this.bot.listingManager.cap)} | Startup time: ${process
                .uptime()
                .toFixed(0)} s`
        );

        this.bot.startSteamGamePresenceUpdater();
        this.bot.client.setPersona(EPersonaState.Online);

        this.botSteamID = this.bot.client.steamID;

        // Get Premium info from backpack.tf
        this.getBPTFAccountInfo().catch(() => {
            // Ignore error
        });

        if (this.isCraftingManual === false) {
            // Smelt / combine metal if needed
            keepMetalSupply(this.bot, this.minimumScrap, this.minimumReclaimed, this.combineThreshold);

            // Craft duplicate weapons
            craftDuplicateWeapons(this.bot)
                .then(() => {
                    return craftClassWeapons(this.bot);
                })
                .catch(err => {
                    log.warn('Failed to craft duplicated craft/class weapons', err);
                });
        }

        if (this.isDeletingUntradableJunk) {
            // Delete untradable junk
            this.deleteUntradableJunk();
        }

        // Auto sell and buy keys if ref < minimum
        this.autokeys.check();

        // Sort the inventory after crafting / combining metal
        this.sortInventory();

        // Check friend requests that we got while offline
        this.checkFriendRequests();

        // Check group invites that we got while offline
        this.checkGroupInvites();

        // Initialize send stats
        this.bot.sendStats();

        // Check for missing listings every 30 minutes, initiate setInterval 5 minutes after start
        this.refreshTimeout = setTimeout(() => {
            this.bot.startAutoRefreshListings();
        }, 5 * 60 * 1000);

        // Price configured SKUs (robot parts) off competing backpack.tf buy orders instead of the
        // pricer. Started here so the bp.tf API key obtained during login is available.
        this.bot.startCompetitiveBuyPricer();

        this.pollDataInterval = setInterval(this.refreshPollDataPath.bind(this), 24 * 60 * 60 * 1000);

        // Automatically retry any held crafting-service items (stuck intake fabricators, stuck
        // return offers) every few minutes, so transient Steam failures resolve themselves
        // without needing an admin to run !retryintake/!retryreturn manually.
        this.heldItemsRetryInterval = setInterval(() => {
            void this.retryAllHeldItems();
        }, 3 * 60 * 1000);

        // Send notification to admin/Discord Webhook if there's any item failed to go through updateOldPrices
        const failedToUpdateOldPrices = this.bot.pricelist.failedUpdateOldPrices;

        if (failedToUpdateOldPrices.length > 0) {
            const dw = this.opt.discordWebhook.sendAlert;
            const isDwEnabled = dw.enable && dw.url.main !== '';

            if (this.opt.sendAlert.enable && this.opt.sendAlert.failedToUpdateOldPrices) {
                if (isDwEnabled) {
                    sendAlert('failedToUpdateOldPrices', this.bot, '', null, null, failedToUpdateOldPrices);
                } else {
                    this.bot.messageAdmins(
                        `Failed to update old prices (probably because autoprice is set to true but item does not exist` +
                            ` on the pricer source):\n\n${failedToUpdateOldPrices.join(
                                '\n'
                            )}\n\nAll items above has been temporarily disabled.`,
                        []
                    );
                }
            }

            this.bot.pricelist.resetFailedUpdateOldPrices = 0;
        }

        // Send notification to admin/Discord Webhook if there's any partially priced item got reset on updateOldPrices
        const bulkUpdatedPartiallyPriced = this.bot.pricelist.partialPricedUpdateBulk;

        const count = bulkUpdatedPartiallyPriced.length;
        if (count > 0 && count < 20) {
            // we send only if less than 20
            const dw = this.opt.discordWebhook.sendAlert;
            const isDwEnabled = dw.enable && (dw.url.main !== '' || dw.url.partialPriceUpdate !== '');

            const msg = `All items below has been updated with partial price:\n\n- ${bulkUpdatedPartiallyPriced.join(
                '\n- '
            )}`;

            if (this.opt.sendAlert.enable && this.opt.sendAlert.partialPrice.onBulkUpdatePartialPriced) {
                if (isDwEnabled) {
                    sendAlert('onBulkUpdatePartialPriced', this.bot, msg);
                } else {
                    this.bot.messageAdmins(msg, []);
                }
            }
        }

        // Send notification to admin/Discord Webhook if there's any partially priced item got reset on updateOldPrices
        const bulkResetPartiallyPriced = this.bot.pricelist.autoResetPartialPriceBulk;

        if (bulkResetPartiallyPriced.length > 0) {
            const dw = this.opt.discordWebhook.sendAlert;
            const isDwEnabled = dw.enable && (dw.url.main !== '' || dw.url.partialPriceUpdate !== '');

            const msg =
                `All partially priced items below has been reset to use the current prices ` +
                `because no longer in stock or exceed the threshold:\n\n• ${bulkResetPartiallyPriced
                    .map(sku => {
                        const name = this.bot.schema.getName(SKU.fromString(sku), this.opt.tradeSummary.showProperName);
                        return `${isDwEnabled ? `[${name}](https://pricedb.io/item/${sku})` : name} (${sku})`;
                    })
                    .join('\n• ')}`;

            if (this.opt.sendAlert.enable && this.opt.sendAlert.partialPrice.onResetAfterThreshold) {
                if (isDwEnabled) {
                    sendAlert('autoResetPartialPriceBulk', this.bot, msg);
                } else {
                    this.bot.messageAdmins(msg, []);
                }
            }
        }
    }

    onShutdown(): Promise<void> {
        if (this.poller) {
            clearInterval(this.poller);
        }

        if (this.refreshTimeout) {
            clearInterval(this.refreshTimeout);
        }

        if (this.bot.sendStatsInterval) {
            clearInterval(this.bot.sendStatsInterval);
        }

        if (this.bot.autoRefreshListingsInterval) {
            clearInterval(this.bot.autoRefreshListingsInterval);
        }

        if (this.classWeaponsTimeout) {
            clearTimeout(this.classWeaponsTimeout);
        }

        if (this.retryRequest) {
            clearTimeout(this.retryRequest);
        }

        if (this.bot.periodicCheckAdmin) {
            clearInterval(this.bot.periodicCheckAdmin);
        }

        if (this.pollDataInterval) {
            clearInterval(this.pollDataInterval);
        }

        return new Promise(resolve => {
            if (this.opt.autokeys.enable) {
                log.debug('Disabling Autokeys and disabling key entry in the pricelist...');
                this.autokeys
                    .disable(this.bot.pricelist.getKeyPrices)
                    .catch(() => {
                        log.warn('Unable to disable Mann Co. Supply Crate Key...');
                    })
                    .finally(() => {
                        if (!this.bot.listingManager || this.bot.listingManager.ready !== true) {
                            // We have not set up the listing manager, don't try and remove listings
                            return resolve();
                        }

                        // Remove backpack.tf listings first and then crit.tf listings
                        this.bot.listings
                            .removeAll()
                            .catch((err: Error) =>
                                log.warn('Failed to remove all listings on shutdown (autokeys was enabled): ', err)
                            )
                            .finally(() => {
                                // Remove crit.tf listings
                                if (this.bot.pricedbStoreManager) {
                                    this.bot.pricedbStoreManager
                                        .deleteAllListings()
                                        .catch((err: Error) =>
                                            log.warn('Failed to remove pricedb.io listings on shutdown: ', err)
                                        )
                                        .finally(() => resolve());
                                } else {
                                    resolve();
                                }
                            });
                    });
            } else {
                if (!this.bot.listingManager || this.bot.listingManager.ready !== true) {
                    // We have not set up the listing manager, don't try and remove listings
                    return resolve();
                }

                // Remove backpack.tf listings
                this.bot.listings
                    .removeAll()
                    .catch((err: Error) => log.warn('Failed to remove all listings on shutdown: ', err))
                    .finally(() => {
                        // Remove crit.tf listings
                        if (this.bot.pricedbStoreManager) {
                            this.bot.pricedbStoreManager
                                .deleteAllListings()
                                .catch((err: Error) => log.warn('Failed to remove crit.tf listings on shutdown: ', err))
                                .finally(() => resolve());
                        } else {
                            resolve();
                        }
                    });
            }
        });
    }

    onLoggedOn(): void {
        if (this.bot.isReady) {
            this.bot.client.setPersona(EPersonaState.Online);
            this.bot.updateSteamGamePresence(true);
        }
    }

    onDisconnected(eresult: number, msg?: string): void {
        log.warn('Lost connection to Steam', { eresult, msg });
        // Connection will be handled by Bot.onDisconnected
    }

    onLoggedOff(): void {
        log.info('Logged off from Steam');
    }

    async onMessage(steamID: SteamID, message: string, respondChat = true): Promise<void | string> {
        if (!this.opt.commands.enable) {
            if (!this.bot.isAdmin(steamID)) {
                const custom = this.opt.commands.customDisableReply;
                const msg = custom ? custom : '❌ Command function is disabled by the owner.';
                if (respondChat) {
                    return this.bot.sendMessage(steamID, msg);
                } else {
                    return msg;
                }
            }
        }

        if (this.bot.isHalted && !this.bot.isAdmin(steamID)) {
            const custom = this.opt.customMessage.halted;
            const msg = custom ? custom : '❌ The bot is not operational right now. Please come back later.';
            if (respondChat) {
                return this.bot.sendMessage(steamID, msg);
            } else {
                return msg;
            }
        }

        if (this.isUpdating) {
            const msg = '⚠️ The bot is updating, please wait until I am back online.';
            if (respondChat) {
                return this.bot.sendMessage(steamID, msg);
            } else {
                return msg;
            }
        }

        if (steamID.type !== 0) {
            const steamID64 = steamID.toString();
            if (!this.bot.friends.isFriend(steamID64)) {
                return;
            }

            const friend = this.bot.friends.getFriend(steamID64);

            if (friend === null) {
                log.info(`Message from ${steamID64}: ${message}`);
            } else {
                log.info(`Message from ${friend.player_name} (${steamID64}): ${message}`);
            }

            if (this.recentlySentMessage[steamID64] !== undefined && this.recentlySentMessage[steamID64] >= 1) {
                return;
            }

            this.recentlySentMessage[steamID64] =
                (this.recentlySentMessage[steamID64] === undefined ? 0 : this.recentlySentMessage[steamID64]) + 1;
        } else if (steamID instanceof SteamID && steamID.redirectAnswerTo) {
            if (
                this.recentlySentMessage[steamID.redirectAnswerTo.author.id] !== undefined &&
                this.recentlySentMessage[steamID.redirectAnswerTo.author.id] >= 1
            ) {
                return;
            }

            this.recentlySentMessage[steamID.redirectAnswerTo.author.id] =
                (this.recentlySentMessage[steamID.redirectAnswerTo.author.id] === undefined
                    ? 0
                    : this.recentlySentMessage[steamID.redirectAnswerTo.author.id]) + 1;
        }

        await this.commands.processMessage(steamID, message);
    }

    onRefreshToken(token: string): void {
        log.debug('New refresh key');

        files.writeFile(this.paths.files.refreshToken, token, false).catch(err => {
            log.warn('Failed to save refresh token: ', err);
        });
    }

    onLoginAttempts(attempts: number[]): void {
        files.writeFile(this.paths.files.loginAttempts, attempts, true).catch(err => {
            log.warn('Failed to save login attempts: ', err);
        });
    }

    onFriendRelationship(steamID: SteamID, relationship: number): void {
        if (relationship === EFriendRelationship.Friend) {
            this.onNewFriend(steamID);
            this.checkFriendsCount(steamID);
        } else if (relationship === EFriendRelationship.RequestRecipient) {
            this.respondToFriendRequest(steamID);
        }
    }

    onGroupRelationship(groupID: SteamID, relationship: number): void {
        log.debug('Group relation changed', { steamID: groupID, relationship: relationship });
        if (relationship === EClanRelationship.Invited) {
            const join = this.groups.includes(groupID.getSteamID64());

            log.info(`Got invited to group ${groupID.getSteamID64()}, ${join ? 'accepting...' : 'declining...'}`);
            this.bot.client.respondToGroupInvite(groupID, join);
        } else if (relationship === EClanRelationship.Member) {
            log.info(`Joined group ${groupID.getSteamID64()}`);
        }
    }

    onBptfAuth(auth: { apiKey: string; accessToken: string }): void {
        const details = Object.assign({ private: true }, auth);
        log.warn('Please add your backpack.tf API key and access token to your environment variables!', details);
    }

    async onNewTradeOffer(offer: TradeOffer): Promise<null | OnNewTradeOffer> {
        offer.log('info', 'is being processed...');

        // Allow sending notifications
        offer.data('notify', true);

        // If crafting class weapons still waiting, cancel it.
        clearTimeout(this.classWeaponsTimeout);

        const opt = this.opt;
        const isAdmin = this.bot.isAdmin(offer.partner);
        const partnerSteamID = offer.partner.getSteamID64();

        const items = {
            our: Inventory.fromItems(
                this.bot.client.steamID === null ? this.botSteamID : this.bot.client.steamID,
                offer.itemsToGive,
                this.bot,
                'our',
                this.bot.boundInventoryGetter
            ).getItems,
            their: Inventory.fromItems(
                offer.partner,
                offer.itemsToReceive,
                this.bot,
                isAdmin ? 'admin' : 'their',
                this.bot.boundInventoryGetter
            ).getItems
        };

        const exchange = {
            contains: { items: false, metal: false, keys: false, pricedAssets: false },
            our: {
                value: 0,
                keys: 0,
                scrap: 0,
                contains: { items: false, metal: false, keys: false, pricedAssets: false },
                pricedAssetSkus: new Set<string>(),
                pricedAssetIds: new Set<string>(),
                pricedAsset: new Map<string, string>(),
                pricedAssetSkuTotals: {}
            },
            their: {
                value: 0,
                keys: 0,
                scrap: 0,
                contains: { items: false, metal: false, keys: false, pricedAssets: false },
                pricedAssetSkus: new Set<string>(),
                pricedAssetIds: new Set<string>(),
                pricedAsset: new Map<string, string>(),
                pricedAssetSkuTotals: {}
            }
        };

        const itemsDict: ItemsDict = { our: {}, their: {} };
        const getHighValue: GetHighValue = {
            our: {
                items: {},
                isMention: false
            },
            their: {
                items: {},
                isMention: false
            }
        };

        let isDuelingNotFullUses = false;
        let isNoiseMakerNotFullUses = false;
        const noiseMakerNotFullSKUs: string[] = [];
        let hasNonTF2Items = false;
        let keyOurSide = false;
        let keyOnBothSide = false;

        const states = [false, true];
        for (let i = 0; i < states.length; i++) {
            const buying = states[i];
            const which = buying ? 'their' : 'our';
            for (const sku in items[which]) {
                if (!Object.prototype.hasOwnProperty.call(items[which], sku)) {
                    continue;
                }

                for (const entry of items[which][sku]) {
                    const { id } = entry;
                    const price = this.bot.pricelist.getPrice({ priceKey: id });
                    if (price) {
                        exchange[which].pricedAssetIds.add(id);
                        exchange[which].pricedAsset[id] = sku;
                        itemsDict[which][id] = 1;
                        exchange.contains.pricedAssets = true;
                        exchange[which].contains.pricedAssets = true;
                        exchange.contains.items = true; // we consider pricedAssets as items
                        exchange[which].contains.items = true;
                        if (exchange[which].pricedAssetSkus.has(sku)) {
                            exchange[which].pricedAssetSkuTotals[sku] += 1;
                        } else {
                            exchange[which].pricedAssetSkus.add(sku);
                            exchange[which].pricedAssetSkuTotals[sku] = 1;
                        }
                    }
                }

                let totalGeneric = 0;
                // assign amount for sku
                if (exchange[which].pricedAssetSkus.has(sku)) {
                    totalGeneric = items[which][sku].length - exchange[which].pricedAssetSkuTotals[sku];
                    if (totalGeneric > 0) {
                        itemsDict[which][sku] = totalGeneric;
                    }
                } else {
                    totalGeneric = items[which][sku].length;
                    itemsDict[which][sku] = totalGeneric;
                }

                if (!testPriceKey(sku)) {
                    // Offer contains an item that is not from TF2
                    hasNonTF2Items = true;
                }

                if (totalGeneric > 0) {
                    if (sku === '5000;6') {
                        exchange.contains.metal = true;
                        exchange[which].contains.metal = true;
                    } else if (sku === '5001;6') {
                        exchange.contains.metal = true;
                        exchange[which].contains.metal = true;
                    } else if (sku === '5002;6') {
                        exchange.contains.metal = true;
                        exchange[which].contains.metal = true;
                    } else if (sku === '5021;6') {
                        exchange.contains.keys = true;
                        exchange[which].contains.keys = true;
                        if (which === 'our') {
                            keyOurSide = true;
                        } else if (which === 'their' && keyOurSide === true) {
                            // Consider this as an invalid offer
                            keyOnBothSide = true;
                        }
                    } else {
                        exchange.contains.items = true;
                        exchange[which].contains.items = true;
                    }
                }

                // Get High-value items
                items[which][sku].forEach(item => {
                    if (item.hv !== undefined) {
                        const priceKey = this.bot.pricelist.hasPrice({ priceKey: item.id }) ? item.id : sku;
                        // If hv exist, get the high value and assign into items
                        getHighValue[which].items[priceKey] = item.hv;

                        Object.keys(item.hv).forEach(attachment => {
                            if (item.hv[attachment] !== undefined) {
                                for (const pSku in item.hv[attachment]) {
                                    if (!Object.prototype.hasOwnProperty.call(item.hv[attachment], pSku)) {
                                        continue;
                                    }

                                    if (item.hv[attachment as 's' | 'sp' | 'ks' | 'ke' | 'p'][pSku] === true) {
                                        getHighValue[which].isMention = true;
                                    }
                                }
                            }
                        });
                    } else if (item.isFullUses !== undefined) {
                        const priceKey = this.bot.pricelist.hasPrice({ priceKey: item.id }) ? item.id : sku;
                        getHighValue[which].items[priceKey] = { isFull: item.isFullUses };

                        if (which === 'their') {
                            // Only check for their side
                            if (sku === '241;6' && item.isFullUses === false) {
                                isDuelingNotFullUses = true;
                            } else if (noiseMakers.has(sku) && item.isFullUses === false) {
                                isNoiseMakerNotFullUses = true;
                                noiseMakerNotFullSKUs.push(sku);
                            }
                        }
                    }
                });
            }
        }

        offer.data('dict', itemsDict);
        offer.data('keyOurSide', keyOurSide);

        // Always check if trade partner is taking higher value items (such as spelled or strange parts) that are not in our pricelist

        const highValueMeta = {
            items: {
                our: getHighValue.our.items,
                their: getHighValue.their.items
            },
            isMention: {
                our: getHighValue.our.isMention,
                their: getHighValue.their.isMention
            }
        };

        const isContainsHighValue =
            Object.keys(getHighValue.our.items).length > 0 || Object.keys(getHighValue.their.items).length > 0;

        // Crafting service: bot gives nothing, customer sends fabricator + parts or fabricator + keys.
        // Must run before the admin check so admins also go through the craft flow.
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            const fabricatorItems = (offer.itemsToReceive as any[]).filter(
                (item: any) => typeof item.market_hash_name === 'string' && item.market_hash_name.includes('Fabricator')
            );
            if (fabricatorItems.length > 0) {
                const fabricatorAssetIds = fabricatorItems.map((i: any) => String(i.assetid));
                const otherItems = (offer.itemsToReceive as any[]).filter(
                    (item: any) => !fabricatorAssetIds.includes(String(item.assetid))
                );
                const componentItems = otherItems.filter(
                    (item: any) => item.market_hash_name !== 'Mann Co. Supply Crate Key'
                );
                const keyCount = otherItems.length - componentItems.length;

                // PAYMENT GATE (currently disabled — open pilot period).
                // To re-enable paid-only access, restore this whitelist check and remove the `true` below.
                // const isWhitelisted = isAdmin || (this.opt.craftingServiceWhitelist ?? []).includes(partnerSteamID);
                const isWhitelisted = true;

                if (isWhitelisted && componentItems.length > 0) {
                    // Mode A (self-service): user provides their own components.
                    // Components may include unapplied KS Kits + plain weapons instead of pre-applied KS weapons.
                    const componentAssetIds = componentItems.map((i: any) => String(i.assetid));
                    const kitAssetIds = componentItems
                        .filter((i: any) => {
                            const n: string = i.market_hash_name ?? '';
                            return n.includes('Killstreak') && n.includes('Kit') && !n.includes('Fabricator');
                        })
                        .map((i: any) => String(i.assetid));
                    // Snapshot current GC backpack IDs BEFORE accepting — used to find new items after trade
                    const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
                    // Admins get their fabricator topped up from the bot's own stock, so they only
                    // have to send the parts the bot doesn't keep (today: the killstreak weapon).
                    // Deliberately set on this branch only — the intake and kit-only branches keep
                    // asking the partner for parts, which is what leaves non-admin flows untouched.
                    offer.data('craftingService', { fabricatorAssetIds, componentAssetIds, kitAssetIds, preTradeIds, adminSelfFill: isAdmin });
                    offer.log('info', `[Mode A]${isAdmin ? '[self-fill]' : ''} crafting service — ${fabricatorAssetIds.length} fabricator(s) [${fabricatorAssetIds.join(', ')}] + ${componentItems.length} component(s)${kitAssetIds.length > 0 ? ` (${kitAssetIds.length} unapplied kit(s))` : ''}`);
                    return { action: 'accept', reason: 'CRAFTING_SERVICE' };
                } else if (keyCount >= 2) {
                    // Mode B (key payment): bot uses own parts, keeps keys as payment
                    const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
                    offer.data('craftingService', { fabricatorAssetIds, componentAssetIds: [], preTradeIds });
                    offer.log('info', `[Mode B] crafting service — ${fabricatorAssetIds.length} fabricator(s) + ${keyCount} key(s)`);
                    return { action: 'accept', reason: 'CRAFTING_SERVICE' };
                } else if (isAdmin && fabricatorAssetIds.length > 0) {
                    // Bare fabricator from an admin: cover the WHOLE recipe from the bot's own
                    // stock rather than asking the admin for parts the bot already owns — that
                    // round trip (withdraw the parts, send them straight back with the fabricator)
                    // is the thing this feature exists to remove.
                    //
                    // Shaped as Mode A data with no components rather than phase:'intake', because
                    // the intake branch returns before runMultiFabCraft is ever defined and cannot
                    // reach it. Falling through to the craft branch works because a directly-sent
                    // fabricator shows up in that trade's own backpack diff, and runMultiFabCraft's
                    // `components.length > 0 || selfFill` already tolerates an empty component list.
                    const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
                    offer.data('craftingService', {
                        fabricatorAssetIds,
                        componentAssetIds: [],
                        kitAssetIds: [],
                        preTradeIds,
                        adminSelfFill: true
                    });
                    const fabList = fabricatorAssetIds.join(', ');
                    offer.log(
                        'info',
                        `[Mode A][self-fill] crafting service — ${fabricatorAssetIds.length} bare fabricator(s) [${fabList}] — filling entirely from the bot's own stock`
                    );
                    return { action: 'accept', reason: 'CRAFTING_SERVICE' };
                } else if (fabricatorAssetIds.length > 0) {
                    // Bare fabricator(s), no components, <2 keys: we can't build a craft plan
                    // without knowing the real recipe, and the GC won't tell us that until we own
                    // the item(s). Accept, then decode each real recipe and request matching parts
                    // back in one combined offer — same two-phase flow as the website's
                    // bot-initiated /api/crafting/request-offer, generalized to N fabricators.
                    const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
                    offer.data('craftingService', { phase: 'intake', fabricatorAssetIds, preTradeIds });
                    offer.log('info', `[Intake] ${fabricatorAssetIds.length} bare fabricator(s) [${fabricatorAssetIds.join(', ')}] — accepting to read real recipe(s)`);
                    return { action: 'accept', reason: 'CRAFTING_SERVICE' };
                }
                // Non-whitelisted with components: fall through
            } else {
                // No fabricator in offer — check for kit-only trade (kit + weapon, whitelisted)
                const allItems = offer.itemsToReceive as any[];
                const kitItems = allItems.filter((i: any) => {
                    const n: string = i.market_hash_name ?? '';
                    return n.includes('Killstreak') && n.includes('Kit') && !n.includes('Fabricator');
                });
                // PAYMENT GATE (currently disabled — open pilot period).
                // To re-enable paid-only access, restore this whitelist check and remove the `true` below.
                // const isWhitelisted = isAdmin || (this.opt.craftingServiceWhitelist ?? []).includes(partnerSteamID);
                const isWhitelisted = true;
                if (isWhitelisted && kitItems.length > 0) {
                    const kitAssetIds = kitItems.map((i: any) => String(i.assetid));
                    const componentAssetIds = allItems
                        .filter((i: any) => i.market_hash_name !== 'Mann Co. Supply Crate Key')
                        .map((i: any) => String(i.assetid));
                    const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
                    offer.data('craftingService', { fabricatorAssetIds: [], componentAssetIds, kitAssetIds, preTradeIds });
                    offer.log('info', `[Mode Kit] crafting service — ${kitItems.length} kit(s) → apply and return`);
                    return { action: 'accept', reason: 'CRAFTING_SERVICE' };
                }
            }
        }

        // Check if the offer is from an admin
        if (isAdmin) {
            offer.log(
                'trade',
                `is from an admin, accepting. Summary:\n${JSON.stringify(
                    summarize(offer, this.bot, 'summary-accepting', false),
                    null,
                    4
                )}`
            );

            return {
                action: 'accept',
                reason: 'ADMIN',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        // Check if the offer has keys on both sides
        if (keyOnBothSide) {
            offer.log('info', 'offer contains keys on both sides');
            return {
                action: 'decline',
                reason: 'CONTAINS_KEYS_ON_BOTH_SIDES',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        // Check if the offer has items on both sides
        if (
            !opt.miscSettings.itemsOnBothSides.enable &&
            exchange['our'].contains.items &&
            exchange['their'].contains.items
        ) {
            offer.log('info', 'offer has items on both sides');
            return {
                action: 'decline',
                reason: 'CONTAINS_ITEMS_ON_BOTH_SIDES',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        const itemsToGiveCount = offer.itemsToGive.length;
        const itemsToReceiveCount = offer.itemsToReceive.length;

        // check if the trade is valid
        const isCannotProceedProcessingOffer = itemsToGiveCount === 0 && itemsToReceiveCount === 0;

        if (isCannotProceedProcessingOffer) {
            log.warn('isCannotProceedProcessingOffer', {
                status: isCannotProceedProcessingOffer,
                offerData: offer
            });
            // Both itemsToGive and itemsToReceive are an empty array, abort.
            this.bot.sendMessage(
                offer.partner,
                `❌ Looks like there was some issue with Steam getting your offer data.` +
                    ` I will retry to get the offer data now.` +
                    ` My owner has been informed, and they might manually act on your offer later.`
            );

            const optDw = opt.discordWebhook;

            if (opt.sendAlert.enable && opt.sendAlert.unableToProcessOffer) {
                if (optDw.sendAlert.enable && optDw.sendAlert.url.main !== '') {
                    sendAlert('failed-processing-offer', this.bot, null, null, null, [partnerSteamID, offer.id]);
                } else {
                    const prefix = this.bot.getPrefix();
                    this.bot.messageAdmins(
                        '',
                        `Unable to process offer #${offer.id} with ${partnerSteamID}.` +
                            ' The offer data received was broken because our side and their side are both empty.' +
                            `\nPlease manually check the offer (login as me): https://steamcommunity.com/tradeoffer/${offer.id}/` +
                            `\nSend "${prefix}faccept ${offer.id}" to force accept, or "${prefix}fdecline ${offer.id}" to decline.`,
                        []
                    );
                }
            }

            // Abort processing the offer.
            return;
        }

        // Check if there are any missing items in both sides
        const isMissingItemsToGive = offer.itemsToGive.some(item => item.missing);
        const isMissingItemsToReceive = offer.itemsToReceive.some(item => item.missing);

        if (isMissingItemsToGive || isMissingItemsToReceive) {
            // Ignore the trade, let polling offer automatically change offer state to 8 (InvalidItems)
            return {
                action: 'ignore',
                reason: 'CONTAINS_MISSING_ITEMS'
            };
        }

        const manualReviewEnabled = opt.manualReview.enable;
        const isIgnoreHalted = opt.offerReceived.halted.ignoreHalted;

        // A list of things that is wrong about the offer and other information
        const wrongAboutOffer: WrongAboutOffer[] = [];

        if (this.bot.isHalted) {
            if (manualReviewEnabled && !isIgnoreHalted) {
                wrongAboutOffer.push({
                    reason: '⬜_HALTED'
                });
                offer.log('info', 'bot is halted, review enabled & not ignore -> marking as halted ang going to skip');
            } else if (isIgnoreHalted) {
                // do nothing
                offer.log('info', 'bot is halted, review disabled & set to ignore -> Do nothing');
                return {
                    action: 'ignore',
                    reason: '⬜_HALTED'
                };
            } else {
                offer.log('info', 'bot is halted, review disabled -> declining');
                return {
                    action: 'decline',
                    reason: 'HALTED',
                    meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                };
            }
        }

        let checkBannedFailed = false;

        offer.log('info', 'checking escrow...');

        try {
            const hasEscrow = await this.bot.checkEscrow(offer);

            if (hasEscrow) {
                offer.log('info', 'would be held if accepted, declining...');
                return {
                    action: 'decline',
                    reason: 'ESCROW',
                    meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                };
            }
        } catch (err) {
            wrongAboutOffer.push({
                reason: '⬜_ESCROW_CHECK_FAILED'
            });
            log.warn('Failed to check escrow: ', err);
        }

        offer.log('info', 'checking bans...');

        try {
            const isBanned = await this.bot.checkBanned(partnerSteamID);

            if (isBanned.isBanned) {
                offer.log('info', 'partner is banned in one or more communities, declining...');
                this.bot.client.blockUser(offer.partner, err => {
                    if (err) {
                        log.warn(`❌ Failed to block user ${partnerSteamID}: `, err);
                    } else log.info(`✅ Successfully blocked user ${partnerSteamID}`);
                });

                this.saveBlockedUser(
                    partnerSteamID,
                    `[onReceivedOffer] Banned on ${Object.keys(isBanned.contents)
                        .filter(website => isBanned.contents[website] !== 'clean')
                        .join(', ')}`
                );

                return {
                    action: 'decline',
                    reason: 'BANNED',
                    meta: isContainsHighValue ? { highValue: highValueMeta, banned: isBanned.contents } : undefined
                };
            }
        } catch (err) {
            checkBannedFailed = true;
            wrongAboutOffer.push({
                reason: '⬜_BANNED_CHECK_FAILED'
            });
            log.error('Failed to check banned: ', err);
        }

        if (hasNonTF2Items && opt.offerReceived.alwaysDeclineNonTF2Items) {
            // Using boolean because items dict always needs to be saved
            offer.log('info', 'contains items not from TF2, declining...');
            return { action: 'decline', reason: '🟨_CONTAINS_NON_TF2' };
        }

        const offerMessage = offer.message.toLowerCase();

        const forcesReview =
            opt.manualReview.enable &&
            opt.offerReceived.reviewForced.enable &&
            ['refund', 'review', 'check', 'manual'].some(word => offerMessage.includes(word)); // "Please review" will also make this true this way.
        if (forcesReview) {
            wrongAboutOffer.push({
                reason: '⬜_REVIEW_FORCED'
            });
        } else {
            if (itemsToGiveCount === 0) {
                const isGift = [
                    'gift',
                    'donat', // So that 'donate' or 'donation' will also be accepted
                    'tip', // All others are synonyms
                    'tribute',
                    'souvenir',
                    'favor',
                    'giveaway',
                    'bonus',
                    'grant',
                    'bounty',
                    'present',
                    'contribution',
                    'award',
                    'nice', // Up until here actually
                    'happy', // All below people might also use
                    'thank',
                    'goo', // For 'good', 'goodie' or anything else
                    'awesome',
                    'rep',
                    'joy',
                    'cute', // right?
                    'enjoy',
                    'prize',
                    'free',
                    'tnx',
                    'ty',
                    'love',
                    '<3'
                ].some(word => offerMessage.includes(word));

                if (isGift) {
                    // We can accept escrow if it's gift
                    if (checkBannedFailed) {
                        offer.log('info', `is a gift offer, but failed to check for banned status, declining...`);
                        return {
                            action: 'decline',
                            reason: 'GIFT_FAILED_CHECK_BANNED',
                            meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                        };
                    }

                    offer.log(
                        'trade',
                        `is a gift offer, accepting. Summary:\n${JSON.stringify(
                            summarize(offer, this.bot, 'summary-accepting', false),
                            null,
                            4
                        )}`
                    );

                    return {
                        action: 'accept',
                        reason: 'GIFT',
                        meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                    };
                } else {
                    if (opt.bypass.giftWithoutMessage.allow) {
                        if (checkBannedFailed) {
                            offer.log(
                                'info',
                                `is a gift offer without any offer message, but failed to check for banned status, declining...`
                            );
                            return {
                                action: 'decline',
                                reason: 'GIFT_FAILED_CHECK_BANNED',
                                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                            };
                        }

                        offer.log(
                            'trade',
                            'is a gift offer without any offer message, but allowed to be accepted, accepting...'
                        );

                        return {
                            action: 'accept',
                            reason: 'GIFT',
                            meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                        };
                    } else {
                        offer.log('info', 'is a gift offer without any offer message, declining...');
                        return {
                            action: 'decline',
                            reason: 'GIFT_NO_NOTE',
                            meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                        };
                    }
                }
            } else if (
                itemsToGiveCount > 0 &&
                itemsToReceiveCount === 0 &&
                !(
                    (opt.miscSettings.counterOffer.enable
                        ? !opt.miscSettings.counterOffer.autoDeclineLazyOffer
                        : false) && exchange.contains.items
                )
            ) {
                offer.log('info', 'is taking our items for free, declining...');
                return {
                    action: 'decline',
                    reason: 'CRIME_ATTEMPT',
                    meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                };
            }
        }

        // Check for Dueling Mini-Game and/or Noise maker for 5x/25x Uses only when enabled
        // and decline if not 5x/25x and exist in pricelist

        const checkExist = this.bot.pricelist;

        if (opt.miscSettings.checkUses.duel && isDuelingNotFullUses) {
            if (checkExist.getPrice({ priceKey: '241;6', onlyEnabled: true }) !== null) {
                // Dueling Mini-Game: Only decline if exist in pricelist
                offer.log('info', 'contains Dueling Mini-Game that does not have 5 uses.');
                return {
                    action: 'decline',
                    reason: 'DUELING_NOT_5_USES',
                    meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                };
            }
        }

        if (opt.miscSettings.checkUses.noiseMaker && isNoiseMakerNotFullUses) {
            const isHasNoiseMaker = noiseMakerNotFullSKUs.some(
                sku => checkExist.getPrice({ priceKey: sku, onlyEnabled: true }) !== null
            );
            if (isHasNoiseMaker) {
                // Noise Maker: Only decline if exist in pricelist
                offer.log('info', 'contains Noise Maker that does not have 25 uses.');
                return {
                    action: 'decline',
                    reason: 'NOISE_MAKER_NOT_25_USES',
                    meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
                };
            }
        }

        const ourItemsHVCount = Object.keys(getHighValue.our.items).length;

        const isInPricelist =
            ourItemsHVCount > 0 // Only check if this not empty
                ? Object.keys(getHighValue.our.items).some(sku => {
                      return checkExist.getPrice({ priceKey: sku, onlyEnabled: false }) !== null; // Return true if exist in pricelist, enabled or not.
                  })
                : null;

        if (ourItemsHVCount > 0 && isInPricelist === false) {
            // Decline trade that offer overpay on high valued (spelled) items that are not in our pricelist.
            offer.log('info', 'contains higher value item on our side that is not in our pricelist.');

            // Inform admin via Steam Chat or Discord Webhook Something Wrong Alert.
            const highValueOurNames: string[] = [];
            const itemsName = getHighValueItems(getHighValue.our.items, this.bot);

            if (opt.sendAlert.enable && opt.sendAlert.highValue.tryingToTake) {
                if (opt.discordWebhook.sendAlert.enable && opt.discordWebhook.sendAlert.url.main !== '') {
                    for (const name in itemsName) {
                        if (!Object.prototype.hasOwnProperty.call(itemsName, name)) {
                            continue;
                        }

                        highValueOurNames.push(`_${name}_` + itemsName[name]);
                    }

                    sendAlert('tryingToTake', this.bot, null, null, null, highValueOurNames);
                } else {
                    for (const name in itemsName) {
                        if (!Object.prototype.hasOwnProperty.call(itemsName, name)) {
                            continue;
                        }

                        highValueOurNames.push(name + itemsName[name]);
                    }

                    this.bot.messageAdmins(
                        `Someone is attempting to purchase a high valued item that you own ` +
                            `but is not in your pricelist:\n- ${highValueOurNames.join('\n\n- ')}`,
                        []
                    );
                }
            }

            if (!forcesReview) {
                return {
                    action: 'decline',
                    reason: 'HIGH_VALUE_ITEMS_NOT_SELLING',
                    meta: {
                        highValueName: highValueOurNames
                    }
                };
            }
        }

        const itemPrices: Prices = {};

        const keyPrices = this.bot.pricelist.getKeyPrices;
        // Original autobot behavior: one key price for the entire offer.
        const keyPrice = keyPrices[keyOurSide ? 'sell' : 'buy'];
        let hasOverstockAndIsPartialPriced = false;
        let assetidsToCheck: string[] = [];
        let skuToCheck: string[] = [];
        let hasNoPrice = false;
        let hasInvalidItemsOur = false;

        let isTakingOurItemWithIntentBuy = false;
        let isGivingTheirItemWithIntentSell = false;

        const craftAll = this.bot.craftWeapons;
        const uncraftAll = this.bot.uncraftWeapons;

        const itemsDiff = offer.getDiff();
        /* this loop goes through the following
        buying = false; which = 'our';   intent = 'sell';
        buying = true;  which = 'their'; intent = 'buy';
         */
        for (let i = 0; i < states.length; i++) {
            const buying = states[i];
            const which = buying ? 'their' : 'our';
            const intentString = buying ? 'buy' : 'sell';

            if (exchange[which].contains.pricedAssets) {
                for (const id of exchange[which].pricedAssetIds) {
                    const match = this.bot.pricelist.getPrice({ priceKey: id });
                    exchange[which].value += match[intentString].toValue(keyPrice.metal);
                    exchange[which].keys += match[intentString].keys;
                    exchange[which].scrap += Currencies.toScrap(match[intentString].metal);
                    itemPrices[id] = {
                        buy: match.buy,
                        sell: match.sell
                    };
                    // Check if asset is disabled
                    if (!match.enabled) {
                        wrongAboutOffer.push({
                            reason: '🟧_DISABLED_ITEMS',
                            sku: exchange[which].pricedAsset[id] as string
                        });
                    }
                }
            }
            for (const sku in itemsDict[which]) {
                if (!Object.prototype.hasOwnProperty.call(itemsDict[which], sku) || Pricelist.isAssetId(sku)) {
                    continue;
                }

                const amount = itemsDict[which][sku];

                if (amount === 0) {
                    continue;
                }

                let isNonTF2Items = false;

                if (sku === '5000;6') {
                    exchange[which].value += amount;
                    exchange[which].scrap += amount;
                } else if (sku === '5001;6') {
                    const value = 3 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else if (sku === '5002;6') {
                    const value = 9 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else if (
                    this.isWeaponsAsCurrency.enable &&
                    (craftAll.includes(sku) || (this.isWeaponsAsCurrency.withUncraft && uncraftAll.includes(sku))) &&
                    this.bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: true }) === null
                ) {
                    const value = 0.5 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else {
                    let match: Entry | null = null;

                    if (hasNonTF2Items) {
                        if (testPriceKey(sku)) {
                            match =
                                which === 'our'
                                    ? this.bot.pricelist.getPrice({ priceKey: sku })
                                    : this.bot.pricelist.getPrice({
                                          priceKey: sku,
                                          onlyEnabled: false,
                                          getGenericPrice: true
                                      });
                        } else {
                            isNonTF2Items = true;
                        }
                    } else {
                        match =
                            which === 'our'
                                ? this.bot.pricelist.getPrice({ priceKey: sku })
                                : this.bot.pricelist.getPrice({
                                      priceKey: sku,
                                      onlyEnabled: false,
                                      getGenericPrice: true
                                  });
                    }

                    const notIncludeCraftweapons = this.isWeaponsAsCurrency.enable
                        ? !(
                              craftAll.includes(sku) ||
                              (this.isWeaponsAsCurrency.withUncraft && uncraftAll.includes(sku))
                          )
                        : true;

                    if (match !== null && (sku !== '5021;6' || !exchange.contains.items)) {
                        // If we found a matching price and the item is not a key, or the we are not trading items
                        // (meaning that we are trading keys) then add the price of the item

                        exchange[which].value += match[intentString].toValue(keyPrice.metal) * amount;
                        exchange[which].keys += match[intentString].keys * amount;
                        exchange[which].scrap += Currencies.toScrap(match[intentString].metal) * amount;

                        itemPrices[match.sku] = {
                            buy: match.buy,
                            sell: match.sell
                        };

                        // Check stock limits (not for keys)
                        const diff = itemsDiff[sku] as number | null;

                        const isBuying = diff > 0; // is buying if true.
                        const inventoryManager = this.bot.inventoryManager;
                        const amountCanTrade = inventoryManager.amountCanTrade({
                            priceKey: sku,
                            tradeIntent: isBuying ? 'buying' : 'selling',
                            getGenericAmount: which === 'their'
                        }); // return a number

                        if (diff !== 0 && sku !== '5021;6' && amountCanTrade < diff && notIncludeCraftweapons) {
                            if (match.enabled) {
                                // User is offering too many
                                if (match.isPartialPriced) {
                                    hasOverstockAndIsPartialPriced = true;
                                }

                                wrongAboutOffer.push({
                                    reason: '🟦_OVERSTOCKED',
                                    sku: sku,
                                    buying: isBuying,
                                    diff: diff,
                                    amountCanTrade: amountCanTrade,
                                    amountOffered: amount
                                });

                                this.bot.listings.checkByPriceKey({
                                    priceKey: match.sku,
                                    checkGenerics: which === 'their',
                                    showLogs: true
                                });
                            } else {
                                // Item was disabled
                                wrongAboutOffer.push({
                                    reason: '🟧_DISABLED_ITEMS',
                                    sku: sku
                                });
                            }
                        }

                        if (which === 'our' && match.intent === 0) {
                            isTakingOurItemWithIntentBuy = true;
                        } else if (which === 'their' && match.intent === 1) {
                            isGivingTheirItemWithIntentSell = true;
                        }

                        if (
                            diff !== 0 &&
                            !isBuying &&
                            sku !== '5021;6' &&
                            amountCanTrade < Math.abs(diff) &&
                            notIncludeCraftweapons
                        ) {
                            if (match.enabled) {
                                // User is taking too many

                                if (match.min !== 0 || match.intent === 0) {
                                    // If min is set to 0, how come it can be understocked right?
                                    // fix exploit found on August 4th, 2021
                                    const amountInInventory = inventoryManager.getInventory.getAmount({
                                        priceKey: sku,
                                        includeNonNormalized: false
                                    });

                                    if (amountInInventory > 0) {
                                        wrongAboutOffer.push({
                                            reason: '🟩_UNDERSTOCKED',
                                            sku: sku,
                                            selling: !isBuying,
                                            diff: diff,
                                            amountCanTrade: amountCanTrade,
                                            amountTaking: amount
                                        });

                                        this.bot.listings.checkByPriceKey({
                                            priceKey: match.sku,
                                            checkGenerics: which === 'their',
                                            showLogs: true
                                        });
                                    }
                                }
                            } else {
                                // Item was disabled
                                wrongAboutOffer.push({
                                    reason: '🟧_DISABLED_ITEMS',
                                    sku: sku
                                });
                            }
                        }

                        const keyPriceBuy = keyPrices.buy;
                        const buyPrice = match.buy.toValue(keyPriceBuy.metal);
                        const sellPrice = match.sell.toValue(keyPriceBuy.metal);
                        const minimumKeysDupeCheck = this.minimumKeysDupeCheck * keyPriceBuy.toValue();
                        if (
                            buying && // check only items on their side
                            (buyPrice > minimumKeysDupeCheck || sellPrice > minimumKeysDupeCheck)
                            // if their side contains invalid_items, will use our side value
                        ) {
                            skuToCheck = skuToCheck.concat(sku);
                            assetidsToCheck = assetidsToCheck.concat(items[which][sku].map(item => item.id));
                        }
                        //
                    } else if (sku === '5021;6' && exchange.contains.items) {
                        // Offer contains keys alongside items; value them at the offer's single key rate.
                        exchange[which].value += keyPrice.toValue() * amount;
                        exchange[which].keys += amount;
                        //
                    } else if (
                        (match === null && notIncludeCraftweapons) ||
                        (match !== null && match.intent === (buying ? 1 : 0))
                    ) {
                        // Offer contains an item that we are not trading
                        // hasInvalidItems = true;

                        // If that particular item is on our side, then put to review
                        if (which === 'our') {
                            hasInvalidItemsOur = true;
                        }

                        let itemSuggestedValue = 'No price';

                        if (!isNonTF2Items) {
                            // await timersPromises.setTimeout(1 * 1000);
                            const price = await this.bot.pricelist.getItemPrices(sku);
                            const item = SKU.fromString(sku);

                            const isCrateOrCases = item.crateseries !== null || ['5737;6', '5738;6'].includes(sku);
                            // 5737;6 and 5738;6 - Mann Co. Stockpile Crate

                            const isWinterNoiseMaker = ['673;6'].includes(sku);

                            const isSkinsOrWarPaints = item.wear !== null;

                            if (price === null) {
                                hasNoPrice = true;
                            } else {
                                price.buy = new Currencies(price.buy);
                                price.sell = new Currencies(price.sell);

                                itemPrices[sku] = {
                                    buy: price.buy,
                                    sell: price.sell
                                };

                                if (
                                    opt.offerReceived.invalidItems.givePrice &&
                                    !isSkinsOrWarPaints &&
                                    !isCrateOrCases &&
                                    !isWinterNoiseMaker // all of these (with !) should be false in order to be true
                                ) {
                                    // if offerReceived.invalidItems.givePrice is set to true (enable) and items is not skins/war paint/crate/cases,
                                    // then give that item price and include in exchange
                                    exchange[which].value += price[intentString].toValue(keyPrice.metal) * amount;
                                    exchange[which].keys += price[intentString].keys * amount;
                                    exchange[which].scrap += Currencies.toScrap(price[intentString].metal) * amount;
                                }
                                const keyPriceForRef = keyPrices.buy;
                                const valueInRef = {
                                    buy: Currencies.toRefined(price.buy.toValue(keyPriceForRef.metal)),
                                    sell: Currencies.toRefined(price.sell.toValue(keyPriceForRef.metal))
                                };

                                itemSuggestedValue =
                                    (intentString === 'buy' ? valueInRef.buy : valueInRef.sell) >= keyPriceForRef.metal
                                        ? `${valueInRef.buy.toString()} ref (${price.buy.toString()})` +
                                          ` / ${valueInRef.sell.toString()} ref (${price.sell.toString()})`
                                        : `${price.buy.toString()} / ${price.sell.toString()}`;
                            }
                        }

                        wrongAboutOffer.push({
                            reason: '🟨_INVALID_ITEMS',
                            sku: sku,
                            buying: buying,
                            amount: amount,
                            price: itemSuggestedValue
                        });
                    }
                }
            }
        }

        // Doing this so that the prices will always be displayed as only metal
        if (opt.miscSettings.showOnlyMetal.enable) {
            exchange.our.scrap += exchange.our.keys * keyPrice.toValue();
            exchange.our.keys = 0;
            exchange.their.scrap += exchange.their.keys * keyPrice.toValue();
            exchange.their.keys = 0;
        }

        offer.data('value', {
            our: {
                total: exchange.our.value,
                keys: exchange.our.keys,
                metal: Currencies.toRefined(exchange.our.scrap)
            },
            their: {
                total: exchange.their.value,
                keys: exchange.their.keys,
                metal: Currencies.toRefined(exchange.their.scrap)
            },
            rate: keyPrice.metal
        });

        offer.data('prices', itemPrices);

        if (isTakingOurItemWithIntentBuy) {
            // Always decline an offer taking our item(s) with intent to only buy
            offer.log('info', 'is trying to take item(s) with intent buy, declining...');
            return {
                action: 'decline',
                reason: 'TAKING_ITEMS_WITH_INTENT_BUY',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        if (isGivingTheirItemWithIntentSell) {
            // Always decline an offer giving their item(s) with intent to only sell
            offer.log('info', 'is trying to give item(s) with intent sell, declining...');
            return {
                action: 'decline',
                reason: 'GIVING_ITEMS_WITH_INTENT_SELL',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        if (!forcesReview && exchange.contains.metal && !exchange.contains.keys && !exchange.contains.items) {
            // Offer only contains metal
            offer.log('info', 'only contains metal, declining...');
            return { action: 'decline', reason: 'ONLY_METAL' };
        } else if (exchange.contains.keys && !exchange.contains.items) {
            // Offer is for trading keys, check if we are trading them
            const priceEntry = this.bot.pricelist.getPrice({ priceKey: '5021;6', onlyEnabled: true });
            if (!forcesReview && priceEntry === null) {
                // We are not trading keys
                offer.log('info', 'we are not trading keys, declining...');
                this.bot.listings.checkByPriceKey({
                    priceKey: '5021;6',
                    checkGenerics: false,
                    showLogs: true
                });
                return { action: 'decline', reason: 'NOT_TRADING_KEYS' };
            } else if (
                !forcesReview &&
                exchange.our.contains.keys &&
                priceEntry.intent !== 1 &&
                priceEntry.intent !== 2
            ) {
                // We are not selling keys
                offer.log('info', 'we are not selling keys, declining...');
                this.bot.listings.checkByPriceKey({
                    priceKey: '5021;6',
                    checkGenerics: false,
                    showLogs: true
                });
                return { action: 'decline', reason: 'NOT_SELLING_KEYS' };
            } else if (
                !forcesReview &&
                exchange.their.contains.keys &&
                priceEntry.intent !== 0 &&
                priceEntry.intent !== 2
            ) {
                // We are not buying keys
                offer.log('info', 'we are not buying keys, declining...');
                this.bot.listings.checkByPriceKey({
                    priceKey: '5021;6',
                    checkGenerics: false,
                    showLogs: true
                });
                return { action: 'decline', reason: 'NOT_BUYING_KEYS' };
            } else {
                // Check overstock / understock on keys
                const diff = itemsDiff['5021;6'] as number | null;
                // If the diff is greater than 0 then we are buying, less than is selling
                const isBuying = diff > 0;
                const inventoryManager = this.bot.inventoryManager;
                const amountCanTrade = inventoryManager.amountCanTrade({
                    priceKey: '5021;6',
                    tradeIntent: isBuying ? 'buying' : 'selling'
                });

                if (diff !== 0 && amountCanTrade < diff) {
                    // User is offering too many
                    wrongAboutOffer.push({
                        reason: '🟦_OVERSTOCKED',
                        sku: '5021;6',
                        buying: isBuying,
                        diff: diff,
                        amountCanTrade: amountCanTrade,
                        amountOffered: itemsDict['their']['5021;6']
                    });

                    this.bot.listings.checkByPriceKey({
                        priceKey: '5021;6',
                        checkGenerics: false,
                        showLogs: true
                    });
                }

                const acceptUnderstock = opt.autokeys.accept.understock;
                if (diff !== 0 && !isBuying && amountCanTrade < Math.abs(diff) && !acceptUnderstock) {
                    // User is taking too many

                    if (priceEntry.min !== 0) {
                        const amountInInventory = inventoryManager.getInventory.getAmount({
                            priceKey: '5021;6',
                            includeNonNormalized: false
                        });

                        if (amountInInventory > 0) {
                            wrongAboutOffer.push({
                                reason: '🟩_UNDERSTOCKED',
                                sku: '5021;6',
                                selling: !isBuying,
                                diff: diff,
                                amountCanTrade: amountCanTrade,
                                amountTaking: itemsDict['our']['5021;6']
                            });

                            this.bot.listings.checkByPriceKey({
                                priceKey: '5021;6',
                                checkGenerics: false,
                                showLogs: true
                            });
                        }
                    }
                }
            }
        }

        let isOurItems = false;
        let isTheirItems = false;
        const exceptionSKU = opt.offerReceived.invalidValue.exceptionValue.skus;
        const exceptionValue = this.invalidValueException;
        const ourItems = Object.keys(itemsDict.our);
        const theirItems = Object.keys(itemsDict.their);

        if (exceptionSKU.length > 0 && exceptionValue > 0) {
            isOurItems = exceptionSKU.some(sku => {
                return ourItems.some(ourItemSKU => {
                    return ourItemSKU.includes(sku);
                });
            });

            isTheirItems = exceptionSKU.some(sku => {
                return theirItems.some(theirItemSKU => {
                    return theirItemSKU.includes(sku);
                });
            });
        }

        const isExcept = isOurItems || isTheirItems;

        if (exchange.our.value > exchange.their.value) {
            if (!isExcept || (isExcept && exchange.our.value - exchange.their.value >= exceptionValue)) {
                // Check if the values are correct and is not include the exception sku
                // OR include the exception sku but the invalid value is more than or equal to exception value
                this.hasInvalidValueException = false;
                wrongAboutOffer.push({
                    reason: '🟥_INVALID_VALUE',
                    our: exchange.our.value,
                    their: exchange.their.value,
                    missing: exchange.our.value - exchange.their.value
                });

                // Always run checkBySKU for INVALID_VALUE offer so that the listings will always be updated if incorrect
                ourItems
                    .concat(theirItems)
                    .filter(sku => !['5000;6', '5001;6', '5002;6'].includes(sku))
                    .forEach(sku => this.bot.listings.checkByPriceKey({ priceKey: sku }));
            } else if (isExcept && exchange.our.value - exchange.their.value < exceptionValue) {
                log.info(
                    `Contains ${exceptionSKU.join(' or ')} and difference is ${Currencies.toRefined(
                        exchange.our.value - exchange.their.value
                    )} ref which is less than your exception value of ${Currencies.toRefined(
                        exceptionValue
                    )} ref. Accepting/checking for other reasons...`
                );
                this.hasInvalidValueException = true;
            }
        }

        if (!forcesReview && exchange.our.value < exchange.their.value && !opt.bypass.overpay.allow) {
            offer.log('info', 'is offering more than needed, declining...');
            return {
                action: 'decline',
                reason: 'OVERPAY',
                meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
            };
        }

        const assetidsToCheckCount = assetidsToCheck.length;

        if (this.dupeCheckEnabled && assetidsToCheckCount > 0) {
            offer.log('info', 'checking ' + pluralize('item', assetidsToCheckCount, true) + ' for dupes...');
            const inventory = new TF2Inventory(offer.partner, this.bot.manager);

            const requests = assetidsToCheck.map(async (assetid): Promise<boolean | null> => {
                log.debug(`Dupe checking ${assetid}...`);
                const result = await inventory.isDuped(assetid, this.bot.userID);
                log.debug(`Dupe check for ${assetid}... done`);
                return result;
            });

            try {
                const result: (boolean | null)[] = await Promise.all(requests);
                log.info(`Got result from dupe checks on ${assetidsToCheck.join(', ')}`, { result: result });

                const resultCount = result.length;

                for (let i = 0; i < resultCount; i++) {
                    if (result[i] === true) {
                        // Found duped item
                        // Offer contains duped items but we don't decline duped items, instead add it to the wrong about offer list and continue
                        wrongAboutOffer.push({
                            reason: '🟫_DUPED_ITEMS',
                            assetid: assetidsToCheck[i],
                            sku: skuToCheck[i]
                        });
                    } else if (result[i] === null) {
                        // Could not determine if the item was duped, make the offer be pending for review
                        wrongAboutOffer.push({
                            reason: '🟪_DUPE_CHECK_FAILED',
                            withError: false,
                            assetid: assetidsToCheck[i],
                            sku: skuToCheck[i]
                        });
                    }
                }
            } catch (err) {
                log.error(`Failed dupe check on ${assetidsToCheck.join(', ')}`, err);
                wrongAboutOffer.push({
                    reason: '🟪_DUPE_CHECK_FAILED',
                    withError: true,
                    assetid: assetidsToCheck,
                    sku: skuToCheck,
                    error: (err as Error).message
                });
            }
        }

        if (wrongAboutOffer.length !== 0) {
            const reasons = wrongAboutOffer.map(wrong => wrong.reason);
            const uniqueReasons = filterReasons(reasons.filter(reason => reasons.includes(reason)));

            const hasInvalidValue = uniqueReasons.includes('🟥_INVALID_VALUE');
            const hasInvalidItem = uniqueReasons.includes('🟨_INVALID_ITEMS');
            const hasDisabledItem = uniqueReasons.includes('🟧_DISABLED_ITEMS');
            const hasOverstocked = uniqueReasons.includes('🟦_OVERSTOCKED');
            const hasUnderstocked = uniqueReasons.includes('🟩_UNDERSTOCKED');
            const hasDupedItem = uniqueReasons.includes('🟫_DUPED_ITEMS');
            const hasDupedCheckFailed = uniqueReasons.includes('🟪_DUPE_CHECK_FAILED');
            const hasEscrowCheckFailed = uniqueReasons.includes('⬜_ESCROW_CHECK_FAILED');
            const hasBannedCheckFailed = uniqueReasons.includes('⬜_BANNED_CHECK_FAILED');

            const canAcceptInvalidItemsOverpay = opt.offerReceived.invalidItems.autoAcceptOverpay;
            const canAcceptDisabledItemsOverpay = opt.offerReceived.disabledItems.autoAcceptOverpay;
            const canAcceptOverstockedOverpay = opt.offerReceived.overstocked.autoAcceptOverpay;
            const canAcceptUnderstockedOverpay = opt.offerReceived.understocked.autoAcceptOverpay;

            const isIgnoreEscrowCheckFailed = opt.offerReceived.escrowCheckFailed.ignoreFailed;
            const isIgnoreBannedCheckFailed = opt.offerReceived.bannedCheckFailed.ignoreFailed;

            // accepting 🟨_INVALID_ITEMS overpay
            const isAcceptInvalidItems =
                hasInvalidItem &&
                canAcceptInvalidItemsOverpay &&
                !hasInvalidItemsOur &&
                (exchange.our.value < exchange.their.value ||
                    (exchange.our.value === exchange.their.value && hasNoPrice)) &&
                (hasOverstocked ? canAcceptOverstockedOverpay : true) &&
                (hasUnderstocked ? canAcceptUnderstockedOverpay : true) &&
                (hasDisabledItem ? canAcceptDisabledItemsOverpay : true);

            // accepting 🟧_DISABLED_ITEMS overpay
            const isAcceptDisabledItems =
                hasDisabledItem &&
                canAcceptDisabledItemsOverpay &&
                exchange.our.value < exchange.their.value &&
                (hasInvalidItem ? canAcceptInvalidItemsOverpay : true) &&
                (hasOverstocked ? canAcceptOverstockedOverpay : true) &&
                (hasUnderstocked ? canAcceptUnderstockedOverpay : true);

            // accepting 🟦_OVERSTOCKED overpay
            const isAcceptOverstocked =
                hasOverstocked &&
                canAcceptOverstockedOverpay &&
                !hasOverstockAndIsPartialPriced && // because partial priced will use old buying prices
                exchange.our.value < exchange.their.value &&
                (hasInvalidItem ? canAcceptInvalidItemsOverpay : true) &&
                (hasUnderstocked ? canAcceptUnderstockedOverpay : true) &&
                (hasDisabledItem ? canAcceptDisabledItemsOverpay : true);

            // accepting 🟩_UNDERSTOCKED overpay
            const isAcceptUnderstocked =
                hasUnderstocked &&
                canAcceptUnderstockedOverpay &&
                exchange.our.value < exchange.their.value &&
                (hasInvalidItem ? canAcceptInvalidItemsOverpay : true) &&
                (hasOverstocked ? canAcceptOverstockedOverpay : true) &&
                (hasDisabledItem ? canAcceptDisabledItemsOverpay : true);

            const isOnlyInvalidValue =
                hasInvalidValue &&
                !(
                    hasInvalidItem ||
                    hasDisabledItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyInvalidItem =
                hasInvalidItem &&
                !(
                    hasInvalidValue ||
                    hasDisabledItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyDisabledItem =
                hasDisabledItem && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyOverstocked =
                hasOverstocked && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasDisabledItem ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyUnderstocked =
                hasUnderstocked && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasOverstocked ||
                    hasDisabledItem ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyDupedItem =
                hasDupedItem && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDisabledItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyFailedToCheckDupedItem =
                hasDupedCheckFailed && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDisabledItem ||
                    hasDupedItem ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyEscrowCheckFailed =
                hasEscrowCheckFailed && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasDisabledItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasBannedCheckFailed
                );

            const isOnlyBannedCheckFailed =
                hasBannedCheckFailed && // if contains 🟥_INVALID_VALUE too, this will pass
                !(
                    hasInvalidItem ||
                    hasDisabledItem ||
                    hasOverstocked ||
                    hasUnderstocked ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed
                );

            const meta = {
                uniqueReasons: uniqueReasons,
                reasons: wrongAboutOffer,
                highValue: isContainsHighValue ? highValueMeta : undefined
            };

            // don't use business logic if the bot is not operational or the trade must be reviewed
            if (this.bot.isHalted || forcesReview) {
                return {
                    action: 'skip',
                    reason: 'REVIEW',
                    meta: meta
                };
            }

            if (
                (isAcceptInvalidItems || isAcceptOverstocked || isAcceptUnderstocked || isAcceptDisabledItems) &&
                exchange.our.value !== 0 &&
                !(
                    hasInvalidValue ||
                    hasDupedItem ||
                    hasDupedCheckFailed ||
                    hasEscrowCheckFailed ||
                    hasBannedCheckFailed
                )
            ) {
                // if the offer is Invalid_items/disabled_items/over/understocked and accepting overpay enabled, but the offer is not
                // includes Invalid_value, duped or duped check failed, true for acceptTradeCondition and our side not empty,
                // accept the trade.
                offer.log(
                    'trade',
                    `contains ${
                        (isAcceptInvalidItems ? 'INVALID_ITEMS' : '') +
                        (isAcceptOverstocked ? `${isAcceptInvalidItems ? '/' : ''}OVERSTOCKED` : '') +
                        (isAcceptUnderstocked
                            ? `${isAcceptInvalidItems || isAcceptOverstocked ? '/' : ''}UNDERSTOCKED`
                            : '') +
                        (isAcceptDisabledItems
                            ? `${
                                  isAcceptInvalidItems || isAcceptOverstocked || isAcceptUnderstocked ? '/' : ''
                              }DISABLED_ITEMS`
                            : '')
                    }, but offer value is greater or equal, accepting. Summary:\n${JSON.stringify(
                        summarize(offer, this.bot, 'summary-accepting', false),
                        null,
                        4
                    )}`
                );

                if (opt.offerReceived.sendPreAcceptMessage.enable) {
                    const preAcceptMessage = opt.customMessage.accepted.automatic;

                    MyHandler.sendPreAcceptedMessage(
                        this.bot,
                        offer.partner,
                        preAcceptMessage,
                        itemsToGiveCount + itemsToReceiveCount > 50
                    );
                }

                return {
                    action: 'accept',
                    reason: 'VALID_WITH_OVERPAY',
                    meta: meta
                };
            } else if (
                (opt.offerReceived.invalidValue.autoDecline.enable || opt.miscSettings.counterOffer.enable) &&
                isOnlyInvalidValue &&
                this.hasInvalidValueException === false
            ) {
                if (opt.miscSettings.counterOffer.enable) {
                    // if counteroffer enabled
                    if (manualReviewEnabled && opt.miscSettings.counterOffer.skipIncludeMessage && offerMessage) {
                        // if skipIncludeMessage is set to true and offer contains message, skip for review
                        offer.log('info', `offer needs review (${uniqueReasons.join(', ')}), skipping...`);

                        return {
                            action: 'skip',
                            reason: 'REVIEW',
                            meta: meta
                        };
                    }

                    offer.log(
                        'info',
                        `offer need to counter.\nSummary:\n${JSON.stringify(
                            summarize(offer, this.bot, 'summary-countering', false),
                            null,
                            4
                        )}`
                    );

                    return {
                        action: 'counter',
                        reason: 'COUNTER_INVALID_VALUE',
                        meta: meta
                    };
                }

                // If only 🟥_INVALID_VALUE and did not matched exception value, will just decline the trade.
                return { action: 'decline', reason: 'ONLY_INVALID_VALUE', meta: meta };
            } else if (opt.offerReceived.invalidItems.autoDecline.enable && isOnlyInvalidItem) {
                // If only 🟨_INVALID_ITEMS and Auto-decline INVALID_ITEMS enabled, will just decline the trade.
                return { action: 'decline', reason: 'ONLY_INVALID_ITEMS', meta: meta };
            } else if (opt.offerReceived.disabledItems.autoDecline.enable && isOnlyDisabledItem) {
                // If only 🟧_DISABLED_ITEMS (and with 🟥_INVALID_VALUE)
                // and Auto-decline DISABLED_ITEMS enabled, will just decline the trade.
                return { action: 'decline', reason: 'ONLY_DISABLED_ITEMS', meta: meta };
            } else if (opt.offerReceived.overstocked.autoDecline.enable && isOnlyOverstocked) {
                // If only 🟦_OVERSTOCKED (and with 🟥_INVALID_VALUE)
                // and Auto-decline OVERSTOCKED enabled, will just decline the trade.
                return { action: 'decline', reason: 'ONLY_OVERSTOCKED', meta: meta };
            } else if (opt.offerReceived.understocked.autoDecline.enable && isOnlyUnderstocked) {
                // If only 🟩_UNDERSTOCKED (and with 🟥_INVALID_VALUE)
                // and Auto-decline UNDERSTOCKED enabled, will just decline the trade.
                return { action: 'decline', reason: 'ONLY_UNDERSTOCKED', meta: meta };
            } else if (opt.offerReceived.duped.autoDecline.enable && isOnlyDupedItem) {
                // If only 🟫_DUPED_ITEMS (and with 🟥_INVALID_VALUE)
                // and Auto-decline DUPED_ITEMS enabled, will just decline the trade.
                return {
                    action: 'decline',
                    reason: 'ONLY_DUPED_ITEM',
                    meta: meta
                };
            } else if (opt.offerReceived.failedToCheckDuped.autoDecline.enable && isOnlyFailedToCheckDupedItem) {
                // If only 🟪_DUPE_CHECK_FAILED (and with 🟥_INVALID_VALUE)
                // and Auto-decline DUPE_CHECK_FAILED enabled, will just decline the trade.
                return {
                    action: 'decline',
                    reason: 'ONLY_DUPE_CHECK_FAILED',
                    meta: meta
                };
            } else if (isIgnoreEscrowCheckFailed && isOnlyEscrowCheckFailed) {
                // If only ⬜_ESCROW_CHECK_FAILED (and with 🟥_INVALID_VALUE)
                // and always ignore enabled, will do nothing.
                return {
                    action: 'ignore',
                    reason: '⬜_ESCROW_CHECK_FAILED'
                };
            } else if (isIgnoreBannedCheckFailed && isOnlyBannedCheckFailed) {
                // If only ⬜_BANNED_CHECK_FAILED  (and with 🟥_INVALID_VALUE)
                // and always ignore enabled, will do nothing.
                return {
                    action: 'ignore',
                    reason: '⬜_BANNED_CHECK_FAILED'
                };
            } else if (manualReviewEnabled) {
                offer.log('info', `offer needs review (${uniqueReasons.join(', ')}), skipping...`);

                return {
                    action: 'skip',
                    reason: 'REVIEW',
                    meta: meta
                };
            } else {
                // manual review disabled, decline any offer with any reason
                if (hasOverstocked) {
                    offer.log('info', 'is offering too many, declining...');

                    return {
                        action: 'decline',
                        reason: '🟦_OVERSTOCKED',
                        meta: meta
                    };
                } else if (hasUnderstocked) {
                    offer.log('info', 'is taking too many, declining...');

                    return {
                        action: 'decline',
                        reason: '🟩_UNDERSTOCKED',
                        meta: meta
                    };
                } else if (hasDisabledItem) {
                    offer.log('info', 'is taking disabled item(s), declining...');

                    return {
                        action: 'decline',
                        reason: '🟧_DISABLED_ITEMS',
                        meta: meta
                    };
                } else if (hasInvalidItem) {
                    offer.log('info', 'contains invalid item(s), declining...');

                    return {
                        action: 'decline',
                        reason: '🟨_INVALID_ITEMS',
                        meta: meta
                    };
                } else if (hasDupedItem) {
                    offer.log('info', 'contains duped item(s), declining...');

                    return {
                        action: 'decline',
                        reason: '🟫_DUPED_ITEMS',
                        meta: meta
                    };
                } else if (hasDupedCheckFailed) {
                    offer.log('info', 'failed to check for duped item, declining...');

                    return {
                        action: 'decline',
                        reason: '🟪_DUPE_CHECK_FAILED',
                        meta: meta
                    };
                } else if (hasEscrowCheckFailed) {
                    if (isIgnoreEscrowCheckFailed) {
                        // Valid offer but failed to escrow check and manual review disabled
                        // and options.offerReceived.escrowCheckFailed.ignoreFailed=true
                        return {
                            action: 'ignore',
                            reason: '⬜_ESCROW_CHECK_FAILED'
                        };
                    } // else decline
                    return {
                        action: 'decline',
                        reason: '⬜_ESCROW_CHECK_FAILED',
                        meta: meta
                    };
                } else if (hasBannedCheckFailed) {
                    if (isIgnoreBannedCheckFailed) {
                        // Valid offer but failed to ban check and manual review disabled
                        // and options.offerReceived.bannedCheckFailed.ignoreFailed=true
                        return {
                            action: 'ignore',
                            reason: '⬜_BANNED_CHECK_FAILED'
                        };
                    } // else decline
                    return {
                        action: 'decline',
                        reason: '⬜_BANNED_CHECK_FAILED',
                        meta: meta
                    };
                } else if (hasInvalidValue) {
                    // We are offering more than them, decline the offer
                    offer.log('info', 'is not offering enough, declining...');

                    return {
                        action: 'decline',
                        reason: '🟥_INVALID_VALUE',
                        meta: meta
                    };
                }
            }
        }
        // else nothing wrong, process accept offer
        offer.log(
            'trade',
            `accepting. Summary:\n${JSON.stringify(summarize(offer, this.bot, 'summary-accepting', false), null, 4)}`
        );

        if (opt.offerReceived.sendPreAcceptMessage.enable && this.bot.friends.isFriend(offer.partner)) {
            const preAcceptMessage = opt.customMessage.accepted.automatic;

            MyHandler.sendPreAcceptedMessage(
                this.bot,
                offer.partner,
                preAcceptMessage,
                itemsToGiveCount + itemsToReceiveCount > 50
            );
        }

        return {
            action: 'accept',
            reason: 'VALID',
            meta: isContainsHighValue ? { highValue: highValueMeta } : undefined
        };
    }

    private static sendPreAcceptedMessage(
        bot: Bot,
        steamID: SteamID,
        preAcceptMessageOpt: OfferType,
        itemsLarge: boolean
    ): void {
        if (itemsLarge) {
            bot.sendMessage(
                steamID,
                preAcceptMessageOpt.largeOffer
                    ? preAcceptMessageOpt.largeOffer
                    : 'I have accepted your offer. The trade may take a while to finalize due to it being a large offer.' +
                          ' If the trade does not finalize after 5-10 minutes has passed, please send your offer again, ' +
                          'or add me and use the !sell/!sellcart or !buy/!buycart command.'
            );
        } else {
            bot.sendMessage(
                steamID,
                preAcceptMessageOpt.smallOffer
                    ? preAcceptMessageOpt.smallOffer
                    : 'I have accepted your offer. The trade will be finalized shortly.' +
                          ' If the trade does not finalize after 1-2 minutes has passed, please send your offer again, ' +
                          'or add me and use the !sell/!sellcart or !buy/!buycart command.'
            );
        }
    }

    onTradeOfferChanged(offer: TradeOffer, oldState: number, timeTakenToComplete?: number): void {
        void (async () => {
            // Not sure if it can go from other states to active
            if (oldState === TradeOfferManager.ETradeOfferState['Accepted']) {
                offer.data('switchedState', oldState);
            }

            const highValue: {
                isDisableSKU: string[];
                theirItems: string[];
                items: Items;
            } = {
                isDisableSKU: [],
                theirItems: [],
                items: {}
            };

            if (offer.data('handledByUs') === true) {
                if (offer.data('notify') === true && offer.data('switchedState') !== offer.state) {
                    const notifyOpt = this.opt.steamChat.notifyTradePartner;

                    if (offer.state === TradeOfferManager.ETradeOfferState['Accepted']) {
                        if (notifyOpt.onSuccessAccepted) accepted(offer, this.bot);

                        if (offer.data('donation')) {
                            this.bot.messageAdmins('✅ Success! Your donation has been sent and received!', []);
                        } else if (offer.data('buyBptfPremium')) {
                            this.bot.messageAdmins('✅ Success! Your premium purchase has been sent and received!', []);
                        }
                    } else if (offer.state === TradeOfferManager.ETradeOfferState['InEscrow']) {
                        if (notifyOpt.onSuccessAcceptedEscrow) acceptEscrow(offer, this.bot);
                    } else if (offer.state === TradeOfferManager.ETradeOfferState['Declined']) {
                        if (notifyOpt.onDeclined) declined(offer, this.bot);
                        offer.data('isDeclined', true);
                    } else if (offer.state === TradeOfferManager.ETradeOfferState['Canceled']) {
                        if (notifyOpt.onCancelled) cancelled(offer, oldState, this.bot);

                        if (offer.data('canceledByUser') === true) {
                            // do nothing
                        } else if (oldState === TradeOfferManager.ETradeOfferState['CreatedNeedsConfirmation']) {
                            offer.data('isFailedConfirmation', true);
                        } else {
                            offer.data('isCanceledUnknown', true);
                        }
                        MyHandler.removePolldataKeys(offer);
                    } else if (offer.state === TradeOfferManager.ETradeOfferState['InvalidItems']) {
                        if (notifyOpt.onTradedAway) invalid(offer, this.bot);
                        offer.data('isInvalid', true);
                        MyHandler.removePolldataKeys(offer);
                    }

                    // Update assetid in pricelist if needed
                    if (
                        ((offer.state === TradeOfferManager.ETradeOfferState['Canceled'] &&
                            offer.data('isCanceledUnknown') === true) ||
                            offer.state === TradeOfferManager.ETradeOfferState['InvalidItems']) &&
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        offer.tradeID
                    ) {
                        if (Object.keys(this.bot.pricelist.assetidInPricelist).length < 1) {
                            // Check if cache is not empty
                            return;
                        }

                        offer.getExchangeDetails(true, (err, status, tradeInitTime, receivedItems, sentItems) => {
                            if (err) {
                                return log.error(err);
                            }

                            if (Array.isArray(sentItems)) {
                                sentItems.forEach(item => {
                                    const entry = this.bot.pricelist.getPriceBySkuOrAsset({ priceKey: item.assetid });

                                    if (entry !== null && entry.id && item.rollback_new_assetid) {
                                        const newEntry = Object.assign({}, entry);
                                        const oldId = entry.id;
                                        newEntry.id = item.rollback_new_assetid;
                                        delete newEntry.name;
                                        delete newEntry.time;

                                        this.bot.pricelist.replacePriceEntry(oldId, newEntry);
                                        const msg = `✅ Automatically replaced ${oldId} with ${newEntry.id} in pricelist due to rollback.`;
                                        log.debug(msg);
                                        const dwEnabled =
                                            this.bot.options.discordWebhook.sendAlert.enable &&
                                            this.bot.options.discordWebhook.sendAlert.url.main !== '';
                                        if (
                                            this.bot.options.sendAlert.enable &&
                                            this.bot.options.sendAlert.autoUpdateAssetid
                                        ) {
                                            if (dwEnabled) {
                                                sendAlert('autoUpdateAssetid', this.bot, msg, null, null, [
                                                    oldId,
                                                    newEntry.id
                                                ]);
                                            } else {
                                                this.bot.messageAdmins(msg, []);
                                            }
                                        }
                                    }
                                });
                            }
                        });
                    }
                }

                // If a customer declines our follow-up parts-request offer, the fabricator(s) it
                // was requesting parts FOR are already sitting in the bot's own backpack (received
                // in the earlier, already-accepted intake trade) — nothing else ever returns them.
                // Deliberately a sibling of the notify-gated block above, not nested inside it:
                // this.componentOffer (like every crafting-service offer WE send) never gets
                // offer.data('notify') set — only offers the bot RECEIVES do (onNewTradeOffer,
                // line 632) — so nesting this inside that gate would mean it silently never fires
                // for the offers that actually matter here. Matches how the sibling Accepted-side
                // craft-triggering block just below already handles this same problem.
                if (
                    offer.state === TradeOfferManager.ETradeOfferState['Declined'] &&
                    !offer.data('craftingServiceDeclineHandled')
                ) {
                    const craftingService = offer.data('craftingService') as
                        | { phase?: string; fabricatorAssetIds?: string[] }
                        | undefined;
                    if (craftingService?.phase === 'components' && (craftingService.fabricatorAssetIds?.length ?? 0) > 0) {
                        offer.data('craftingServiceDeclineHandled', true);
                        const partnerSteamID64 = offer.partner.getSteamID64();
                        const fabricatorAssetIds = craftingService.fabricatorAssetIds as string[];
                        const backpack = ((this.bot.tf2 as any).backpack as any[]) ?? [];
                        const stillOwned = fabricatorAssetIds.filter(id => backpack.some((i: any) => String(i.id) === id));

                        if (stillOwned.length > 0) {
                            log.info(`[craftingService] Parts request declined by ${partnerSteamID64} — returning ${stillOwned.length} fabricator(s): ${stillOwned.join(', ')}`);
                            void (async () => {
                                const token = await fetchTradeUrlToken(partnerSteamID64);
                                const returnOffer = this.bot.manager.createOffer(offer.partner, token);
                                returnOffer.data('dict', this.craftingDict(stillOwned, []));
                                stillOwned.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
                                returnOffer.setMessage(
                                    `You declined the parts request, so here's your fabricator${stillOwned.length > 1 ? 's' : ''} back — re-send whenever you're ready!`
                                );

                                const attemptSend = (retriesLeft: number): void => {
                                    this.bot.trades
                                        .sendOffer(returnOffer)
                                        .then(status => {
                                            if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                                        })
                                        .catch((sendErr: Error) => {
                                            if (retriesLeft > 0) {
                                                log.warn(`[craftingService] Failed to return fabricator(s) after decline (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`);
                                                setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                                                return;
                                            }
                                            log.warn(`[craftingService] Failed to return fabricator(s) to ${partnerSteamID64} after decline: ${this.describeSendError(sendErr)}`);
                                            this.holdReturnItems(partnerSteamID64, stillOwned);
                                            this.bot.sendMessage(
                                                offer.partner,
                                                `⚠️ Couldn't return your fabricator${stillOwned.length > 1 ? 's' : ''} automatically just now — I'll retry shortly, no action needed on your end.`
                                            );
                                        });
                                };
                                attemptSend(3);
                            })();
                        }
                    }
                }

                if (
                    [
                        TradeOfferManager.ETradeOfferState['Accepted'],
                        TradeOfferManager.ETradeOfferState['InEscrow']
                    ].includes(offer.state) &&
                    !this.sentSummary[offer.id]
                ) {
                    // Only run this if the bot handled the offer and do not send again if already sent once

                    clearTimeout(this.resetSentSummaryTimeout);
                    this.sentSummary[offer.id] = true;

                    const isAcceptedWithEscrow = offer.state === TradeOfferManager.ETradeOfferState['InEscrow'];
                    offer.data(`isAccepted${isAcceptedWithEscrow ? '_withEscrow' : ''}`, true);
                    offer.log('trade', `has been accepted${isAcceptedWithEscrow ? ' with trade hold' : ''}.`);

                    // Auto sell and buy keys if ref < minimum

                    this.autokeys.check();

                    const result = await processAccepted(offer, this.bot, timeTakenToComplete, isAcceptedWithEscrow);

                    highValue.isDisableSKU = result.isDisableSKU;
                    highValue.theirItems = result.theirHighValuedItems;
                    highValue.items = result.items;

                    // Crafting service: trigger fabricator craft after backpack sync
                    const strangifyService = offer.data('strangifyService') as { preTradeIds?: string[] } | undefined;
                    if (strangifyService) {
                        log.info(`[strangifyService] Trade ${offer.id} accepted — scheduling apply in 5s`);
                        setTimeout(() => {
                            void this.handleStrangifyAccepted(offer.partner, strangifyService.preTradeIds ?? []);
                        }, 5000);
                    }

                    const craftingService = offer.data('craftingService') as
                        | { phase: 'intake'; fabricatorAssetIds: string[]; preTradeIds?: string[] }
                        | { phase: 'components'; fabricatorAssetIds: string[]; componentAssetIds: string[]; kitAssetIds?: string[]; preTradeIds?: string[] }
                        | { phase?: undefined; fabricatorAssetIds: string[]; componentAssetIds: string[]; kitAssetIds?: string[]; preTradeIds?: string[]; adminSelfFill?: boolean }
                        | undefined;
                    if (craftingService) {
                        const partnerSteamID64 = offer.partner.getSteamID64();
                        // See fetchTradeUrlToken on handleCraftingIntake below — every offer sent
                        // from this block (refund, partial-fill/results return) is bot-initiated.
                        const token = await fetchTradeUrlToken(partnerSteamID64);
                        const preTradeIds = craftingService.preTradeIds;
                        log.info(`[craftingService] Trade ${offer.id} accepted — scheduling fabricator craft in 5s`);

                        // preTradeIds was snapshotted before the trade was accepted (either in
                        // onNewTradeOffer, or in HttpManager.ts / handleCraftingIntake for
                        // bot-initiated website offers). After 5s the GC backpack is synced —
                        // any ID not in the snapshot is from this trade.
                        const knownIds = new Set<string>(preTradeIds ?? []);

                        if (craftingService.phase === 'intake') {
                            // Received one or more bare fabricators — read each one's real recipe
                            // now that we own them, then send a (combined, if more than one)
                            // follow-up offer requesting matching components.
                            const expectedCount = craftingService.fabricatorAssetIds.length;

                            const attemptIntakeDiff = (attempt: number): void => {
                                const currentBackpack: any[] = (this.bot.tf2 as any).backpack ?? [];
                                const newItems = currentBackpack.filter((i: any) => !knownIds.has(String(i.id)));

                                // Exclude fabricators another (sibling) intake offer's own diff already
                                // claimed — see claimedIntakeFabricatorIds' comment for why this happens.
                                const newFabsFromDiff = newItems
                                    .filter(
                                        (i: any) =>
                                            FABRICATOR_DEFINDEXES.includes(i.def_index) &&
                                            !this.claimedIntakeFabricatorIds.has(String(i.id))
                                    )
                                    .sort((a: any, b: any) => a.def_index - b.def_index);

                                log.debug(`[craftingService] Intake backpack diff (attempt ${attempt}): ${newItems.length} new item(s), ${newFabsFromDiff.length} unclaimed fabricator(s) (knownIds=${knownIds.size}): ${newItems.map((i: any) => `id=${i.id} def=${i.def_index}`).join(', ') || '(none)'}`);

                                if (newFabsFromDiff.length !== expectedCount) {
                                    if (attempt < 3) {
                                        log.debug(`[craftingService] Intake: expected ${expectedCount} new fabricator(s), found ${newFabsFromDiff.length} — retrying in 5s (attempt ${attempt + 1}/3)`);
                                        setTimeout(() => attemptIntakeDiff(attempt + 1), 5000);
                                        return;
                                    }
                                    log.warn(`[craftingService] Intake: expected ${expectedCount} new fabricator(s), found ${newFabsFromDiff.length} after ${attempt} attempts`);
                                    if (newFabsFromDiff.length === 0) {
                                        this.bot.sendMessage(
                                            offer.partner,
                                            `⚠️ Something went wrong receiving your fabricator(s) — please contact the bot owner.`
                                        );
                                    } else {
                                        // Found candidate fabricator(s), just couldn't tell which one(s)
                                        // belong to this specific offer — hold all of them so
                                        // !retryintake can resolve each individually instead of leaving
                                        // them stuck in the bot's backpack with no way to recover them.
                                        newFabsFromDiff.forEach((i: any) => this.heldIntakeFabricators.set(String(i.id), partnerSteamID64));
                                        log.warn(`[craftingService] Intake: holding ${newFabsFromDiff.length} ambiguous fabricator(s) for ${partnerSteamID64}: ${newFabsFromDiff.map((i: any) => i.id).join(', ')}`);
                                        this.bot.messageAdmins(
                                            `⚠️ Held ${newFabsFromDiff.length} ambiguous fabricator(s) for ${partnerSteamID64}: ${newFabsFromDiff.map((i: any) => i.id).join(', ')}. Use !retryintake assetid=<id> or !returnfab assetid=<id>.`,
                                            []
                                        );
                                        this.bot.sendMessage(
                                            offer.partner,
                                            `⚠️ Ambiguous fabricator match — I'll retry automatically shortly, no action needed on your end.`
                                        );
                                    }
                                    return;
                                }

                                newFabsFromDiff.forEach((i: any) => this.claimedIntakeFabricatorIds.add(String(i.id)));

                                if (newFabsFromDiff.length === 1) {
                                    void this.handleCraftingIntake(offer.partner, newFabsFromDiff[0], offer.id);
                                } else {
                                    void this.handleCraftingIntakeBatch(offer.partner, newFabsFromDiff, offer.id);
                                }
                            };

                            setTimeout(() => attemptIntakeDiff(1), 5000);
                            return;
                        }

                        setTimeout(() => {
                            const currentBackpack: any[] = (this.bot.tf2 as any).backpack ?? [];
                            const newItems = currentBackpack.filter((i: any) => !knownIds.has(String(i.id)));
                            const allNewIds = newItems.map((i: any) => String(i.id));

                            // Held from here until these items are crafted away or returned, so a
                            // concurrent self-fill craft can't spend them. Released in sendResults
                            // and doRefund once they're on their way back.
                            allNewIds.forEach((id: string) => this.craftingInFlightIds.add(id));

                            log.debug(`[craftingService] Backpack diff: ${newItems.length} new item(s) (knownIds=${knownIds.size}): ${newItems.map((i: any) => `id=${i.id} def=${i.def_index}`).join(', ') || '(none)'}`);

                            // All new fabs in this trade's diff, Spec (20002) before Pro (20003)
                            const newFabsFromDiff = newItems
                                .filter((i: any) => FABRICATOR_DEFINDEXES.includes(i.def_index))
                                .sort((a: any, b: any) => a.def_index - b.def_index);

                            const { fabricatorAssetIds, componentAssetIds, kitAssetIds, adminSelfFill } = craftingService as {
                                fabricatorAssetIds: string[];
                                componentAssetIds: string[];
                                kitAssetIds?: string[];
                                adminSelfFill?: boolean;
                            };
                            const selfFill = adminSelfFill === true;

                            // phase 'components': the fabricator was already received in a prior intake
                            // trade, so it won't appear in THIS trade's diff — look it up directly by its
                            // now-current id instead. Legacy Mode A/B (no phase) still expects the
                            // fabricator to arrive in the same diff as the components.
                            const newFabs = craftingService.phase === 'components' && fabricatorAssetIds.length > 0
                                ? fabricatorAssetIds
                                      .map((id: string) => currentBackpack.find((i: any) => String(i.id) === id))
                                      .filter(Boolean)
                                      .sort((a: any, b: any) => a.def_index - b.def_index)
                                : newFabsFromDiff;

                            // Component pool = all non-fab new items
                            const availablePool: any[] = newItems.filter((i: any) => !FABRICATOR_DEFINDEXES.includes(i.def_index));

                            if (componentAssetIds.length > 0 && availablePool.length !== componentAssetIds.length) {
                                log.warn(`[craftingService] Backpack diff: expected ${componentAssetIds.length} component(s), got ${availablePool.length} — may include unrelated items from concurrent operation`);
                            }

                            const doRefund = (reason: string): void => {
                                log.warn(`[craftingService] ${reason}`);
                                this.bot.sendMessage(
                                    offer.partner,
                                    `⚠️ Crafting failed: ${reason}. Your items will be returned.`
                                );
                                const refundIds = allNewIds.length > 0
                                    ? allNewIds
                                    : (offer.itemsToReceive as any[]).map((i: any) => String(i.assetid));
                                const refundOffer = this.bot.manager.createOffer(offer.partner, token);
                                refundOffer.data('dict', this.craftingDict(refundIds, []));
                                refundIds.forEach(id =>
                                    refundOffer.addMyItem({ appid: 440, contextid: '2', assetid: id })
                                );
                                // reason can embed an unbounded err.message (see kit-application
                                // failure callsite below) — slice defensively so we never exceed
                                // Steam's 128-char setMessage limit; full reason is already logged above.
                                refundOffer.setMessage(`Refund — crafting failed: ${reason}`.slice(0, 128));

                                const attemptSend = (retriesLeft: number): void => {
                                    this.bot.trades.sendOffer(refundOffer)
                                        .then(status => {
                                            if (status === 'pending') void this.bot.trades.acceptConfirmation(refundOffer);
                                            this.releaseCraftingInFlight(allNewIds);
                                        })
                                        .catch((sendErr: Error) => {
                                            if (retriesLeft > 0) {
                                                log.warn(`[craftingService] Refund send failed (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`);
                                                setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                                                return;
                                            }
                                            log.warn(`[craftingService] Refund send failed permanently to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                                            this.holdReturnItems(partnerSteamID64, refundIds);
                                            this.bot.sendMessage(
                                                offer.partner,
                                                `⚠️ Crafting failed and I couldn't return your items just now — I'll retry automatically shortly, no action needed unless it doesn't resolve.`
                                            );
                                            this.bot.messageAdmins(
                                                `⚠️ [craftingService] Refund to ${partnerSteamID64} failed after 3 attempts (${this.describeSendError(sendErr)}). ` +
                                                    `Manual return needed — item IDs: ${refundIds.join(', ')}`,
                                                []
                                            );
                                        });
                                };
                                attemptSend(3);
                            };

                            if (newFabs.length === 0 && fabricatorAssetIds.length > 0) {
                                doRefund('Could not find any fabricators in backpack after trade');
                                return;
                            }

                            if (newFabs.length > 0) {
                                log.debug(`[craftingService] Found ${newFabs.length} fabricator(s) in backpack diff`);
                            }

                            const ROBOT_PART_DEFINDEXES = [5700, 5701, 5702, 5703, 5704, 5705, 5706, 5707];

                            const runMultiFabCraft = (pool: any[]): void => {
                                const craftPlan: { fabId: string; componentIds: string[] }[] = [];
                                const uncraftableFabIds: string[] = [];
                                let remainingPool = [...pool];

                                for (const fab of newFabs) {
                                    const components = buildCraftComponents(fab as any, remainingPool as any);
                                    // Under self-fill an empty match isn't a dead end — the bot's own
                                    // stock still has to be offered the slots before we give up.
                                    if (components.length > 0 || selfFill) {
                                        const usedIds = new Set(components.map((c: any) => c.subject_item_id));
                                        craftPlan.push({ fabId: String(fab.id), componentIds: [...usedIds] });
                                        remainingPool = remainingPool.filter((i: any) => !usedIds.has(String(i.id)));
                                    } else {
                                        uncraftableFabIds.push(String(fab.id));
                                    }
                                }
                                const leftoverIds = remainingPool.map((i: any) => String(i.id));

                                log.info(`[craftingService] Craft plan: ${craftPlan.length} fab(s) to attempt, ${uncraftableFabIds.length} with no matching components, ${leftoverIds.length} leftover component(s)`);

                                if (craftPlan.length === 0) {
                                    doRefund('No fabricators could be matched with any components');
                                    return;
                                }

                                const resultKitIds: string[] = [];
                                const partialFabIds: string[] = [];
                                const failedFabIds: string[] = [...uncraftableFabIds];
                                let planIndex = 0;

                                const sendResults = (): void => {
                                    const returnIds = [...resultKitIds, ...partialFabIds, ...failedFabIds, ...leftoverIds];
                                    if (returnIds.length === 0) {
                                        log.warn(`[craftingService] Nothing to return for offer ${offer.id}`);
                                        return;
                                    }
                                    const returnOffer = this.bot.manager.createOffer(offer.partner, token);
                                    returnOffer.data('dict', this.craftingDict(returnIds, []));
                                    returnIds.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));

                                    let msg: string;
                                    if (resultKitIds.length > 0 && partialFabIds.length === 0 && failedFabIds.length === 0 && leftoverIds.length === 0) {
                                        if (resultKitIds.length === 1) {
                                            const kitBpItem = ((this.bot.tf2 as any).backpack as any[] ?? []).find((i: any) => String(i.id) === resultKitIds[0]);
                                            const kitName = kitBpItem
                                                ? ((this.bot.schema as any).getItemByDefindex?.(kitBpItem.def_index)?.item_name ?? 'Killstreak Kit')
                                                : 'Killstreak Kit';
                                            msg = `Here is your ${kitName}! Thanks for using the crafting service.`;
                                        } else {
                                            msg = `Here are your ${resultKitIds.length} Killstreak Kits! Thanks for using the crafting service.`;
                                        }
                                    } else {
                                        const parts: string[] = [];
                                        if (resultKitIds.length > 0) parts.push(`${resultKitIds.length} kit(s) crafted`);
                                        if (partialFabIds.length > 0) parts.push(`${partialFabIds.length} fab(s) partial`);
                                        if (failedFabIds.length > 0) parts.push(`${failedFabIds.length} fab(s) failed`);
                                        if (leftoverIds.length > 0) parts.push(`${leftoverIds.length} part(s) leftover`);
                                        msg = parts.join(', ') + '. Thanks!';
                                    }

                                    returnOffer.setMessage(msg.slice(0, 128));
                                    log.info(`[craftingService] Sending return offer to ${partnerSteamID64}: ${returnIds.length} item(s)`);
                                    const attemptSend = (retriesLeft: number): void => {
                                        this.bot.trades.sendOffer(returnOffer)
                                            .then(status => {
                                                if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                                                this.releaseCraftingInFlight(allNewIds);
                                            })
                                            .catch((sendErr: Error) => {
                                                if (retriesLeft > 0) {
                                                    log.warn(`[craftingService] Failed to send return offer (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`);
                                                    setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                                                    return;
                                                }
                                                log.warn(`[craftingService] Failed to send return offer to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                                                this.holdReturnItems(partnerSteamID64, returnIds);
                                                this.bot.sendMessage(
                                                    offer.partner,
                                                    `⚠️ Crafting complete but couldn't send results automatically. Contact the bot owner. Kit IDs: ${resultKitIds.join(', ')}`
                                                );
                                                this.bot.messageAdmins(
                                                    `⚠️ [craftingService] Return offer to ${partnerSteamID64} failed after 3 attempts (${this.describeSendError(sendErr)}). ` +
                                                        `Items held — item IDs: ${returnIds.join(', ')}`,
                                                    []
                                                );
                                            });
                                    };
                                    attemptSend(3);
                                };

                                const craftNext = (): void => {
                                    if (planIndex >= craftPlan.length) {
                                        sendResults();
                                        return;
                                    }
                                    const { fabId, componentIds } = craftPlan[planIndex++];
                                    log.debug(`[craftingService] Crafting fab ${fabId} (${planIndex}/${craftPlan.length}) with ${componentIds.length} component(s)`);
                                    // Rebuilt per fab rather than once per plan: an earlier craft in
                                    // this same plan may have already spent some of the bot's stock.
                                    const craftOptions = {
                                        componentIds,
                                        selfFill,
                                        excludeIds: selfFill ? this.buildSelfFillExcludeIds(allNewIds) : undefined
                                    };
                                    this.bot.tf2gc.craftFabricator(fabId, craftOptions, (err, result) => {
                                        if (err || !result) {
                                            log.warn(`[craftingService] Craft failed for fab ${fabId}: ${err?.message ?? 'no result'}`);
                                            failedFabIds.push(fabId);
                                            if (selfFill && err) {
                                                // The generic "N fab(s) failed" summary doesn't say
                                                // WHICH part the bot ran out of, which is the only
                                                // thing worth knowing here.
                                                this.bot.sendMessage(offer.partner, `⚠️ Couldn't self-fill fabricator ${fabId}: ${err.message}`);
                                            }
                                        } else if (result.kitId) {
                                            log.info(`[craftingService] Craft succeeded for fab ${fabId} — kit ${result.kitId}`);
                                            resultKitIds.push(result.kitId);
                                            this.reconcileSelfFilledComponents(result.selfFilledIds);
                                        } else if (result.partialFabId) {
                                            log.info(`[craftingService] Partial fill for fab ${fabId} — returning partially filled fab`);
                                            partialFabIds.push(result.partialFabId);
                                            // A genuine partial fill (GC actually attached some components) consumes
                                            // them — they cease to exist as separate backpack items. But the timeout
                                            // path in TF2GC.craftFabricator can ALSO report partialFabId just because
                                            // the original fabricator is still present and unchanged, which is equally
                                            // consistent with the craft never having progressed at all — leaving these
                                            // componentIds untouched in the backpack. Checking which of them are still
                                            // actually there (rather than assuming either way) is the only way to tell,
                                            // and avoids stranding a customer's components with no return and no
                                            // tracking — the exact bug that caused a live stuck-parts incident.
                                            const backpack = ((this.bot.tf2 as any).backpack as any[]) ?? [];
                                            const unconsumedComponentIds = componentIds.filter(id =>
                                                backpack.some((i: any) => String(i.id) === id)
                                            );
                                            if (unconsumedComponentIds.length > 0) {
                                                log.warn(
                                                    `[craftingService] Partial fill for fab ${fabId} left ${unconsumedComponentIds.length} component(s) unconsumed — returning them too: ${unconsumedComponentIds.join(', ')}`
                                                );
                                                leftoverIds.push(...unconsumedComponentIds);
                                            }
                                            // Deliberately NOT added to leftoverIds: these are the
                                            // bot's own items, and leftoverIds is shipped to the
                                            // partner. Any of them the craft actually swallowed
                                            // just needs the inventory cache told.
                                            this.reconcileSelfFilledComponents(result.selfFilledIds);
                                        }
                                        craftNext();
                                    });
                                };

                                craftNext();
                            };

                            // Kit application path: apply unapplied KS Kits to plain weapons, then craft fabs
                            const unappliedKits = kitAssetIds && kitAssetIds.length > 0
                                ? availablePool.filter((i: any) => KS_KIT_DEFINDEXES.includes(i.def_index))
                                : [];

                            if (unappliedKits.length === 0) {
                                if (fabricatorAssetIds.length === 0) {
                                    doRefund('Kits not found in backpack after trade — cannot apply');
                                    return;
                                }
                                runMultiFabCraft(availablePool);
                                return;
                            }

                            log.info(`[craftingService] ${unappliedKits.length} unapplied kit(s) — applying before fabricator craft`);

                            const robotPartItems = availablePool.filter((i: any) => ROBOT_PART_DEFINDEXES.includes(i.def_index));
                            const hasKsAttr = (i: any): boolean =>
                                ((i as any).attribute ?? []).some((a: any) => a.def_index === 2025);
                            const alreadyKsWeapons = availablePool.filter((i: any) =>
                                !KS_KIT_DEFINDEXES.includes(i.def_index) &&
                                !ROBOT_PART_DEFINDEXES.includes(i.def_index) &&
                                hasKsAttr(i)
                            );
                            const plainWeapons = availablePool.filter((i: any) =>
                                !KS_KIT_DEFINDEXES.includes(i.def_index) &&
                                !ROBOT_PART_DEFINDEXES.includes(i.def_index) &&
                                !hasKsAttr(i)
                            );

                            // Match each kit to an unused weapon whose defindex equals the kit's own
                            // "tool target item" attribute (2012) — every Killstreak Kit is bound to one
                            // specific weapon (e.g. an Air Strike Kit only ever applies to an Air Strike),
                            // unlike a Fabricator's weapon *slot* which really is defidx=0/any-weapon.
                            // Pairing blind on array order previously mismatched kits to the wrong weapon,
                            // which the GC silently ignores (no response), producing a 30s
                            // "timed out waiting for kit application" failure and a full refund.
                            const kitPairs: { kitId: string; weaponId: string }[] = [];
                            const usedWeaponIds = new Set<string>();
                            for (const kit of unappliedKits) {
                                const targetDefindex = getItemAttrValue(kit, ATTR_TOOL_TARGET_ITEM);
                                log.debug(
                                    `[craftingService] Kit ${kit.id} (def=${(kit as any).def_index}) target defindex=${targetDefindex}, attrs=${JSON.stringify(((kit as any).attribute ?? []).map((a: any) => ({ d: a.def_index, v: a.value, vb: a.value_bytes })))}`
                                );
                                if (targetDefindex === null) {
                                    doRefund(`Could not determine target weapon for kit ${kit.id}`);
                                    return;
                                }
                                const match = plainWeapons.find(
                                    (w: any) => !usedWeaponIds.has(String(w.id)) && w.def_index === Math.round(targetDefindex)
                                );
                                if (!match) {
                                    doRefund(`No matching weapon (defindex ${Math.round(targetDefindex)}) in your trade for kit ${kit.id}`);
                                    return;
                                }
                                usedWeaponIds.add(String(match.id));
                                kitPairs.push({ kitId: String(kit.id), weaponId: String(match.id) });
                            }

                            const resultWeaponIds: string[] = [];
                            let pairIndex = 0;

                            const applyNext = (): void => {
                                if (pairIndex >= kitPairs.length) {
                                    // Look up resulting KS weapons from current backpack and build full pool
                                    const currentBp: any[] = (this.bot.tf2 as any).backpack ?? [];
                                    const resultWeaponItems = resultWeaponIds
                                        .map(id => currentBp.find((i: any) => String(i.id) === id))
                                        .filter(Boolean);

                                    if (newFabs.length === 0) {
                                        // Kit-only trade — return the resulting KS weapons directly
                                        log.info(`[craftingService] Kit-only trade — returning ${resultWeaponIds.length} KS weapon(s)`);
                                        const returnOffer = this.bot.manager.createOffer(offer.partner, token);
                                        returnOffer.data('dict', this.craftingDict(resultWeaponIds, []));
                                        resultWeaponIds.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
                                        returnOffer.setMessage(`Here is your Killstreak weapon! Thanks for using the crafting service.`);
                                        const attemptSend = (retriesLeft: number): void => {
                                            this.bot.trades.sendOffer(returnOffer)
                                                .then(status => {
                                                    if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                                                })
                                                .catch((sendErr: Error) => {
                                                    if (retriesLeft > 0) {
                                                        log.warn(`[craftingService] Failed to send KS weapon (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`);
                                                        setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                                                        return;
                                                    }
                                                    log.warn(`[craftingService] Failed to send KS weapon to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                                                    this.holdReturnItems(partnerSteamID64, resultWeaponIds);
                                                    this.bot.sendMessage(
                                                        offer.partner,
                                                        `⚠️ Crafting complete but I couldn't send your weapon just now — I'll retry automatically shortly, no action needed.`
                                                    );
                                                });
                                        };
                                        attemptSend(3);
                                        return;
                                    }

                                    const fullPool = [...robotPartItems, ...alreadyKsWeapons, ...resultWeaponItems];
                                    log.debug(`[craftingService] Kit application done — pool: ${fullPool.length} item(s) for fab crafting`);
                                    runMultiFabCraft(fullPool);
                                    return;
                                }
                                const { kitId, weaponId } = kitPairs[pairIndex++];
                                log.debug(`[craftingService] Applying kit ${kitId} to weapon ${weaponId} (${pairIndex}/${kitPairs.length})`);
                                this.bot.tf2gc.applyKSKit(kitId, weaponId, (err, resultId) => {
                                    if (err || !resultId) {
                                        doRefund(`Kit application failed (kit ${kitId}): ${err?.message ?? 'no result'}`);
                                        return;
                                    }
                                    resultWeaponIds.push(resultId);
                                    applyNext();
                                });
                            };
                            applyNext();
                        }, 5000);
                    }
                } else if (
                    offer.state === TradeOfferManager.ETradeOfferState['Declined'] &&
                    this.bot.options.tradeSummary.declinedTrade.enable &&
                    !this.sentSummary[offer.id]
                ) {
                    //No need to create a new timeout cause a trade can't be accepted after getting declined or cant be declined after being accepted.
                    clearTimeout(this.resetSentSummaryTimeout);
                    this.sentSummary[offer.id] = true;

                    processDeclined(offer, this.bot);
                    MyHandler.removePolldataKeys(offer);
                }
            }

            if (offer.state === TradeOfferManager.ETradeOfferState['Accepted']) {
                // Offer is accepted

                if (this.isCraftingManual === false && !offer.data('craftingService')) {
                    // Smelt / combine metal
                    keepMetalSupply(this.bot, this.minimumScrap, this.minimumReclaimed, this.combineThreshold);

                    // Craft duplicate weapons
                    craftDuplicateWeapons(this.bot)
                        .then(() => {
                            return craftClassWeapons(this.bot);
                        })
                        .catch(err => {
                            log.warn('Failed to craft duplicated craft/class weapons', err);
                        });
                }

                // Sort inventory
                this.sortInventory();

                // Tell bot uptime
                log.debug(uptime());

                // Update listings
                updateListings(offer, this.bot, highValue);

                // Refresh pricedb.io inventory after trade if enabled
                if (
                    this.bot.pricedbStoreManager &&
                    this.opt.miscSettings.pricedbStore.enable &&
                    this.opt.miscSettings.pricedbStore.enableInventoryRefresh
                ) {
                    this.bot.pricedbStoreManager.refreshInventory().catch(err => {
                        log.warn('Failed to refresh pricedb.io inventory after trade:', err);
                    });
                }

                // Invite to group
                this.inviteToGroups(offer.partner);

                // delete notify and meta keys from polldata after each successful trades
                MyHandler.removePolldataKeys(offer);

                this.resetSentSummaryTimeout = setTimeout(() => {
                    this.sentSummary = {};
                }, 2 * 60 * 1000);
            } else {
                this.bot.updateSteamGamePresence();
            }
        })().catch(err => {
            log.error('Error in onTradeOfferChanged:', err);
        });
    }

    private static removePolldataKeys(offer: TradeOffer): void {
        offer.data('notify', undefined);
        offer.data('meta', undefined);
    }

    /**
     * Handles the "intake" phase of a website-initiated crafting-service trade: the bot just
     * received a lone fabricator, and — now owning it — can read its real recipe via
     * decodeFabricatorSlots(). This checks what components the same trade partner currently owns
     * and sends a follow-up offer requesting whatever subset they have (partial fulfillment is
     * fine; the existing craft pipeline already tolerates unfilled slots).
     */
    private async handleCraftingIntake(partner: SteamID, fab: any, intakeOfferId?: string): Promise<void> {
        const partnerSteamID64 = partner.getSteamID64();
        this.heldIntakeFabricators.delete(String(fab.id));
        // See fetchTradeUrlToken: every offer this method sends is initiated by us, not the
        // customer, so Steam needs a token to bypass their privacy settings if they aren't
        // friends with the bot. Fetched once up front and reused for every createOffer call below.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        try {
            // defindex 20002/20003 covers every fabricator regardless of target weapon — the
            // schema's item_name for that base defindex is generic (e.g. "... Kit Fabricator"),
            // not weapon-specific, so name-based resolution always resolves to the fabricator
            // itself. The actual target weapon is only known per-instance, already decoded into
            // the bot's own SKU for this item (the "td-<defindex>" segment, e.g. "20002;6;kt-2;
            // td-172;od-6523;oq-6") via the standard Steam-description-based SKU pipeline.
            const fabSku = this.bot.inventoryManager.getInventory.findByAssetid(String(fab.id));
            const tdMatch = fabSku?.match(/;td-(\d+)/);
            let targetWeaponDefindex = tdMatch ? parseInt(tdMatch[1], 10) : null;

            if (targetWeaponDefindex === null) {
                // Fallback in case the bot's own inventory hasn't synced this item's SKU yet.
                const fabSchemaItem = (this.bot.schema as any).getItemByDefindex?.(fab.def_index);
                const targetWeaponName = fabSchemaItem ? extractTargetWeaponName(fabSchemaItem.item_name) : null;
                targetWeaponDefindex = targetWeaponName
                    ? ((this.bot.schema as any).getItemByItemName?.(targetWeaponName)?.defindex ?? null)
                    : null;
            }

            if (targetWeaponDefindex === null) {
                log.warn(
                    `[craftingService] Intake: could not resolve target weapon defindex for fabricator ${fab.id} (def=${fab.def_index}, sku=${fabSku ?? 'unknown'}) — will only attempt robot-part slots`
                );
            } else {
                log.debug(
                    `[craftingService] Intake: resolved target weapon defindex ${targetWeaponDefindex} for fabricator ${fab.id} (sku=${fabSku ?? 'unknown'})`
                );
            }

            const kitDefindexByTier: Partial<Record<number, number>> = {};
            for (const defindex of KS_KIT_DEFINDEXES) {
                const kitSchemaItem = (this.bot.schema as any).getItemByDefindex?.(defindex);
                const tier = kitSchemaItem ? ksKitTierFromName(kitSchemaItem.item_name) : undefined;
                if (tier !== undefined) kitDefindexByTier[tier] = defindex;
            }

            let theirInventory = new Inventory(partner, this.bot, 'their', this.bot.boundInventoryGetter);
            let fetchErr: Error | undefined;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await theirInventory.fetch();
                    fetchErr = undefined;
                    break;
                } catch (err) {
                    fetchErr = err as Error;
                    log.warn(
                        `[craftingService] Intake: attempt ${attempt}/3 to load ${partnerSteamID64}'s inventory failed: ${fetchErr.message}`
                    );
                    if (attempt < 3) {
                        await new Promise(resolve => setTimeout(resolve, this.inventoryFetchRetryDelay(fetchErr, attempt)));
                    }
                }
            }
            if (fetchErr) {
                log.warn(
                    `[craftingService] Intake: native fetch failed after 3 attempts, trying ExpressLoad fallback for ${partnerSteamID64}`
                );
                const expressLoadItems = await fetchInventoryViaExpressLoad(partner, 440, '2');
                if (expressLoadItems) {
                    theirInventory = Inventory.fromItems(partner, expressLoadItems, this.bot, 'their', this.bot.boundInventoryGetter);
                    fetchErr = undefined;
                    log.debug(`[craftingService] Intake: ExpressLoad fallback succeeded for ${partnerSteamID64}`);
                }
            }
            if (fetchErr) {
                log.warn(`[craftingService] Intake: giving up loading ${partnerSteamID64}'s inventory after 3 attempts: ${fetchErr.message}`);
                const returnOffer = this.bot.manager.createOffer(partner, token);
                returnOffer.data('dict', this.craftingDict([String(fab.id)], []));
                returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: String(fab.id) });
                returnOffer.setMessage(
                    `⚠️ Failed to load your inventory 3x — Steam may be down, or it's private. Fabricator returned; make it public and re-send.`
                );
                this.bot.trades
                    .sendOffer(returnOffer)
                    .then(status => {
                        if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                    })
                    .catch((sendErr: Error) => {
                        log.warn(
                            `[craftingService] Intake: failed to return fabricator to ${partnerSteamID64} after inventory-fetch failure: ${this.describeSendError(sendErr)}`
                        );
                        this.heldIntakeFabricators.set(String(fab.id), partnerSteamID64);
                        this.alertHeldFabricators([String(fab.id)], partnerSteamID64, this.describeSendError(sendErr));
                        this.bot.sendMessage(
                            partner,
                            `⚠️ Failed to load your inventory, and returning your fabricator also failed just now. ` +
                                `I'll retry automatically shortly — no action needed unless it doesn't resolve.`
                        );
                    });
                return;
            }

            // Any Unique-quality (6) weapon with a matching killstreak tier satisfies the weapon
            // slot — the real recipe has no weapon-type restriction (see decodeFabricatorSlots:
            // weapon slots always decode with itemDefIndex=0). Strange-quality weapons are
            // intentionally excluded even though the base game allows them, per business rule.
            // Shared with the plain "weapon + kit" lookupSku fallback below — a customer's raw
            // Steam trade-asset items (with full descriptions) are only available before
            // Inventory reduces them to its SKU-keyed Dict, which discards this per-instance data.
            const rawItemsById = new Map(theirInventory.getRawItems.map(item => [item.id, item]));
            const excludeSpelledIds = (ids: string[]): string[] =>
                ids.filter(id => {
                    const rawItem = rawItemsById.get(id);
                    if (rawItem && hasExcludedHalloweenSpell(rawItem)) {
                        log.debug(`[craftingService] Intake: excluding item ${id} — has an excluded Halloween Spell`);
                        return false;
                    }
                    return true;
                });

            const lookupKillstreakWeapon = (killstreakTier: number, tradableOnly = true): string[] => {
                const results: string[] = [];
                for (const sku of Object.keys(theirInventory.getItems)) {
                    const parts = sku.split(';');
                    const skuDefindex = parseInt(parts[0], 10);
                    // Fabricators and unapplied Kits also carry a "kt-N" segment in their own SKU
                    // (their output tier) — exclude them, only actual weapons are valid here.
                    if (FABRICATOR_DEFINDEXES.includes(skuDefindex) || KS_KIT_DEFINDEXES.includes(skuDefindex)) {
                        continue;
                    }
                    if (parts[1] !== '6' || !parts.includes(`kt-${killstreakTier}`)) continue;
                    // Non-Craftable items can't be used as crafting ingredients in TF2 at all —
                    // Steam's GC would reject the whole recipe fulfillment if one were included.
                    if (parts.includes('uncraftable')) {
                        log.debug(`[craftingService] Intake: excluding uncraftable weapon SKU ${sku} from kt-${killstreakTier} weapon-slot candidates`);
                        continue;
                    }
                    // Business rule: Festive weapons (a distinct schema defindex, e.g. "Festive
                    // Rocket Launcher" — not the same thing as a Festivized ";festive" SKU tag) and
                    // weapons carrying specific Halloween Spells (Exorcism, Pumpkin Bombs,
                    // Halloween Fire) are never requested as crafting components.
                    if (isFestiveWeaponDefindex(skuDefindex, this.bot)) {
                        log.debug(`[craftingService] Intake: excluding Festive weapon SKU ${sku} from kt-${killstreakTier} weapon-slot candidates`);
                        continue;
                    }
                    results.push(...excludeSpelledIds(theirInventory.findBySKU(sku, tradableOnly)));
                }
                return results;
            };

            const result = findPartnerComponents(
                fab as any,
                targetWeaponDefindex,
                kitDefindexByTier,
                (sku, tradableOnly) => excludeSpelledIds(theirInventory.findBySKU(sku, tradableOnly)),
                lookupKillstreakWeapon
            );

            if (targetWeaponDefindex !== null && result.missing.some(m => m.includes('weapon'))) {
                const ownedSkusForDefindex = Object.keys(theirInventory.getItems).filter(
                    sku => sku.split(';')[0] === String(targetWeaponDefindex)
                );
                log.debug(
                    `[craftingService] Intake: weapon slot unmatched — searched defindex ${targetWeaponDefindex}, ` +
                        `partner's inventory SKUs for that defindex: ${
                            ownedSkusForDefindex.length > 0 ? ownedSkusForDefindex.join(', ') : '(none)'
                        }`
                );
            }

            if (result.assetIds.length === 0) {
                log.info(`[craftingService] Intake: no matching components found for ${partnerSteamID64} — returning fabricator ${fab.id}`);
                const returnOffer = this.bot.manager.createOffer(partner, token);
                returnOffer.data('dict', this.craftingDict([String(fab.id)], []));
                returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: String(fab.id) });
                // result.missing can list several unbounded slot descriptions — kept out of the
                // customer-facing message (still logged above) so this can't exceed Steam's 128-char cap.
                returnOffer.setMessage(
                    `You don't own any of the parts for this fabricator. It's being returned — trade it back once you have the parts!`
                );
                this.bot.trades
                    .sendOffer(returnOffer)
                    .then(status => {
                        if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                    })
                    .catch((sendErr: Error) => {
                        log.warn(`[craftingService] Intake: failed to return fabricator to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                        this.heldIntakeFabricators.set(String(fab.id), partnerSteamID64);
                        this.alertHeldFabricators([String(fab.id)], partnerSteamID64, this.describeSendError(sendErr));
                        this.bot.sendMessage(
                            partner,
                            `⚠️ Couldn't return your fabricator automatically just now — I'll retry shortly, no action needed on your end.`
                        );
                    });
                return;
            }

            const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
            const componentOffer = this.bot.manager.createOffer(partner, token);
            componentOffer.data('dict', this.craftingDict([], result.assetIds));
            result.assetIds.forEach(assetid => componentOffer.addTheirItem({ appid: 440, contextid: '2', assetid }));
            componentOffer.data('craftingService', {
                phase: 'components',
                fabricatorAssetIds: [String(fab.id)],
                componentAssetIds: [],
                preTradeIds
            });
            // result.missing can list several unbounded slot descriptions — kept out of the
            // customer-facing message (still logged elsewhere) so this can't exceed Steam's 128-char cap.
            componentOffer.setMessage(
                `Thanks! Found these parts in your inventory — accept to continue crafting.` +
                    (result.missing.length > 0 ? ` Missing some parts, so it may be partially filled.` : '')
            );

            const attemptSend = (retriesLeft: number): void => {
                this.bot.trades
                    .sendOffer(componentOffer)
                    .then(status => {
                        if (status === 'pending') void this.bot.trades.acceptConfirmation(componentOffer);
                        log.info(
                            `[craftingService] Intake: sent components offer ${componentOffer.id} to ${partnerSteamID64} (${result.assetIds.length} item(s), missing: ${result.missing.join(', ') || 'none'})`
                        );
                        if (intakeOfferId) {
                            void notifyComponentOffer({
                                steamId: partnerSteamID64,
                                intakeOfferId,
                                componentOfferId: componentOffer.id
                            });
                        }
                    })
                    .catch((sendErr: Error) => {
                        if (retriesLeft > 0) {
                            log.warn(
                                `[craftingService] Intake: failed to send components offer (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`
                            );
                            setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                            return;
                        }
                        log.warn(`[craftingService] Intake: failed to send components offer to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                        this.heldIntakeFabricators.set(String(fab.id), partnerSteamID64);
                        this.alertHeldFabricators([String(fab.id)], partnerSteamID64, this.describeSendError(sendErr));
                        this.bot.sendMessage(partner, `⚠️ Failed to send the follow-up parts request just now — I'll retry automatically shortly, no action needed.`);
                    });
            };
            attemptSend(3);
        } catch (err) {
            log.error(`[craftingService] Intake: unexpected error handling fabricator ${fab.id}:`, err);
            this.bot.sendMessage(partner, `⚠️ Something went wrong processing your fabricator — please contact the bot owner.`);
        }
    }

    /**
     * Same intake flow as handleCraftingIntake, generalized to N bare fabricators received in one
     * trade: fetches the partner's inventory once (not once per fabricator), resolves each
     * fabricator's own target weapon, and matches components for all of them against one shared
     * usedIds Set so the same owned item can't be requested for two different fabricators' slots.
     * Sends one combined follow-up offer instead of one per fabricator.
     */
    private async handleCraftingIntakeBatch(partner: SteamID, fabs: any[], intakeOfferId?: string): Promise<void> {
        const partnerSteamID64 = partner.getSteamID64();
        const fabIds = fabs.map(fab => String(fab.id));
        fabIds.forEach(id => this.heldIntakeFabricators.delete(id));
        // See fetchTradeUrlToken on handleCraftingIntake above.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        try {
            const kitDefindexByTier: Partial<Record<number, number>> = {};
            for (const defindex of KS_KIT_DEFINDEXES) {
                const kitSchemaItem = (this.bot.schema as any).getItemByDefindex?.(defindex);
                const tier = kitSchemaItem ? ksKitTierFromName(kitSchemaItem.item_name) : undefined;
                if (tier !== undefined) kitDefindexByTier[tier] = defindex;
            }

            let theirInventory = new Inventory(partner, this.bot, 'their', this.bot.boundInventoryGetter);
            let fetchErr: Error | undefined;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await theirInventory.fetch();
                    fetchErr = undefined;
                    break;
                } catch (err) {
                    fetchErr = err as Error;
                    log.warn(
                        `[craftingService] Intake (batch): attempt ${attempt}/3 to load ${partnerSteamID64}'s inventory failed: ${fetchErr.message}`
                    );
                    if (attempt < 3) {
                        await new Promise(resolve => setTimeout(resolve, this.inventoryFetchRetryDelay(fetchErr, attempt)));
                    }
                }
            }
            if (fetchErr) {
                log.warn(
                    `[craftingService] Intake (batch): native fetch failed after 3 attempts, trying ExpressLoad fallback for ${partnerSteamID64}`
                );
                const expressLoadItems = await fetchInventoryViaExpressLoad(partner, 440, '2');
                if (expressLoadItems) {
                    theirInventory = Inventory.fromItems(partner, expressLoadItems, this.bot, 'their', this.bot.boundInventoryGetter);
                    fetchErr = undefined;
                    log.debug(`[craftingService] Intake (batch): ExpressLoad fallback succeeded for ${partnerSteamID64}`);
                }
            }
            if (fetchErr) {
                log.warn(`[craftingService] Intake (batch): giving up loading ${partnerSteamID64}'s inventory after 3 attempts: ${fetchErr.message}`);
                const returnOffer = this.bot.manager.createOffer(partner, token);
                returnOffer.data('dict', this.craftingDict(fabIds, []));
                fabIds.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
                returnOffer.setMessage(
                    `⚠️ Failed to load your inventory 3x — Steam may be down, or it's private. Fabricators returned; make it public and re-send.`
                );
                this.bot.trades
                    .sendOffer(returnOffer)
                    .then(status => {
                        if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                    })
                    .catch((sendErr: Error) => {
                        log.warn(
                            `[craftingService] Intake (batch): failed to return fabricators to ${partnerSteamID64} after inventory-fetch failure: ${this.describeSendError(sendErr)}`
                        );
                        fabIds.forEach(id => this.heldIntakeFabricators.set(id, partnerSteamID64));
                        this.alertHeldFabricators(fabIds, partnerSteamID64, this.describeSendError(sendErr));
                        this.bot.sendMessage(
                            partner,
                            `⚠️ Failed to load your inventory, and returning your fabricators also failed just now. ` +
                                `I'll retry automatically shortly — no action needed unless it doesn't resolve.`
                        );
                    });
                return;
            }

            const rawItemsById = new Map(theirInventory.getRawItems.map(item => [item.id, item]));
            const excludeSpelledIds = (ids: string[]): string[] =>
                ids.filter(id => {
                    const rawItem = rawItemsById.get(id);
                    if (rawItem && hasExcludedHalloweenSpell(rawItem)) {
                        log.debug(`[craftingService] Intake (batch): excluding item ${id} — has an excluded Halloween Spell`);
                        return false;
                    }
                    return true;
                });

            const lookupKillstreakWeapon = (killstreakTier: number, tradableOnly = true): string[] => {
                const results: string[] = [];
                for (const sku of Object.keys(theirInventory.getItems)) {
                    const parts = sku.split(';');
                    const skuDefindex = parseInt(parts[0], 10);
                    if (FABRICATOR_DEFINDEXES.includes(skuDefindex) || KS_KIT_DEFINDEXES.includes(skuDefindex)) {
                        continue;
                    }
                    if (parts[1] !== '6' || !parts.includes(`kt-${killstreakTier}`)) continue;
                    // Non-Craftable items can't be used as crafting ingredients in TF2 at all —
                    // Steam's GC would reject the whole recipe fulfillment if one were included.
                    if (parts.includes('uncraftable')) {
                        log.debug(`[craftingService] Intake (batch): excluding uncraftable weapon SKU ${sku} from kt-${killstreakTier} weapon-slot candidates`);
                        continue;
                    }
                    // Business rule: Festive weapons (a distinct schema defindex, e.g. "Festive
                    // Rocket Launcher" — not the same thing as a Festivized ";festive" SKU tag) and
                    // weapons carrying specific Halloween Spells (Exorcism, Pumpkin Bombs,
                    // Halloween Fire) are never requested as crafting components.
                    if (isFestiveWeaponDefindex(skuDefindex, this.bot)) {
                        log.debug(`[craftingService] Intake (batch): excluding Festive weapon SKU ${sku} from kt-${killstreakTier} weapon-slot candidates`);
                        continue;
                    }
                    results.push(...excludeSpelledIds(theirInventory.findBySKU(sku, tradableOnly)));
                }
                return results;
            };

            // Shared across every fabricator in the batch so the same owned item can't be
            // claimed for two different fabricators' slots. Results are kept grouped by
            // fabricator (rather than flattened into one list) so a too-large batch can be split
            // into multiple offers below without ever re-matching against inventory — each
            // group's asset IDs are already mutually exclusive by the time this loop finishes.
            const usedIds = new Set<string>();
            const fabGroups: { fabId: string; assetIds: string[]; missing: string[] }[] = [];

            for (const fab of fabs) {
                const fabSku = this.bot.inventoryManager.getInventory.findByAssetid(String(fab.id));
                const tdMatch = fabSku?.match(/;td-(\d+)/);
                let targetWeaponDefindex = tdMatch ? parseInt(tdMatch[1], 10) : null;

                if (targetWeaponDefindex === null) {
                    const fabSchemaItem = (this.bot.schema as any).getItemByDefindex?.(fab.def_index);
                    const targetWeaponName = fabSchemaItem ? extractTargetWeaponName(fabSchemaItem.item_name) : null;
                    targetWeaponDefindex = targetWeaponName
                        ? ((this.bot.schema as any).getItemByItemName?.(targetWeaponName)?.defindex ?? null)
                        : null;
                }

                log.debug(
                    targetWeaponDefindex === null
                        ? `[craftingService] Intake (batch): could not resolve target weapon defindex for fabricator ${fab.id} (def=${fab.def_index}, sku=${fabSku ?? 'unknown'}) — will only attempt robot-part slots`
                        : `[craftingService] Intake (batch): resolved target weapon defindex ${targetWeaponDefindex} for fabricator ${fab.id} (sku=${fabSku ?? 'unknown'})`
                );

                const result = findPartnerComponents(
                    fab as any,
                    targetWeaponDefindex,
                    kitDefindexByTier,
                    (sku, tradableOnly) => excludeSpelledIds(theirInventory.findBySKU(sku, tradableOnly)),
                    lookupKillstreakWeapon,
                    usedIds
                );

                fabGroups.push({ fabId: String(fab.id), assetIds: result.assetIds, missing: result.missing });
            }

            const masterAssetIds = fabGroups.flatMap(g => g.assetIds);
            if (masterAssetIds.length === 0) {
                log.info(`[craftingService] Intake (batch): no matching components found for ${partnerSteamID64} — returning ${fabIds.length} fabricator(s)`);
                const returnOffer = this.bot.manager.createOffer(partner, token);
                returnOffer.data('dict', this.craftingDict(fabIds, []));
                fabIds.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
                returnOffer.setMessage(
                    `You don't own any of the parts for these fabricators. They're being returned — trade them back once you have the parts!`
                );
                this.bot.trades
                    .sendOffer(returnOffer)
                    .then(status => {
                        if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                    })
                    .catch((sendErr: Error) => {
                        log.warn(`[craftingService] Intake (batch): failed to return fabricators to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                        fabIds.forEach(id => this.heldIntakeFabricators.set(id, partnerSteamID64));
                        this.alertHeldFabricators(fabIds, partnerSteamID64, this.describeSendError(sendErr));
                        this.bot.sendMessage(
                            partner,
                            `⚠️ Couldn't return your fabricators automatically just now — I'll retry shortly, no action needed on your end.`
                        );
                    });
                return;
            }

            const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));

            // Sends one components offer per chunk of fabricator-groups. Chunks are only ever
            // produced by splitting fabGroups (never by re-matching against inventory), so two
            // chunks can never claim the same item. Splitting happens only in response to Steam's
            // "would exceed inventory capacity" error — halving the chunk and retrying each half
            // — since we don't know the bot's available headroom up front. Chunks are sent
            // sequentially (each half awaited before the next starts) to avoid stacking up
            // multiple outstanding offers to the same partner at once, which trips a separate
            // Steam rate limit.
            const CAPACITY_ERROR_SNIPPET = 'exceed the maximum number of items allowed';

            const sendChunk = async (group: typeof fabGroups, retriesLeft = 3): Promise<void> => {
                const chunkFabIds = group.map(g => g.fabId);
                const chunkAssetIds = group.flatMap(g => g.assetIds);
                const chunkMissing = group.filter(g => g.missing.length > 0);

                const offer = this.bot.manager.createOffer(partner, token);
                offer.data('dict', this.craftingDict([], chunkAssetIds));
                chunkAssetIds.forEach(assetid => offer.addTheirItem({ appid: 440, contextid: '2', assetid }));
                offer.data('craftingService', {
                    phase: 'components',
                    fabricatorAssetIds: chunkFabIds,
                    componentAssetIds: [],
                    preTradeIds
                });

                // Per-fabricator missing-parts detail is unbounded (one entry per fab in the chunk) —
                // kept out of the customer-facing message, replaced with a short fixed note instead.
                const missingMsg = chunkMissing.length > 0 ? ' Some may be partially filled (missing parts).' : '';
                offer.setMessage(
                    (`Thanks! Found parts for your ${chunkFabIds.length} fabricator(s) — accept to continue crafting.${missingMsg}`).slice(
                        0,
                        128
                    )
                );

                try {
                    const status = await this.bot.trades.sendOffer(offer);
                    if (status === 'pending') void this.bot.trades.acceptConfirmation(offer);
                    log.info(
                        `[craftingService] Intake (batch): sent components offer ${offer.id} to ${partnerSteamID64} for ${chunkFabIds.length} fabricator(s) (${chunkAssetIds.length} item(s))`
                    );
                    if (intakeOfferId) {
                        void notifyComponentOffer({
                            steamId: partnerSteamID64,
                            intakeOfferId,
                            componentOfferId: offer.id
                        });
                    }
                } catch (sendErr) {
                    // Capacity-check uses the raw message (the snippet only ever appears there);
                    // logging uses the decoded eresult/cause version for diagnosability.
                    const message = (sendErr as Error).message;
                    if (message.includes(CAPACITY_ERROR_SNIPPET) && group.length > 1) {
                        const mid = Math.ceil(group.length / 2);
                        log.warn(
                            `[craftingService] Intake (batch): chunk of ${group.length} fabricator(s) exceeded inventory capacity — splitting into ${mid}/${group.length - mid} and retrying`
                        );
                        await sendChunk(group.slice(0, mid));
                        await sendChunk(group.slice(mid));
                        return;
                    }
                    if (retriesLeft > 0) {
                        log.warn(
                            `[craftingService] Intake (batch): failed to send components offer for ${chunkFabIds.length} fabricator(s) (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`
                        );
                        await new Promise(resolve => setTimeout(resolve, 15000));
                        await sendChunk(group, retriesLeft - 1);
                        return;
                    }
                    log.warn(
                        `[craftingService] Intake (batch): failed to send components offer for fabricator(s) [${chunkFabIds.join(', ')}] to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`
                    );
                    chunkFabIds.forEach(id => this.heldIntakeFabricators.set(id, partnerSteamID64));
                    this.alertHeldFabricators(chunkFabIds, partnerSteamID64, this.describeSendError(sendErr));
                    this.bot.sendMessage(
                        partner,
                        `⚠️ Failed to send the follow-up parts request for ${chunkFabIds.length} fabricator(s) just now — I'll retry automatically shortly, no action needed.`
                    );
                }
            };
            void sendChunk(fabGroups);
        } catch (err) {
            log.error(`[craftingService] Intake (batch): unexpected error handling fabricators [${fabIds.join(', ')}]:`, err);
            this.bot.sendMessage(partner, `⚠️ Something went wrong processing your fabricators — please contact the bot owner.`);
        }
    }

    /**
     * Customer-facing !strangify command: scans the customer's own inventory for Strangifiers,
     * pairs each with a matching Unique-quality plain weapon also in their inventory, and sends
     * one combined bot-initiated offer requesting all matched pairs — so the customer doesn't
     * have to manually select potentially 100+ items in Steam's trade UI.
     *
     * Strangifier target-weapon resolution reuses the exact same mechanism as fabricators: the
     * standard SKU pipeline (getSKU.ts) already resolves each Strangifier's target weapon into a
     * "td-<defindex>" SKU segment (via a static schema attribute for some Strangifiers, a
     * name-parsing fallback for others — both already handled internally before the item is ever
     * stored in the inventory dict), so a simple regex on the SKU works for every Strangifier type.
     */
    async handleStrangifyCommand(partner: SteamID): Promise<void> {
        const partnerSteamID64 = partner.getSteamID64();
        // See fetchTradeUrlToken on handleCraftingIntake above.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        this.bot.sendMessage(partner, `🔍 Scanning your inventory for Strangifiers, one moment...`);

        const theirInventory = new Inventory(partner, this.bot, 'their', this.bot.boundInventoryGetter);
        let fetchErr: Error | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await theirInventory.fetch();
                fetchErr = undefined;
                break;
            } catch (err) {
                fetchErr = err as Error;
                log.warn(`[strangifyService] attempt ${attempt}/3 to load ${partnerSteamID64}'s inventory failed: ${fetchErr.message}`);
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, this.inventoryFetchRetryDelay(fetchErr, attempt)));
                }
            }
        }
        if (fetchErr) {
            this.bot.sendMessage(
                partner,
                `⚠️ Failed to load your inventory after 3 attempts — Steam might be down, or your inventory is ` +
                    `private. Please make sure it's public and try !strangify again.`
            );
            return;
        }

        const usedIds = new Set<string>();
        const pairs: { strangifierId: string; weaponId: string }[] = [];
        const unmatched: string[] = [];

        for (const sku of Object.keys(theirInventory.getItems)) {
            const defindex = parseInt(sku.split(';')[0], 10);
            const schemaItem = (this.bot.schema as any).getItemByDefindex?.(defindex);
            if (!schemaItem || schemaItem.item_name !== 'Strangifier') continue;

            const tdMatch = sku.match(/;td-(\d+)/);
            const targetDefindex = tdMatch ? parseInt(tdMatch[1], 10) : null;
            if (targetDefindex === null) {
                log.warn(`[strangifyService] Could not resolve target weapon for strangifier SKU ${sku} (${partnerSteamID64})`);
                continue;
            }

            // Unique (6) and Genuine (1) are both valid strangify inputs.
            const weaponSkus = [6, 1].map(quality => SKU.fromObject({ defindex: targetDefindex, quality }));
            const strangifierIds = theirInventory.findBySKU(sku, true).filter(id => !usedIds.has(id));

            for (const strangifierId of strangifierIds) {
                let weaponId: string | undefined;
                for (const weaponSku of weaponSkus) {
                    weaponId = theirInventory.findBySKU(weaponSku, true).find(id => !usedIds.has(id));
                    if (weaponId) break;
                }
                if (!weaponId) {
                    const weaponName =
                        (this.bot.schema as any).getItemByDefindex?.(targetDefindex)?.item_name ?? `defindex ${targetDefindex}`;
                    unmatched.push(weaponName);
                    continue;
                }
                usedIds.add(strangifierId);
                usedIds.add(weaponId);
                pairs.push({ strangifierId, weaponId });
            }
        }

        const uniqueUnmatched = [...new Set(unmatched)];

        if (pairs.length === 0 && uniqueUnmatched.length === 0) {
            this.bot.sendMessage(partner, `You don't have any Strangifiers in your inventory.`);
            return;
        }
        if (pairs.length === 0) {
            this.bot.sendMessage(
                partner,
                `Found Strangifier(s) but no matching Unique-quality weapon(s) owned for: ${uniqueUnmatched.join(', ')}. Nothing to request.`
            );
            return;
        }

        const preTradeIds = ((this.bot.tf2 as any).backpack as any[] ?? []).map((i: any) => String(i.id));
        const requestOffer = this.bot.manager.createOffer(partner, token);
        const requestedIds = pairs.flatMap(p => [p.strangifierId, p.weaponId]);
        requestOffer.data('dict', this.craftingDict([], requestedIds));
        requestedIds.forEach(assetid => requestOffer.addTheirItem({ appid: 440, contextid: '2', assetid }));
        // Only preTradeIds is kept — `pairs` was computed against the customer's PRE-trade asset
        // IDs, which Steam always reassigns once the items land in the bot's own backpack. Storing
        // it here would tempt a future reader into reusing stale IDs post-accept, so it's dropped;
        // handleStrangifyAccepted re-derives the real pairing from the post-accept backpack diff.
        requestOffer.data('strangifyService', { preTradeIds });
        // uniqueUnmatched can list many weapon names — kept out of the customer-facing message
        // (a count is enough context) so this can't exceed Steam's 128-char cap.
        requestOffer.setMessage(
            `Found ${pairs.length} Strangifier+weapon pair(s) — accept to apply them!` +
                (uniqueUnmatched.length > 0 ? ` ${uniqueUnmatched.length} unmatched, skipped.` : '')
        );

        const attemptSend = (retriesLeft: number): void => {
            this.bot.trades
                .sendOffer(requestOffer)
                .then(status => {
                    if (status === 'pending') void this.bot.trades.acceptConfirmation(requestOffer);
                    log.info(`[strangifyService] Sent request offer ${requestOffer.id} to ${partnerSteamID64} for ${pairs.length} pair(s)`);
                })
                .catch((sendErr: Error) => {
                    if (retriesLeft > 0) {
                        log.warn(
                            `[strangifyService] Failed to send request offer (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`
                        );
                        setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                        return;
                    }
                    log.warn(`[strangifyService] Failed to send request offer to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                    this.bot.sendMessage(partner, `⚠️ Failed to send the strangify request offer — please try !strangify again in a bit.`);
                });
        };
        attemptSend(3);
    }

    /**
     * Applies each accepted strangifier+weapon pair sequentially (one applyStrangifier GC job at
     * a time, matching the sequential craftNext pattern used for fabricators) and returns the
     * resulting Strange weapon(s) — plus any pair that failed to apply, unchanged — in one
     * combined offer. Reuses the existing heldReturnItems tracking/auto-retry for send failures.
     *
     * The pairing computed by handleStrangifyCommand used the customer's PRE-trade asset IDs —
     * Steam always assigns new asset IDs to items once they change owner via trade, so those IDs
     * don't exist in the bot's own backpack. Re-derives the real pairing here from the post-accept
     * backpack diff (same preTradeIds-snapshot technique the crafting service uses), instead of
     * trusting the stale IDs — using stale IDs was the original bug: applyStrangifier failed with
     * "not found in backpack", and the return offer then failed with Steam EResult 26 (Revoked)
     * because it tried to give back items that never existed under those IDs in the first place.
     */
    private async handleStrangifyAccepted(partner: SteamID, preTradeIds: string[]): Promise<void> {
        const partnerSteamID64 = partner.getSteamID64();
        // See fetchTradeUrlToken on handleCraftingIntake above.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        const resultWeaponIds: string[] = [];
        const failedPairIds: string[] = [];

        const knownIds = new Set<string>(preTradeIds);
        const newItems: any[] = ((this.bot.tf2 as any).backpack as any[] ?? []).filter(
            (i: any) => !knownIds.has(String(i.id))
        );
        log.debug(
            `[strangifyService] Backpack diff: ${newItems.length} new item(s) (knownIds=${knownIds.size}): ${newItems.map((i: any) => `id=${i.id} def=${i.def_index}`).join(', ') || '(none)'}`
        );

        const usedIds = new Set<string>();
        const pairs: { strangifierId: string; weaponId: string }[] = [];
        for (const item of newItems) {
            const itemId = String(item.id);
            if (usedIds.has(itemId)) continue;

            const sku = this.bot.inventoryManager.getInventory.findByAssetid(itemId);
            const defindex = sku ? parseInt(sku.split(';')[0], 10) : item.def_index;
            const schemaItem = (this.bot.schema as any).getItemByDefindex?.(defindex);
            if (!schemaItem || schemaItem.item_name !== 'Strangifier') continue;

            const tdMatch = sku?.match(/;td-(\d+)/);
            const targetDefindex = tdMatch ? parseInt(tdMatch[1], 10) : null;
            if (targetDefindex === null) {
                log.warn(`[strangifyService] Could not resolve target weapon for strangifier ${itemId} (sku=${sku ?? 'unknown'})`);
                continue;
            }

            const weaponMatch = newItems.find((w: any) => {
                const wId = String(w.id);
                if (wId === itemId || usedIds.has(wId) || w.def_index !== targetDefindex) return false;
                const wSku = this.bot.inventoryManager.getInventory.findByAssetid(wId);
                const wQuality = wSku ? parseInt(wSku.split(';')[1], 10) : null;
                return wQuality === 6 || wQuality === 1; // Unique or Genuine
            });

            if (!weaponMatch) {
                log.warn(`[strangifyService] Received strangifier ${itemId} but no matching weapon (defindex ${targetDefindex}) found in backpack diff`);
                continue;
            }

            usedIds.add(itemId);
            usedIds.add(String(weaponMatch.id));
            pairs.push({ strangifierId: itemId, weaponId: String(weaponMatch.id) });
        }

        if (pairs.length === 0) {
            log.warn(`[strangifyService] No strangifier+weapon pairs resolved from backpack diff for ${partnerSteamID64} — nothing to apply`);
            return;
        }

        const applyNext = (index: number): void => {
            if (index >= pairs.length) {
                const returnIds = [...resultWeaponIds, ...failedPairIds];
                if (returnIds.length === 0) {
                    log.warn(`[strangifyService] Nothing to return to ${partnerSteamID64}`);
                    return;
                }
                const returnOffer = this.bot.manager.createOffer(partner, token);
                returnOffer.data('dict', this.craftingDict(returnIds, []));
                returnIds.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
                returnOffer.setMessage(
                    failedPairIds.length > 0
                        ? `Here are your ${resultWeaponIds.length} Strange weapon(s)! ${
                              failedPairIds.length / 2
                          } pair(s) failed — contact the bot owner.`
                        : `Here are your ${resultWeaponIds.length} Strange weapon(s)! Thanks for using the strangifier service.`
                );

                const attemptSend = (retriesLeft: number): void => {
                    this.bot.trades
                        .sendOffer(returnOffer)
                        .then(status => {
                            if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
                            log.info(`[strangifyService] Sent return offer ${returnOffer.id} to ${partnerSteamID64}: ${returnIds.length} item(s)`);
                        })
                        .catch((sendErr: Error) => {
                            if (retriesLeft > 0) {
                                log.warn(
                                    `[strangifyService] Failed to send return offer (${this.describeSendError(sendErr)}), retrying in 15s (${retriesLeft} left)`
                                );
                                setTimeout(() => attemptSend(retriesLeft - 1), 15000);
                                return;
                            }
                            log.warn(`[strangifyService] Failed to send return offer to ${partnerSteamID64}: ${this.describeSendError(sendErr)}`);
                            this.holdReturnItems(partnerSteamID64, returnIds);
                            this.bot.sendMessage(
                                partner,
                                `⚠️ Strangifying complete but couldn't send results automatically. Contact the bot owner.`
                            );
                        });
                };
                attemptSend(3);
                return;
            }

            const { strangifierId, weaponId } = pairs[index];
            this.bot.tf2gc.applyStrangifier(strangifierId, weaponId, (err, resultWeaponId) => {
                if (err || !resultWeaponId) {
                    log.warn(
                        `[strangifyService] Failed to apply strangifier ${strangifierId} to weapon ${weaponId} for ${partnerSteamID64}: ${
                            err?.message ?? 'no result'
                        }`
                    );
                    failedPairIds.push(strangifierId, weaponId);
                } else {
                    log.info(`[strangifyService] Applied strangifier ${strangifierId} to weapon ${weaponId} -> ${resultWeaponId}`);
                    resultWeaponIds.push(resultWeaponId);
                }
                applyNext(index + 1);
            });
        };

        applyNext(0);
    }

    /**
     * Re-runs the intake step for a fabricator that got stuck after exhausting inventory-fetch
     * retries (see heldIntakeFabricators). Wired to the admin-only !retryintake command.
     */
    async retryHeldIntake(fabAssetId: string): Promise<string> {
        const partnerSteamID64 = this.heldIntakeFabricators.get(fabAssetId);
        if (!partnerSteamID64) {
            return `❌ No held fabricator found with assetid ${fabAssetId}.`;
        }

        const fab = (((this.bot.tf2 as any).backpack as any[]) ?? []).find((i: any) => String(i.id) === fabAssetId);
        if (!fab) {
            return `❌ Fabricator ${fabAssetId} is no longer in the bot's backpack (already processed or traded away?).`;
        }

        void this.handleCraftingIntake(new SteamID(partnerSteamID64), fab);
        return `🔄 Retrying intake for fabricator ${fabAssetId} (partner ${partnerSteamID64})...`;
    }

    // Force-returns a fabricator stuck in heldIntakeFabricators as-is, bypassing the
    // parts-matching/request flow entirely (unlike retryHeldIntake, which re-runs that same flow
    // and will hit the same error again if the failure isn't transient, e.g. a partner-side
    // AccessDenied on sending them a new offer). Wired to the admin-only !returnfab command.
    //
    // heldIntakeFabricators is in-memory only, so a bot restart between a fabricator getting held
    // and an admin acting on it wipes the map entry even though the item is still physically in
    // the backpack — steamID64Override lets the command work anyway by skipping the lookup.
    async forceReturnHeldIntake(fabAssetId: string, steamID64Override?: string): Promise<string> {
        const partnerSteamID64 = this.heldIntakeFabricators.get(fabAssetId) ?? steamID64Override;
        if (!partnerSteamID64) {
            return `❌ No held fabricator found with assetid ${fabAssetId}. If it's stuck from before a restart, pass steamid=<64>.`;
        }

        const fab = (((this.bot.tf2 as any).backpack as any[]) ?? []).find((i: any) => String(i.id) === fabAssetId);
        if (!fab) {
            this.heldIntakeFabricators.delete(fabAssetId);
            return `❌ Fabricator ${fabAssetId} is no longer in the bot's backpack (already processed or traded away?). Cleared the hold.`;
        }

        const partner = new SteamID(partnerSteamID64);
        // See fetchTradeUrlToken on handleCraftingIntake above.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        const returnOffer = this.bot.manager.createOffer(partner, token);
        returnOffer.data('dict', this.craftingDict([fabAssetId], []));
        returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: fabAssetId });
        returnOffer.setMessage(`Here's your fabricator back — we weren't able to process it automatically.`);

        try {
            const status = await this.bot.trades.sendOffer(returnOffer);
            if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
            this.heldIntakeFabricators.delete(fabAssetId);
            this.bot.sendMessage(
                partner,
                `Your fabricator has been returned — sorry for the delay! Feel free to re-send it if you'd like to try again.`
            );
            return `✅ Returned fabricator ${fabAssetId} to ${partnerSteamID64}.`;
        } catch (err) {
            return `❌ Failed to return fabricator ${fabAssetId} to ${partnerSteamID64}: ${this.describeSendError(err)}. Still held — try again.`;
        }
    }

    // summarizeOffer.ts reads offer.data('dict') and crashes (Object.keys on null) if it's never set.
    // It's normally set by the Cart classes or by onNewTradeOffer's own evaluation — neither of
    // which runs for offers the crafting service creates directly via manager.createOffer(). Keys
    // need to be actual SKUs (not raw asset IDs) for getSummary() in summarizeOffer.ts to resolve a
    // real item name instead of printing the bare asset ID — resolve each ID against the bot's
    // current GC backpack for a defindex/quality, falling back to the raw ID only if the item can't
    // be found there (e.g. it already left the backpack by the time this runs).
    private craftingDict(giveIds: string[], receiveIds: string[]): { our: Record<string, number>; their: Record<string, number> } {
        const backpack: any[] = ((this.bot.tf2 as any).backpack as any[]) ?? [];
        const toCounts = (ids: string[]): Record<string, number> => {
            const counts: Record<string, number> = {};
            for (const id of ids) {
                const item = backpack.find((i: any) => String(i.id) === id);
                const key = item
                    ? `${item.def_index};${item.quality ?? 6}${item.flag_cannot_craft ? ';uncraftable' : ''}`
                    : id;
                counts[key] = (counts[key] ?? 0) + 1;
            }
            return counts;
        };
        return { our: toCounts(giveIds), their: toCounts(receiveIds) };
    }

    /**
     * Backpack IDs a self-fill craft must not spend. Everything the bot physically holds is a
     * candidate ingredient as far as the GC is concerned, so what keeps this safe is subtraction:
     * anything that belongs to someone else, or that the bot has promised elsewhere, is removed
     * before the recipe gets to choose.
     *
     * @param currentTradeIds every item that arrived in the trade being crafted. Excluded wholesale
     * because those are passed separately as componentIds — they must not be double-counted as
     * donated stock, or a partial fill would hand the customer's own items back as "leftovers"
     * twice over.
     */
    private buildSelfFillExcludeIds(currentTradeIds: string[]): string[] {
        const exclude = new Set<string>(currentTradeIds);

        this.craftingInFlightIds.forEach(id => exclude.add(id));
        this.heldIntakeFabricators.forEach((_partner, id) => exclude.add(id));
        this.claimedIntakeFabricatorIds.forEach(id => exclude.add(id));
        this.heldReturnItems.forEach(ids => ids.forEach(id => exclude.add(id)));

        const backpack: any[] = ((this.bot.tf2 as any).backpack as any[]) ?? [];

        // A fabricator can never fill a slot, and a Killstreak Kit is a recipe's OUTPUT rather than
        // an input. Neither should ever be selected, and both are valuable enough that relying on
        // slot matching alone to skip them is not worth the risk.
        for (const item of backpack) {
            if (FABRICATOR_DEFINDEXES.includes(item.def_index) || KS_KIT_DEFINDEXES.includes(item.def_index)) {
                exclude.add(String(item.id));
            }
        }

        // Stock floor: never let a craft pull a SKU below the `min` its pricelist entry promises.
        // Keyed off the pricelist rather than a hardcoded parts list, so killstreak weapons are
        // covered automatically once the bot starts stocking and pricing them.
        const bySku = new Map<string, string[]>();
        for (const item of backpack) {
            const id = String(item.id);
            if (exclude.has(id)) continue;
            const sku = `${item.def_index};${item.quality ?? 6}${item.flag_cannot_craft ? ';uncraftable' : ''}`;
            bySku.set(sku, [...(bySku.get(sku) ?? []), id]);
        }

        bySku.forEach((ids, sku) => {
            const min = this.bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: false })?.min ?? 0;
            if (min <= 0) return;
            // Reserve from the front; which specific copies are held back doesn't matter, only how
            // many. If stock is already at or below the floor this excludes all of them.
            ids.slice(0, min).forEach(id => exclude.add(id));
        });

        return [...exclude];
    }

    // Called once a trade's items are on their way back to their owner. Anything that failed to send
    // deliberately stays reserved — it's tracked in heldReturnItems instead and still isn't ours.
    private releaseCraftingInFlight(assetIds: string[]): void {
        assetIds.forEach(id => this.craftingInFlightIds.delete(id));
    }

    /**
     * Drops components the bot spent on its own craft out of the Steam inventory cache.
     *
     * Every other TF2GC job already does this (see the combine/craft/apply handlers), but the
     * fabricator path never needed to: it only ever consumed items that had just arrived from a
     * customer and were never counted as the bot's stock. Self-fill breaks that assumption — the
     * items it burns are stock the bot bought. Left uncorrected the cache keeps counting them, so
     * `amountCanTrade` sizes buy orders against inventory that no longer exists and the bot bids
     * for parts it thinks it still has.
     *
     * Only ids genuinely absent from the GC backpack are removed: a craft can report a partial fill
     * without having consumed anything, and dropping a still-held item would err the other way.
     */
    private reconcileSelfFilledComponents(selfFilledIds: string[] | undefined): void {
        if (!selfFilledIds?.length) return;

        const backpack: any[] = ((this.bot.tf2 as any).backpack as any[]) ?? [];
        const inventory = this.bot.inventoryManager.getInventory;
        const affectedSkus = new Set<string>();

        for (const id of selfFilledIds) {
            if (backpack.some((i: any) => String(i.id) === id)) continue;

            // Resolve the SKU before removing — that lookup is exactly what removeItem invalidates.
            const sku = inventory.findByAssetid(id);
            if (sku !== null) affectedSkus.add(sku);
            inventory.removeItem(id);
        }

        if (affectedSkus.size === 0) return;

        log.info(
            `[craftingService] Self-fill consumed ${selfFilledIds.length} of the bot's own item(s); ` +
                `refreshing listings for ${[...affectedSkus].join(', ')}`
        );
        affectedSkus.forEach(sku => this.bot.listings.checkByPriceKey({ priceKey: sku }));
    }

    private holdReturnItems(partnerSteamID64: string, assetIds: string[]): void {
        const existing = this.heldReturnItems.get(partnerSteamID64) ?? [];
        this.heldReturnItems.set(partnerSteamID64, [...new Set([...existing, ...assetIds])]);
        this.bot.messageAdmins(
            `⚠️ Held ${assetIds.length} item(s) for ${partnerSteamID64} after a return send failed: ${assetIds.join(', ')}. Use !retryreturn steamid=${partnerSteamID64}.`,
            []
        );
    }

    // Alerts admins (Steam + Discord) whenever a fabricator gets stuck at the intake step —
    // these previously only messaged the customer, so a repeatedly-failing send (e.g. a
    // partner-side AccessDenied that auto-retry can't fix) went unnoticed indefinitely.
    private alertHeldFabricators(fabAssetIds: string[], partnerSteamID64: string, reason: string): void {
        this.bot.messageAdmins(
            `⚠️ Held ${fabAssetIds.length} fabricator(s) for ${partnerSteamID64} (${reason}): ${fabAssetIds.join(', ')}. ` +
                `Use !retryintake assetid=<id> or !returnfab assetid=<id>.`,
            []
        );
    }

    /**
     * A live customer trade showed Steam rate-limiting (HTTP 429) an inventory fetch 3 times in a
     * row within ~20s using a flat 5s/10s backoff — nowhere near long enough to clear an actual
     * Steam rate-limit window (typically 30-60s+), so all 3 attempts were effectively doomed
     * together as soon as the first one got limited. A 429 needs a much longer cooldown than a
     * generic transient failure; other errors (network blips, timeouts) keep the original short
     * backoff since those usually clear on their own quickly.
     */
    private inventoryFetchRetryDelay(err: Error, attempt: number): number {
        return err.message.includes('429') ? 30000 * attempt : 5000 * attempt;
    }

    /**
     * Trade offer send failures from node-tradeoffer-manager carry a numeric Steam `eresult` (and
     * sometimes a `cause`) on top of the generic `.message` — e.g. the "(26)" seen in send-failure
     * messages is EResult.Revoked, meaning Steam considered one of the offer's items to no longer
     * match its expected inventory state. The crafting/strangify-service logs only ever surfaced
     * the bare message, which isn't enough to diagnose a recurrence — this decodes the eresult name
     * and links steamerrors.com for it, matching the pattern Trades.ts already uses elsewhere.
     */
    private describeSendError(err: unknown): string {
        const e = err as CustomError;
        const parts = [e?.message ?? String(err)];
        if (e?.eresult !== undefined) {
            const name = (TradeOfferManager.EResult as unknown as Record<number, string>)[e.eresult];
            parts.push(`eresult=${e.eresult}${name ? ` (${name})` : ''} — https://steamerrors.com/${e.eresult}`);
        }
        if (e?.cause) {
            parts.push(`cause=${e.cause}`);
        }
        return parts.join(' | ');
    }

    /**
     * Re-sends a batch of items stuck in the bot's backpack after a return-offer send
     * permanently failed (see heldReturnItems). Wired to the admin-only !retryreturn command.
     */
    async retryHeldReturn(partnerSteamID64: string): Promise<string> {
        const heldIds = this.heldReturnItems.get(partnerSteamID64);
        if (!heldIds || heldIds.length === 0) {
            return `❌ No held return items found for steamID ${partnerSteamID64}.`;
        }

        const backpack = ((this.bot.tf2 as any).backpack as any[]) ?? [];
        const stillOwned = heldIds.filter(id => backpack.some((i: any) => String(i.id) === id));
        const missing = heldIds.filter(id => !stillOwned.includes(id));

        if (stillOwned.length === 0) {
            this.heldReturnItems.delete(partnerSteamID64);
            return `❌ None of the held items (${heldIds.join(', ')}) are still in the bot's backpack — already sent or traded away? Cleared the hold.`;
        }

        const partner = new SteamID(partnerSteamID64);
        // See fetchTradeUrlToken on handleCraftingIntake above.
        const token = await fetchTradeUrlToken(partnerSteamID64);
        const returnOffer = this.bot.manager.createOffer(partner, token);
        returnOffer.data('dict', this.craftingDict(stillOwned, []));
        stillOwned.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
        returnOffer.setMessage(`Here are your item(s) from the crafting service.`);

        try {
            const status = await this.bot.trades.sendOffer(returnOffer);
            if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
            this.heldReturnItems.delete(partnerSteamID64);
            return (
                `🔄 Retried return offer to ${partnerSteamID64} with ${stillOwned.length} item(s)` +
                (missing.length > 0 ? ` (skipped ${missing.length} no-longer-owned item(s): ${missing.join(', ')})` : '') +
                `.`
            );
        } catch (err) {
            return `❌ Retry failed: ${this.describeSendError(err)}. Items remain held.`;
        }
    }

    // Force-returns arbitrary asset IDs to a partner, with no map lookup at all — for items that
    // never went through heldReturnItems in the first place (nothing ever attempted to send them,
    // so nothing ever failed and got tracked as held). Concretely: a craft that times out can be
    // wrongly treated as a "partial fill" that already consumed its components, when they're
    // actually still sitting untouched in the backpack — leaving them permanently untracked and
    // unreturned until manually recovered here. Wired to the admin-only !returnitems command.
    async forceReturnItems(partnerSteamID64: string, assetIds: string[]): Promise<string> {
        const backpack = ((this.bot.tf2 as any).backpack as any[]) ?? [];
        const stillOwned = assetIds.filter(id => backpack.some((i: any) => String(i.id) === id));
        const missing = assetIds.filter(id => !stillOwned.includes(id));

        if (stillOwned.length === 0) {
            return `❌ None of the given item(s) (${assetIds.join(', ')}) are in the bot's backpack.`;
        }

        const partner = new SteamID(partnerSteamID64);
        const token = await fetchTradeUrlToken(partnerSteamID64);
        const returnOffer = this.bot.manager.createOffer(partner, token);
        returnOffer.data('dict', this.craftingDict(stillOwned, []));
        stillOwned.forEach(id => returnOffer.addMyItem({ appid: 440, contextid: '2', assetid: id }));
        returnOffer.setMessage(`Here are your item(s) from the crafting service — sorry for the delay!`);

        try {
            const status = await this.bot.trades.sendOffer(returnOffer);
            if (status === 'pending') void this.bot.trades.acceptConfirmation(returnOffer);
            return (
                `✅ Returned ${stillOwned.length} item(s) to ${partnerSteamID64}` +
                (missing.length > 0 ? ` (skipped ${missing.length} not in backpack: ${missing.join(', ')})` : '') +
                `.`
            );
        } catch (err) {
            return `❌ Failed to return item(s) to ${partnerSteamID64}: ${this.describeSendError(err)}.`;
        }
    }

    /**
     * Automatically sweeps both held-item maps and retries them, so transient failures resolve
     * on their own without needing an admin to notice and run the command manually. Wired to a
     * periodic interval in onReady().
     *
     * Held fabricators are grouped by partner before retrying (rather than looping through
     * retryHeldIntake per assetid, which always re-invokes the single-fabricator flow) so a
     * batch of fabricators that got held together goes back out as one combined offer instead of
     * one offer per fabricator.
     */
    private async retryAllHeldItems(): Promise<void> {
        if (this.retryingHeldItems) return;
        this.retryingHeldItems = true;
        try {
            const heldByPartner = new Map<string, string[]>();
            for (const [fabAssetId, partnerSteamID64] of this.heldIntakeFabricators) {
                const list = heldByPartner.get(partnerSteamID64) ?? [];
                list.push(fabAssetId);
                heldByPartner.set(partnerSteamID64, list);
            }

            for (const [partnerSteamID64, fabAssetIds] of heldByPartner) {
                const backpack = ((this.bot.tf2 as any).backpack as any[]) ?? [];
                const fabs = fabAssetIds
                    .map(id => backpack.find((i: any) => String(i.id) === id))
                    .filter((f): f is any => !!f);

                fabAssetIds
                    .filter(id => !fabs.some((f: any) => String(f.id) === id))
                    .forEach(id => this.heldIntakeFabricators.delete(id));

                if (fabs.length === 0) continue;

                if (fabs.length === 1) {
                    log.debug(`[craftingService] Auto-retry (intake): retrying held fabricator ${fabs[0].id} for ${partnerSteamID64}`);
                    void this.handleCraftingIntake(new SteamID(partnerSteamID64), fabs[0]);
                } else {
                    log.debug(
                        `[craftingService] Auto-retry (intake): retrying ${fabs.length} held fabricators as one combined offer for ${partnerSteamID64}`
                    );
                    void this.handleCraftingIntakeBatch(new SteamID(partnerSteamID64), fabs);
                }
            }
            for (const partnerSteamID64 of Array.from(this.heldReturnItems.keys())) {
                const result = await this.retryHeldReturn(partnerSteamID64);
                log.debug(`[craftingService] Auto-retry (return): ${result}`);
            }
        } finally {
            this.retryingHeldItems = false;
        }
    }

    onOfferAction(offer: TradeOffer, action: ActionType, reason: string, meta: Meta): void {
        if (offer.data('notify') !== true) {
            return;
        }

        if (action === 'skip') {
            void sendReview(offer, this.bot, meta);
            return;
        }
    }

    private sortInventory(): void {
        if (this.opt.miscSettings.sortInventory.enable) {
            const type = this.opt.miscSettings.sortInventory.type;
            this.bot.tf2gc.sortInventory(type);
        }
    }

    private inviteToGroups(steamID: SteamID | string): void {
        if (!this.opt.miscSettings.sendGroupInvite.enable) {
            return;
        }

        this.bot.groups.inviteToGroups(steamID, this.groups);
    }

    private checkFriendRequests(): void {
        if (!this.bot.client.myFriends) {
            return;
        }

        this.checkFriendsCount();
        for (const steamID64 in this.bot.client.myFriends) {
            if (!Object.prototype.hasOwnProperty.call(this.bot.client.myFriends, steamID64)) {
                continue;
            }

            if ((this.bot.client.myFriends[steamID64] as number) === EFriendRelationship.RequestRecipient) {
                // relation
                this.respondToFriendRequest(steamID64);
            }
        }

        this.bot.getAdmins.forEach(steamID => {
            if (!this.bot.friends.isFriend(steamID)) {
                log.info(`Not friends with admin ${steamID.toString()}, sending friend request...`);
                this.bot.client.addFriend(steamID, err => {
                    if (err) {
                        log.warn('Failed to send friend request: ', err);
                    }
                });
            }
        });
    }

    private respondToFriendRequest(steamID: SteamID | string): void {
        if (!this.opt.miscSettings.addFriends.enable) {
            if (!this.bot.isAdmin(steamID)) {
                return this.bot.client.removeFriend(steamID);
            }
        }

        const steamID64 = typeof steamID === 'string' ? steamID : steamID.getSteamID64();
        const accept = () => {
            log.info(`Accepting friend request from ${steamID64}...`);
            this.bot.client.addFriend(steamID, err => {
                if (err) {
                    log.warn(`Failed to accept friend request from ${steamID64}: `, err);
                    return;
                }
                log.debug('Friend request has been accepted');
            });
        };

        if (this.bot.isAdmin(steamID)) {
            return accept();
        }

        void this.bot
            .checkBanned(steamID)
            .then(banned => {
                if (banned.isBanned) {
                    log.info(`Declining friend request and blocking ${steamID64}...`);

                    this.bot.client.removeFriend(steamID);
                    this.bot.client.blockUser(steamID, err => {
                        if (err) {
                            log.error(`❌ Failed to block user ${steamID64}: `, err);
                        } else log.info(`✅ Successfully blocked user ${steamID64}`);
                    });

                    this.saveBlockedUser(
                        steamID64,
                        `[onFriendRequest] Banned on ${Object.keys(banned.contents)
                            .filter(website => banned.contents[website] !== 'clean')
                            .join(', ')}`
                    );

                    return;
                }

                return accept();
            })
            .catch(err => {
                log.error('Failed to check banned on respondToFriendRequest: ', err);
                return; // We respond again later
            });
    }

    private onNewFriend(steamID: SteamID, tries = 0): void {
        if (tries === 0) {
            log.debug(`Now friends with ${steamID.getSteamID64()}`);
        }

        const isAdmin = this.bot.isAdmin(steamID);
        setImmediate(() => {
            if (!this.bot.friends.isFriend(steamID)) {
                return;
            }

            const friend = this.bot.friends.getFriend(steamID);
            if (friend === null || friend.player_name === undefined) {
                tries++;

                if (tries >= 5) {
                    log.info(`I am now friends with ${steamID.getSteamID64()}`);

                    // Check if greeting is globally disabled
                    if (this.bot.options.globalDisable?.greeting === true) {
                        log.debug('Greeting disabled, not sending welcome message');
                        return;
                    }

                    return this.bot.sendMessage(
                        steamID,
                        this.opt.customMessage.welcome
                            ? this.opt.customMessage.welcome
                                  .replace(/%name%/g, '')
                                  .replace(/%admin%/g, isAdmin ? '!help' : '!how2trade')
                                  .replace(/%pricedb_store%/g, this.bot.getPricedbStoreUrl())
                            : `Hi! If you don't know how things work, please type "!${isAdmin ? 'help' : 'how2trade'}"`
                    );
                }

                log.debug('Waiting for name');
                // Wait for friend info to be available
                setTimeout(() => {
                    this.onNewFriend(steamID, tries);
                }, exponentialBackoff(tries - 1, 200));
                return;
            }

            log.info(`I am now friends with ${friend.player_name} (${steamID.getSteamID64()})`);

            // Check if greeting is globally disabled
            if (this.bot.options.globalDisable?.greeting === true) {
                log.debug('Greeting disabled, not sending welcome message');
                return;
            }

            this.bot.sendMessage(
                steamID,
                this.opt.customMessage.welcome
                    ? this.opt.customMessage.welcome
                          .replace(/%name%/g, friend.player_name)
                          .replace(/%admin%/g, isAdmin ? '!help' : '!how2trade')
                          .replace(/%pricedb_store%/g, this.bot.getPricedbStoreUrl())
                    : `Hi ${friend.player_name}! If you don't know how things work, please type ` +
                          `"!${isAdmin ? 'help' : 'how2trade'}"`
            );
        });
    }

    private checkFriendsCount(steamIDToIgnore?: SteamID | string): void {
        log.debug('Checking friends count');
        const friends = this.bot.friends.getFriends;
        const friendslistBuffer = 20;
        const friendsToRemoveCount = friends.length + friendslistBuffer - this.bot.friends.maxFriends;

        log.debug(`Friends to remove: ${friendsToRemoveCount}`);
        if (friendsToRemoveCount > 0) {
            // We have friends to remove, find people with fewest trades and remove them
            const friendsWithTrades = this.bot.trades.getTradesWithPeople(friends);

            // Ignore friends to keep
            this.friendsToKeep.forEach(steamID => delete friendsWithTrades[steamID]);

            if (steamIDToIgnore) {
                delete friendsWithTrades[steamIDToIgnore.toString()];
            }

            // Convert object into an array so it can be sorted
            const tradesWithPeople: { steamID: string; trades: number }[] = [];
            for (const steamID in friendsWithTrades) {
                if (!Object.prototype.hasOwnProperty.call(friendsWithTrades, steamID)) {
                    continue;
                }
                tradesWithPeople.push({ steamID: steamID, trades: friendsWithTrades[steamID] });
            }

            // Sorts people by trades and picks people with lowest amounts of trades but not the 2 latest people
            const friendsToRemove = tradesWithPeople
                .sort((a, b) => a.trades - b.trades)
                .splice(1, friendsToRemoveCount - 2 <= 0 ? 2 : friendsToRemoveCount);

            log.info(`Cleaning up friendslist, removing ${friendsToRemove.length} people...`);
            friendsToRemove.forEach(friend => {
                const friendSteamID = friend.steamID;
                const getFriend = this.bot.friends.getFriend(friendSteamID);

                this.bot.sendMessage(
                    friendSteamID,
                    this.opt.customMessage.clearFriends
                        ? this.opt.customMessage.clearFriends.replace(
                              /%name%/g,
                              getFriend ? getFriend.player_name : friendSteamID
                          )
                        : '/quote I am cleaning up my friend list and you have randomly been selected to be removed. ' +
                              'Please feel free to add me again if you want to trade at a later time!'
                );
                this.bot.client.removeFriend(friendSteamID);
            });
        }
    }

    private getBPTFAccountInfo(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.bot.manager.steamID) {
                log.warn('Cannot get BPTF account info: not logged in to Steam');
                return reject(new Error('Not logged in to Steam'));
            }

            const steamID64 = this.bot.manager.steamID.getSteamID64();

            apiRequest<BPTFGetUserInfo>({
                url: 'https://api.backpack.tf/api/users/info/v1',
                method: 'GET',
                headers: {
                    'User-Agent': 'TF2AutobotPriceDB@' + process.env.BOT_VERSION,
                    Cookie: 'user-id=' + this.bot.userID
                },
                params: {
                    key: this.opt.bptfApiKey,
                    steamids: steamID64
                }
            })
                .then(body => {
                    const user = body.users[steamID64];
                    this.botName = user.name;
                    this.botAvatarURL = user.avatar;
                    this.isPremium = user.premium ? user.premium === 1 : false;
                    return resolve();
                })
                .catch(err => {
                    log.error('Failed requesting bot info from backpack.tf, retrying in 5 minutes: ', err);
                    clearTimeout(this.retryRequest);

                    this.retryRequest = setTimeout(() => {
                        this.getBPTFAccountInfo().catch(() => {
                            // ignore error
                        });
                    }, 5 * 60 * 1000);
                    return reject();
                });
        });
    }

    private checkGroupInvites(): void {
        for (const groupID64 in this.bot.client.myGroups) {
            if (!Object.prototype.hasOwnProperty.call(this.bot.client.myGroups, groupID64)) {
                continue;
            }

            if ((this.bot.client.myGroups[groupID64] as number) === EClanRelationship.Invited) {
                // relation
                this.bot.client.respondToGroupInvite(groupID64, false);
            }
        }

        this.groups.forEach(steamID => {
            if (
                this.bot.client.myGroups[steamID] !== EClanRelationship.Member &&
                this.bot.client.myGroups[steamID] !== EClanRelationship.Blocked
            ) {
                this.bot.community.getSteamGroup(new SteamID(steamID), (err, group) => {
                    if (err) {
                        log.warn('Failed to get group: ', err);
                        return;
                    }

                    log.info(`Not member of group ${group.name} ("${steamID}"), joining...`);
                    group.join(err => {
                        if (err) {
                            log.warn('Failed to join group: ', err);
                        }
                    });
                });
            }
        });
    }

    private deleteUntradableJunk(): void {
        const assetidsToDelete = this.bot.inventoryManager.getInventory.findUntradableJunk();

        for (const assetid of assetidsToDelete) {
            log.debug(`Deleting junk item ${assetid}`);
            this.bot.tf2gc.deleteItem(assetid, err => {
                log.warn('Error deleting untradable junk', err);
            });
        }
    }

    onPollData(pollData: PollData): void {
        files.writeFile(this.paths.files.pollData, pollData, true).catch(err => {
            log.warn('Failed to save polldata: ', err);
        });
    }

    async onPricelist(pricelist: PricesObject): Promise<void> {
        if (Object.keys(pricelist).length === 0) {
            // Ignore errors
            await this.bot.listings.removeAll().catch(err => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                log.error('Error on removing all listings: ', filterAxiosError(err));
            });
        }

        /*
         * was: Failed to save pricelist:  The "data" argument must be of type string or an instance of Buffer, TypedArray, or
         * DataView. Received undefined {"code":"ERR_INVALID_ARG_TYPE"}
         *
         * This will also save the "name" property. I think it's okay.
         */
        files.writeFile(this.paths.files.pricelist, pricelist, true).catch(err => {
            log.warn('Failed to save pricelist: ', err);
        });
    }

    onPriceChange(priceKey: string, entry: Entry): void {
        this.bot.listings.checkByPriceKey({ priceKey, data: entry, checkGenerics: false, showLogs: true });
    }

    saveBlockedUser(steamID: string, reason: string): void {
        if (reason) {
            // Will add or replace new one, if reason is defined
            this.bot.blockedList[steamID] = reason;

            files.writeFile(this.paths.files.blockedList, this.bot.blockedList, true).catch(err => {
                log.warn('Failed to save blockedList: ', err);
            });
        }
    }

    removeBlockedUser(steamID: string): void {
        delete this.bot.blockedList[steamID];

        files.writeFile(this.paths.files.blockedList, this.bot.blockedList, true).catch(err => {
            log.warn('Failed to update blockedList: ', err);
        });
    }

    onUserAgent(pulse: { status: string; current_time?: number; expire_at?: number; client?: string }): void {
        if (pulse.client) {
            delete pulse.client;
        }
        // log.debug('user-agent', pulse);
    }

    onLoginThrottle(wait: number): void {
        log.warn(`Waiting ${wait} ms before trying to sign in...`);
    }

    onTF2QueueCompleted(): void {
        log.debug('Queue finished');
        this.bot.updateSteamGamePresence();
    }

    onCreateListingsSuccessful(response: { created: number; archived: number; errors: any[] }): void {
        log.debug('Successfully create listings:', response);
    }

    onUpdateListingsSuccessful(response: { updated: number; errors: any[] }): void {
        log.debug('Successfully update listings:', response);
    }

    onDeleteListingsSuccessful(response: Record<string, unknown>): void {
        log.debug('Successfully delete listings:', response);
    }

    onDeleteArchivedListingSuccessful(response: boolean): void {
        log.debug('Successfully delete an archived listing:', response);
    }

    onCreateListingsError(err: Error): void {
        log.error('Error on create listings:', err);
    }

    onUpdateListingsError(err: Error): void {
        log.error('Error on update listings:', err);
    }

    onDeleteListingsError(err: Error): void {
        log.error('Error on delete listings:', err);
    }

    onDeleteArchivedListingError(err: Error): void {
        log.error('Error on delete archived listings:', err);
    }

    onSystemMessage(message: string): void {
        if (
            this.opt.discordWebhook.sendTf2Events.systemMessage.enable &&
            this.opt.discordWebhook.sendTf2Events.systemMessage.url !== ''
        ) {
            sendTf2SystemMessage(this.bot, message);
        }
    }

    onDisplayNotification(title: string, body: string): void {
        if (
            this.opt.discordWebhook.sendTf2Events.displayNotification.enable &&
            this.opt.discordWebhook.sendTf2Events.displayNotification.url !== ''
        ) {
            sendTf2DisplayNotification(this.bot, title, body);
        }
    }

    onItemBroadcast(message: string, username: string, wasDestruction: boolean, defindex: number): void {
        if (
            this.opt.discordWebhook.sendTf2Events.itemBroadcast.enable &&
            this.opt.discordWebhook.sendTf2Events.itemBroadcast.url !== ''
        ) {
            sendTf2ItemBroadcast(this.bot, message, username, wasDestruction, defindex);
        }
    }

    refreshPollDataPath() {
        const newPaths = genPaths(this.opt.steamAccountName);
        const pathChanged = newPaths.files.pollData !== this.paths.files.pollData;
        this.paths = newPaths;

        if (!pathChanged) {
            return;
        }

        files
            .readFile(this.paths.files.pollData, true)
            .then((pollDataFile: SteamTradeOfferManager.PollData | null) => {
                const currentPollData = this.bot.manager.pollData;
                const activeOffers = this.bot.trades.getActiveOffers(currentPollData);
                const newPollData = pollDataFile
                    ? pollDataFile
                    : ({ sent: {}, received: {}, offerData: {} } as SteamTradeOfferManager.PollData);
                Object.keys(activeOffers).forEach(intent => {
                    (activeOffers[intent] as string[]).forEach(id => {
                        (newPollData[intent] as Record<string, number>)[id] = (
                            currentPollData[intent] as Record<string, number>
                        )[id];

                        newPollData.offerData[id] = currentPollData.offerData[id];
                    });
                });
                this.bot.manager.pollData = newPollData;
                // TODO: Remove duplicate entries
                // Duplicates are already handled in src/lib/tools/polldata
                // so this is only for optimizing storage
            })
            .catch(err => {
                log.error('Failed to update polldata path:', err);
            });
    }
}

interface OnNewTradeOffer {
    action: ActionType;
    reason: string;
    meta?: Meta;
}

export interface BotInfo {
    name: string;
    avatarURL: string;
    steamID: SteamID;
    premium: boolean;
}

interface GetHighValue {
    our: Which;
    their: Which;
}

interface Which {
    items: Record<string, any>;
    isMention: boolean;
}
