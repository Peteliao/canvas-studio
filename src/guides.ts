import { state } from './state';
import { $, $opt, clamp, finite, iconEl, round2 } from './utils';
import { getEl } from './model';
import { getAABB, selectionAABB } from './geometry';
import { applySelectionClasses } from './render';
import { commit, scheduleCommit } from './history';
import { updateUI } from './panel';
import { moveSelected } from './elements';
import { drawMeasure } from './measure';
import type { AABB, CanvasElement, Guide, Point } from './types';

export interface BoxGuideMeasure { dist: number; sign: number; ext: number; from: Point; to: Point; n: Point; }

export function currentGuide(): Guide | null {
    return state.guideSel ? (state.model.guides || []).find(g => g.id === state.guideSel) || null : null;
}

/** 辅助线 = 过锚点 (x,y)、方向角 angle 的无限直线；n 为单位法向量，c 为法向偏移 */
export function guideGeom(g: Guide): { n: Point; c: number; dir: Point } {
    const rad = g.angle * Math.PI / 180;
    const n = { x: -Math.sin(rad), y: Math.cos(rad) };
    return { n, c: n.x * g.x + n.y * g.y, dir: { x: Math.cos(rad), y: Math.sin(rad) } };
}

export function guideAxis(g: Guide): 'h' | 'v' | null {
    const m = ((g.angle % 180) + 180) % 180;
    if (Math.abs(m) < 1e-6) return 'h';
    if (Math.abs(m - 90) < 1e-6) return 'v';
    return null;
}

/** 包围盒到辅助线的垂直距离：分离时取最近角点，穿过时距离 0 并保留中心偏移符号 */
export function boxGuideMeasure(box: AABB, g: Guide): BoxGuideMeasure {
    const { n, c } = guideGeom(g);
    const pts = [{ x: box.left, y: box.top }, { x: box.right, y: box.top },
        { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom }];
    let dmin = Infinity, dmax = -Infinity, pmin = pts[0], pmax = pts[0];
    pts.forEach(p => {
        const d = n.x * p.x + n.y * p.y - c;
        if (d < dmin) { dmin = d; pmin = p; }
        if (d > dmax) { dmax = d; pmax = p; }
    });
    if (dmin >= 0) return { dist: dmin, sign: 1, ext: dmin, from: pmin, to: { x: pmin.x - dmin * n.x, y: pmin.y - dmin * n.y }, n };
    if (dmax <= 0) return { dist: -dmax, sign: -1, ext: dmax, from: pmax, to: { x: pmax.x - dmax * n.x, y: pmax.y - dmax * n.y }, n };
    const center = { x: box.cx, y: box.cy };
    const sc = n.x * center.x + n.y * center.y - c;
    const sign = sc >= 0 ? 1 : -1;
    return { dist: 0, sign, ext: sign > 0 ? dmin : dmax, from: center, to: { x: center.x - sc * n.x, y: center.y - sc * n.y }, n };
}

export function nearestGuidesToBox(box: AABB, limit: number): { g: Guide; m: BoxGuideMeasure }[] {
    if (state.settings.guideLines === false) return [];
    return (state.model.guides || []).map(g => ({ g, m: boxGuideMeasure(box, g) }))
        .sort((a, b) => a.m.dist - b.m.dist).slice(0, limit);
}

export function nearestObjectsToGuide(g: Guide): { o: CanvasElement; m: BoxGuideMeasure }[] {
    const sides: Record<number, { o: CanvasElement; m: BoxGuideMeasure } | null> = { 1: null, [-1]: null };
    state.model.elements.forEach(o => {
        if (o.visible === false) return;
        const m = boxGuideMeasure(getAABB(o), g);
        const cur = sides[m.sign];
        if (!cur || m.dist < cur.m.dist) sides[m.sign] = { o, m };
    });
    return [sides[1], sides[-1]].filter((x): x is { o: CanvasElement; m: BoxGuideMeasure } => !!x);
}

/** 编辑物件↔辅助线距离：沿法向平移选区，使最近边落到目标距离 */
export function applyObjectGuideDistance(g: Guide, v: number): void {
    const b = selectionAABB();
    if (!b) return;
    const m = boxGuideMeasure(b, g);
    const t = m.sign * Math.max(0, round2(v)) - m.ext;
    moveSelected(round2(m.n.x * t), round2(m.n.y * t));
}

/** 编辑辅助线↔物件距离：沿法向平移辅助线本身 */
export function applyGuideDistance(g: Guide, v: number, otherId: string): void {
    const o = getEl(otherId);
    if (!o) return;
    const m = boxGuideMeasure(getAABB(o), g);
    const t = m.ext - m.sign * Math.max(0, round2(v));
    g.x = round2(g.x + m.n.x * t);
    g.y = round2(g.y + m.n.y * t);
    drawGuides();
    drawMeasure();
    scheduleCommit(160);
}

export function guideSegPath(m: BoxGuideMeasure, g: Guide, zoom: number, pan: Point): string {
    const X = (v: number) => round2(v * zoom + pan.x), Y = (v: number) => round2(v * zoom + pan.y);
    const { dir } = guideGeom(g);
    const t = 4, dx = dir.x * t, dy = dir.y * t;
    const x1 = X(m.from.x), y1 = Y(m.from.y), x2 = X(m.to.x), y2 = Y(m.to.y);
    return `M ${round2(x1 - dx)} ${round2(y1 - dy)} L ${round2(x1 + dx)} ${round2(y1 + dy)} M ${x1} ${y1} L ${x2} ${y2} M ${round2(x2 - dx)} ${round2(y2 - dy)} L ${round2(x2 + dx)} ${round2(y2 + dy)}`;
}

const guideNodeMap = new Map<string, HTMLDivElement>();

export function drawGuides(): void {
    const layer = $opt('guideLayer');
    if (!layer) return;
    const guides = state.settings.guideLines === false ? [] : (state.model.guides || []);
    const vp = $('viewport');
    const L = vp.clientWidth + vp.clientHeight + 400;
    const seen = new Set<string>();
    guides.forEach(g => {
        seen.add(g.id);
        let d = guideNodeMap.get(g.id);
        if (!d) {
            d = document.createElement('div');
            d.className = 'guide-line';
            d.dataset.id = g.id;
            layer.appendChild(d);
            guideNodeMap.set(g.id, d);
        }
        const ax = g.x * state.zoom + state.pan.x, ay = g.y * state.zoom + state.pan.y;
        d.style.width = L + 'px';
        d.style.left = (ax - L / 2) + 'px';
        d.style.top = (ay - 4) + 'px';
        d.style.transform = 'rotate(' + g.angle + 'deg)';
        const axis = guideAxis(g);
        d.style.cursor = axis === 'h' ? 'ns-resize' : axis === 'v' ? 'ew-resize' : 'move';
        d.classList.toggle('selected', state.guideSel === g.id);
        d.classList.toggle('deleting', !!(state.interaction && state.interaction.kind === 'guidemove' &&
            state.interaction.id === g.id && state.interaction.deleteHint));
        d.title = '辅助线：拖动移动，拖回标尺删除；双击设置角度';
    });
    guideNodeMap.forEach((d, id) => {
        if (!seen.has(id)) { d.remove(); guideNodeMap.delete(id); }
    });
    drawGuideCtrl();
}

/** 选中辅助线的浮动控制条：角度输入 + 删除按钮，贴在线的视口中心投影处 */
function drawGuideCtrl(): void {
    let ctrl = $opt('guideCtrl');
    const g = currentGuide();
    if (!g || state.settings.guideLines === false) {
        if (ctrl) ctrl.remove();
        return;
    }
    if (!ctrl) {
        ctrl = document.createElement('div');
        ctrl.id = 'guideCtrl';
        ctrl.className = 'guide-ctrl';
        const lab = document.createElement('span'); lab.className = 'gc-label'; lab.textContent = '∠';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '1'; inp.className = 'gc-angle';
        inp.setAttribute('aria-label', '辅助线角度（度）');
        const deg = document.createElement('span'); deg.className = 'gc-label'; deg.textContent = '°';
        const del = document.createElement('button');
        del.className = 'gc-del'; del.title = '删除辅助线 (Delete)';
        del.appendChild(iconEl('trash'));
        ctrl.append(lab, inp, deg, del);
        inp.addEventListener('input', () => {
            const gd = currentGuide();
            const v = finite(inp.value, NaN);
            if (!gd || Number.isNaN(v)) return;
            gd.angle = clamp(round2(v), -36000, 36000);
            drawGuides(); drawMeasure(); scheduleCommit(160);
        });
        inp.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') inp.blur();
        });
        del.addEventListener('click', e => { e.stopPropagation(); deleteGuide(state.guideSel); });
        ctrl.addEventListener('pointerdown', e => e.stopPropagation());
        ctrl.addEventListener('dblclick', e => e.stopPropagation());
        $('viewport').appendChild(ctrl);
    }
    const inp = ctrl.querySelector<HTMLInputElement>('.gc-angle')!;
    if (document.activeElement !== inp) inp.value = String(round2(g.angle));
    const vp = $('viewport');
    const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
    const { n } = guideGeom(g);
    const ax = g.x * state.zoom + state.pan.x, ay = g.y * state.zoom + state.pan.y;
    const s = n.x * (cx - ax) + n.y * (cy - ay);
    // 窄屏下检查器是覆盖画布的抽屉，浮控需留在其左侧可见区
    let rightLimit = vp.clientWidth - 80;
    const insp = $opt('inspector');
    if (insp && !insp.classList.contains('collapsed') && getComputedStyle(insp).position === 'absolute') {
        const ir = insp.getBoundingClientRect(), vr = vp.getBoundingClientRect();
        if (ir.left < vr.right && ir.right > vr.left) rightLimit = Math.min(rightLimit, ir.left - vr.left - 56);
    }
    ctrl.style.left = clamp(cx - s * n.x, 80, Math.max(80, rightLimit)) + 'px';
    ctrl.style.top = clamp(cy - s * n.y + 12, 8, vp.clientHeight - 36) + 'px';
}

export function selectGuide(id: string | null): void {
    state.guideSel = id;
    state.selection = [];
    applySelectionClasses();
    updateUI();
}

export function deleteGuide(id: string | null, skipCommit?: boolean): void {
    const arr = state.model.guides || [];
    const i = arr.findIndex(g => g.id === id);
    if (i < 0) return;
    arr.splice(i, 1);
    if (state.guideSel === id) state.guideSel = null;
    drawGuides();
    updateUI();
    if (!skipCommit) commit();
}

export function isOverRuler(clientX: number, clientY: number): boolean {
    if (!state.settings.rulers) return false;
    return ['rulerH', 'rulerV'].some(id => {
        const r = $(id).getBoundingClientRect();
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
}