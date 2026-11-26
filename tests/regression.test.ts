import { describe, expect, it } from 'vitest';
import { flushAssetSet } from '../src/asset-storage';
import { exportInkPadding, padExportBounds, rasterExportScale, unionExportBounds } from '../src/export-bounds';
import { makeImage } from '../src/image-ref';
import type { CanvasElement, Model } from '../src/types';
import { findMatchingProject, projectContentSignature, remapProjectAssets } from '../src/project-binding';
import { pinchViewport } from '../src/touch';

const box = { left: 10, top: 20, right: 110, bottom: 70, w: 100, h: 50 };
const element = (extra: Record<string, unknown> = {}): CanvasElement => ({
    type: 'rect', line: null,
    stroke: { width: 0, align: 'center' },
    shadow: { enabled: false, x: 0, y: 0, blur: 0 },
    ...extra
} as CanvasElement);

describe('image metadata', () => {
    it('preserves valid non-destructive crop rectangles', () => {
        expect(makeImage({ assetId: 'img', crop: { x: 10, y: 20, w: 100, h: 80 } }))
            .toEqual({ assetId: 'img', originalAssetId: 'img', crop: { x: 10, y: 20, w: 100, h: 80 } });
    });

    it('drops invalid crop rectangles without rejecting the image', () => {
        expect(makeImage({ assetId: 'img', crop: { x: 0, y: 0, w: 0, h: 20 } })?.crop).toBeNull();
        expect(makeImage({ assetId: 'img', crop: { x: NaN, y: 0, w: 20, h: 20 } })?.crop).toBeNull();
    });
});

describe('export bounds', () => {
    it('keeps content outside the canvas and applies symmetric padding', () => {
        expect(padExportBounds({ ...box, left: -20, top: -30, right: 80, bottom: 20 }, 8))
            .toEqual({ x: -28, y: -38, w: 116, h: 66 });
    });

    it('unions independently padded element bounds', () => {
        expect(unionExportBounds([
            { x: -28, y: -38, w: 116, h: 58 },
            { x: 200, y: 100, w: 50, h: 50 }
        ], 0)).toEqual({ x: -28, y: -38, w: 278, h: 188 });
        expect(unionExportBounds([], 0)).toBeNull();
    });

    it('includes outside stroke and shadow extents', () => {
        const outside = element({ stroke: { width: 12, align: 'outside' } });
        const shadow = element({ shadow: { enabled: true, x: 3, y: 4, blur: 10 } });
        expect(exportInkPadding(outside)).toBe(16);
        expect(exportInkPadding(shadow)).toBe(29);
    });

    it('caps raster exports by pixel count and canvas side length', () => {
        expect(rasterExportScale({ x: 0, y: 0, w: 100, h: 50 })).toBe(2);
        expect(rasterExportScale({ x: 0, y: 0, w: 20000, h: 20000 })).toBeCloseTo(0.2);
        const skinny = { x: 0, y: 0, w: 40000, h: 1 };
        const scale = rasterExportScale(skinny);
        expect(skinny.w * scale).toBeLessThanOrEqual(32767);
        expect(skinny.w * skinny.h * scale * scale).toBeLessThanOrEqual(16_000_000);
    });
});

describe('project binding', () => {
    it('only adopts an exact snapshot and picks the newest match', () => {
        const items = [
            { id: 'old', data: 'same', updated: 1 },
            { id: 'other', data: 'different', updated: 3 },
            { id: 'new', data: 'same', updated: 2 }
        ];
        expect(findMatchingProject(items, 'same')?.id).toBe('new');
        expect(findMatchingProject(items, 'missing')).toBeNull();
        expect(items.map(x => x.id)).toEqual(['old', 'other', 'new']);
    });

    it('supports semantic matching after project validation', () => {
        const items = [
            { id: 'old', data: '{"name":"same","version":2}', updated: 1 },
            { id: 'other', data: '{"name":"other","version":4}', updated: 3 },
            { id: 'new', data: '{"version":4,"name":"same"}', updated: 2 }
        ];
        const match = findMatchingProject(items, '', data => JSON.parse(data).name === 'same');
        expect(match?.id).toBe('new');
        expect(projectContentSignature({ name: 'same', canvas: 'c', elements: 'e', guides: 'g' }))
            .toBe(projectContentSignature({ guides: 'g', elements: 'e', canvas: 'c', name: 'same' }));
    });

    it('remaps imported assets without mutating the source or reusing ids', () => {
        const crop = { x: 1, y: 2, w: 30, h: 40 };
        const project: Model = {
            version: 4, name: 'import', canvas: {} as Model['canvas'], guides: [],
            elements: [
                element({ id: 'el1', image: { assetId: 'shared', originalAssetId: 'original', crop }, maskAssetId: 'mask' }),
                element({ id: 'el2', image: { assetId: 'shared', originalAssetId: 'shared', crop: null } })
            ],
            assets: { shared: 'data-shared', original: 'data-original', mask: 'data-mask' }
        };
        let next = 0;
        const remapped = remapProjectAssets(project, () => `fresh_${++next}`);
        const first = remapped.elements[0].image!;
        const second = remapped.elements[1].image!;
        expect(first.assetId).toBe(second.assetId);
        expect(first.assetId).not.toBe('shared');
        expect(first.originalAssetId).not.toBe('original');
        expect(first.crop).toEqual(crop);
        expect(remapped.elements[0].maskAssetId).not.toBe('mask');
        expect(Object.keys(remapped.assets!).sort()).toEqual([first.assetId, first.originalAssetId, remapped.elements[0].maskAssetId!].sort());
        expect(project.elements[0].image!.assetId).toBe('shared');
        expect(Object.keys(project.assets!)).toEqual(['shared', 'original', 'mask']);
    });

    it('remaps missing references so they cannot resolve to another project asset', () => {
        const project: Model = {
            version: 4, name: 'import', canvas: {} as Model['canvas'], guides: [],
            elements: [element({ id: 'el1', image: { assetId: 'collision', originalAssetId: 'collision', crop: null }, maskAssetId: 'missingMask' })]
        };
        let next = 0;
        const remapped = remapProjectAssets(project, () => `fresh_${++next}`);
        expect(remapped.elements[0].image!.assetId).not.toBe('collision');
        expect(remapped.elements[0].image!.originalAssetId).toBe(remapped.elements[0].image!.assetId);
        expect(remapped.elements[0].maskAssetId).not.toBe('missingMask');
        expect(remapped.assets).toBeUndefined();
    });
});

describe('asset durability', () => {
    it('retains failed writes for retry and clears successful ones', async () => {
        const dirty = new Set(['a', 'b']);
        const assets = { a: 'data-a', b: 'data-b' };
        expect(await flushAssetSet(dirty, assets, async id => id !== 'a')).toBe(false);
        expect([...dirty]).toEqual(['a']);
        expect(await flushAssetSet(dirty, assets, async () => true)).toBe(true);
        expect(dirty.size).toBe(0);
    });

    it('does not clear an asset that changed while its write was pending', async () => {
        const dirty = new Set(['a']);
        const assets = { a: 'old' };
        let release!: (ok: boolean) => void;
        const pending = flushAssetSet(dirty, assets, () => new Promise<boolean>(resolve => { release = resolve; }));
        assets.a = 'new';
        release(true);
        expect(await pending).toBe(false);
        expect(dirty.has('a')).toBe(true);
    });
});

describe('touch pinch', () => {
    const pinch = { dist: 100, zoom: 1, cx: 500, cy: 400, panX: 100, panY: 200 };

    it('anchors the initial world point under the moving pinch center', () => {
        const next = pinchViewport(pinch, 200, 550, 430, 0.1, 4);
        expect(next.zoom).toBe(2);
        expect(next.panX + 400 * next.zoom).toBe(550);
        expect(next.panY + 200 * next.zoom).toBe(430);
    });

    it('clamps zoom while preserving the anchor', () => {
        const next = pinchViewport(pinch, 1000, 500, 400, 0.1, 1.5);
        expect(next.zoom).toBe(1.5);
        expect(next.panX + 400 * next.zoom).toBe(500);
        expect(next.panY + 200 * next.zoom).toBe(400);
    });
});
