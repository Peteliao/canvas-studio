/* 旋转 / 倾斜模式：四角旋转标识浮在尺寸标注与工具栏之上，任意一角都可拖拽旋转
 * 标识放在视口层（屏幕坐标、恒定大小），避免被物件数值标签遮挡或拦截点击；
 * 位置随旋转 / 倾斜 / 自定义枢轴 / 缩放 / 平移实时更新 */
import { state } from './state';
import { selectedEls } from './model';
import { elementCorners, selectionAABB } from './geometry';
import { $, $opt, clamp, finite, round2 } from './utils';
import type { Point } from './types';

const DIRS = ['nw', 'ne', 'se', 'sw'] as const;
const OFFSET = 22;           // 角点外侧偏移（屏幕像素）
const PAD = 6;               // 四角标识避让留白
const HANDLE_PAD = 9;        // 顶部旋转小圆点避让留白（数值/工具条离得更开）
export interface ScreenSeed { l: number; t: number; r: number; b: number }

let marks: HTMLDivElement[] | null = null;

function ensureMarks(layer: HTMLElement): HTMLDivElement[] {
    if (marks && marks.length === 4 && marks.every(m => m.parentElement === layer)) return marks;
    layer.textContent = '';
    marks = DIRS.map(dir => {
        const m = document.createElement('div');
        m.className = 'rotate-mark rotate-mark-' + dir;
        m.dataset.dir = dir;
        m.textContent = '↻';
        m.title = '拖拽旋转（Shift 吸附 15°）；四角任一标识均可旋转';
        m.setAttribute('role', 'button');
        m.setAttribute('aria-label', '拖拽旋转');
        layer.appendChild(m);
        return m;
    });
    return marks;
}
function cornersForSelection(): { pts: Point[]; angle: number; id: string } | null {
    const els = selectedEls().filter(e => !e.locked && e.visible !== false);
    if (!els.length) return null;
    if (els.length === 1) {
        return { pts: elementCorners(els[0]), angle: finite(els[0].rotation, 0), id: els[0].id };
    }
    const b = selectionAABB();
    if (!b) return null;
    return {
        pts: [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }],
        angle: 0, id: ''
    };
}
/** 重建/更新四角旋转标识；变换模式关闭或退出选择工具时整体隐藏 */
export function refreshRotateMarks(): void {
    const layer = $opt('rotateMarksLayer');
    if (!layer) return;
    const list = ensureMarks(layer);
    const on = state.transformMode && state.tool === 'select' && state.selection.length > 0 && !state.isTextEditing;
    $('viewport').classList.toggle('transform-mode-active', on);
    layer.hidden = !on;
    if (!on) { list.forEach(m => m.classList.remove('dragging')); return; }
    const geo = cornersForSelection();
    const z = clamp(finite(state.zoom, 1), 0.05, 16);
    if (!geo || geo.pts.length !== 4) { layer.hidden = true; return; }
    const rad = geo.angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    list.forEach((m, i) => {
        const dir = DIRS[i], p = geo.pts[i];
        const dx = dir.includes('w') ? -OFFSET : OFFSET;
        const dy = dir.includes('n') ? -OFFSET : OFFSET;
        // 偏移随物件旋转，保证旋转后标识仍落在角点外侧
        const ox = dx * cos - dy * sin, oy = dx * sin + dy * cos;
        m.style.left = round2(state.pan.x + p.x * z + ox) + 'px';
        m.style.top = round2(state.pan.y + p.y * z + oy) + 'px';
        m.dataset.id = geo.id;
    });
}
/** 视口坐标下的旋转控件占位，供尺寸数值标签与浮动工具条避让 */
function seedOf(n: Element, pad: number, vr: DOMRect): ScreenSeed | null {
    const r = n.getBoundingClientRect();
    if (r.width < .5 || r.height < .5) return null;   // display:none 的控件自然跳过
    return {
        l: round2(r.left - vr.left - pad), t: round2(r.top - vr.top - pad),
        r: round2(r.right - vr.left + pad), b: round2(r.bottom - vr.top + pad)
    };
}
/** 所有旋转手柄的占位：变换模式四角 ↻ + 普通选中态物件顶部的小圆点。
 *  普通选中时四角浮层隐藏，但 .rotator 仍显示在元素内且会被数值/工具条盖住，必须一并避让 */
export function rotateHandleSeedRects(): ScreenSeed[] {
    const vr = $('viewport').getBoundingClientRect();
    const out: ScreenSeed[] = [];
    const layer = $opt('rotateMarksLayer');
    if (layer && !layer.hidden) {
        layer.querySelectorAll<HTMLElement>('.rotate-mark').forEach(n => {
            const s = seedOf(n, PAD, vr);
            if (s) out.push(s);
        });
    }
    document.querySelectorAll<HTMLElement>('.canvas-element.active .rotator').forEach(n => {
        const s = seedOf(n, HANDLE_PAD, vr);
        if (s) out.push(s);
    });
    return out.filter(s => s.r > s.l && s.b > s.t);
}
