import { MAX_EXPORT_PIXELS } from './constants';
import type { Box, CanvasElement } from './types';

const MAX_EXPORT_SIDE = 32767;

export interface ExportBounds { x: number; y: number; w: number; h: number; }

export function exportInkPadding(el: CanvasElement): number {
    const strokeWidth = el.type === 'line' || el.type === 'curve' ? el.line?.width || 0 : el.stroke.width;
    const strokeExtent = el.type === 'line' || el.type === 'curve'
        ? strokeWidth
        : el.stroke.align === 'outside' ? strokeWidth : el.stroke.align === 'center' ? strokeWidth / 2 : 0;
    const shadow = el.shadow.enabled
        ? Math.hypot(el.shadow.x, el.shadow.y) + Math.max(0, el.shadow.blur) * 2
        : 0;
    return Math.max(8, strokeExtent + 4, shadow + 4);
}

export function padExportBounds(box: Box, padding: number): ExportBounds {
    return {
        x: box.left - padding,
        y: box.top - padding,
        w: box.w + padding * 2,
        h: box.h + padding * 2
    };
}

export function rasterExportScale(bounds: ExportBounds, preferredScale = 2): number {
    const pixels = Math.max(1, bounds.w * bounds.h);
    const side = Math.max(1, bounds.w, bounds.h);
    return Math.max(0.001, Math.min(
        preferredScale,
        Math.sqrt(MAX_EXPORT_PIXELS / pixels),
        MAX_EXPORT_SIDE / side
    ));
}

export function unionExportBounds(boxes: readonly ExportBounds[], padding = 8): ExportBounds | null {
    if (!boxes.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const box of boxes) {
        left = Math.min(left, box.x - padding);
        top = Math.min(top, box.y - padding);
        right = Math.max(right, box.x + box.w + padding);
        bottom = Math.max(bottom, box.y + box.h + padding);
    }
    return { x: left, y: top, w: right - left, h: bottom - top };
}
