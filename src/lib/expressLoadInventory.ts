import axios from 'axios';
import SteamID from 'steamid';
import { EconItem } from '@tf2autobot/tradeoffer-manager';

// Not exported from the package's public index.js, but present on disk — the same class
// @tf2autobot/steamcommunity's own getUserInventoryContents uses to build each item.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CEconItem = require('@tf2autobot/steamcommunity/classes/CEconItem.js');

const EXPRESSLOAD_API_KEY = process.env.EXPRESSLOAD_API_KEY ?? '';

interface SteamAssetProperty {
    assetid: string;
    asset_properties: unknown;
}

interface ExpressLoadInventoryResponse {
    assets?: Record<string, unknown>[];
    descriptions?: Record<string, unknown>[];
    asset_properties?: SteamAssetProperty[];
}

function descKey(classid: string, instanceid: string | undefined): string {
    return `${classid}_${instanceid && instanceid !== '0' ? instanceid : '0'}`;
}

/**
 * Fallback for steamcommunity.com/inventory/{id}/{appid}/{contextid} — that endpoint is
 * hard-blocked/rate-limited from this VPS's IP (same root cause already worked around on the
 * website side, see autofabricator-web/server/expressLoad.ts). ExpressLoad mirrors Steam's own
 * assets/descriptions JSON shape exactly, so items are built the identical way
 * @tf2autobot/steamcommunity's users.js does it (new CEconItem(asset, description, contextID,
 * assetProperties)) — the resulting EconItem[] is a drop-in replacement for a native fetch and can
 * be handed to Inventory.fromItems().
 */
export async function fetchInventoryViaExpressLoad(
    steamID: SteamID | string,
    appid: number,
    contextid: string
): Promise<EconItem[] | null> {
    if (!EXPRESSLOAD_API_KEY) return null;

    const steamID64 = typeof steamID === 'string' ? steamID : steamID.getSteamID64();

    try {
        const r = await axios.get<ExpressLoadInventoryResponse>(
            `https://api.express-load.com/v1/steam/inventory/${steamID64}/${appid}/${contextid}`,
            { headers: { 'X-API-Key': EXPRESSLOAD_API_KEY }, timeout: 20000 }
        );
        if (!r.data?.assets || !r.data?.descriptions) return null;

        const descMap = new Map<string, Record<string, unknown>>();
        for (const d of r.data.descriptions) {
            descMap.set(descKey(d.classid as string, d.instanceid as string | undefined), d);
        }

        const assetPropertiesLookup = new Map<string, unknown>();
        if (r.data.asset_properties) {
            for (const ap of r.data.asset_properties) assetPropertiesLookup.set(ap.assetid, ap.asset_properties);
        }

        const items: EconItem[] = r.data.assets.map(asset => {
            const description = descMap.get(descKey(asset.classid as string, asset.instanceid as string | undefined));
            const assetProperties = assetPropertiesLookup.get(asset.assetid as string) ?? null;
            return new CEconItem(asset, description, contextid, assetProperties);
        });
        return items;
    } catch (err) {
        console.warn('[expressLoad] inventory fallback failed:', (err as Error).message);
        return null;
    }
}
