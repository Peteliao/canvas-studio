import { MAX_CANVAS_SIDE } from './constants';
import type { ElementType } from './types';
import { state } from './state';
import { $, clamp, deepCopy, finite, round2, toast, uid } from './utils';
import { buildElement, getEl, nextZIndex, selectedEls, validateElement } from './model';
import { lineHeightFor } from './style';
import { renderAll, syncCanvasSize, syncElement, updateTextStats } from './render';
import { commit, scheduleCommit } from './history';
import { canvasCenterFor } from './view';
import { selectionAABB, setPivot } from './geometry';
import { setSelection } from './selection';
import { updatePropPanel, updateUI } from './panel';
import { syncGeoInputs, syncPivotInputs } from './interaction';
import { drawMeasure } from './measure';

export function addShape(type: ElementType): void {
    const proto = buildElement(type, 0, 0);
    const pos = canvasCenterFor(proto.w, proto.type === 'line' ? lineHeightFor(proto) : proto.h);
    proto.x = round2(pos.x); proto.y = round2(pos.y);
    state.model.elements.push(proto);
    renderAll();
    setSelection([proto.id]);
    commit();
}

export function deleteSelected(): void {
    const removable = selectedEls().filter(e => !e.locked).map(e => e.id);
    const lockedCount = state.selection.length - removable.length;
    if (!removable.length) {
        if (lockedCount) toast('选中的元素已锁定，无法删除', 'error');
        return;
    }
    state.model.elements = state.model.elements.filter(e => !removable.includes(e.id));
    state.selection = [];
    renderAll(); updateUI();
    commit();
    if (lockedCount) toast(`已删除 ${removable.length} 个元素，${lockedCount} 个锁定元素被保留`, 'success');
}

export function duplicateSelected(): void {
    const src = selectedEls();
    if (!src.length) return;
    const clones = src.map(e => {
        const c = deepCopy(e);
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false;
        // 副本默认脱离原组合与关联，是否建立属性同步由用户显式点击按钮决定
        c.groupId = null; c.linkId = null;
        return validateElement(c);
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
}

export function copyToClipboard(): void {
    if (!state.selection.length) return;
    state.clipboard = selectedEls().map(deepCopy);
    toast(`已复制 ${state.clipboard.length} 个元素`, 'success');
}

export function pasteFromClipboard(): void {
    if (!state.clipboard.length) return;
    const clones = state.clipboard.map(e => {
        const c = validateElement(deepCopy(e));
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false;
        c.groupId = null; c.linkId = null;
        return c;
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
}

export function toggleLock(): void {
    const els = selectedEls(); if (!els.length) return;
    const allLocked = els.every(e => e.locked);
    els.forEach(e => { e.locked = !allLocked; syncElement(e.id); });
    updateUI(); commit();
}

export function toggleExportVisibility(): void {
    const els = selectedEls(); if (!els.length) return;
    const visible = $<HTMLInputElement>('chkExportVisible').checked;
    els.forEach(e => { e.exportVisible = visible; syncElement(e.id); });
    commit();
}

export function centerOnCanvas(): void {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    const box = selectionAABB();
    if (!box) return;
    const dx = (state.model.canvas.w - box.w) / 2 - box.left;
    const dy = (state.model.canvas.h - box.h) / 2 - box.top;
    els.forEach(e => { e.x = round2(e.x + dx); e.y = round2(e.y + dy); syncElement(e.id); });
    if (els.length === 1) syncGeoInputs(els[0]);
    commit();
}

export function updateGeo(type: 'x' | 'y' | 'w' | 'h' | 'r'): void {
    if (state.selection.length !== 1) return;
    const el = getEl(state.selection[0]);
    if (!el) return;
    if (el.locked) { toast('元素已锁定，无法修改', 'error'); updatePropPanel(el); return; }
    const map = { x: 'geoX', y: 'geoY', w: 'geoW', h: 'geoH', r: 'geoR' } as const;
    const value = finite($<HTMLInputElement>(map[type]).value, NaN);
    if (Number.isNaN(value)) return;
    const ratioLocked = state.geoRatioLocked && el.type !== 'line';
    const ratio = ratioLocked ? el.w / Math.max(1, lineHeightFor(el)) : state.geoRatio;
    if (ratioLocked) state.geoRatio = ratio;
    if (type === 'x') el.x = value;
    else if (type === 'y') el.y = value;
    else if (type === 'w') {
        el.w = Math.max(1, value);
        if (ratioLocked) { el.h = round2(Math.max(1, el.w / ratio)); $<HTMLInputElement>('geoH').value = String(Math.round(el.h)); }
    } else if (type === 'h') {
        el.h = Math.max(1, value);
        if (ratioLocked) { el.w = round2(Math.max(1, el.h * ratio)); $<HTMLInputElement>('geoW').value = String(Math.round(el.w)); }
    } else if (type === 'r') { el.rotation = value; }
    if (el.type === 'text' && (type === 'w' || type === 'h') && el.text!.sizeMode !== 'fixed') {
        el.text!.sizeMode = 'fixed';
        $<HTMLSelectElement>('textSizeMode').value = 'fixed';
    }
    if (el.type === 'text') updateTextStats(el);
    syncElement(el.id);
    drawMeasure();
    scheduleCommit();
}

export function updatePivotInput(axis: 'x' | 'y'): void {
    if (state.selection.length !== 1) return;
    const el = getEl(state.selection[0]);
    if (!el || el.locked) { if (el) syncPivotInputs(el); return; }
    const v = finite($<HTMLInputElement>(axis === 'x' ? 'pivotXInput' : 'pivotYInput').value, 50);
    if (axis === 'x') setPivot(el, v / 100, el.pivotY, true);
    else setPivot(el, el.pivotX, v / 100, true);
    syncElement(el.id);
    syncGeoInputs(el);
    drawMeasure();
    scheduleCommit();
}

export function resetPivot(): void {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    els.forEach(el => {
        setPivot(el, 0.5, 0.5, true);
        syncElement(el.id);
    });
    if (els.length === 1) syncGeoInputs(els[0]);
    drawMeasure();
    commit();
    toast('旋转中心已复位到元素正中', 'success');
}

export function moveSelected(dx: number, dy: number): void {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    els.forEach(e => { e.x = round2(e.x + dx); e.y = round2(e.y + dy); syncElement(e.id); });
    if (els.length === 1) syncGeoInputs(els[0]);
    drawMeasure();
    scheduleCommit(160);
}

export function resizeCanvasSize(source?: string): void {
    const c = state.model.canvas;
    let w = finite($<HTMLInputElement>('canvasW').value, c.w), h = finite($<HTMLInputElement>('canvasH').value, c.h);
    w = clamp(w, 1, MAX_CANVAS_SIDE); h = clamp(h, 1, MAX_CANVAS_SIDE);
    if (state.canvasRatioLocked) {
        if (source === 'w') { h = Math.round(w / state.canvasRatio); $<HTMLInputElement>('canvasH').value = String(h); }
        else if (source === 'h') { w = Math.round(h * state.canvasRatio); $<HTMLInputElement>('canvasW').value = String(w); }
    }
    c.w = w; c.h = h;
    syncCanvasSize();
    scheduleCommit();
}