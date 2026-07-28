import axios from 'axios';

const WEBSITE_URL = process.env.CRAFTING_WEBSITE_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY ?? '';

/**
 * Looks up a customer's own trade-URL token, as saved on the crafting website
 * (autofabricator-web's tradeUrlStore) when they set up their account there.
 *
 * Every crafting-service offer the bot *initiates* itself (a follow-up parts request, a refund,
 * a return) is created via manager.createOffer(partner) with no token — Steam only lets that
 * succeed without one if the partner is already a friend, or their account otherwise allows
 * trade offers from anyone. A customer whose Steam privacy restricts incoming offers (or a new
 * account without a long-standing Mobile Authenticator) rejects it with eresult 15 (AccessDenied)
 * instead, and no amount of retrying fixes that — the bot has no token from them because these
 * are offers *we* send, not ones they sent us to begin with.
 *
 * The website already has this: it required the customer's trade URL before letting them place
 * an order at all, and stores it against their steamID indefinitely. This calls back into the
 * website (shared API_KEY / BOT_API_KEY secret, matching the auth already used the other
 * direction in HttpManager.ts) to reuse that same token for our own outbound offers.
 */
export async function fetchTradeUrlToken(steamID64: string): Promise<string | undefined> {
    if (!API_KEY) return undefined;

    try {
        const r = await axios.get<{ tradeUrl: string | null }>(
            `${WEBSITE_URL}/api/internal/trade-url/${steamID64}`,
            { headers: { Authorization: `Bearer ${API_KEY}` }, timeout: 5000 }
        );
        const tradeUrl = r.data?.tradeUrl;
        if (!tradeUrl) return undefined;
        return new URL(tradeUrl).searchParams.get('token') ?? undefined;
    } catch (err) {
        console.warn('[craftingWebsiteApi] Failed to fetch stored trade URL:', (err as Error).message);
        return undefined;
    }
}
