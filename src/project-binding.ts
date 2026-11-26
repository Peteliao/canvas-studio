import type { CanvasElement, Model } from './types';

export interface ProjectContent {
    name: string;
    canvas: unknown;
    elements: unknown;
    guides: unknown;
}

export function projectContentSignature(project: ProjectContent): string {
    return JSON.stringify([project.name, project.canvas, project.elements, project.guides]);
}

export function remapProjectAssets(project: Model, createId: () => string): Model {
    const ids = new Set(Object.keys(project.assets || {}));
    project.elements.forEach(el => {
        if (el.image) { ids.add(el.image.assetId); ids.add(el.image.originalAssetId); }
        if (el.maskAssetId) ids.add(el.maskAssetId);
    });
    const mapping = new Map(Array.from(ids, id => [id, createId()]));
    const assets: Record<string, string> = {};
    Object.entries(project.assets || {}).forEach(([id, data]) => { assets[mapping.get(id)!] = data; });
    const elements: CanvasElement[] = project.elements.map(el => ({
        ...el,
        image: el.image ? {
            ...el.image,
            assetId: mapping.get(el.image.assetId) || el.image.assetId,
            originalAssetId: mapping.get(el.image.originalAssetId) || el.image.originalAssetId
        } : null,
        maskAssetId: el.maskAssetId ? mapping.get(el.maskAssetId) || el.maskAssetId : null
    }));
    return { ...project, elements, assets: Object.keys(assets).length ? assets : undefined };
}

export function findMatchingProject<T extends { data: string; updated: number }>(items: readonly T[], snapshot: string, matches: (data: string) => boolean = data => data === snapshot): T | null {
    let match: T | null = null;
    for (const item of items) {
        if (matches(item.data) && (!match || item.updated > match.updated)) match = item;
    }
    return match;
}
