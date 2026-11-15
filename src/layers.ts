import { state } from './state';
import { $, round2, toast } from './utils';
import { getEl, selectedEls, sortedElements } from './model';
import { renderAll, applySelectionClasses, syncElement } from './render';
import { commit } from './history';
import { getAABB, normalizeZFromOrder } from './geometry';
import type { AABB } from './types';

export function alignElements(type: string): void {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    // N7：相对画布基准时允许单选，并以整个画布作为对齐框
    const canvasBase = state.alignBase === 'canvas';
    if (!canvasBase && els.length < 2) return;
    let a: AABB, anchor: ReturnType<typeof getEl> = null;
    if (canvasBase) {
        a = { left: 0, top: 0, right: state.model.canvas.w, bottom: state.model.canvas.h,
              cx: state.model.canvas.w / 2, cy: state.model.canvas.h / 2,
              w: state.model.canvas.w, h: state.model.canvas.h };
    } else {
        anchor = getEl(state.selection[state.selection.length - 1]);
        if (!anchor) return;
        a = getAABB(anchor);
    }
    els.forEach(el => {
        if (el === anchor) return;
        const b = getAABB(el);
        if (type === 'left') el.x = round2(el.x + (a.left - b.left));
        else if (type === 'right') el.x = round2(el.x + (a.right - b.right));
        else if (type === 'center') el.x = round2(el.x + (a.cx - b.cx));
        else if (type === 'top') el.y = round2(el.y + (a.top - b.top));
        else if (type === 'bottom') el.y = round2(el.y + (a.bottom - b.bottom));
        else if (type === 'middle') el.y = round2(el.y + (a.cy - b.cy));
        syncElement(el.id);
    });
    commit();
}

export function distributeElements(axis: 'h' | 'v'): void {
    const els = selectedEls();
    if (els.length < 3) return;
    if (els.some(e => e.locked)) { toast('选中了锁定元素，无法分布', 'error'); return; }
    const items = els.map(el => ({ el, a: getAABB(el) }));
    const key: 'left' | 'top' = axis === 'h' ? 'left' : 'top';
    const sizeKey: 'w' | 'h' = axis === 'h' ? 'w' : 'h';
    items.sort((p, q) => p.a[key] - q.a[key]);
    const first = items[0], last = items[items.length - 1];
    const totalSize = items.reduce((s, i) => s + i.a[sizeKey], 0);
    const span = (axis === 'h' ? last.a.right - first.a.left : last.a.bottom - first.a.top);
    const gap = (span - totalSize) / (items.length - 1);
    let cursor = first.a[key];
    items.forEach(i => {
        const delta = cursor - i.a[key];
        if (axis === 'h') i.el.x = round2(i.el.x + delta);
        else i.el.y = round2(i.el.y + delta);
        syncElement(i.el.id);
        cursor += i.a[sizeKey] + gap;
    });
    commit();
}

export function layerAction(action: string): void {
    const ids = new Set(state.selection);
    if (!ids.size) return;
    const order = sortedElements();
    const picked = order.filter(e => ids.has(e.id));
    if (!picked.length) return;
    const rest = order.filter(e => !ids.has(e.id));
    const firstIdx = order.findIndex(e => ids.has(e.id));
    if (action === 'top') rest.push(...picked);
    else if (action === 'bottom') rest.unshift(...picked);
    else if (action === 'up') rest.splice(Math.min(firstIdx + 1, rest.length), 0, ...picked);
    else if (action === 'down') rest.splice(Math.max(firstIdx - 1, 0), 0, ...picked);
    normalizeZFromOrder(rest);
    renderAll(); applySelectionClasses(); commit();
}

export function startRelLayer(type: 'under' | 'above'): void {
    if (state.selection.length !== 1) return;
    state.layerPick = { type, id: state.selection[0] };
    $<HTMLButtonElement>('btnRelUnder').disabled = true; $<HTMLButtonElement>('btnRelAbove').disabled = true;
    $('relLayerMsg').style.display = 'block';
    document.body.style.cursor = 'crosshair';
}

export function endRelLayer(): void {
    state.layerPick = null;
    $<HTMLButtonElement>('btnRelUnder').disabled = false; $<HTMLButtonElement>('btnRelAbove').disabled = false;
    $('relLayerMsg').style.display = 'none';
    document.body.style.cursor = 'default';
}

export function handleLayerPick(targetId: string): void {
    const pick = state.layerPick;
    if (!pick) return;
    if (targetId === pick.id) { toast('不能选择自己', 'error'); return; }
    const order = sortedElements().filter(e => e.id !== pick.id);
    const selected = getEl(pick.id);
    const idx = order.findIndex(e => e.id === targetId);
    if (idx < 0 || !selected) { endRelLayer(); return; }
    order.splice(pick.type === 'under' ? idx : idx + 1, 0, selected);
    normalizeZFromOrder(order);
    renderAll(); applySelectionClasses();
    endRelLayer(); commit();
}