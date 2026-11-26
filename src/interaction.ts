/* 交互（Pointer Events + rAF）：拖拽 / 缩放 / 旋转 / 枢轴 / 曲线节点 / 钢笔 */
import { SVG_NS, LINE_STYLES } from './constants';
import type { CanvasElement, CurveNode, Point, Interaction, LineStyle, StrokeStyle, HandleSide, PenDraft, SnapPoint } from './types';
import { state, nodeMap } from './state';
import { $, clamp, round2, round3, toast } from './utils';
import { getEl, selectedEls, sortedElements, buildElement, makeLine, makeCurve, curveSegPts, cubicAt, splitCubic, curveNodeHasIn, curveNodeHasOut, curveLocalBox, curveNodesBox, curveFillOn } from './model';
import { lineHeightFor } from './style';
import { syncElement, syncElementTransform, syncElementsTransform, renderAll, applySelectionClasses, syncTransform } from './render';
import { commit } from './history';
import { viewportRect, setZoom, showFitFloat } from './view';
import { getAABB, pivotWorld, selectionAABB, setPivot, elementLocalToWorld, elementWorldToLocal } from './geometry';
import { setSelection, deselectAll, toggleSelection, setTransformMode } from './selection';
import { updateUI, updatePropPanel, syncCurveFillControls } from './panel';
import { saveSettings } from './db';
import { startTextEdit, finishTextEdit } from './richtext';
import { resetPivot } from './elements';
import { endRelLayer, handleLayerPick } from './layers';
import { openCropModal } from './cropper';
import { bucketHitElement, bucketDetectTarget, applyBucketColor, bucketColor, setBucketColor, bucketSlotLabel, updateBucketHover, elementSlotColor } from './bucket';
import { useColor } from './swatches';
import { setTool, refreshStudioUI } from './tools';
import { handleStylePickPointerDown, confirmStyleCommand } from './selectiontools';
import { setToggleButton } from './theme';
import { selectGuide, drawGuides, isOverRuler, deleteGuide, guideGeom } from './guides';
import { drawMeasure } from './measure';
import { applyDragSnap, drawSnapGuides, clearSnapGuides, drawAnchorCandidates, clearAnchorCandidates } from './snap';
import { nearestSnapPoint, elementSnapPoints, curveNodeSnapPoint, SNAP_POINT_PX } from './snappoints';
import { updateLineStyle } from './styles';

type RotateInteraction = Extract<Interaction, { kind: 'rotate' }>;

let rafPending = false;
let pendingPointer: PointerEvent | null = null;

export function clientToWorld(clientX: number, clientY: number): Point {
    const vr = viewportRect();
    return {
        x: (clientX - vr.left - state.pan.x) / state.zoom,
        y: (clientY - vr.top - state.pan.y) / state.zoom
    };
}
/** 世界坐标 → 元素未旋转局部坐标（含自定义枢轴与倾斜补偿） */
export function worldToLocalPoint(el: CanvasElement, world: Point): Point {
    return elementWorldToLocal(el, world);
}
/** 缩放手柄对应的世界坐标（角点或边中点，旋转、倾斜与自定义枢轴均适用） */
function resizerAnchorWorld(el: CanvasElement, dir: string): SnapPoint {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const fx = dir.includes('w') ? 0 : dir.includes('e') ? 1 : 0.5;
    const fy = dir.includes('n') ? 0 : dir.includes('s') ? 1 : 0.5;
    const corner = dir.length > 1;
    const p = elementLocalToWorld(el, fx * el.w, fy * h);
    return {
        x: p.x,
        y: p.y,
        kind: corner ? 'endpoint' : 'midpoint',
        label: corner ? '角点' : '边中点',
        elementId: el.id
    };
}
/** 局部像素坐标 → 曲线比例坐标 */
export function curveNorm(el: CanvasElement, loc: Point): Point {
    return {
        x: clamp(round3(loc.x / Math.max(1, el.w)), -3, 4),
        y: clamp(round3(loc.y / Math.max(1, el.h)), -3, 4)
    };
}

const ANCHOR_HOVER_PX = 16, ANCHOR_GRAB_PX = 16;

function clearAnchorHover(): void {
    clearAnchorCandidates();
    $('viewport').classList.remove('anchor-hot');
}

/** 仅在实际拖拽/缩放/旋转时切换光标，悬停不改变手势 */
function setInteractionCursor(cursor: string | null): void {
    const vp = $('viewport');
    if (cursor) {
        vp.style.setProperty('--interaction-cursor', cursor);
        vp.classList.add('interaction-cursor');
    } else {
        vp.classList.remove('interaction-cursor');
        vp.style.removeProperty('--interaction-cursor');
    }
}
function markInteracting(ids: string[]): void {
    ids.forEach(id => nodeMap.get(id)?.classList.add('interacting'));
}
function resizeCursor(dir: string): string {
    if (dir === 'n' || dir === 's') return 'ns-resize';
    if (dir === 'e' || dir === 'w') return 'ew-resize';
    return dir === 'ne' || dir === 'sw' ? 'nesw-resize' : 'nwse-resize';
}

function startRotateInteraction(e: PointerEvent, el: CanvasElement): void {
    if (!state.selection.includes(el.id)) setSelection([el.id]);
    const box = selectionAABB();
    if (!box) return;
    const items = selectedEls().filter(x => !x.locked);
    if (!items.length) return;
    // 单选围绕自身枢轴旋转；多选围绕选区中心旋转
    const center = items.length === 1 ? pivotWorld(items[0]) : { x: box.cx, y: box.cy };
    items.forEach(x => {
        const n = nodeMap.get(x.id);
        if (n) { n.classList.add('pivot-peek'); clearTimeout(n._peekTimer); }
    });
    const vr = viewportRect();
    state.interaction = {
        kind: 'rotate', box, center, single: items.length === 1,
        startAngle: Math.atan2(e.clientY - (vr.top + state.pan.y + center.y * state.zoom), e.clientX - (vr.left + state.pan.x + center.x * state.zoom)),
        items: items.map(x => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, rotation: x.rotation, pivotX: x.pivotX, pivotY: x.pivotY }))
    };
    markInteracting(state.selection);
    setInteractionCursor('crosshair');
    e.preventDefault();
}

function startSkewInteraction(e: PointerEvent, dir: 'n' | 's' | 'e' | 'w', el: CanvasElement): void {
    if (!state.selection.includes(el.id)) setSelection([el.id]);
    const box = selectionAABB();
    if (!box) return;
    const items = selectedEls().filter(x => !x.locked);
    if (!items.length) return;
    state.interaction = {
        kind: 'skew', dir, startX: e.clientX, startY: e.clientY, box,
        items: items.map(x => ({
            id: x.id, x: x.x, y: x.y, w: x.w, h: x.h,
            rotation: x.rotation, pivotX: x.pivotX, pivotY: x.pivotY,
            skewX: x.skewX || 0, skewY: x.skewY || 0
        }))
    };
    markInteracting(state.selection);
    setInteractionCursor(dir === 'n' || dir === 's' ? 'ew-resize' : 'ns-resize');
    e.preventDefault();
}

function updateAnchorHover(e: PointerEvent): void {
    if (state.tool !== 'select' || !(e.ctrlKey || e.metaKey) || !state.selection.length) {
        clearAnchorHover();
        return;
    }
    const target = e.target as HTMLElement | null;
    if (!target || isChromeUI(target)) { clearAnchorHover(); return; }
    const d = target.closest('.canvas-element');
    const el = d ? getEl(d.getAttribute('data-id') || '') : null;
    if (!el || el.locked || !state.selection.includes(el.id)) { clearAnchorHover(); return; }
    const pts = elementSnapPoints(el);
    const hot = nearestSnapPoint(clientToWorld(e.clientX, e.clientY), ANCHOR_HOVER_PX / state.zoom, new Set(), pts);
    drawAnchorCandidates(pts, hot);
    $('viewport').classList.toggle('anchor-hot', !!hot);
}

/** 以物件自身的角点 / 节点 / 中心 / 黄金分割等特征点为锚点拖动整个选区 */
function startAnchorDrag(e: PointerEvent, anchor: SnapPoint, pendingNodeClick?: { id: string; i: number }): boolean {
    const box = selectionAABB();
    if (!box) return false;
    const items = selectedEls().filter(x => !x.locked).map(x => ({ id: x.id, x: x.x, y: x.y }));
    if (!items.length) return false;
    if (pendingNodeClick) {
        state.nodeSel = { id: pendingNodeClick.id, i: pendingNodeClick.i };
        syncElement(pendingNodeClick.id);
    }
    state.interaction = {
        kind: 'drag', startX: e.clientX, startY: e.clientY, startBox: box, items, anchor,
        ...(pendingNodeClick ? { pendingNodeClick } : {})
    };
    clearAnchorHover();
    $('viewport').classList.add('anchor-drag');
    markInteracting(state.selection);
    e.preventDefault();
    return true;
}
/** 平滑节点：让两侧控制柄共线（保留各自长度） */
export function smoothNodeHandles(el: CanvasElement, i: number): void {
    const n = el.curve!.nodes[i];
    const hasIn = curveNodeHasIn(n), hasOut = curveNodeHasOut(n);
    if (hasOut && hasIn) {
        const lo = Math.hypot(n.ox - n.x, n.oy - n.y);
        const li = Math.hypot(n.ix - n.x, n.iy - n.y);
        if (lo < 1e-6) return;
        const ux = (n.ox - n.x) / lo, uy = (n.oy - n.y) / lo;
        n.ix = clamp(round3(n.x - ux * li), -3, 4);
        n.iy = clamp(round3(n.y - uy * li), -3, 4);
    } else if (hasOut) {
        n.ix = clamp(round3(n.x * 2 - n.ox), -3, 4);
        n.iy = clamp(round3(n.y * 2 - n.oy), -3, 4);
    } else if (hasIn) {
        n.ox = clamp(round3(n.x * 2 - n.ix), -3, 4);
        n.oy = clamp(round3(n.y * 2 - n.iy), -3, 4);
    }
}

function toggleCurveNodeType(el: CanvasElement, i: number): void {
    const n = el.curve?.nodes[i];
    if (!n) return;
    n.t = n.t === 'cusp' ? 'smooth' : 'cusp';
    if (n.t === 'smooth') smoothNodeHandles(el, i);
    state.nodeSel = { id: el.id, i };
    syncElement(el.id);
    updateCurveNodePanel(el);
}
/** 拖动一侧控制柄后，另一侧保持共线（平滑节点），保留其原长度 */
export function mirrorCurveHandle(n: CurveNode, moved: HandleSide): void {
    if (n.t === 'cusp') return;
    const lIn = Math.hypot(n.ix - n.x, n.iy - n.y);
    const lOut = Math.hypot(n.ox - n.x, n.oy - n.y);
    const vx = moved === 'out' ? n.ox - n.x : n.ix - n.x;
    const vy = moved === 'out' ? n.oy - n.y : n.iy - n.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return;
    const target = (moved === 'out' ? lIn : lOut) > 1e-6 ? (moved === 'out' ? lIn : lOut) : len;
    const ux = -vx / len, uy = -vy / len;
    if (moved === 'out') {
        n.ix = clamp(round3(n.x + ux * target), -3, 4);
        n.iy = clamp(round3(n.y + uy * target), -3, 4);
    } else {
        n.ox = clamp(round3(n.x + ux * target), -3, 4);
        n.oy = clamp(round3(n.y + uy * target), -3, 4);
    }
}
function showSizeTooltip(x: number, y: number, w: number, h: number): void {
    const t = $('sizeTooltip');
    t.style.display = 'block';
    t.style.left = (x + 15) + 'px'; t.style.top = (y + 15) + 'px';
    t.textContent = `W:${w} H:${h}`;
}
function showAngleTooltip(x: number, y: number, deg: number): void {
    const t = $('sizeTooltip');
    t.style.display = 'block';
    t.style.left = (x + 15) + 'px'; t.style.top = (y + 15) + 'px';
    const norm = ((Math.round(deg) % 360) + 360) % 360;
    t.textContent = `∠ ${norm}°`;
}
function showSkewTooltip(x: number, y: number, axis: 'X' | 'Y', deg: number): void {
    const t = $('sizeTooltip');
    t.style.display = 'block';
    t.style.left = (x + 15) + 'px'; t.style.top = (y + 15) + 'px';
    t.textContent = `倾斜 ${axis} ${deg >= 0 ? '+' : ''}${Math.round(deg)}°`;
}
function hideSizeTooltip(): void { $('sizeTooltip').style.display = 'none'; }
/** 旋转时在视口上绘制：枢轴→指针参考线 + 角度弧 + 度数标签（屏幕坐标） */
function drawRotateGuide(it: RotateInteraction, clientX: number, clientY: number, delta: number, shown?: number): void {
    const layer = $('guidesLayer');
    if (!layer) return;
    layer.textContent = '';
    const vr = viewportRect();
    const px = state.pan.x + it.center.x * state.zoom;
    const py = state.pan.y + it.center.y * state.zoom;
    const mx = clientX - vr.left, my = clientY - vr.top;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rotate-guide');
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(px)); line.setAttribute('y1', String(py));
    line.setAttribute('x2', String(mx)); line.setAttribute('y2', String(my));
    svg.appendChild(line);
    const r = 34;
    const a0 = it.startAngle, a1 = a0 + delta * Math.PI / 180;
    const large = Math.abs(delta) > 180 ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', `M ${px + r * Math.cos(a0)} ${py + r * Math.sin(a0)} A ${r} ${r} 0 ${large} ${sweep} ${px + r * Math.cos(a1)} ${py + r * Math.sin(a1)}`);
    svg.appendChild(arc);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(px)); dot.setAttribute('cy', String(py)); dot.setAttribute('r', '4');
    svg.appendChild(dot);
    const label = document.createElementNS(SVG_NS, 'text');
    const norm = ((Math.round(shown === undefined ? delta : shown) % 360) + 360) % 360;
    label.setAttribute('x', String(px + 10)); label.setAttribute('y', String(py - 10));
    label.textContent = norm + '°';
    svg.appendChild(label);
    layer.appendChild(svg);
}

/** 鼠标右键：确认并结算当前命令 */
function confirmCurrentCommand(): boolean {
    if (confirmStyleCommand()) return true;
    if (state.pen) { finishPen(false); return true; }
    if (state.isTextEditing) { finishTextEdit(); commit(); return true; }
    if (state.layerPick) { endRelLayer(); return true; }
    if (state.interaction && state.interaction.kind !== 'crop') {
        endInteraction();
        return true;
    }
    return false;
}

export function initCanvasInteraction(): void {
    const viewport = $('viewport');
    viewport.addEventListener('wheel', e => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
        const factor = Math.exp(-e.deltaY * unit * 0.0012);
        setZoom(state.zoom * factor, e.clientX, e.clientY);
        showFitFloat(e.clientX, e.clientY);
    }, { passive: false });
    // 阻止中键触发浏览器自动滚动
    viewport.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('contextmenu', e => {
        const t = e.target as HTMLElement;
        if (!state.isTextEditing && t.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (confirmCurrentCommand()) e.preventDefault();
    });
    const syncAnchorCursor = (e: KeyboardEvent): void => {
        const on = !!e.ctrlKey || !!e.metaKey;
        viewport.classList.toggle('anchor-ready', on);
        if (!on) clearAnchorHover();
    };
    document.addEventListener('keydown', syncAnchorCursor);
    document.addEventListener('keyup', syncAnchorCursor);
    window.addEventListener('blur', () => { viewport.classList.remove('anchor-ready'); clearAnchorHover(); });
    // 从标尺拖出辅助线：上标尺→水平线，左标尺→垂直线；拖回标尺放弃/删除
    ([['rulerH', 0], ['rulerV', 90]] as [string, number][]).forEach(([id, angle]) => {
        $(id).addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (state.settings.guideLines === false) {
                state.settings.guideLines = true;
                saveSettings();
                setToggleButton('btnGuideLines', true);
            }
            const world = clientToWorld(e.clientX, e.clientY);
            const g = {
                id: 'gd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                angle, x: round2(world.x), y: round2(world.y)
            };
            state.model.guides.push(g);
            selectGuide(g.id);
            state.interaction = { kind: 'guidemove', id: g.id, start: world, ox: g.x, oy: g.y, deleteHint: false };
            drawGuides(); drawMeasure();
            if (!state.guideTipShown) {
                state.guideTipShown = true;
                toast('辅助线：拖动移动；双击或选中后输入角度旋转；拖回标尺或按 Delete 删除', 'success');
            }
        });
    });
    window.addEventListener('dblclick', e => {
        const t = e.target as HTMLElement;
        if (state.tool === 'bucket') { e.preventDefault(); return; }
        if (state.tool === 'pen' && state.pen) { finishPen(false); e.preventDefault(); return; }
        const gn = t.closest && t.closest('.guide-line');
        if (gn) {
            selectGuide(gn.getAttribute('data-id') || '');
            const inp = document.querySelector<HTMLInputElement>('#guideCtrl .gc-angle');
            if (inp) { inp.focus(); inp.select(); }
            e.preventDefault();
            return;
        }
        if (t.closest && t.closest('.pivot-handle')) {
            const d = t.closest('.canvas-element');
            const el = d && getEl(d.getAttribute('data-id') || '');
            if (el && !el.locked) {
                if (el.type === 'text') startTextEdit(el);
                else resetPivot();
                e.preventDefault();
            }
            return;
        }
        const d = t.closest && t.closest('.canvas-element');
        if (!d) return;
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el) return;
        if (el.type === 'curve' && !el.locked && handleCurveDoubleTap(el, e)) { e.preventDefault(); return; }
        handleDoubleTap(el);
    });
    window.addEventListener('pointermove', e => {
        pendingPointer = e;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; onPointerMove(pendingPointer); });
    });
    window.addEventListener('pointerup', endInteraction);
    window.addEventListener('pointercancel', endInteraction);
    window.addEventListener('blur', () => { state.spaceDown = false; endInteraction(); });
}

function handleDoubleTap(el: CanvasElement): void {
    if (el.locked) return;
    if (state.transformMode) setTransformMode(false);
    if (el.type === 'text') startTextEdit(el);
    else if (el.type === 'curve') {
        if (state.selection.length !== 1) setSelection([el.id]);
        toast('双击线段插入节点，双击节点删除；右侧「节点编辑」可闭合/断开、平滑/尖角', 'success');
    }
    else if (el.type === 'line') toast('在右侧「线条样式」中切换实线 / 虚线 / 点线 / 波浪', 'success');
    else openCropModal(el.id);
}
/** 曲线双击：线段上加点，节点上删点 */
function handleCurveDoubleTap(el: CanvasElement, e: MouseEvent): boolean {
    const t = e.target as HTMLElement;
    const nodeDiv = t.closest && t.closest('.curve-node');
    if (nodeDiv) {
        const i = Number(nodeDiv.getAttribute('data-i'));
        if (state.selection.length !== 1) setSelection([el.id]);
        removeCurveNode(el, i);
        return true;
    }
    const loc = worldToLocalPoint(el, clientToWorld(e.clientX, e.clientY));
    const hit = curveSegHit(el, loc, 9 / state.zoom);
    if (hit) {
        if (state.selection.length !== 1) setSelection([el.id]);
        insertCurveNode(el, hit.a, hit.b, hit.t);
        return true;
    }
    return false;
}
function isChromeUI(target: HTMLElement): boolean {
    return !!(target.closest && (target.closest('.topbar') || target.closest('.contextbar') ||
        target.closest('.tool-rail') || target.closest('.inspector') || target.closest('.statusbar') ||
        target.closest('.modal') || target.closest('.toast') || target.closest('.ruler') ||
        target.closest('.measure-tag') || target.closest('.guide-ctrl') ||
        target.closest('.selection-tools') || target.closest('.style-brush-menu') ||
        target.closest('.shape-convert-menu') || target.closest('.fit-float')));
}
/** 物件在点击位置是否有可见主体；无填充的图形只保留描边命中区，内部可穿透到下层 */
function elementHasBody(el: CanvasElement): boolean {
    if (el.type === 'line' || el.type === 'text') return true;
    if (el.type === 'curve') return curveFillOn(el);
    if (el.image || el.maskAssetId) return true;
    return el.fill.enabled && (el.fill.alpha === undefined || el.fill.alpha > 0.001);
}
/** 从当前点击的透明物件向下寻找第一个有可见主体的物件 */
function elementBelowAt(d: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
    if (typeof document.elementsFromPoint !== 'function') return null;
    let passedSelf = false;
    for (const n of document.elementsFromPoint(clientX, clientY)) {
        const c = n.closest<HTMLElement>('.canvas-element');
        if (!c) continue;
        if (c === d) { passedSelf = true; continue; }
        if (!passedSelf) continue;
        const el = getEl(c.dataset.id || '');
        if (!el || !el.visible || !elementHasBody(el)) continue;
        return c;
    }
    return null;
}
function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch' && (state.pinch || state.touchPoints.size >= 2)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
    }
    const target = e.target as HTMLElement;
    // 中键拖动平移：不改变选择与当前工具
    if (e.button === 1) {
        if (!target.closest('#viewport') || state.interaction) return;
        state.interaction = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
        $('viewport').classList.add('panning');
        e.preventDefault();
        return;
    }
    if (e.button !== 0) return;
    clearAnchorHover();
    // 变换模式四角 ↻ 标识位于 HUD 顶层、不属于任何 .canvas-element，需优先接管旋转
    const rotateMark = target.closest<HTMLElement>('.rotate-mark');
    if (rotateMark) {
        const el = getEl(rotateMark.dataset.id || '') || selectedEls()[0];
        if (el && !el.locked && state.transformMode && state.tool === 'select') {
            rotateMark.classList.add('dragging');
            startRotateInteraction(e, el);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }
    // 颜料桶下尺寸标注浮层不拦截点击，交由 bucketHitElement 穿透到下方元素
    const bucketMeasure = state.tool === 'bucket' && target.closest && target.closest('.measure-tag');
    if (!bucketMeasure && isChromeUI(target)) return;   // 点击面板不退出编辑态

    const guideNode = target.closest('.guide-line');
    if (guideNode) {
        const g = (state.model.guides || []).find(x => x.id === guideNode.getAttribute('data-id'));
        if (!g) return;
        selectGuide(g.id);
        const world = clientToWorld(e.clientX, e.clientY);
        state.interaction = { kind: 'guidemove', id: g.id, start: world, ox: g.x, oy: g.y, deleteHint: false };
        e.preventDefault(); return;
    }

    if (!target.closest('.canvas-element') && state.isTextEditing) finishTextEdit();

    if (state.layerPick) {
        const d = target.closest('.canvas-element');
        if (d) { handleLayerPick(d.getAttribute('data-id') || ''); e.stopPropagation(); return; }
        endRelLayer(); return;
    }
    if (state.spaceDown || state.tool === 'pan') {
        state.interaction = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
        $('viewport').classList.add('panning');
        e.preventDefault(); return;
    }
    if (state.stylePickSource && state.tool === 'select') {
        if (handleStylePickPointerDown(e)) return;
    }
    if (state.tool === 'bucket') {
        if (state.isTextEditing) finishTextEdit();
        const hit = bucketHitElement(e.clientX, e.clientY, e.target as HTMLElement);
        const slot = bucketDetectTarget(hit, e.clientX, e.clientY, e);
        if (e.altKey) {
            if (hit) {
                const c = elementSlotColor(hit, slot);
                useColor(c);
                setBucketColor(slot, c);
                toast(c === 'none'
                    ? '已吸取' + bucketSlotLabel(slot) + '状态：无' + bucketSlotLabel(slot)
                    : '已吸取' + bucketSlotLabel(slot) + '色 ' + c.toUpperCase(), 'success');
            }
            e.preventDefault(); return;
        }
        const painted = new Set<string>();
        if (hit && applyBucketColor(hit, slot, bucketColor(slot))) {
            painted.add(hit.id);
            setSelection([hit.id]);
        }
        state.interaction = { kind: 'bucketpaint', painted };
        e.preventDefault(); return;
    }
    if (state.tool === 'pen') {
        if (state.isTextEditing) finishTextEdit();
        penPointerDown(e);
        e.preventDefault(); return;
    }
    if (state.tool === 'text') {
        const td = target.closest('.canvas-element');
        if (td) {
            const tel = getEl(td.getAttribute('data-id') || '');
            if (tel && tel.type === 'text' && !tel.locked) {
                setSelection([tel.id]); setTool('select'); startTextEdit(tel);
                e.preventDefault(); return;
            }
        } else if (target === $('canvas') || target === $('viewport') || target === $('transformLayer')) {
            const world = clientToWorld(e.clientX, e.clientY);
            state.interaction = { kind: 'textcreate', start: world, current: world };
            const box = $('selectionBox');
            box.style.display = 'block';
            box.style.left = world.x + 'px'; box.style.top = world.y + 'px';
            box.style.width = '0px'; box.style.height = '0px';
            e.preventDefault(); return;
        }
    }

    const resizer = target.closest('.resizer');
    const rotator = target.closest('.rotator');
    const pivotH = target.closest('.pivot-handle');
    const ctrlH = target.closest('.curve-ctrl');
    const nodeH = target.closest('.curve-node');
    let d = target.closest<HTMLElement>('.canvas-element');
    if (d && state.tool === 'select' && target === d) {
        const hitEl = getEl(d.getAttribute('data-id') || '');
        if (hitEl && !elementHasBody(hitEl)) {
            const below = elementBelowAt(d, e.clientX, e.clientY);
            if (below) d = below;
        }
    }

    if (pivotH && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el || el.locked) return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const h = el.type === 'line' ? lineHeightFor(el) : el.h;
        state.interaction = {
            kind: 'pivot', id: el.id, w: el.w, h,
            x: el.x, y: el.y, fx: el.pivotX, fy: el.pivotY, rotation: el.rotation
        };
        pivotH.classList.add('dragging');
        d.classList.add('pivot-peek');
        clearTimeout((d as HTMLDivElement)._peekTimer);
        markInteracting([el.id]);
        setInteractionCursor('grabbing');
        e.preventDefault(); return;
    }
    if (ctrlH && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el || el.locked || el.type !== 'curve') return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const i = Number(ctrlH.getAttribute('data-i'));
        const h = (ctrlH.getAttribute('data-h') || 'out') as HandleSide;
        state.nodeSel = { id: el.id, i };
        state.interaction = { kind: 'cctrl', id: el.id, i, h };
        ctrlH.classList.add('dragging');
        markInteracting([el.id]);
        setInteractionCursor('grabbing');
        syncElement(el.id);
        e.preventDefault(); return;
    }
    if (nodeH && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el || el.locked || el.type !== 'curve') return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const i = Number(nodeH.getAttribute('data-i'));
        const n = el.curve!.nodes[i];
        if (!n) return;
        if (e.ctrlKey || e.metaKey) {
            if (state.selection.includes(el.id)) {
                const anchor = curveNodeSnapPoint(el, i);
                if (anchor && startAnchorDrag(e, anchor, { id: el.id, i })) return;
            }
            toggleCurveNodeType(el, i);
            commit();
            e.preventDefault(); return;
        }
        state.nodeSel = { id: el.id, i };
        state.interaction = {
            kind: 'cnode', id: el.id, i,
            start: clientToWorld(e.clientX, e.clientY),
            ox: n.x, oy: n.y
        };
        nodeH.classList.add('dragging');
        markInteracting([el.id]);
        setInteractionCursor('grabbing');
        syncElement(el.id);
        e.preventDefault(); return;
    }
    if (resizer && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el || el.locked) return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const dir = resizer.getAttribute('data-dir') || '';
        // 变换模式：四角拖拽旋转，四边中点拖拽倾斜
        if (state.transformMode && !(e.ctrlKey || e.metaKey)) {
            if (dir.length === 2) { startRotateInteraction(e, el); return; }
            if (dir === 'n' || dir === 's' || dir === 'e' || dir === 'w') {
                startSkewInteraction(e, dir, el);
                return;
            }
        }
        const box = selectionAABB();
        if (!box) return;
        if (e.ctrlKey || e.metaKey) {
            if (startAnchorDrag(e, resizerAnchorWorld(el, dir))) return;
        }
        state.interaction = {
            kind: 'resize', dir, startX: e.clientX, startY: e.clientY,
            box, items: selectedEls().filter(x => !x.locked).map(x => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h }))
        };
        markInteracting(state.selection);
        setInteractionCursor(resizeCursor(dir));
        e.preventDefault(); return;
    }
    if (rotator && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (!el || el.locked) return;
        startRotateInteraction(e, el);
        return;
    }
    if ((e.ctrlKey || e.metaKey) && d) {
        const el = getEl(d.getAttribute('data-id') || '');
        if (el && !el.locked && state.selection.includes(el.id)) {
            const anchor = nearestSnapPoint(clientToWorld(e.clientX, e.clientY), ANCHOR_GRAB_PX / state.zoom, new Set(), elementSnapPoints(el));
            if (anchor && startAnchorDrag(e, anchor)) return;
        }
    }
    if (d) {
        const id = d.getAttribute('data-id') || '';
        if (state.isTextEditing && state.editingId === id) return;
        if (state.isTextEditing) finishTextEdit();
        if (e.altKey && !state.selection.includes(id)) { e.preventDefault(); return; }
        let secondClick = false;
        if (!e.altKey) {
            const additive = e.ctrlKey || e.metaKey;
            const wasSelected = state.selection.includes(id);
            // 已选中的成员保持整组 / 多选不动，便于直接拖动；单击但不拖动才进入变换模式
            if (additive || !wasSelected) toggleSelection(id, additive);
            secondClick = !additive && wasSelected && e.detail < 2 && state.tool === 'select';
        }
        const movable = selectedEls().filter(x => !x.locked);
        if (movable.length) {
            state.interaction = {
                kind: 'drag', startX: e.clientX, startY: e.clientY, startBox: selectionAABB(), secondClick,
                items: movable.map(x => ({ id: x.id, x: x.x, y: x.y }))
            };
            markInteracting(state.selection);
            setInteractionCursor('grabbing');
        }
        e.preventDefault(); return;
    }

    // 空白处：框选
    if (target === $('canvas') || target === $('viewport') || target === $('transformLayer') || target.id === 'selectionBox') {
        const world = clientToWorld(e.clientX, e.clientY);
        state.boxCache = sortedElements().map(el => ({ id: el.id, a: getAABB(el) }));
        state.interaction = {
            kind: 'box', start: world, additive: e.ctrlKey || e.metaKey, subtractive: e.altKey,
            initial: state.selection.slice(), current: world
        };
        if (!state.interaction.additive && !state.interaction.subtractive) deselectAll();
        const box = $('selectionBox');
        box.style.display = 'block';
        box.style.left = world.x + 'px'; box.style.top = world.y + 'px';
        box.style.width = '0px'; box.style.height = '0px';
        e.preventDefault();
    }
}
function onPointerMove(e: PointerEvent | null): void {
    if (!e || (e.pointerType === 'touch' && (state.pinch || state.touchPoints.size >= 2))) return;
    const it = state.interaction;
    if (!it) {
        if (state.tool === 'bucket') { clearAnchorHover(); updateBucketHover(e); return; }
        if (state.tool === 'pen') {
            clearAnchorHover();
            // 落点前也预览捕捉特征点；指针进入面板时收起，避免标记停留在画布上
            if (isChromeUI(e.target as HTMLElement)) { clearSnapGuides(); return; }
            const w = penPointFromEvent(e);
            const pen = state.pen;
            if (pen) {
                const last = pen.nodes[pen.nodes.length - 1];
                if (last && (Math.abs(w.x - pen.cursor.x) > 0.2 || Math.abs(w.y - pen.cursor.y) > 0.2)) {
                    pen.cursor = w;
                    renderPenDraft();
                }
            }
            return;
        }
        if (state.tool === 'select' && (e.ctrlKey || e.metaKey)) updateAnchorHover(e);
        else clearAnchorHover();
        return;
    }
    if (it.kind === 'pan') {
        state.pan.x += e.clientX - it.lastX;
        state.pan.y += e.clientY - it.lastY;
        it.lastX = e.clientX; it.lastY = e.clientY;
        syncTransform();
        showFitFloat(e.clientX, e.clientY);
        return;
    }
    if (it.kind === 'textcreate') {
        const cur = clientToWorld(e.clientX, e.clientY);
        it.current = cur;
        const box = $('selectionBox');
        box.style.left = Math.min(it.start.x, cur.x) + 'px';
        box.style.top = Math.min(it.start.y, cur.y) + 'px';
        box.style.width = Math.abs(cur.x - it.start.x) + 'px';
        box.style.height = Math.abs(cur.y - it.start.y) + 'px';
        return;
    }
    if (it.kind === 'box') {
        const cur = clientToWorld(e.clientX, e.clientY);
        it.current = cur;
        const left = Math.min(it.start.x, cur.x), top = Math.min(it.start.y, cur.y);
        const w = Math.abs(cur.x - it.start.x), h = Math.abs(cur.y - it.start.y);
        const box = $('selectionBox');
        box.style.left = left + 'px'; box.style.top = top + 'px';
        box.style.width = w + 'px'; box.style.height = h + 'px';
        const rect = { left, top, right: left + w, bottom: top + h };
        // 左→右：完全落在框内才选中；右→左：接触即选中
        const containOnly = cur.x >= it.start.x;
        let ids = it.initial.slice();
        (state.boxCache || []).forEach(o => {
            const a = o.a;
            const hit = containOnly
                ? (a.left >= rect.left && a.right <= rect.right && a.top >= rect.top && a.bottom <= rect.bottom)
                : !(rect.right < a.left || rect.left > a.right || rect.bottom < a.top || rect.top > a.bottom);
            if (!hit) return;
            if (it.subtractive) ids = ids.filter(id => id !== o.id);
            else if (!ids.includes(o.id)) ids.push(o.id);
        });
        state.selection = ids;
        applySelectionClasses();
        $('selCountBadge').textContent = String(ids.length);
        return;
    }
    if (it.kind === 'bucketpaint') {
        const el = bucketHitElement(e.clientX, e.clientY);
        if (el && !it.painted.has(el.id)) {
            const t = bucketDetectTarget(el, e.clientX, e.clientY, e);
            if (applyBucketColor(el, t, bucketColor(t))) it.painted.add(el.id);
        }
        updateBucketHover(e);
        return;
    }
    if (it.kind === 'pendrag') {
        penDragMove(e);
        return;
    }
    if (it.kind === 'guidemove') {
        const g = (state.model.guides || []).find(x => x.id === it.id);
        if (!g) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const { n } = guideGeom(g);
        const d = n.x * (world.x - it.start.x) + n.y * (world.y - it.start.y);
        g.x = round2(it.ox + n.x * d);
        g.y = round2(it.oy + n.y * d);
        it.deleteHint = isOverRuler(e.clientX, e.clientY);
        drawGuides();
        drawMeasure();
        return;
    }
    if (it.kind === 'drag') {
        if (it.pendingNodeClick) {
            if (Math.hypot(e.clientX - it.startX, e.clientY - it.startY) < 4) return;
            delete it.pendingNodeClick;
        }
        const dx = (e.clientX - it.startX) / state.zoom;
        const dy = (e.clientY - it.startY) / state.zoom;
        let mx = dx, my = dy;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; }
        // 智能吸附（画布中心/边缘 + 其他元素边缘/中心）
        if (!e.altKey) {
            const snapped = applyDragSnap(it, mx, my);
            mx = snapped.mx; my = snapped.my;
            drawSnapGuides(snapped.guides, snapped.point, snapped.anchor);
        } else if (it.anchor) {
            drawSnapGuides(null, null, { ...it.anchor, x: it.anchor.x + mx, y: it.anchor.y + my });
        } else {
            clearSnapGuides();
        }
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            el.x = round2(o.x + mx); el.y = round2(o.y + my);
        });
        syncElementsTransform(it.items.map(o => o.id));
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        drawMeasure();
        return;
    }
    if (it.kind === 'resize') {
        const dx = (e.clientX - it.startX) / state.zoom;
        const dy = (e.clientY - it.startY) / state.zoom;
        const b = it.box;
        let left = b.left, top = b.top, right = b.right, bottom = b.bottom;
        if (it.dir.includes('w')) left += dx;
        if (it.dir.includes('e')) right += dx;
        if (it.dir.includes('n')) top += dy;
        if (it.dir.includes('s')) bottom += dy;
        if (right - left < 8) { if (it.dir.includes('w')) left = right - 8; else right = left + 8; }
        if (bottom - top < 8) { if (it.dir.includes('n')) top = bottom - 8; else bottom = top + 8; }
        let sx = (right - left) / Math.max(1, b.w), sy = (bottom - top) / Math.max(1, b.h);
        const ratioLocked = state.geoRatioLocked;
        if (ratioLocked) {
            // 锁定比例：角手柄取主方向统一缩放；边手柄以另一轴居中对齐
            const hasX = it.dir.includes('w') || it.dir.includes('e');
            const hasY = it.dir.includes('n') || it.dir.includes('s');
            const s = hasX && hasY ? Math.max(sx, sy) : hasX ? sx : sy;
            sx = s; sy = s;
        } else if (e.shiftKey) {
            const s = Math.max(sx, sy); sx = s; sy = s;
        }
        const ax = ratioLocked
            ? (it.dir.includes('w') ? b.right : it.dir.includes('e') ? b.left : (b.left + b.right) / 2)
            : (it.dir.includes('w') ? b.right : b.left);
        const ay = ratioLocked
            ? (it.dir.includes('n') ? b.bottom : it.dir.includes('s') ? b.top : (b.top + b.bottom) / 2)
            : (it.dir.includes('n') ? b.bottom : b.top);
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            el.x = round2(ax + (o.x - ax) * sx);
            el.y = round2(ay + (o.y - ay) * sy);
            el.w = round2(Math.max(1, o.w * sx));
            el.h = round2(Math.max(1, o.h * sy));
            syncElement(el.id);
        });
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        showSizeTooltip(e.clientX, e.clientY, Math.round(b.w * sx), Math.round(b.h * sy));
        drawMeasure();
        return;
    }
    if (it.kind === 'rotate') {
        const vr = viewportRect();
        const cx = vr.left + state.pan.x + it.center.x * state.zoom;
        const cy = vr.top + state.pan.y + it.center.y * state.zoom;
        const cur = Math.atan2(e.clientY - cy, e.clientX - cx);
        let delta = (cur - it.startAngle) * 180 / Math.PI;
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        const rad = delta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            const hh = el.type === 'line' ? lineHeightFor(el) : el.h;
            // 围绕旋转中心转动每个元素的枢轴，再反推元素左上角，兼容任意自定义枢轴
            const pxw = o.x + o.pivotX * o.w, pyw = o.y + o.pivotY * hh;
            const nx = it.center.x + (pxw - it.center.x) * cos - (pyw - it.center.y) * sin;
            const ny = it.center.y + (pxw - it.center.x) * sin + (pyw - it.center.y) * cos;
            el.x = round2(nx - o.pivotX * o.w);
            el.y = round2(ny - o.pivotY * hh);
            el.rotation = round2(o.rotation + delta);
        });
        syncElementsTransform(it.items.map(o => o.id));
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        const singleEl = it.single ? getEl(it.items[0].id) : null;
        const shown = singleEl ? singleEl.rotation : delta;
        showAngleTooltip(e.clientX, e.clientY, shown);
        drawRotateGuide(it, e.clientX, e.clientY, delta, shown);
        drawMeasure();
        return;
    }
    if (it.kind === 'skew') {
        const dx = (e.clientX - it.startX) / state.zoom;
        const dy = (e.clientY - it.startY) / state.zoom;
        if (it.dir === 'n' || it.dir === 's') {
            if (it.items.length === 1) {
                const o = it.items[0], el = getEl(o.id);
                if (!el) return;
                const rad = o.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
                const localDx = dx * cos + dy * sin;
                const sign = it.dir === 'n' ? -1 : 1;
                const angle = Math.atan2(sign * localDx, Math.max(1, o.h / 2)) * 180 / Math.PI;
                el.skewX = round2(clamp(o.skewX + angle, -85, 85));
                syncElementTransform(el.id);
                showSkewTooltip(e.clientX, e.clientY, 'X', el.skewX);
            } else {
                const k = (it.dir === 'n' ? 1 : -1) * dx / Math.max(1, it.box.h / 2);
                const angle = -Math.atan2(k, 1) * 180 / Math.PI;
                it.items.forEach(o => {
                    const el = getEl(o.id); if (!el) return;
                    const hh = el.type === 'line' ? lineHeightFor(el) : el.h;
                    el.x = round2(o.x + k * (it.box.cy - (o.y + o.pivotY * hh)));
                    el.skewX = round2(clamp(o.skewX + angle, -85, 85));
                });
                syncElementsTransform(it.items.map(o => o.id));
                showSkewTooltip(e.clientX, e.clientY, 'X', angle);
            }
        } else {
            if (it.items.length === 1) {
                const o = it.items[0], el = getEl(o.id);
                if (!el) return;
                const rad = o.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
                const localDy = -dx * sin + dy * cos;
                const sign = it.dir === 'e' ? 1 : -1;
                const angle = Math.atan2(sign * localDy, Math.max(1, o.w / 2)) * 180 / Math.PI;
                el.skewY = round2(clamp(o.skewY + angle, -85, 85));
                syncElementTransform(el.id);
                showSkewTooltip(e.clientX, e.clientY, 'Y', el.skewY);
            } else {
                const k = (it.dir === 'e' ? 1 : -1) * dy / Math.max(1, it.box.w / 2);
                const angle = Math.atan2(k, 1) * 180 / Math.PI;
                it.items.forEach(o => {
                    const el = getEl(o.id); if (!el) return;
                    el.y = round2(o.y + k * ((o.x + o.pivotX * o.w) - it.box.cx));
                    el.skewY = round2(clamp(o.skewY + angle, -85, 85));
                });
                syncElementsTransform(it.items.map(o => o.id));
                showSkewTooltip(e.clientX, e.clientY, 'Y', angle);
            }
        }
        drawMeasure();
        return;
    }
    if (it.kind === 'pivot') {
        const el = getEl(it.id); if (!el) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const rad = it.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        // 以交互起点为基准：指针世界坐标 → 元素未旋转局部坐标，图形保持原位
        const P1x = it.x + it.fx * it.w, P1y = it.y + it.fy * it.h;
        const dx = world.x - P1x, dy = world.y - P1y;
        const lx = it.fx * it.w + dx * cos + dy * sin;
        const ly = it.fy * it.h - dx * sin + dy * cos;
        let fx = lx / it.w, fy = ly / it.h;
        // 靠近九宫格锚点时自动吸附
        const thr = 8 / state.zoom;
        [0, 0.5, 1].forEach(a => {
            if (Math.abs(fx - a) * it.w < thr) fx = a;
            if (Math.abs(fy - a) * it.h < thr) fy = a;
        });
        setPivot(el, fx, fy, true);
        syncElementTransform(el.id);
        syncGeoInputs(el);
        drawMeasure();
        return;
    }
    if (it.kind === 'cnode') {
        const el = getEl(it.id); if (!el || !el.curve) return;
        const n = el.curve.nodes[it.i]; if (!n) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const loc = worldToLocalPoint(el, world);
        const sLoc = worldToLocalPoint(el, it.start);
        let dx = loc.x - sLoc.x, dy = loc.y - sLoc.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const nx = clamp(round3(it.ox + dx / el.w), -3, 4);
        const ny = clamp(round3(it.oy + dy / el.h), -3, 4);
        const mx = nx - n.x, my = ny - n.y;
        n.x = nx; n.y = ny;
        n.ix = clamp(round3(n.ix + mx), -3, 4); n.iy = clamp(round3(n.iy + my), -3, 4);
        n.ox = clamp(round3(n.ox + mx), -3, 4); n.oy = clamp(round3(n.oy + my), -3, 4);
        syncElement(el.id);
        syncGeoInputs(el);
        drawMeasure();
        return;
    }
    if (it.kind === 'cctrl') {
        const el = getEl(it.id); if (!el || !el.curve) return;
        const n = el.curve.nodes[it.i]; if (!n) return;
        const world = clientToWorld(e.clientX, e.clientY);
        let loc = worldToLocalPoint(el, world);
        if (e.shiftKey) {
            // 控制柄方向 15° 吸附
            const vx = loc.x - n.x * el.w, vy = loc.y - n.y * el.h;
            let ang = Math.atan2(vy, vx);
            const step = Math.PI / 12;
            ang = Math.round(ang / step) * step;
            const len = Math.hypot(vx, vy);
            loc = { x: n.x * el.w + Math.cos(ang) * len, y: n.y * el.h + Math.sin(ang) * len };
        }
        const p = curveNorm(el, loc);
        if (it.h === 'out') { n.ox = p.x; n.oy = p.y; }
        else { n.ix = p.x; n.iy = p.y; }
        if (!e.altKey) mirrorCurveHandle(n, it.h);
        else n.t = 'cusp';
        syncElement(el.id);
        return;
    }
}
export function endInteraction(e?: PointerEvent): void {
    const it = state.interaction;
    if (!it || it.kind === 'crop') return;   // 裁剪框交互由裁剪器自行收尾，不提交画布历史
    if (it.kind === 'drag' && it.pendingNodeClick && e?.type === 'pointerup') {
        const p = it.pendingNodeClick;
        const el = getEl(p.id);
        if (el && el.type === 'curve') toggleCurveNodeType(el, p.i);
    }
    if (it.kind === 'drag' && it.secondClick && e?.type === 'pointerup'
        && Math.hypot(e.clientX - it.startX, e.clientY - it.startY) < 4) {
        setTransformMode(!state.transformMode);
    }
    if (it.kind === 'textcreate') {
        $('selectionBox').style.display = 'none';
        state.interaction = null;
        createTextFromRect(it.start, it.current || it.start);
    } else if (it.kind === 'box') {
        $('selectionBox').style.display = 'none';
        state.boxCache = null;
        state.selection = state.selection.filter(id => !!getEl(id));
        updateUI();
    } else if (it.kind === 'guidemove') {
        // 拖回标尺 = 删除（含刚拖出又放弃的情况）
        if (it.deleteHint) deleteGuide(it.id, true);
        commit();
        drawGuides();
    } else if (it.kind === 'bucketpaint') {
        if (it.painted.size) {
            const sel = state.selection.length === 1 ? getEl(state.selection[0]) : null;
            if (sel && it.painted.has(sel.id)) updatePropPanel(sel);
            commit();
            toast(`已为 ${it.painted.size} 个元素上色（按位置识别填充 / 描边）`, 'success');
        }
    } else if (it.kind === 'pendrag') {
        // 钢笔取点结束：草稿仍在，等下一次点击或结束命令
    } else if (it.kind !== 'pan') {
        // 手动缩放后文本退出自动尺寸，避免下一帧又被内容撑回去
        if (it.kind === 'resize') {
            selectedEls().forEach(x => {
                if (x.type === 'text' && x.text!.sizeMode !== 'fixed') { x.text!.sizeMode = 'fixed'; syncElement(x.id); }
            });
            if (state.selection.length === 1) updatePropPanel(getEl(state.selection[0]));
        }
        if (it.kind === 'cnode' || it.kind === 'cctrl') updateCurveNodePanel(getEl(it.id));
        commit();
    }
    hideSizeTooltip();
    document.querySelectorAll('.pivot-handle.dragging, .curve-node.dragging, .curve-ctrl.dragging, .rotate-mark.dragging').forEach(n => n.classList.remove('dragging'));
    const endedKind = state.interaction ? state.interaction.kind : null;
    document.querySelectorAll<HTMLElement>('.canvas-element.pivot-peek').forEach(n => {
        // 交互结束但指针仍停在元素上时延迟收起，便于继续调整枢轴
        if (endedKind && n.matches(':hover') && n._hidePeekLater) n._hidePeekLater();
        else n.classList.remove('pivot-peek');
    });
    $('viewport').classList.remove('panning', 'anchor-drag');
    setInteractionCursor(null);
    document.querySelectorAll<HTMLElement>('.canvas-element.interacting').forEach(n => n.classList.remove('interacting'));
    state.interaction = null;
    clearSnapGuides();
    clearAnchorHover();
    refreshStudioUI();
}
/* -------------------- 曲线：节点编辑（增删 / 平滑 / 闭合 / 适配） -------------------- */
export function curveSelectedIndex(el: CanvasElement | null): number {
    if (!el || !el.curve) return 0;
    const n = el.curve.nodes.length;
    const i = state.nodeSel && state.nodeSel.id === el.id ? state.nodeSel.i : 0;
    return clamp(i, 0, Math.max(0, n - 1));
}
/** 线段列表：[起点索引, 终点索引]，闭合路径含末→首段 */
export function curveSegments(el: CanvasElement): [number, number][] {
    const n = el.curve!.nodes.length;
    const segs: [number, number][] = [];
    for (let i = 1; i < n; i++) segs.push([i - 1, i]);
    if (el.curve!.closed && n > 1) segs.push([n - 1, 0]);
    return segs;
}
/** 命中测试：返回最近的线段与参数 t（局部像素坐标） */
export function curveSegHit(el: CanvasElement, loc: Point, tol: number): { d: number; a: number; b: number; t: number } | null {
    let best: { d: number; a: number; b: number; t: number } | null = null;
    for (const [a, b] of curveSegments(el)) {
        const pts = curveSegPts(el.curve!.nodes, a, b, el.w, el.h);
        for (let s = 0; s <= 48; s++) {
            const t = s / 48;
            const p = cubicAt(pts[0], pts[1], pts[2], pts[3], t);
            const d = Math.hypot(p.x - loc.x, p.y - loc.y);
            if (!best || d < best.d) best = { d, a, b, t };
        }
    }
    return best && best.d <= tol ? best : null;
}
/** 在指定线段的 t 处插入节点（De Casteljau 分割，形状不变） */
export function insertCurveNode(el: CanvasElement, a: number, b: number, t: number): void {
    const nodes = el.curve!.nodes;
    const A = nodes[a], B = nodes[b];
    if (!A || !B) return;
    const px = (p: Point): Point => ({ x: round3(p.x / Math.max(1, el.w)), y: round3(p.y / Math.max(1, el.h)) });
    const flat = !curveNodeHasOut(A) && !curveNodeHasIn(B);
    const pts = curveSegPts(nodes, a, b, el.w, el.h);
    const split = splitCubic(pts, clamp(t, 0.05, 0.95));
    const mid = px(split.mid);
    const nn: CurveNode = { x: mid.x, y: mid.y, ix: mid.x, iy: mid.y, ox: mid.x, oy: mid.y, t: 'smooth' };
    if (flat) {
        A.ox = A.x; A.oy = A.y;
        B.ix = B.x; B.iy = B.y;
    } else {
        const cA = px(split.left[1]), cB = px(split.right[2]);
        A.ox = clamp(cA.x, -3, 4); A.oy = clamp(cA.y, -3, 4);
        B.ix = clamp(cB.x, -3, 4); B.iy = clamp(cB.y, -3, 4);
        nn.ix = clamp(px(split.left[2]).x, -3, 4); nn.iy = clamp(px(split.left[2]).y, -3, 4);
        nn.ox = clamp(px(split.right[1]).x, -3, 4); nn.oy = clamp(px(split.right[1]).y, -3, 4);
    }
    const at = b === 0 ? nodes.length : b;
    nodes.splice(at, 0, nn);
    state.nodeSel = { id: el.id, i: at };
    renderAll();
    updateCurveNodePanel(el);
    commit();
    toast('已插入节点（形状保持不变）', 'success');
}
export function removeCurveNode(el: CanvasElement, i: number): void {
    const nodes = el.curve!.nodes;
    if (nodes.length <= 2) { toast('曲线至少保留 2 个节点', 'error'); return; }
    nodes.splice(i, 1);
    if (el.curve!.closed && nodes.length < 3) el.curve!.closed = false;
    state.nodeSel = { id: el.id, i: clamp(i - 1, 0, nodes.length - 1) };
    renderAll();
    updateCurveNodePanel(el);
    commit();
    toast('已删除节点', 'success');
}
/** 把元素边框收紧到路径实际范围（含控制柄），路径位置保持不动 */
export function fitCurveBox(el: CanvasElement): void {
    const b = curveLocalBox(el);
    const offX = b.left, offY = b.top;
    const nw = Math.max(1, round2(b.w)), nh = Math.max(1, round2(b.h));
    const oldW = el.w, oldH = el.h;
    // 局部坐标平移 off，保持形状在屏幕上的位置（兼容旋转与自定义枢轴）
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const oldPivot = pivotWorld(el);
    const plx = el.pivotX * nw, ply = el.pivotY * nh;
    const ox = offX + plx - el.pivotX * oldW;
    const oy = offY + ply - el.pivotY * oldH;
    el.x = round2(oldPivot.x + ox * cos - oy * sin - plx);
    el.y = round2(oldPivot.y + ox * sin + oy * cos - ply);
    el.curve!.nodes.forEach(n => {
        n.x = clamp(round3((n.x * oldW - offX) / nw), -3, 4);
        n.y = clamp(round3((n.y * oldH - offY) / nh), -3, 4);
        n.ix = clamp(round3((n.ix * oldW - offX) / nw), -3, 4);
        n.iy = clamp(round3((n.iy * oldH - offY) / nh), -3, 4);
        n.ox = clamp(round3((n.ox * oldW - offX) / nw), -3, 4);
        n.oy = clamp(round3((n.oy * oldH - offY) / nh), -3, 4);
    });
    el.w = nw; el.h = nh;
    renderAll();
    updateCurveNodePanel(el);
    updatePropPanel(el);
    commit();
    toast('边框已收紧到路径范围', 'success');
}
export function curveOp(action: string): void {
    const el = selectedEls()[0];
    if (!el || el.type !== 'curve') { toast('请先选中一条曲线', 'error'); return; }
    if (el.locked) { toast('元素已锁定，无法编辑节点', 'error'); return; }
    const c = el.curve!;
    const i = curveSelectedIndex(el);
    if (action === 'close') {
        if (c.nodes.length < 2) return;
        c.closed = true;
    } else if (action === 'open') {
        c.closed = false;
    } else if (action === 'add') {
        const segs = curveSegments(el);
        const seg = segs.find(sg => sg[0] === i) || segs[segs.length - 1];
        if (!seg) return;
        insertCurveNode(el, seg[0], seg[1], 0.5);
        return;
    } else if (action === 'del') {
        removeCurveNode(el, i);
        return;
    } else if (action === 'smooth' || action === 'cusp') {
        const n = c.nodes[i];
        if (!n) return;
        n.t = action;
        if (action === 'smooth') smoothNodeHandles(el, i);
    } else if (action === 'reverse') {
        c.nodes.reverse();
        c.nodes.forEach(n => {
            const ix = n.ix, iy = n.iy;
            n.ix = n.ox; n.iy = n.oy; n.ox = ix; n.oy = iy;
        });
        state.nodeSel = { id: el.id, i: c.nodes.length - 1 - i };
    } else if (action === 'fit') {
        fitCurveBox(el);
        return;
    }
    syncElement(el.id);
    updateCurveNodePanel(el);
    syncCurveFillControls(el);
    drawMeasure();
    commit();
    toast('路径已更新', 'success');
}
/** 同步曲线节点面板的状态 */
export function updateCurveNodePanel(el: CanvasElement | null): void {
    const block = $('curveNodeBlock');
    if (!block) return;
    const isCurve = !!el && el.type === 'curve';
    block.style.display = isCurve ? 'block' : 'none';
    if (!isCurve || !el) return;
    const c = el.curve!, n = c.nodes.length, i = curveSelectedIndex(el);
    const info = $('curveNodeInfo');
    if (info) info.textContent = `${n} 节点 · ${c.closed ? '闭合' : '开放'} · 当前 #${i + 1}`;
    const closeBtn = $<HTMLButtonElement>('btnCurveClose'), openBtn = $<HTMLButtonElement>('btnCurveOpen');
    if (closeBtn) closeBtn.disabled = !!c.closed || n < 2;
    if (openBtn) openBtn.disabled = !c.closed;
    block.querySelectorAll<HTMLButtonElement>('.text-btn[data-arg]').forEach(b => {
        const arg = b.dataset.arg;
        if (arg === 'del') b.disabled = n <= 2 || el.locked;
        else if (arg === 'smooth' || arg === 'cusp') {
            const cur = c.nodes[i];
            b.classList.toggle('active', !!cur && cur.t === arg);
        }
    });
    const hint = $('curveNodeHint');
    if (hint) hint.textContent = el.locked
        ? '元素已锁定，解锁后即可编辑节点'
        : '拖拽方块移动节点，拖拽圆形控制柄调整弧度（Alt 断开对称，Shift 15° 吸附）；双击线段加点，双击节点删点';
}

/* -------------------- 钢笔工具（贝塞尔路径绘制） -------------------- */
function penNodeAt(p: Point): CurveNode {
    return { x: round2(p.x), y: round2(p.y), ix: round2(p.x), iy: round2(p.y), ox: round2(p.x), oy: round2(p.y), t: 'smooth' };
}
const PEN_SNAP_IGNORE = new Set<string>();
export function penPointFromEvent(e: PointerEvent): Point {
    const w = clientToWorld(e.clientX, e.clientY);
    if (e.altKey) { clearSnapGuides(); return w; }
    if (state.settings.snap) {
        const target = nearestSnapPoint(w, SNAP_POINT_PX / state.zoom, PEN_SNAP_IGNORE);
        if (target) {
            drawSnapGuides(null, target);
            return { x: target.x, y: target.y };
        }
    }
    clearSnapGuides();
    if (state.settings.grid) {
        const g = Math.max(1, state.settings.gridSize || 20);
        return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
    }
    return w;
}
/** 收起节点的出手柄（转为角点），使从它出发的下一段变成直线；入柄属于已画好的上一段，保持不变 */
function penCollapseOutHandle(pen: PenDraft, i: number): boolean {
    const n = pen.nodes[i];
    if (!n) return false;
    if (Math.abs(n.ox - n.x) < 1e-6 && Math.abs(n.oy - n.y) < 1e-6) return false;
    n.ox = n.x; n.oy = n.y; n.t = 'cusp';
    return true;
}
function penPointerDown(e: PointerEvent): void {
    const raw = clientToWorld(e.clientX, e.clientY);
    const pen = state.pen;
    if (pen) {
        // 闭合 / 连点结束 / 收起手柄按原始指针判断，避免吸附点抢走首尾节点
        if (pen.lastDown && Date.now() - pen.lastDown.t < 340 &&
            Math.hypot(raw.x - pen.lastDown.x, raw.y - pen.lastDown.y) * state.zoom < 7) {
            finishPen(false);
            return;
        }
        const first = pen.nodes[0];
        if (pen.nodes.length >= 2 && Math.hypot(raw.x - first.x, raw.y - first.y) * state.zoom <= 10) {
            finishPen(true);
            return;
        }
        const last = pen.nodes[pen.nodes.length - 1];
        // Alt + 点击刚放下的锚点 = 收起它的出手柄，之后下一段即为直线
        if (e.altKey && last && Math.hypot(raw.x - last.x, raw.y - last.y) * state.zoom <= 10) {
            if (penCollapseOutHandle(pen, pen.nodes.length - 1)) {
                state.interaction = null;
                clearSnapGuides();
                renderPenDraft();
                toast('已收起出手柄：下一段为直线', 'success');
            }
            return;
        }
    }
    const world = penPointFromEvent(e);
    if (!pen) {
        state.pen = { nodes: [penNodeAt(world)], cursor: world, closed: false,
            lastDown: { x: world.x, y: world.y, t: Date.now() } };
        state.interaction = { kind: 'pendrag', i: 0, sx: e.clientX, sy: e.clientY };
        renderPenDraft();
        return;
    }
    // Alt + 落新点 = 顺带收起上一个节点的出手柄，让新生成的这一段是直线
    pen.nodes.push(penNodeAt(world));
    if (e.altKey) {
        if (penCollapseOutHandle(pen, pen.nodes.length - 2)) toast('已收起出手柄：新段为直线', 'success');
    }
    pen.lastDown = { x: world.x, y: world.y, t: Date.now() };
    state.interaction = { kind: 'pendrag', i: pen.nodes.length - 1, sx: e.clientX, sy: e.clientY };
    renderPenDraft();
}
function penDragMove(e: PointerEvent): void {
    const pen = state.pen;
    if (!pen) return;
    const it = state.interaction && state.interaction.kind === 'pendrag' ? state.interaction : null;
    // 4px 死区：单击时的手抖不应生成出手柄，否则下一段会意外变成曲线
    if (it && Math.hypot(e.clientX - it.sx, e.clientY - it.sy) < 4) return;
    const n = pen.nodes[it ? it.i : pen.nodes.length - 1];
    if (!n) return;
    const world = clientToWorld(e.clientX, e.clientY);
    let vx = world.x - n.x, vy = world.y - n.y;
    if (e.shiftKey) {
        const len = Math.hypot(vx, vy);
        const step = Math.PI / 12;
        const ang = Math.round(Math.atan2(vy, vx) / step) * step;
        vx = Math.cos(ang) * len; vy = Math.sin(ang) * len;
    }
    n.ox = round2(n.x + vx); n.oy = round2(n.y + vy);
    if (!e.altKey) { n.ix = round2(n.x - vx); n.iy = round2(n.y - vy); n.t = 'smooth'; }
    else { n.t = 'cusp'; }
    pen.cursor = world;
    renderPenDraft();
}
export function cancelPen(): void {
    state.pen = null;
    state.interaction = null;
    clearSnapGuides();
    renderPenDraft();
}
export function finishPen(close: boolean, keepTool?: boolean): void {
    const pen = state.pen;
    state.pen = null;
    state.interaction = null;
    clearSnapGuides();
    renderPenDraft();
    if (pen && pen.nodes.length >= 2) {
        const nodes = pen.nodes;
        const b = curveNodesBox(nodes, 1, 1, !!close);
        const x = round2(b.left), y = round2(b.top);
        const w = Math.max(1, round2(b.w)), h = Math.max(1, round2(b.h));
        const el = buildElement('curve', x, y);
        el.w = w; el.h = h;
        const color = (state.settings.recentColors && state.settings.recentColors[0]) || '#1c2230';
        el.line = makeLine({ style: 'solid', width: 3, color });
        el.curve = makeCurve({
            closed: !!close,
            nodes: nodes.map(n => ({
                x: (n.x - x) / w, y: (n.y - y) / h,
                ix: (n.ix - x) / w, iy: (n.iy - y) / h,
                ox: (n.ox - x) / w, oy: (n.oy - y) / h,
                t: n.t
            }))
        });
        state.model.elements.push(el);
        renderAll();
        setSelection([el.id]);
        if (!keepTool) setTool('select');
        commit();
        toast(`已创建曲线 ${nodes.length} 个节点${close ? ' · 闭合路径，可用颜料桶 (B) 或检查器填充' : ''}`, 'success');
    } else if (!keepTool) {
        setTool('select');
    }
}
/** 草稿预览：路径 + 节点 + 控制柄 + 到指针的橡皮筋 */
export function renderPenDraft(): void {
    const layer = $('penLayer');
    if (!layer) return;
    layer.textContent = '';
    const pen = state.pen;
    if (!pen || !pen.nodes.length) return;
    const z = state.zoom, p = state.pan;
    const X = (v: number): number => round2(v * z + p.x), Y = (v: number): number => round2(v * z + p.y);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const ns = pen.nodes;
    let d = `M ${X(ns[0].x)} ${Y(ns[0].y)}`;
    for (let i = 1; i < ns.length; i++) {
        d += ` C ${X(ns[i - 1].ox)} ${Y(ns[i - 1].oy)}, ${X(ns[i].ix)} ${Y(ns[i].iy)}, ${X(ns[i].x)} ${Y(ns[i].y)}`;
    }
    if (pen.closed && ns.length > 1) {
        const L = ns[ns.length - 1];
        d += ` C ${X(L.ox)} ${Y(L.oy)}, ${X(ns[0].ix)} ${Y(ns[0].iy)}, ${X(ns[0].x)} ${Y(ns[0].y)} Z`;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'pen-path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    // 橡皮筋：从最后一个节点到指针，按最后一个节点的出控制柄预览弧度
    const dragging = state.interaction && state.interaction.kind === 'pendrag';
    const last = ns[ns.length - 1];
    if (!dragging && pen.cursor && !pen.closed) {
        const rb = document.createElementNS(SVG_NS, 'path');
        rb.setAttribute('class', 'pen-rubber');
        rb.setAttribute('d', `M ${X(last.x)} ${Y(last.y)} C ${X(last.ox)} ${Y(last.oy)}, ${X(pen.cursor.x)} ${Y(pen.cursor.y)}, ${X(pen.cursor.x)} ${Y(pen.cursor.y)}`);
        svg.appendChild(rb);
    }
    // 控制柄与节点
    const tail = last;
    (['in', 'out'] as const).forEach(k => {
        const has = k === 'in' ? curveNodeHasIn(tail) : curveNodeHasOut(tail);
        if (!has) return;
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('class', 'pen-tangent');
        ln.setAttribute('x1', String(X(tail.x))); ln.setAttribute('y1', String(Y(tail.y)));
        ln.setAttribute('x2', String(X(k === 'in' ? tail.ix : tail.ox)));
        ln.setAttribute('y2', String(Y(k === 'in' ? tail.iy : tail.oy)));
        svg.appendChild(ln);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'pen-handle');
        dot.setAttribute('cx', String(X(k === 'in' ? tail.ix : tail.ox)));
        dot.setAttribute('cy', String(Y(k === 'in' ? tail.iy : tail.oy)));
        dot.setAttribute('r', '3.2');
        svg.appendChild(dot);
    });
    ns.forEach((n, i) => {
        const sq = document.createElementNS(SVG_NS, 'rect');
        sq.setAttribute('class', 'pen-node' + (i === 0 ? ' first' : ''));
        sq.setAttribute('x', String(X(n.x) - 3.5));
        sq.setAttribute('y', String(Y(n.y) - 3.5));
        sq.setAttribute('width', '7');
        sq.setAttribute('height', '7');
        sq.setAttribute('rx', '1.5');
        svg.appendChild(sq);
    });
    layer.appendChild(svg);
}

function createTextFromRect(a: Point, b: Point): void {
    const dragged = Math.abs(b.x - a.x) > 8 || Math.abs(b.y - a.y) > 8;
    const el = buildElement('text', 0, 0);
    el.x = round2(Math.min(a.x, b.x));
    el.y = round2(Math.min(a.y, b.y));
    if (dragged) {
        el.w = round2(Math.max(40, Math.abs(b.x - a.x)));
        el.h = round2(Math.max(el.text!.fontSize * el.text!.lineHeight, Math.abs(b.y - a.y)));
        el.text!.sizeMode = 'fixed';
    } else {
        el.w = 20;
        el.h = round2(el.text!.fontSize * el.text!.lineHeight);
        el.text!.sizeMode = 'autoWH';
    }
    state.model.elements.push(el);
    renderAll();
    setSelection([el.id]);
    setTool('select');
    commit();
    startTextEdit(el);
}
export function syncGeoInputs(el: CanvasElement | null): void {
    if (!el) return;
    $<HTMLInputElement>('geoX').value = String(Math.round(el.x));
    $<HTMLInputElement>('geoY').value = String(Math.round(el.y));
    $<HTMLInputElement>('geoW').value = String(Math.round(el.w));
    $<HTMLInputElement>('geoH').value = String(Math.round(el.type === 'line' ? lineHeightFor(el) : el.h));
    $<HTMLInputElement>('geoR').value = String(Math.round(el.rotation));
    syncPivotInputs(el);
}
export function syncPivotInputs(el: CanvasElement | null): void {
    if (!el) return;
    $<HTMLInputElement>('pivotXInput').value = String(Math.round(el.pivotX * 100));
    $<HTMLInputElement>('pivotYInput').value = String(Math.round(el.pivotY * 100));
}
export function syncLineStyleSeg(style: LineStyle): void {
    document.querySelectorAll('#lineStyleSeg .line-style-btn').forEach(b => {
        const on = b.getAttribute('data-arg') === style;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
}
export function currentLineStyle(): LineStyle {
    const b = document.querySelector('#lineStyleSeg .line-style-btn.active');
    return (b ? b.getAttribute('data-arg') : 'solid') as LineStyle || 'solid';
}
export function setLineStyle(style: string): void {
    if (!LINE_STYLES.includes(style as LineStyle)) return;
    syncLineStyleSeg(style as LineStyle);
    updateLineStyle();
}
export function syncWavyDashSeg(dash: StrokeStyle): void {
    document.querySelectorAll('#wavyDashSeg .line-style-btn').forEach(b => {
        const on = b.getAttribute('data-arg') === dash;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
}
export function currentWavyDash(): StrokeStyle {
    const b = document.querySelector('#wavyDashSeg .line-style-btn.active');
    return (b ? b.getAttribute('data-arg') : 'solid') as StrokeStyle || 'solid';
}
export function setWavyDash(dash: string): void {
    if (!['solid', 'dashed', 'dotted'].includes(dash)) return;
    syncWavyDashSeg(dash as StrokeStyle);
    updateLineStyle();
}