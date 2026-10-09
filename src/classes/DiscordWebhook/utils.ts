import TradeOfferManager, { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import { Webhook, Component, Container } from './interfaces';
import Bot from '../Bot';
import log from '../../lib/logger';
import { AxiosError } from 'axios';
import { ErrorFiltered } from '@tf2autobot/filter-axios-error';
import { apiRequest } from '../../lib/apiRequest';

export function getPartnerDetails(offer: TradeOffer, bot: Bot): Promise<{ personaName: string; avatarFull: string }> {
    return new Promise(resolve => {
        const defaultImage = //default "?" image
            'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/72/72f78b4c8cc1f62323f8a33f6d53e27db57c2252_full.jpg';
        if (offer.state === TradeOfferManager.ETradeOfferState['Active']) {
            offer.getUserDetails((err, me, them) => {
                if (err) {
                    log.warn('Error retrieving partner Avatar and Name: ', err);
                    resolve({
                        personaName: 'unknown',
                        avatarFull: defaultImage
                    });
                } else {
                    log.info('Partner Avatar and Name retrieved. Applying...');
                    resolve({
                        personaName: them.personaName,
                        // The steamcommunity wrapper types these accessors `void`
                        // though they return a URL string at runtime.
                        avatarFull: them.avatarFull as unknown as string
                    });
                }
            });
        } else {
            bot.community.getSteamUser(offer.partner, (err, user) => {
                if (err) {
                    log.warn('Error retrieving partner Avatar and Name: ', err);
                    resolve({
                        personaName: 'unknown',
                        avatarFull: defaultImage
                    });
                } else {
                    log.info('Partner Avatar and Name retrieved. Applying...');
                    resolve({
                        personaName: user.name,
                        avatarFull: user.getAvatarURL('full') as unknown as string
                    });
                }
            });
        }
    });
}

export function quickLinks(name: string, links: { steam: string; bptf: string; reptf: string }): string {
    return `🔍 ${name}'s info:\n[Steam Profile](${links.steam}) | [backpack.tf](${links.bptf}) | [rep.tf](${links.reptf})`;
}

export interface WebhookAttachment {
    /** Filename a component refers to as `attachment://<name>`. */
    name: string;
    buffer: Buffer;
}

/**
 * A stock-change suffix reads as "(12 → 13/50)"; secondary webhooks in a
 * multi-URL fan-out only get the first one, since the inventory state it
 * describes is specific to whichever channel is meant to track it precisely.
 */
const STOCK_CHANGE = / \(\d+ → \d+(\/\d+)?\)/g;

/**
 * Drop the mention block and strip stock-change suffixes from every Text
 * Display, recursing into Containers. The Components V2 counterpart of the
 * content/embeds cleanup below.
 */
function stripForSecondaryUrl(components: Component[]): Component[] {
    return components
        .filter(c => !(c.type === 10 && /^<@!\d+>/.test(c.content)))
        .map(c => {
            if (c.type === 10) {
                return { ...c, content: c.content.replace(STOCK_CHANGE, '') };
            }
            if (c.type === 17) {
                return { ...c, components: stripForSecondaryUrl(c.components) as Container['components'] };
            }
            return c;
        });
}

export function sendWebhook(
    url: string,
    webhook: Webhook,
    event: string,
    i?: number,
    attachment?: WebhookAttachment
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (i > 0 && event === 'trade-summary') {
            if (webhook.components) {
                webhook.components = stripForSecondaryUrl(webhook.components);
            }

            // Guarded: the accepted-trade summary is components-only and carries
            // neither, but other senders share this event name.
            if (webhook.content) {
                webhook.content = webhook.content.replace(/( )?<@!\d+>(,)?/g, ''); // remove mention
            }

            webhook.embeds?.forEach(embed => {
                if (embed.description) {
                    embed.description = embed.description.replace(STOCK_CHANGE, '');
                }
            });
        }

        // Discord takes files as multipart: the usual JSON body moves into
        // `payload_json` and each file goes in `files[n]`. Built here rather than by
        // the caller so every URL in a multi-webhook fan-out gets its own body.
        let data: Record<string, any> | FormData | Webhook = webhook;

        if (attachment) {
            const form = new FormData();
            form.append('payload_json', JSON.stringify(webhook));
            // Copied into a plain Uint8Array: a Buffer's backing store is typed as
            // possibly shared, which is not a valid BlobPart.
            const bytes = new Uint8Array(attachment.buffer);
            form.append('files[0]', new Blob([bytes], { type: 'image/png' }), attachment.name);
            data = form;
        }

        // Components V2 requires this query param on top of the message flag,
        // or Discord silently ignores `components` and posts an empty message.
        const params = webhook.components ? { with_components: true } : undefined;

        apiRequest({ method: 'POST', url, data, params })
            .then(() => resolve())
            .catch((err: AxiosError) => reject({ err, webhook }));
    });
}

export interface WebhookError {
    err: ErrorFiltered;
    webhook: Webhook;
}

export interface WebhookErrorData {
    message: string;
    retry_after: number;
    global: boolean;
}
