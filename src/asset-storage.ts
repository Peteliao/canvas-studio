export async function flushAssetSet(dirty: Set<string>, assets: Record<string, string>, write: (id: string, data: string) => Promise<boolean>): Promise<boolean> {
    let complete = true;
    for (const id of Array.from(dirty)) {
        const data = assets[id];
        if (!data) { complete = false; continue; }
        const saved = await write(id, data);
        if (saved && assets[id] === data) dirty.delete(id);
        else { dirty.add(id); complete = false; }
    }
    return complete;
}
