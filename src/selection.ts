/* 选择 */
import { state } from './state';
import { $, setIcon, toast } from './utils';
import { getEl, selectedEls } from './model';
import { lineHeightFor } from './style';
import { selectionAABB } from './geometry';
import { applySelectionClasses } from './render';
import { updateUI } from './panel';
import { commit } from './history';
import { finishTextEdit } from './richtext';
import { endRelLayer } from './layers';
import { expandGroupIds } from './layerlist';
import { syncBucketFromSelection } from './bucket';
import { syncSelectionTools } from './selectiontools';

function groupUnitIds(id: string): string[] {
    const el = getEl(id);
    if (!el || !el.groupId) return [id];
    return state.model.elements.filter(e => e.groupId === el.groupId).map(e => e.id);
}

function refreshGeoRatio(): void {
    if (!state.geoRatioLocked) return;
    const els = selectedEls();
    if (!els.length) { state.geoRatioLocked = false; updateGeoLockButton(); return; }
    if (els.length === 1) {
        state.geoRatio = els[0].w / Math.max(1, lineHeightFor(els[0]));
    } else {
        const box = selectionAABB();
        if (box) state.geoRatio = box.w / Math.max(1, box.h);
    }
}
export function setSelection(ids: string[]): void {
    const valid = ids.filter(id => !!getEl(id));
    state.selection = expandGroupIds(valid);
    state.transformMode = false;
    refreshGeoRatio();
    applySelectionClasses();
    updateUI();
    syncBucketFromSelection();
}
export function deselectAll(): void {
    if (state.isTextEditing) finishTextEdit();
    state.selection = [];
    state.guideSel = null;
    state.transformMode = false;
    applySelectionClasses();
    state.geoRatioLocked = false;
    updateGeoLockButton();
    endRelLayer();
    updateUI();
}
export function toggleSelection(id: string, additive: boolean): void {
    const unit = groupUnitIds(id);
    if (additive) {
        const allSelected = unit.every(x => state.selection.includes(x));
        if (allSelected) {
            const drop = new Set(unit);
            state.selection = state.selection.filter(x => !drop.has(x));
        } else {
            unit.forEach(x => { if (!state.selection.includes(x)) state.selection.push(x); });
        }
    } else {
        state.selection = unit.slice();
    }
    state.transformMode = false;
    refreshGeoRatio();
    applySelectionClasses();
    updateUI();
    syncBucketFromSelection();
}
/** 二次点击选中物件：进入 / 退出旋转与倾斜变换模式 */
export function setTransformMode(on: boolean): void {
    const next = on && state.selection.length > 0 && state.tool === 'select';
    if (state.transformMode === next) return;
    state.transformMode = next;
    applySelectionClasses();
    syncSelectionTools();
    if (next) toast('变换模式：拖角点旋转，拖上下边中点左右倾斜，拖左右边中点上下倾斜；点击空白退出', 'success');
}
export function updateGeoLockButton(): void {
    const btn = $('btnGeoLock');
    btn.classList.toggle('active', state.geoRatioLocked);
    setIcon(btn, state.geoRatioLocked ? 'link' : 'unlink');
}
export function toggleSelectionLock(): void {
    state.geoRatioLocked = !state.geoRatioLocked;
    refreshGeoRatio();
    updateGeoLockButton();
}
export function toggleCanvasLock(): void {
    state.canvasRatioLocked = !state.canvasRatioLocked;
    state.model.canvas.lockedRatio = state.canvasRatioLocked;
    const btn = $('btnCanvasLock');
    btn.classList.toggle('active', state.canvasRatioLocked);
    setIcon(btn, state.canvasRatioLocked ? 'link' : 'unlink');
    if (state.canvasRatioLocked) state.canvasRatio = state.model.canvas.w / state.model.canvas.h;
    commit();
}