/* 统一几何（旋转 + 倾斜感知，支持自定义枢轴） */
import type { CanvasElement, AABB, Point } from './types';
import { clamp, finite, round2 } from './utils';
import { selectedEls } from './model';
import { lineHeightFor } from './style';

function skewTans(el: CanvasElement): { kx: number; ky: number } {
    const kx = Math.tan(clamp(finite(el.skewX, 0), -85, 85) * Math.PI / 180);
    const ky = Math.tan(clamp(finite(el.skewY, 0), -85, 85) * Math.PI / 180);
    return { kx, ky };
}
/** 元素未旋转局部坐标 → 世界坐标（先倾斜、再旋转，围绕枢轴） */
export function elementLocalToWorld(el: CanvasElement, lx: number, ly: number, x = el.x, y = el.y): Point {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const rad = finite(el.rotation, 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const { kx, ky } = skewTans(el);
    const px = finite(el.pivotX, 0.5) * el.w, py = finite(el.pivotY, 0.5) * h;
    const dx = lx - px, dy = ly - py;
    const sx = dx + kx * dy, sy = dy + ky * dx;
    return { x: x + px + sx * cos - sy * sin, y: y + py + sx * sin + sy * cos };
}
/** 世界坐标 → 元素未旋转局部坐标（反向旋转 + 反向倾斜） */
export function elementWorldToLocal(el: CanvasElement, p: Point): Point {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const rad = finite(el.rotation, 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const { kx, ky } = skewTans(el);
    const px = finite(el.pivotX, 0.5) * el.w, py = finite(el.pivotY, 0.5) * h;
    const dx = p.x - el.x - px, dy = p.y - el.y - py;
    const rx = dx * cos + dy * sin, ry = -dx * sin + dy * cos;
    const det = 1 - kx * ky;
    if (Math.abs(det) < 1e-6) return { x: px + rx, y: py + ry };
    return { x: px + (rx - kx * ry) / det, y: py + (ry - ky * rx) / det };
}
/** 元素四角（世界坐标，含旋转 / 倾斜 / 自定义枢轴），顺序为左上 / 右上 / 右下 / 左下 */
export function elementCorners(el: CanvasElement): Point[] {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    return [
        elementLocalToWorld(el, 0, 0), elementLocalToWorld(el, el.w, 0),
        elementLocalToWorld(el, el.w, h), elementLocalToWorld(el, 0, h)
    ];
}
export function getAABB(el: CanvasElement): AABB {
    const corners = elementCorners(el);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    corners.forEach(p => {
        left = Math.min(left, p.x); top = Math.min(top, p.y);
        right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
    });
    return { left, top, right, bottom, w: right - left, h: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}
/** 元素枢轴的世界坐标 */
export function pivotWorld(el: CanvasElement): Point {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    return { x: el.x + el.pivotX * el.w, y: el.y + el.pivotY * h };
}
/** 旋转手柄的世界坐标（用于让尺寸标注避开它） */
export function rotatorWorld(el: CanvasElement): Point {
    return elementLocalToWorld(el, el.w / 2, -27);
}
/** 设置枢轴（比例坐标）。keepShape=true 时补偿 x/y，使图形在屏幕上保持不动 */
export function setPivot(el: CanvasElement, fx: number, fy: number, keepShape?: boolean): void {
    fx = clamp(finite(fx, 0.5), -2, 3);
    fy = clamp(finite(fy, 0.5), -2, 3);
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    if (keepShape && (el.rotation || el.skewX || el.skewY)) {
        const p = pivotWorld(el);
        const rad = finite(el.rotation, 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const { kx, ky } = skewTans(el);
        const dx = (fx - el.pivotX) * el.w, dy = (fy - el.pivotY) * h;
        const sx = dx + kx * dy, sy = dy + ky * dx;
        const tx = sx * cos - sy * sin, ty = sx * sin + sy * cos;
        el.x = round2(p.x + tx - fx * el.w);
        el.y = round2(p.y + ty - fy * h);
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