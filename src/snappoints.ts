/* 对象捕捉点：端点 / 中线中点 / 中心 / 黄金分割 / 圆心 / 象限点 / 贝塞尔节点 */
import { state } from './state';
import { getEl } from './model';
import { lineHeightFor } from './style';
import type { CanvasElement, Point, SnapPoint } from './types';

export const SNAP_POINT_PX = 8;
const GOLDEN = [0.382, 0.618];

export interface PointSnapResult { target: SnapPoint; dx: number; dy: number; }
export interface SnapSourceItem { id: string; x: number; y: number; }

function localToWorld(el: CanvasElement, lx: number, ly: number, x: number, y: number): Point {
    const h = lineHeightFor(el);
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const px = el.pivotX * el.w, py = el.pivotY * h;
    const dx = lx - px, dy = ly - py;
    return {
        x: x + px + dx * cos - dy * sin,
        y: y + py + dx * sin + dy * cos
    };
}

export function elementSnapPoints(el: CanvasElement, x = el.x, y = el.y): SnapPoint[] {
    if (!el.visible) return [];
    const w = el.w, h = lineHeightFor(el), out: SnapPoint[] = [], seen: Point[] = [];
    const add = (lx: number, ly: number, kind: SnapPoint['kind'], label: string): void => {
        const p = localToWorld(el, lx, ly, x, y);
        if (seen.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.01)) return;
        seen.push(p);
        out.push({ x: p.x, y: p.y, kind, label, elementId: el.id });
    };
    if (el.type === 'circle') {
        add(w / 2, h / 2, 'center', '圆心');
        add(w / 2, 0, 'quadrant', '象限点');
        add(w, h / 2, 'quadrant', '象限点');
        add(w / 2, h, 'quadrant', '象限点');
        add(0, h / 2, 'quadrant', '象限点');
        return out;
    }
    if (el.type === 'line') {
        add(0, h / 2, 'endpoint', '端点');
        add(w, h / 2, 'endpoint', '端点');
        add(w / 2, h / 2, 'center', '中心');
        GOLDEN.forEach(k => add(w * k, h / 2, 'golden', '黄金分割'));
        return out;
    }
    if (el.type === 'curve' && el.curve) {
        const nodes = el.curve.nodes;
        nodes.forEach((n, i) => {
            const end = i === 0 || i === nodes.length - 1;
            add(n.x * w, n.y * h, end ? 'endpoint' : 'node', end ? '端点' : '节点');
        });
    } else {
        add(0, 0, 'endpoint', '端点');
        add(w, 0, 'endpoint', '端点');
        add(w, h, 'endpoint', '端点');
        add(0, h, 'endpoint', '端点');
    }
    add(w / 2, h / 2, 'center', '中心');
    add(w / 2, 0, 'midpoint', '中点');
    add(w, h / 2, 'midpoint', '中点');
    add(w / 2, h, 'midpoint', '中点');
    add(0, h / 2, 'midpoint', '中点');
    for (const k of GOLDEN) {
        add(w * k, 0, 'golden', '黄金分割');
        add(w * k, h, 'golden', '黄金分割');
        add(0, h * k, 'golden', '黄金分割');
        add(w, h * k, 'golden', '黄金分割');
    }
    GOLDEN.forEach(kx => GOLDEN.forEach(ky => add(w * kx, h * ky, 'golden', '黄金分割')));
    return out;
}

export function canvasSnapPoints(): SnapPoint[] {
    const cw = state.model.canvas.w, ch = state.model.canvas.h;
    const out: SnapPoint[] = [
        { x: 0, y: 0, kind: 'canvas', label: '画布角点' },
        { x: cw, y: 0, kind: 'canvas', label: '画布角点' },
        { x: cw, y: ch, kind: 'canvas', label: '画布角点' },
        { x: 0, y: ch, kind: 'canvas', label: '画布角点' },
        { x: cw / 2, y: ch / 2, kind: 'canvas', label: '画布中心' }
    ];
    GOLDEN.forEach(kx => GOLDEN.forEach(ky => {
        out.push({ x: cw * kx, y: ch * ky, kind: 'canvas', label: '画布黄金分割' });
    }));
    return out;
}

export function collectSnapPoints(ignoreIds: Set<string>): SnapPoint[] {
    const out = canvasSnapPoints();
    state.model.elements.forEach(e => {
        if (ignoreIds.has(e.id) || !e.visible) return;
        out.push(...elementSnapPoints(e));
    });
    return out;
}

export function selectionSnapPoints(items: SnapSourceItem[]): SnapPoint[] {
    const out: SnapPoint[] = [];
    items.forEach(item => {
        const el = getEl(item.id);
        if (el) out.push(...elementSnapPoints(el, item.x, item.y));
    });
    return out;
}

export function nearestSnapPoint(p: Point, threshold: number, ignoreIds: Set<string>, targets?: SnapPoint[]): SnapPoint | null {
    let best: SnapPoint | null = null, bestD = threshold * threshold;
    (targets || collectSnapPoints(ignoreIds)).forEach(t => {
        const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
        if (d <= bestD) { bestD = d; best = t; }
    });
    return best;
}

export function nearestPointSnap(sources: SnapPoint[], targets: SnapPoint[], mx: number, my: number, threshold: number): PointSnapResult | null {
    let best: PointSnapResult | null = null, bestD = threshold * threshold;
    sources.forEach(s => {
        const sx = s.x + mx, sy = s.y + my;
        targets.forEach(t => {
            const dx = t.x - sx, dy = t.y - sy;
            const d = dx * dx + dy * dy;
            if (d <= bestD) { bestD = d; best = { target: t, dx, dy }; }
        });
    });
    return best;
}
