import { state } from './state';
import { $, $opt } from './utils';
import { getEl } from './model';
import { getAABB, selectionAABB } from './geometry';
import { guideAxis } from './guides';
import { collectSnapPoints, nearestPointSnap, selectionSnapPoints, SNAP_POINT_PX } from './snappoints';
import type { Interaction, SnapLine, SnapPoint } from './types';

type DragInteraction = Extract<Interaction, { kind: 'drag' }>;
const dragSnapCache = new WeakMap<DragInteraction, { sources: SnapPoint[]; targets: SnapPoint[] }>();

function snapDataFor(it: DragInteraction): { sources: SnapPoint[]; targets: SnapPoint[] } {
    let data = dragSnapCache.get(it);
    if (!data) {
        const ids = new Set(it.items.map(o => o.id));
        data = { sources: selectionSnapPoints(it.items), targets: collectSnapPoints(ids) };
        dragSnapCache.set(it, data);
    }
    return data;
}

export function snapCandidates(ignoreIds: Set<string>): { xs: number[]; ys: number[] } {
    const xs = [0, state.model.canvas.w / 2, state.model.canvas.w];
    const ys = [0, state.model.canvas.h / 2, state.model.canvas.h];
    state.model.elements.forEach(e => {
        if (ignoreIds.has(e.id) || !e.visible) return;
        const a = getAABB(e);
        xs.push(a.left, a.cx, a.right); ys.push(a.top, a.cy, a.bottom);
    });
    // 轴线辅助线参与吸附（旋转线不参与，避免斜向吸附干扰）
    (state.model.guides || []).forEach(g => {
        const axis = guideAxis(g);
        if (axis === 'v') xs.push(g.x);
        else if (axis === 'h') ys.push(g.y);
    });
    return { xs, ys };
}

export function applyDragSnap(it: DragInteraction, mx: number, my: number): { mx: number; my: number; guides: SnapLine[]; point: SnapPoint | null } {
    if (!state.settings.snap) return { mx, my, guides: [], point: null };
    const ids = new Set(it.items.map(o => o.id));
    const { sources, targets } = snapDataFor(it);
    const pointSnap = nearestPointSnap(sources, targets, mx, my, SNAP_POINT_PX / state.zoom);
    if (pointSnap) {
        return { mx: mx + pointSnap.dx, my: my + pointSnap.dy, guides: [], point: pointSnap.target };
    }
    const { xs, ys } = snapCandidates(ids);
    const start = it.startBox || (it.startBox = selectionAABB());
    if (!start) return { mx, my, guides: [], point: null };
    const cur = { left: start.left + mx, right: start.right + mx, cx: start.cx + mx,
                  top: start.top + my, bottom: start.bottom + my, cy: start.cy + my };
    const threshold = 6 / state.zoom;
    let bestX: { d: number; v: number } | null = null, bestY: { d: number; v: number } | null = null;
    for (const key of ['left', 'cx', 'right'] as const) {
        for (const v of xs) {
            const d = v - cur[key];
            if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, v };
        }
    }
    for (const key of ['top', 'cy', 'bottom'] as const) {
        for (const v of ys) {
            const d = v - cur[key];
            if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, v };
        }
    }
    const guides: SnapLine[] = [];
    if (bestX) { mx += bestX.d; guides.push({ vertical: true, at: bestX.v }); }
    if (bestY) { my += bestY.d; guides.push({ vertical: false, at: bestY.v }); }
    // 网格吸附：未命中元素/画布参考线时对齐到网格
    if (!bestX && !bestY && state.settings.grid) {
        const g = state.settings.gridSize;
        if (it.items.length === 1) {
            const el = getEl(it.items[0].id);
            if (el) {
                const nx = Math.round((el.x + mx) / g) * g, ny = Math.round((el.y + my) / g) * g;
                mx += nx - (el.x + mx); my += ny - (el.y + my);
            }
        }
    }
    return { mx, my, guides, point: null };
}

export function drawSnapGuides(guides: SnapLine[] | null, point?: SnapPoint | null): void {
    const layer = $('guidesLayer');
    layer.textContent = '';
    (guides || []).forEach(g => {
        const d = document.createElement('div');
        d.className = 'snap-guide ' + (g.vertical ? 'v' : 'h');
        if (g.vertical) d.style.left = (g.at * state.zoom + state.pan.x) + 'px';
        else d.style.top = (g.at * state.zoom + state.pan.y) + 'px';
        layer.appendChild(d);
    });
    if (!point) return;
    const p = document.createElement('div');
    p.className = 'snap-point snap-' + point.kind;
    const sx = point.x * state.zoom + state.pan.x;
    p.style.left = sx + 'px';
    p.style.top = (point.y * state.zoom + state.pan.y) + 'px';
    if (sx > layer.clientWidth - 90) p.classList.add('flip');
    const tag = document.createElement('span');
    tag.className = 'snap-point-label';
    tag.textContent = point.label;
    p.appendChild(tag);
    layer.appendChild(p);
}

export function clearSnapGuides(): void { const l = $opt('guidesLayer'); if (l) l.textContent = ''; }