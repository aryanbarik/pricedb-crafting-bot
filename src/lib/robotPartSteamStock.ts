import { apiRequest } from './apiRequest';

interface PlayerItem {
    id: number | string;
    defindex: number;
    quality: number;
    flag_cannot_trade?: boolean;
    flag_cannot_craft?: boolean;
}

interface PlayerItemsResponse {
    result?: {
        status?: number;
        statusDetail?: string;
        items?: PlayerItem[];
    };
}

/** Read robot-part asset IDs from Steam's TF2 inventory, never interpreting a failed response as zero stock. */
export async function fetchRobotPartSteamStock(steamId: string, apiKey: string): Promise<Map<string, Set<string>>> {
    const response = await apiRequest<PlayerItemsResponse>({
        method: 'GET',
        url: 'https://api.steampowered.com/IEconItems_440/GetPlayerItems/v0001/',
        params: { key: apiKey, steamid: steamId }
    });

    if (response.result?.status !== 1 || !Array.isArray(response.result.items)) {
        throw new Error(
            `TF2 inventory returned status ${response.result?.status ?? 'unknown'}: ${
                response.result?.statusDetail ?? 'no item list'
            }`
        );
    }

    const bySku = new Map<string, Set<string>>();
    for (const item of response.result.items) {
        if (item.defindex < 5700 || item.defindex > 5707 || item.quality !== 6 || item.flag_cannot_trade) {
            continue;
        }
        const sku = `${item.defindex};6${item.flag_cannot_craft ? ';uncraftable' : ''}`;
        const ids = bySku.get(sku) ?? new Set<string>();
        ids.add(String(item.id));
        bySku.set(sku, ids);
    }

    return bySku;
}
