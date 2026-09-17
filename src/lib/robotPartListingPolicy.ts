/** Only TF2 robot parts are merchandise on this crafting-service bot. */
export function isRobotPartSku(sku: string | undefined): boolean {
    if (!sku) return false;
    const defindex = Number(sku.split(';')[0]);
    return Number.isInteger(defindex) && defindex >= 5700 && defindex <= 5707;
}
