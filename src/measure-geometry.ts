import { elementCorners, elementLocalToWorld } from './geometry';
import { shapePoints } from './shapes';
import type { AABB, CanvasElement, Point } from './types';

export type MeasureSide = 'left' | 'right' | 'top' | 'bottom';
export type MeasureLine = { axis: 'h'; x1: number; x2: number; y: number } | { axis: 'v'; x: number; y1: number; y2: number };
export type GapMeasure = { side: MeasureSide; gap: number; otherId: string; sourcePoint: Point; otherPoint: Point } & MeasureLine;
export interface MeasurementOutline { points: Point[]; bounds: AABB; }
export interface CanvasMargin { side: MeasureSide; value: number; point: Point; }

function boundsFromPoints(points: readonly Point[]): AABB {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    points.forEach(p => {
        left = Math.min(left, p.x); top = Math.min(top, p.y);
        right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
    });
    return { left, top, right, bottom, w: right - left, h: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

export function measurementOutline(el: CanvasElement): MeasurementOutline {
    const shape = shapePoints(el);
    const points = shape
        ? shape.map(([x, y]) => elementLocalToWorld(el, x / 100 * el.w, y / 100 * el.h))
        : elementCorners(el);
    return { points, bounds: boundsFromPoints(points) };
}

export function measurementPoints(elements: readonly CanvasElement[]): Point[] {
    return elements.flatMap(el => measurementOutline(el).points);
}

export function measurementBounds(elements: readonly CanvasElement[]): AABB | null {
    const points = measurementPoints(elements);
    return points.length ? boundsFromPoints(points) : null;
}

export function measurementSidePoint(points: readonly Point[], side: MeasureSide, bounds: AABB): Point {
    const value = side === 'left' ? bounds.left : side === 'right' ? bounds.right : side === 'top' ? bounds.top : bounds.bottom;
    const coordinate = (p: Point): number => side === 'left' || side === 'right' ? p.x : p.y;
    const candidates = points.filter(p => Math.abs(coordinate(p) - value) < 1e-6);
    return (candidates.length ? candidates : points).reduce((best, p) => {
        const distance = Math.hypot(p.x - bounds.cx, p.y - bounds.cy);
        const bestDistance = Math.hypot(best.x - bounds.cx, best.y - bounds.cy);
        return distance < bestDistance ? p : best;
    });
}

export function canvasMarginsFor(outline: MeasurementOutline, canvasWidth: number, canvasHeight: number): CanvasMargin[] {
    const b = outline.bounds;
    return [
        { side: 'left', value: b.left, point: measurementSidePoint(outline.points, 'left', b) },
        { side: 'right', value: canvasWidth - b.right, point: measurementSidePoint(outline.points, 'right', b) },
        { side: 'top', value: b.top, point: measurementSidePoint(outline.points, 'top', b) },
        { side: 'bottom', value: canvasHeight - b.bottom, point: measurementSidePoint(outline.points, 'bottom', b) }
    ];
}

export function neighborGapsFor(box: AABB, elements: CanvasElement[], excludeIds: string[], sourcePoints?: readonly Point[]): GapMeasure[] {
    const best: Partial<Record<MeasureSide, GapMeasure>> = {};
    const source = sourcePoints?.length ? sourcePoints : [
        { x: box.left, y: box.top }, { x: box.right, y: box.top },
        { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }
    ];
    elements.forEach(o => {
        if (excludeIds.includes(o.id) || o.visible === false) return;
        const outline = measurementOutline(o), a = outline.bounds;
        const oy = Math.min(box.bottom, a.bottom) - Math.max(box.top, a.top);
        const ox = Math.min(box.right, a.right) - Math.max(box.left, a.left);
        const put = (side: MeasureSide, gap: number, sourcePoint: Point, otherPoint: Point, line: MeasureLine): void => {
            const ag = Math.abs(gap), cur = best[side];
            if (!cur || ag < Math.abs(cur.gap) || (ag === Math.abs(cur.gap) && gap > cur.gap)) {
                best[side] = Object.assign({ side, gap, otherId: o.id, sourcePoint, otherPoint }, line);
            }
        };
        if (oy > 2) {
            if (a.cx < box.cx) {
                const sp = measurementSidePoint(source, 'left', box), op = measurementSidePoint(outline.points, 'right', a);
                const y = Math.max(box.top, a.top, Math.min(box.bottom, a.bottom, (sp.y + op.y) / 2));
                put('left', box.left - a.right, sp, op, { axis: 'h', x1: a.right, x2: box.left, y });
            } else {
                const sp = measurementSidePoint(source, 'right', box), op = measurementSidePoint(outline.points, 'left', a);
                const y = Math.max(box.top, a.top, Math.min(box.bottom, a.bottom, (sp.y + op.y) / 2));
                put('right', a.left - box.right, sp, op, { axis: 'h', x1: box.right, x2: a.left, y });
            }
        }
        if (ox > 2) {
            if (a.cy < box.cy) {
                const sp = measurementSidePoint(source, 'top', box), op = measurementSidePoint(outline.points, 'bottom', a);
                const x = Math.max(box.left, a.left, Math.min(box.right, a.right, (sp.x + op.x) / 2));
                put('top', box.top - a.bottom, sp, op, { axis: 'v', x, y1: a.bottom, y2: box.top });
            } else {
                const sp = measurementSidePoint(source, 'bottom', box), op = measurementSidePoint(outline.points, 'top', a);
                const x = Math.max(box.left, a.left, Math.min(box.right, a.right, (sp.x + op.x) / 2));
                put('bottom', a.top - box.bottom, sp, op, { axis: 'v', x, y1: box.bottom, y2: a.top });
            }
        }
    });
    return (['left', 'right', 'top', 'bottom'] as const).map(side => best[side]).filter((gap): gap is GapMeasure => !!gap);
}
