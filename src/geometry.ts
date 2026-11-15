/* 统一几何（旋转感知 AABB，支持自定义枢轴） */
import type { CanvasElement, AABB, Point } from './types';
import { clamp, finite, round2 } from './utils';
import { selectedEls } from './model';
import { lineHeightFor } from './style';

export function getAABB(el: CanvasElement): AABB {
    const rad = el.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const vw = el.w * Math.abs(cos) + h * Math.abs(sin);
    const vh = el.w * Math.abs(sin) + h * Math.abs(cos);
    // 旋转围绕枢轴进行：先求未旋转中心相对枢轴的偏移，再旋转该偏移
    const px = el.x + el.pivotX * el.w, py = el.y + el.pivotY * h;
    const ox = el.w / 2 - el.pivotX * el.w, oy = h / 2 - el.pivotY * h;
    const cx = px + ox * cos - oy * sin;
    const cy = py + ox * sin + oy * cos;
    return { left: cx - vw / 2, top: cy - vh / 2, right: cx + vw / 2, bottom: cy + vh / 2, w: vw, h: vh, cx, cy };
}
/** 元素枢轴的世界坐标 */
export function pivotWorld(el: CanvasElement): Point {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    return { x: el.x + el.pivotX * el.w, y: el.y + el.pivotY * h };
}
/** 旋转手柄的世界坐标（用于让尺寸标注避开它） */
export function rotatorWorld(el: CanvasElement): Point {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const ox = el.w / 2 - el.pivotX * el.w, oy = -27 - el.pivotY * h;
    const p = pivotWorld(el);
    return { x: p.x + ox * cos - oy * sin, y: p.y + ox * sin + oy * cos };
}
/** 设置枢轴（比例坐标）。keepShape=true 时补偿 x/y，使图形在屏幕上保持不动 */
export function setPivot(el: CanvasElement, fx: number, fy: number, keepShape?: boolean): void {
    fx = clamp(finite(fx, 0.5), -2, 3);
    fy = clamp(finite(fy, 0.5), -2, 3);
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    if (keepShape && el.rotation) {
        const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const p1x = el.pivotX * el.w, p1y = el.pivotY * h;
        const p2x = fx * el.w, p2y = fy * h;
        const dx = p2x - p1x, dy = p2y - p1y;
        const nx = el.x + p1x + dx * cos - dy * sin;
        const ny = el.y + p1y + dx * sin + dy * cos;
        el.x = round2(nx - p2x);
        el.y = round2(ny - p2y);
    }
    el.pivotX = round2(fx * 100) / 100;
    el.pivotY = round2(fy * 100) / 100;
}
export function selectionAABB(): AABB | null {
    const els = selectedEls();
    if (!els.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    els.forEach(el => {
        const a = getAABB(el);
        l = Math.min(l, a.left); t = Math.min(t, a.top);
        r = Math.max(r, a.right); b = Math.max(b, a.bottom);
    });
    return { left: l, top: t, right: r, bottom: b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}
export function normalizeZFromOrder(order: CanvasElement[]): void {
    order.forEach((el, i) => { el.zIndex = i + 1; });
}