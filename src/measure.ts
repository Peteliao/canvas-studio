import { SVG_NS } from './constants';
import { state } from './state';
import { $, $opt, clamp, finite, iconEl, round2 } from './utils';
import { getEl, selectedEls } from './model';
import { toggleSelectionLock } from './selection';
import { lineHeightFor } from './style';
import { syncElement } from './render';
import { getAABB, pivotWorld, rotatorWorld, selectionAABB } from './geometry';
import { commit, scheduleCommit } from './history';
import { moveSelected, updateGeo } from './elements';
import { applyGuideDistance, applyObjectGuideDistance, currentGuide, guideSegPath, nearestGuidesToBox, nearestObjectsToGuide } from './guides';
import { setSelectionToolsMeasureRefresh, syncSelectionTools } from './selectiontools';
import { refreshRotateMarks, rotateMarkSeedRects } from './rotatemarks';
import type { AABB, CanvasElement, Guide, Point } from './types';

type Side = 'left' | 'right' | 'top' | 'bottom';
type MeasureLine = { axis: 'h'; x1: number; x2: number; y: number } | { axis: 'v'; x: number; y1: number; y2: number };
export type GapMeasure = { side: Side; gap: number; otherId: string } & MeasureLine;
export interface AlignMeasure { otherId: string; edge: Side; delta: number; line: MeasureLine; }
interface MeasureTag { d: HTMLDivElement; cx: number; cy: number; mode: 'center' | 'above'; w?: number; h?: number; }
interface SeedRect { l: number; r: number; t: number; b: number; }

// 标注显示阈值（屏幕像素）：过远的测量线只会让画面变乱
const MEASURE_LIMIT = { gap: 300, align: 220, guide: 300, margin: 260 };
const GAP_ARROW: Record<Side, string> = { left: '←', right: '→', top: '↑', bottom: '↓' };

export function measureApplySize(axis: 'w' | 'h', v: number): void {
    v = Math.max(1, round2(v));
    if (state.selection.length === 1) {
        $<HTMLInputElement>(axis === 'w' ? 'geoW' : 'geoH').value = String(v);
        updateGeo(axis);
        return;
    }
    // 多选：以选区左上角为锚点等比缩放，与拖拽缩放手柄一致
    const box = selectionAABB();
    const els = selectedEls().filter(e => !e.locked);
    if (!box || !els.length) return;
    const s = v / Math.max(1, axis === 'w' ? box.w : box.h);
    els.forEach(el => {
        if (axis === 'w') { el.x = round2(box.left + (el.x - box.left) * s); el.w = round2(Math.max(1, el.w * s)); }
        else { el.y = round2(box.top + (el.y - box.top) * s); el.h = round2(Math.max(1, el.h * s)); }
        if (el.type === 'text' && el.text!.sizeMode !== 'fixed') el.text!.sizeMode = 'fixed';
        syncElement(el.id);
    });
    scheduleCommit();
}

function openMeasureEditor(span: HTMLElement, value: number, apply: (v: number) => void, label: string): void {
    if (span.querySelector('.measure-input')) return;
    const selKey = state.selection.join(',');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'measure-input';
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const fit = () => { input.style.width = Math.max(3, input.value.length + 1) + 'ch'; };
    fit();
    span.textContent = '';
    span.classList.add('editing');
    span.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    let lastApplied: number | null = null;
    const finish = (applyIt: boolean) => {
        if (done) return;
        done = true;
        const v = finite(input.value, NaN);
        input.remove();
        span.classList.remove('editing');
        // 选区在编辑期间变化时放弃应用，避免把数值改到别的对象上
        if (state.selection.join(',') === selKey) {
            if (applyIt && !Number.isNaN(v) && (v !== value || lastApplied !== null)) { apply(v); commit(); }
            // Esc 取消：方向键已实时生效的改动回退到打开编辑前的数值
            else if (!applyIt && lastApplied !== null && lastApplied !== value) { apply(value); commit(); }
        }
        drawMeasure();
    };
    input.addEventListener('input', fit);
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault(); e.stopPropagation();
            const step = (state.moveStep || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const nv = round2(finite(input.value, value) + step);
            input.value = String(nv);
            fit();
            if (state.selection.join(',') === selKey) { lastApplied = nv; apply(nv); }
        }
    });
    input.addEventListener('blur', () => finish(true));
}

function measureNum(parent: HTMLElement, value: number, apply: (v: number) => void, label: string, tip?: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = 'measure-num';
    s.textContent = String(value);
    s.tabIndex = 0;
    s.setAttribute('role', 'spinbutton');
    s.setAttribute('aria-valuenow', String(value));
    s.setAttribute('aria-label', label);
    s.title = tip || ('点击编辑' + label + '（↑↓ 按步长微调，Shift 加速，Enter 确认，Esc 取消）');
    const open = () => openMeasureEditor(s, value, apply, label);
    s.addEventListener('click', e => { e.stopPropagation(); open(); });
    s.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
    });
    parent.appendChild(s);
    return s;
}

function measureText(parent: HTMLElement, text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = 'measure-sep';
    s.textContent = text;
    parent.appendChild(s);
    return s;
}

/* -------------------- 标注排版：屏幕坐标尺寸线 + 药丸标签批量避让 -------------------- */
/** 水平尺寸线（含两端刻度） */
function measureDimH(x1: number, x2: number, y: number, tick?: number): string {
    const t = tick || 4;
    return `M ${round2(x1)} ${round2(y - t)} V ${round2(y + t)} M ${round2(x1)} ${round2(y)} H ${round2(x2)} M ${round2(x2)} ${round2(y - t)} V ${round2(y + t)}`;
}
/** 垂直尺寸线（含两端刻度） */
function measureDimV(x: number, y1: number, y2: number, tick?: number): string {
    const t = tick || 4;
    return `M ${round2(x - t)} ${round2(y1)} H ${round2(x + t)} M ${round2(x)} ${round2(y1)} V ${round2(y2)} M ${round2(x - t)} ${round2(y2)} H ${round2(x + t)}`;
}
/** 任意方向尺寸线（旋转物件用），刻度垂直于线方向 */
function measureDimSeg(ax: number, ay: number, bx: number, by: number, tick?: number): string {
    const t = tick || 4;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    return `M ${round2(ax + nx * t)} ${round2(ay + ny * t)} L ${round2(ax - nx * t)} ${round2(ay - ny * t)}` +
        ` M ${round2(ax)} ${round2(ay)} L ${round2(bx)} ${round2(by)}` +
        ` M ${round2(bx + nx * t)} ${round2(by + ny * t)} L ${round2(bx - nx * t)} ${round2(by - ny * t)}`;
}
/** 视口内可用右边界：窄屏时检查器是覆盖画布的抽屉，标注需让位 */
function measureDrawerLimit(): number | null {
    const insp = $opt('inspector');
    if (!insp || insp.classList.contains('collapsed') || getComputedStyle(insp).position !== 'absolute') return null;
    const ir = insp.getBoundingClientRect(), vr = $('viewport').getBoundingClientRect();
    if (ir.left >= vr.right || ir.right <= vr.left) return null;
    return ir.left - vr.left - 16;
}
/**
 * 标签批量排版：先统一读尺寸（一次布局），再统一写位置
 * pending: [{ d, cx, cy, mode:'center'|'above' }]，seeds: 需要避让的屏幕矩形
 */
function layoutMeasureTags(pending: MeasureTag[], seeds?: SeedRect[]): void {
    if (!pending || !pending.length) return;
    const vp = $('viewport');
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const lim = measureDrawerLimit();
    const right = lim === null ? vw - 4 : clamp(lim, 140, vw - 4);
    const items = pending.slice();
    items.forEach(it => { it.w = it.d.offsetWidth || 46; it.h = it.d.offsetHeight || 19; });
    const placed: SeedRect[] = (seeds || []).map(s => ({ l: s.l, r: s.r, t: s.t, b: s.b }));
    const clash = (r: SeedRect) => placed.some(p => !(r.r + 3 < p.l || r.l - 3 > p.r || r.b + 3 < p.t || r.t - 3 > p.b));
    const CENTER: [number, number][] = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const ABOVE: [number, number][] = [[0, -1], [0, 0], [0, -2], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [0, 2], [-1, 1], [1, 1]];
    items.forEach(it => {
        const w = it.w!, h = it.h!;
        const order = it.mode === 'center' ? CENTER : ABOVE;
        let pick: (SeedRect & { x: number; y: number }) | null = null;
        for (const [dx, dy] of order) {
            const x = clamp(it.cx + dx * (w / 2 + 7), w / 2 + 4, Math.max(w / 2 + 4, right - w / 2));
            const y = clamp(it.cy + dy * (h + 5), h / 2 + 4, Math.max(h / 2 + 4, vh - h / 2 - 4));
            const r = { x, y, l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
            if (clash(r)) continue;
            pick = r;
            break;
        }
        if (!pick) {
            const x = clamp(it.cx, w / 2 + 4, Math.max(w / 2 + 4, right - w / 2));
            const y = clamp(it.cy, h / 2 + 4, Math.max(h / 2 + 4, vh - h / 2 - 4));
            pick = { x, y, l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
        }
        it.d.style.left = pick.x + 'px';
        it.d.style.top = pick.y + 'px';
        placed.push(pick);
    });
}

/* -------------------- 相邻物件间距（四向最近邻，玫红色标注） -------------------- */
const GAP_SIDE_NAME: Record<Side, string> = { left: '左', right: '右', top: '上', bottom: '下' };

export function neighborGapsFor(box: AABB, elements: CanvasElement[], excludeIds: string[]): GapMeasure[] {
    const best: Partial<Record<Side, GapMeasure>> = {};
    elements.forEach(o => {
        if (excludeIds.includes(o.id) || o.visible === false) return;
        const a = getAABB(o);
        const oy = Math.min(box.bottom, a.bottom) - Math.max(box.top, a.top);
        const ox = Math.min(box.right, a.right) - Math.max(box.left, a.left);
        const put = (side: Side, gap: number, line: MeasureLine) => {
            const ag = Math.abs(gap), cur = best[side];
            // 按绝对值取最近邻；同距优先分离侧。负值表示两物件重叠的深度
            if (!cur || ag < Math.abs(cur.gap) || (ag === Math.abs(cur.gap) && gap > cur.gap)) {
                best[side] = Object.assign({ side, gap, otherId: o.id }, line);
            }
        };
        // 垂直方向有投影重叠才比较水平间距，反之亦然，避免斜对角误报；
        // 左右/上下按中心方位分配，因此重叠物件也会得到带符号的相对间距
        if (oy > 2) {
            const my = (Math.max(box.top, a.top) + Math.min(box.bottom, a.bottom)) / 2;
            if (a.cx < box.cx) put('left', box.left - a.right, { axis: 'h', x1: a.right, x2: box.left, y: my });
            else put('right', a.left - box.right, { axis: 'h', x1: box.right, x2: a.left, y: my });
        }
        if (ox > 2) {
            const mx = (Math.max(box.left, a.left) + Math.min(box.right, a.right)) / 2;
            if (a.cy < box.cy) put('top', box.top - a.bottom, { axis: 'v', x: mx, y1: a.bottom, y2: box.top });
            else put('bottom', a.top - box.bottom, { axis: 'v', x: mx, y1: box.bottom, y2: a.top });
        }
    });
    return (['left', 'right', 'top', 'bottom'] as const).map(s => best[s]).filter((g): g is GapMeasure => !!g);
}

/* -------------------- 边缘对齐差（橙色标注，0=对齐，可编辑） -------------------- */
const ALIGN_EDGE_NAME: Record<Side, string> = { top: '顶边', bottom: '底边', left: '左边', right: '右边' };

/** 与最近水平/垂直邻居的四边对齐差：不要求投影重叠，斜向邻居也能数值对齐 */
export function alignmentMeasures(box: AABB, elements: CanvasElement[], excludeIds: string[]): AlignMeasure[] {
    let h: { o: CanvasElement; a: AABB; d: number } | null = null;
    let v: { o: CanvasElement; a: AABB; d: number } | null = null;
    for (const o of elements) {
        if (excludeIds.includes(o.id) || o.visible === false) continue;
        const a = getAABB(o);
        const dh = Math.abs(a.cx - box.cx), dv = Math.abs(a.cy - box.cy);
        if (!h || dh < h.d) h = { o, a, d: dh };
        if (!v || dv < v.d) v = { o, a, d: dv };
    }
    // 每个方向只保留差值更小的一条边，避免四个数字同时出现造成干扰
    const out: AlignMeasure[] = [];
    if (h && h.d > 1e-6) {
        const right = h.a.cx > box.cx;
        const mx = ((right ? box.right : h.a.right) + (right ? h.a.left : box.left)) / 2;
        const cand: AlignMeasure[] = [
            { otherId: h.o.id, edge: 'top', delta: round2(box.top - h.a.top), line: { axis: 'v', x: mx, y1: box.top, y2: h.a.top } },
            { otherId: h.o.id, edge: 'bottom', delta: round2(box.bottom - h.a.bottom), line: { axis: 'v', x: mx, y1: box.bottom, y2: h.a.bottom } }
        ];
        out.push(cand[Math.abs(cand[1].delta) < Math.abs(cand[0].delta) ? 1 : 0]);
    }
    if (v && v.d > 1e-6) {
        const below = v.a.cy > box.cy;
        const my = ((below ? box.bottom : v.a.bottom) + (below ? v.a.top : box.top)) / 2;
        const cand: AlignMeasure[] = [
            { otherId: v.o.id, edge: 'left', delta: round2(box.left - v.a.left), line: { axis: 'h', x1: box.left, x2: v.a.left, y: my } },
            { otherId: v.o.id, edge: 'right', delta: round2(box.right - v.a.right), line: { axis: 'h', x1: box.right, x2: v.a.right, y: my } }
        ];
        out.push(cand[Math.abs(cand[1].delta) < Math.abs(cand[0].delta) ? 1 : 0]);
    }
    return out;
}

/** 编辑对齐差：选区沿对应轴平移，使指定边缘与目标边缘相差 v（0=完全对齐） */
function applyAlignDelta(a: AlignMeasure, v: number): void {
    const o = getEl(a.otherId);
    const b = selectionAABB();
    if (!o || !b) return;
    const aa = getAABB(o);
    const d = round2(round2(v) - (b[a.edge] - aa[a.edge]));
    if (a.edge === 'top' || a.edge === 'bottom') moveSelected(0, d);
    else moveSelected(d, 0);
}

function applyNeighborGap(g: GapMeasure, v: number): void {
    const o = getEl(g.otherId);
    const b = selectionAABB();
    if (!o || !b) return;
    const a = getAABB(o);
    if (g.side === 'left') moveSelected(round2(a.right + v - b.left), 0);
    else if (g.side === 'right') moveSelected(round2(a.left - v - b.right), 0);
    else if (g.side === 'top') moveSelected(0, round2(a.bottom + v - b.top));
    else moveSelected(0, round2(a.top - v - b.bottom));
}

export function drawMeasure(): void {
    refreshRotateMarks();   // 四角旋转标识跟随几何 / 缩放变化，并供下方数值标签避让
    syncSelectionTools();
    const layer = $opt('measureLayer');
    if (!layer) return;
    if (layer.querySelector('.measure-input')) return;   // 编辑中不重绘，避免输入框被销毁
    layer.textContent = '';
    if (!state.settings.guides) return;
    const guideSel = currentGuide();
    if (guideSel) {
        if (state.settings.measureGuide !== false) drawGuideSelectionMeasure(layer, guideSel);
        return;
    }
    if (!state.selection.length) return;
    const box = selectionAABB();
    if (!box) return;
    const single = state.selection.length === 1 ? getEl(state.selection[0]) : null;
    const locked = !!(single && single.locked);
    // 隔离模式只测量可见的选中物件，避免标注到已隐藏的邻居
    const measuredElements = state.isolating
        ? state.model.elements.filter(e => state.selection.includes(e.id))
        : state.model.elements;
    const z = state.zoom || 1;
    const X = (v: number) => round2(v * z + state.pan.x), Y = (v: number) => round2(v * z + state.pan.y);
    const cw = state.model.canvas.w, ch = state.model.canvas.h;

    /* ---- 基础构件：尺寸线层（先建保证在标签之下）、药丸标签 ---- */
    const lineLayer = (cls: string) => {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'measure-lines' + (cls ? ' ' + cls : ''));
        svg.setAttribute('aria-hidden', 'true');
        layer.appendChild(svg);
        return (d: string) => {
            if (!d) return;
            const p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        };
    };
    const sizeLine = lineLayer('size-lines');
    const sizeExt = lineLayer('size-lines ext');
    const gapLine = lineLayer('');
    const alignLine = lineLayer('align-lines');
    const guideLine = lineLayer('guide-lines');
    const marginLine = lineLayer('margin-lines');

    const pending: MeasureTag[] = [];
    const addTag = (cls: string, fill: (d: HTMLDivElement) => void, cx: number, cy: number, opt?: { title?: string; mode?: 'center' | 'above' }): HTMLDivElement => {
        const d = document.createElement('div');
        d.className = 'measure-tag' + (cls ? ' ' + cls : '');
        d.style.left = cx + 'px';
        d.style.top = cy + 'px';
        fill(d);
        if (opt && opt.title) d.title = opt.title;
        layer.appendChild(d);
        pending.push({ d, cx, cy, mode: (opt && opt.mode) || 'above' });
        return d;
    };
    const tagKey = (d: HTMLElement, k: string) => {
        const s = document.createElement('span');
        s.className = 'measure-key';
        s.textContent = k;
        d.appendChild(s);
    };
    // 只读（锁定）时输出纯文本，否则输出可点击编辑的数值
    const tagVal = (d: HTMLElement, value: number, apply: (v: number) => void, label: string, title?: string) => {
        if (locked) return measureText(d, String(Math.round(value)));
        return measureNum(d, Math.round(value), apply, label, title);
    };

    /* ---- 1. 自身尺寸：贴着物件自身边缘的 W / H 尺寸线（旋转后随物件倾斜） ---- */
    const angle = single ? ((Math.round(single.rotation) % 360) + 360) % 360 : 0;
    const rotated = !!(single && angle !== 0);
    const rot = rotated ? rotatorWorld(single!) : null;
    if (state.settings.measureSize !== false) {
        const sizeW = single ? single.w : box.w;
        const sizeH = single ? lineHeightFor(single) : box.h;
        // 物件四角（屏幕坐标）：多选或未旋转时等价于 AABB
        const corner: Point[] = (() => {
            if (!single) {
                return [{ x: X(box.left), y: Y(box.top) }, { x: X(box.right), y: Y(box.top) },
                    { x: X(box.right), y: Y(box.bottom) }, { x: X(box.left), y: Y(box.bottom) }];
            }
            const a = single.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
            const P = pivotWorld(single);
            const px = single.pivotX * single.w, py = single.pivotY * sizeH;
            return [[0, 0], [single.w, 0], [single.w, sizeH], [0, sizeH]].map(([lx, ly]) => {
                const dx = lx - px, dy = ly - py;
                return {
                    x: X(P.x + dx * cos - dy * sin),
                    y: Y(P.y + dx * sin + dy * cos)
                };
            });
        })();
        const rad = single ? single.rotation * Math.PI / 180 : 0;
        const upN = { x: Math.sin(rad), y: -Math.cos(rad) };      // 顶边外法线（屏幕方向）
        const leftN = { x: -Math.cos(rad), y: -Math.sin(rad) };   // 左边外法线
        const off = 18;
        const [cTL, cTR, cBR, cBL] = corner;
        // 尺寸线过分贴近视口边缘时翻到对侧，延伸线同步跟随
        const normal = (p: Point, n: Point, s: number): Point => ({ x: p.x + n.x * off * s, y: p.y + n.y * off * s });
        const vw = $('viewport').clientWidth;
        let wA0 = cTL, wB0 = cTR;
        let wA = normal(wA0, upN, 1), wB = normal(wB0, upN, 1);
        if (Math.min(wA.y, wB.y) < 12) {
            wA0 = cBL; wB0 = cBR;
            wA = normal(wA0, upN, -1); wB = normal(wB0, upN, -1);
        }
        let hA0 = cTL, hB0 = cBL;
        let hA = normal(hA0, leftN, 1), hB = normal(hB0, leftN, 1);
        if (Math.min(hA.x, hB.x) < 12 || Math.max(hA.x, hB.x) > vw - 12) {
            hA0 = cTR; hB0 = cBR;
            hA = normal(hA0, leftN, -1); hB = normal(hB0, leftN, -1);
        }
        sizeLine(measureDimSeg(wA.x, wA.y, wB.x, wB.y));
        // 延伸线：把尺寸线端点接回物件角点，旋转后也能看清对应哪条边
        sizeExt(`M ${round2(wA0.x)} ${round2(wA0.y)} L ${round2(wA.x)} ${round2(wA.y)} M ${round2(wB0.x)} ${round2(wB0.y)} L ${round2(wB.x)} ${round2(wB.y)}`);
        const tW = rotated ? 0.28 : 0.5;
        const wTag = addTag('', d => {
            tagKey(d, 'W');
            tagVal(d, sizeW, v => measureApplySize('w', v), '宽度');
        }, round2(wA.x + (wB.x - wA.x) * tW), round2(wA.y + (wB.y - wA.y) * tW),
            { mode: 'center', title: '宽度：点击数值可直接修改（↑↓ 微调，Shift 加速）' });
        if (!locked && !(single && single.type === 'line')) {
            const lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'measure-lock' + (state.geoRatioLocked ? ' active' : '');
            lockBtn.title = state.geoRatioLocked ? '已锁定宽高比，点击解锁' : '锁定宽高比';
            lockBtn.setAttribute('aria-label', state.geoRatioLocked ? '解除宽高比锁定' : '锁定宽高比');
            lockBtn.appendChild(iconEl(state.geoRatioLocked ? 'link' : 'unlink'));
            lockBtn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
            lockBtn.addEventListener('click', ev => {
                ev.preventDefault(); ev.stopPropagation();
                toggleSelectionLock();
                drawMeasure();
            });
            wTag.appendChild(lockBtn);
        }

        sizeLine(measureDimSeg(hA.x, hA.y, hB.x, hB.y));
        sizeExt(`M ${round2(hA0.x)} ${round2(hA0.y)} L ${round2(hA.x)} ${round2(hA.y)} M ${round2(hB0.x)} ${round2(hB0.y)} L ${round2(hB.x)} ${round2(hB.y)}`);
        addTag('', d => {
            tagKey(d, 'H');
            if (single && single.type === 'line') {
                const s = measureText(d, String(Math.round(sizeH)));
                s.title = '线条显示高度由粗细决定，请在「线条样式」中调整粗细';
            } else tagVal(d, sizeH, v => measureApplySize('h', v), '高度');
        }, round2((hA.x + hB.x) / 2), round2((hA.y + hB.y) / 2),
            { mode: 'center', title: '高度：点击数值可直接修改（↑↓ 微调，Shift 加速）' });

        if (rotated && rot) {
            const rx = X(rot.x), ry = Y(rot.y);
            addTag('', d => {
                tagKey(d, '∠');
                if (locked) measureText(d, angle + '°');
                else {
                    measureNum(d, angle, v => { $<HTMLInputElement>('geoR').value = String(v); updateGeo('r'); }, '旋转角度');
                    measureText(d, '°');
                }
            }, rx, ry - 24, { mode: 'center', title: '旋转角度：点击数值可直接修改' });
        }
    }
    /* ---- 2. 相邻物件间距（近处才标注，避免远处长线干扰） ---- */
    if (state.settings.measureGap !== false) {
        const gaps = neighborGapsFor(box, measuredElements, state.selection)
            .filter(g => Math.abs(g.gap) * z <= MEASURE_LIMIT.gap)
            .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
        gaps.forEach(g => {
            gapLine(g.axis === 'h'
                ? measureDimH(X(g.x1), X(g.x2), Y(g.y))
                : measureDimV(X(g.x), Y(g.y1), Y(g.y2)));
            const ax = g.axis === 'h' ? (X(g.x1) + X(g.x2)) / 2 : X(g.x);
            const ay = g.axis === 'h' ? Y(g.y) : (Y(g.y1) + Y(g.y2)) / 2;
            const other = getEl(g.otherId);
            const nm = other ? other.name : '相邻物件';
            const title = `与「${nm}」的${GAP_SIDE_NAME[g.side]}侧间距` + (g.gap < 0 ? '（负值表示重叠）' : '') + '：点击数值可直接修改';
            addTag('gap', d => {
                tagKey(d, GAP_ARROW[g.side]);
                tagVal(d, g.gap, v => applyNeighborGap(g, v), title);
            }, round2(ax), round2(ay), { mode: 'above', title });
        });
    }

    /* ---- 3. 边缘对齐差（0 时显示绿色“对齐”徽标） ---- */
    if (state.settings.measureAlign !== false) {
        const aligns = alignmentMeasures(box, measuredElements, state.selection)
            .filter(a => Math.abs(a.delta) * z <= MEASURE_LIMIT.align);
        aligns.forEach(a => {
            const lenPx = (a.line.axis === 'h' ? Math.abs(X(a.line.x2) - X(a.line.x1)) : Math.abs(Y(a.line.y2) - Y(a.line.y1)));
            const aligned = Math.abs(a.delta) < 0.5;
            if (!aligned && lenPx > 6) {
                alignLine(a.line.axis === 'h'
                    ? measureDimH(X(a.line.x1), X(a.line.x2), Y(a.line.y), 3)
                    : measureDimV(X(a.line.x), Y(a.line.y1), Y(a.line.y2), 3));
            }
            const ax = a.line.axis === 'h' ? (X(a.line.x1) + X(a.line.x2)) / 2 : X(a.line.x);
            const ay = a.line.axis === 'h' ? Y(a.line.y) : (Y(a.line.y1) + Y(a.line.y2)) / 2;
            const other = getEl(a.otherId);
            const title = `与「${other ? other.name : ''}」${ALIGN_EDGE_NAME[a.edge]}对齐差` +
                (aligned ? '（已对齐）' : '（0=对齐，负=偏上/偏左）：点击数值可直接修改');
            addTag('adist' + (aligned ? ' aligned' : ''), d => {
                if (aligned) { tagKey(d, '✓'); measureText(d, '对齐'); }
                else { tagKey(d, 'Δ'); tagVal(d, a.delta, v => applyAlignDelta(a, v), title); }
            }, round2(ax), round2(ay), { mode: 'above', title });
        });
    }

    /* ---- 4. 与辅助线的垂直距离 ---- */
    if (state.settings.measureGuide !== false) {
        nearestGuidesToBox(box, 2).filter(({ m }) => m.dist * z <= MEASURE_LIMIT.guide).forEach(({ g, m }) => {
            guideLine(guideSegPath(m, g, z, state.pan));
            const ax = (X(m.from.x) + X(m.to.x)) / 2, ay = (Y(m.from.y) + Y(m.to.y)) / 2;
            addTag('gdist', d => {
                tagKey(d, '↔');
                tagVal(d, m.dist, v => applyObjectGuideDistance(g, v), '与辅助线的垂直距离');
            }, round2(ax), round2(ay), { mode: 'above', title: '与辅助线的垂直距离：点击数值可直接修改' });
        });
    }

    /* ---- 5. 画布边距（远距离用短引线，避免横穿整幅画布） ---- */
    if (state.settings.measureCanvas !== false && single) {
        const moveBy = (dx: number, dy: number) => moveSelected(round2(dx), round2(dy));
        const spec = [
            { k: '左', v: box.left, dir: 'left', label: '左边距',
              apply: (v: number) => moveBy(v - selectionAABB()!.left, 0) },
            { k: '右', v: cw - box.right, dir: 'right', label: '右边距',
              apply: (v: number) => moveBy((cw - v) - selectionAABB()!.right, 0) },
            { k: '上', v: box.top, dir: 'top', label: '上边距',
              apply: (v: number) => moveBy(0, v - selectionAABB()!.top) },
            { k: '下', v: ch - box.bottom, dir: 'bottom', label: '下边距',
              apply: (v: number) => moveBy(0, (ch - v) - selectionAABB()!.bottom) }
        ].filter(m => m.v > 0.4);
        const nearest = spec.slice().sort((a, b) => a.v - b.v).slice(0, 2);
        spec.forEach(m => {
            const near = m.v * z <= MEASURE_LIMIT.margin;
            if (!near && nearest.indexOf(m) < 0) return;
            const len = near ? m.v : Math.min(56 / z, m.v * 0.85);
            let p1: Point, p2: Point;
            if (m.dir === 'left') { p1 = { x: box.left - len, y: box.cy }; p2 = { x: box.left, y: box.cy }; }
            else if (m.dir === 'right') { p1 = { x: box.right, y: box.cy }; p2 = { x: box.right + len, y: box.cy }; }
            else if (m.dir === 'top') { p1 = { x: box.cx, y: box.top - len }; p2 = { x: box.cx, y: box.top }; }
            else { p1 = { x: box.cx, y: box.bottom }; p2 = { x: box.cx, y: box.bottom + len }; }
            const x1 = X(p1.x), x2 = X(p2.x), y1 = Y(p1.y), y2 = Y(p2.y);
            if (m.dir === 'left' || m.dir === 'right') marginLine(measureDimH(x1, x2, y1, 3));
            else marginLine(measureDimV(x1, y1, y2, 3));
            addTag('margin', d => {
                tagKey(d, m.k);
                tagVal(d, m.v, m.apply, m.label);
            }, round2((x1 + x2) / 2), round2((y1 + y2) / 2),
                { mode: 'above', title: m.label + '（到画布边缘）：点击数值可直接修改' });
        });
    }

    // 统一排版：尺寸标签优先占位，其余标签依次避让；变换模式下数值一律避开四角旋转标识
    const seeds: SeedRect[] = rotateMarkSeedRects();
    if (state.settings.measureSize !== false && rotated && rot) {
        const rx = X(rot.x), ry = Y(rot.y);
        seeds.push({ l: rx - 9, r: rx + 9, t: ry - 9, b: ry + 9 });
    }
    layoutMeasureTags(pending, seeds);
    // 标签完成避让后再校正浮动工具条，确保不压住刚生成的可编辑数值
    requestAnimationFrame(syncSelectionTools);
}

setSelectionToolsMeasureRefresh(drawMeasure);

/** 选中辅助线：显示法向两侧最近物件的距离，编辑时移动辅助线本身 */
function drawGuideSelectionMeasure(layer: HTMLElement, g: Guide): void {
    const near = nearestObjectsToGuide(g);
    if (!near.length) return;
    const z = state.zoom || 1;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'measure-lines guide-lines');
    svg.setAttribute('aria-hidden', 'true');
    near.forEach(({ m }) => {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', guideSegPath(m, g, z, state.pan));
        svg.appendChild(p);
    });
    layer.appendChild(svg);
    const seeds: SeedRect[] = [];
    const ctrl = $opt('guideCtrl');
    if (ctrl) {
        const vr = $('viewport').getBoundingClientRect();
        const cr = ctrl.getBoundingClientRect();
        seeds.push({ l: cr.left - vr.left, r: cr.right - vr.left, t: cr.top - vr.top, b: cr.bottom - vr.top });
    }
    const pending: MeasureTag[] = [];
    near.forEach(({ o, m }) => {
        if (state.isolating && !state.selection.includes(o.id)) return;
        const label = '辅助线与「' + o.name + '」的距离';
        const d = document.createElement('div');
        d.className = 'measure-tag gdist';
        const k = document.createElement('span');
        k.className = 'measure-key';
        k.textContent = '↔';
        d.appendChild(k);
        measureNum(d, Math.round(m.dist), v => applyGuideDistance(g, v, o.id), label);
        d.title = label + '：点击数值可直接修改';
        layer.appendChild(d);
        pending.push({
            d,
            cx: ((m.from.x + m.to.x) / 2) * z + state.pan.x,
            cy: ((m.from.y + m.to.y) / 2) * z + state.pan.y,
            mode: 'above'
        });
    });
    layoutMeasureTags(pending, seeds);
    requestAnimationFrame(syncSelectionTools);
}