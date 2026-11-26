import { describe, expect, it } from 'vitest';
import { flushAssetSet } from '../src/asset-storage';
import { exportInkPadding, padExportBounds, rasterExportScale, unionExportBounds } from '../src/export-bounds';
import { makeImage } from '../src/image-ref';
import { flattenPsdLayers, psdBlendMode } from '../src/imageimport';
import type { Layer } from 'ag-psd';
import type { CanvasElement, Model } from '../src/types';
import { findMatchingProject, projectContentSignature, remapProjectAssets } from '../src/project-binding';
import { indexSnapTargets, nearestPointSnap, nearestPointSnapIndexed } from '../src/snappoints';
import type { SnapPoint } from '../src/types';
import { pinchViewport } from '../src/touch';
import { elementLocalToWorld, getAABB } from '../src/geometry';
import { canvasMarginsFor, measurementBounds, measurementOutline, measurementPoints, neighborGapsFor } from '../src/measure-geometry';

const box = { left: 10, top: 20, right: 110, bottom: 70, w: 100, h: 50 };
const element = (extra: Record<string, unknown> = {}): CanvasElement => ({
    type: 'rect', line: null,
    stroke: { width: 0, align: 'center' },
    shadow: { enabled: false, x: 0, y: 0, blur: 0 },
    ...extra
} as CanvasElement);

describe('rotated shape measurement', () => {
    const triangle = element({
        id: 'triangle', type: 'triangle', name: 'Triangle', x: 100, y: 80, w: 120, h: 100,
        rotation: 60, skewX: 0, skewY: 0, pivotX: 0.5, pivotY: 0.5, shapeParams: {}, visible: true
    });

    it('anchors a rotated triangle to its three vertices instead of its selection box', () => {
        const outline = measurementOutline(triangle);
        expect(outline.points).toHaveLength(3);
        expect(outline.points[0].x).toBeCloseTo(203.30127019);
        expect(outline.points[0].y).toBeCloseTo(105);
        expect(outline.points[1].x).toBeCloseTo(86.69872981);
        expect(outline.points[1].y).toBeCloseTo(103.03847577);
        expect(outline.points[2].x).toBeCloseTo(146.69872981);
        expect(outline.points[2].y).toBeCloseTo(206.96152423);
        expect(outline.bounds).toMatchObject({ left: 86.69872981077808, right: 203.30127018922192 });
        expect(getAABB(triangle).w).toBeGreaterThan(outline.bounds.w);
        expect(getAABB(triangle).h).toBeGreaterThan(outline.bounds.h);
        expect(getAABB(triangle).right).not.toBeCloseTo(outline.bounds.right);
    });

    it('measures canvas margins from actual vertices and preserves their anchor points', () => {
        const outline = measurementOutline(triangle);
        const margins = canvasMarginsFor(outline, 400, 300);
        expect(margins.map(m => [m.side, m.value])).toEqual([
            ['left', 86.69872981077808], ['right', 400 - 203.30127018922192], ['top', outline.bounds.top], ['bottom', 300 - outline.bounds.bottom]
        ]);
        expect(margins[0].point.x).toBeCloseTo(86.69872981);
        expect(margins[0].point.y).toBeCloseTo(103.03847577);
        expect(margins[1].point.x).toBeCloseTo(203.30127019);
        expect(margins[1].point.y).toBeCloseTo(105);
        expect(margins[2].point.x).toBeCloseTo(86.69872981);
        expect(margins[2].point.y).toBeCloseTo(103.03847577);
        expect(margins[3].point.x).toBeCloseTo(146.69872981);
        expect(margins[3].point.y).toBeCloseTo(206.96152423);
        expect(margins.every(m => outline.points.includes(m.point))).toBe(true);
    });

    it('measures neighboring gaps from both outlines and extends from their extreme vertices', () => {
        const bounds = measurementBounds([triangle])!;
        const neighbors = [
            element({ id: 'left', x: 30, y: 90, w: 50, h: 50, visible: true }),
            element({ id: 'right', x: 230, y: 90, w: 50, h: 50, visible: true }),
            element({ id: 'top', x: 130, y: 20, w: 50, h: 50, visible: true }),
            element({ id: 'bottom', x: 130, y: 220, w: 50, h: 50, visible: true })
        ];
        const gaps = Object.fromEntries(neighborGapsFor(bounds, neighbors, ['triangle'], measurementPoints([triangle])).map(g => [g.side, g]));
        expect(gaps.left.gap).toBeCloseTo(bounds.left - 80);
        expect(gaps.right.gap).toBeCloseTo(230 - bounds.right);
        expect(gaps.top.gap).toBeCloseTo(bounds.top - 70);
        expect(gaps.bottom.gap).toBeCloseTo(220 - bounds.bottom);
        expect(gaps.left.sourcePoint.x).toBeCloseTo(86.69872981);
        expect(gaps.left.sourcePoint.y).toBeCloseTo(103.03847577);
        expect(gaps.left.otherPoint).toEqual({ x: 80, y: 90 });
        expect(gaps.left.y).toBe(bounds.top);
        expect(gaps.left.y).not.toBe(gaps.left.otherPoint.y);
        expect(gaps.right.sourcePoint.x).toBeCloseTo(203.30127019);
        expect(gaps.right.sourcePoint.y).toBeCloseTo(105);
        expect(gaps.bottom.sourcePoint.x).toBeCloseTo(146.69872981);
        expect(gaps.bottom.sourcePoint.y).toBeCloseTo(206.96152423);
    });

    it('uses custom shape vertices and the same skew, rotation and pivot transform', () => {
        const shaped = { ...triangle, shapeParams: { apex: 30 }, skewX: 15, skewY: -8, pivotX: 0.25, pivotY: 0.7 };
        const outline = measurementOutline(shaped);
        expect(outline.points).toHaveLength(3);
        expect(outline.points[0]).toEqual(elementLocalToWorld(shaped, shaped.w * 0.3, 0));
        expect(outline.points[1]).toEqual(elementLocalToWorld(shaped, 0, shaped.h));
        expect(outline.points[2]).toEqual(elementLocalToWorld(shaped, shaped.w, shaped.h));
    });

    it('keeps unrotated rectangle measurements unchanged', () => {
        const rectangle = element({ x: 20, y: 30, w: 100, h: 60, visible: true });
        expect(measurementBounds([rectangle])).toMatchObject({ left: 20, top: 30, right: 120, bottom: 90 });
        expect(canvasMarginsFor(measurementOutline(rectangle), 300, 200).map(m => m.value)).toEqual([20, 180, 30, 110]);
        const gap = neighborGapsFor(measurementBounds([rectangle])!, [element({ id: 'near', x: 150, y: 40, w: 20, h: 20, visible: true })], ['rectangle'])[0];
        expect(gap).toMatchObject({ side: 'right', gap: 30, sourcePoint: { x: 120, y: 30 }, otherPoint: { x: 150, y: 40 } });
    });
});

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

describe('PSD layer metadata', () => {
    it('preserves hierarchy, inherited visibility and opacity, bounds and order', () => {
        const children: Layer[] = [
            {
                name: 'Hidden group', hidden: true, opacity: 0.5,
                children: [{ name: 'Child', opacity: 0.5, left: -10, top: 4, right: 30, bottom: 44 }]
            },
            { name: 'Visible', left: 5, top: 6, right: 45, bottom: 56, blendMode: 'multiply' }
        ];
        const result = flattenPsdLayers(children);
        expect(result.groupCount).toBe(1);
        expect(result.truncated).toBe(false);
        expect(result.layers.map(layer => layer.name)).toEqual(['Hidden group / Child', 'Visible']);
        expect(result.layers[0]).toMatchObject({ left: -10, top: 4, width: 40, height: 40, visible: false, opacity: 0.25 });
        expect(result.layers[0].groupKey).toBe('g:0');
        expect(result.layers[1].groupKey).toBeNull();
        expect(psdBlendMode(children[1].blendMode)).toBe('multiply');
    });

    it('flags layer limits and maps unsupported blend modes safely', () => {
        const children: Layer[] = Array.from({ length: 3 }, (_, i) => ({
            name: `Layer ${i}`, left: 0, top: 0, right: 10, bottom: 10
        }));
        expect(flattenPsdLayers(children, 2)).toMatchObject({ truncated: true });
        expect(flattenPsdLayers(children.slice(0, 2), 2).truncated).toBe(false);
        expect(psdBlendMode('color burn')).toBe('normal');
        expect(psdBlendMode(undefined)).toBe('normal');
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

describe('snap point index', () => {
    it('matches exhaustive nearest-point search including tie priority', () => {
        const targets: SnapPoint[] = [
            { x: 10, y: 10, kind: 'center', label: 'a' },
            { x: 14, y: 10, kind: 'center', label: 'b' },
            { x: 10, y: 10, kind: 'center', label: 'c' },
            { x: 80, y: 80, kind: 'center', label: 'far' },
            { x: -20, y: 4, kind: 'center', label: 'edge' }
        ];
        const sources: SnapPoint[] = [
            { x: 0, y: 0, kind: 'endpoint', label: 's1' },
            { x: 4, y: 6, kind: 'endpoint', label: 's2' }
        ];
        const index = indexSnapTargets(targets);
        for (const [mx, my, threshold] of [[0, 0, 8], [6, 4, 8], [70, 70, 20], [-10, 0, 8], [500, 500, 8]]) {
            expect(nearestPointSnapIndexed(sources, index, mx, my, threshold))
                .toEqual(nearestPointSnap(sources, targets, mx, my, threshold));
        }
        expect(targets.map(t => t.label)).toEqual(['a', 'b', 'c', 'far', 'edge']);
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
