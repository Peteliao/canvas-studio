import type { CanvasElement, Model } from './types';

export interface ProjectContent {
    name: string;
    canvas: unknown;
    elements: unknown;
    guides: unknown;
    components?: unknown;
}

export function projectContentSignature(project: ProjectContent): string {
    return JSON.stringify([project.name, project.canvas, project.elements, project.guides, project.components]);
}

export function remapProjectAssets(project: Model, createId: () => string): Model {
    const ids = new Set(Object.keys(project.assets || {}));
    const collectIds = (elements: readonly CanvasElement[]): void => elements.forEach(el => {
        if (el.image) { ids.add(el.image.assetId); ids.add(el.image.originalAssetId); }
        if (el.maskAssetId) ids.add(el.maskAssetId);
    });
    collectIds(project.elements);
    project.components?.forEach(component => collectIds(component.elements));
    const mapping = new Map(Array.from(ids, id => [id, createId()]));
    const assets: Record<string, string> = {};
    Object.entries(project.assets || {}).forEach(([id, data]) => { assets[mapping.get(id)!] = data; });
    const remapElement = (el: CanvasElement): CanvasElement => ({
        ...el,
        image: el.image ? {
            ...el.image,
            assetId: mapping.get(el.image.assetId) || el.image.assetId,
            originalAssetId: mapping.get(el.image.originalAssetId) || el.image.originalAssetId
        } : null,
        maskAssetId: el.maskAssetId ? mapping.get(el.maskAssetId) || el.maskAssetId : null
    });
    const elements = project.elements.map(remapElement);
    const components = project.components?.map(component => ({ ...component, elements: component.elements.map(remapElement) }));
    return { ...project, elements, components, assets: Object.keys(assets).length ? assets : undefined };
}

export function findMatchingProject<T extends { data: string; updated: number }>(items: readonly T[], snapshot: string, matches: (data: string) => boolean = data => data === snapshot): T | null {
    let match: T | null = null;
    for (const item of items) {
        if (matches(item.data) && (!match || item.updated > match.updated)) match = item;
    }
    return match;
}
