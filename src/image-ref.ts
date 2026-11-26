import { MAX_CANVAS_SIDE } from './constants';
import type { ImageRef } from './types';

const cropNumber = (value: unknown): number => value === '' || value === null || value === undefined || !Number.isFinite(Number(value))
    ? NaN
    : Number(value);
const clampCrop = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function makeImage(raw: unknown): ImageRef | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.assetId !== 'string' || !o.assetId) return null;
    let crop = null;
    if (o.crop && typeof o.crop === 'object') {
        const c = o.crop as Record<string, unknown>;
        const x = cropNumber(c.x), y = cropNumber(c.y), w = cropNumber(c.w), h = cropNumber(c.h);
        if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
            crop = {
                x: clampCrop(x, 0, MAX_CANVAS_SIDE), y: clampCrop(y, 0, MAX_CANVAS_SIDE),
                w: clampCrop(w, 0.001, MAX_CANVAS_SIDE), h: clampCrop(h, 0.001, MAX_CANVAS_SIDE)
            };
        }
    }
    return {
        assetId: o.assetId.slice(0, 120),
        originalAssetId: typeof o.originalAssetId === 'string' ? o.originalAssetId.slice(0, 120) : o.assetId.slice(0, 120),
        crop
    };
}
