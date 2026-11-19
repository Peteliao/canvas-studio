/* 选择 */
import { state } from './state';
import { $, setIcon } from './utils';
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
    refreshGeoRatio();
    applySelectionClasses();
    updateUI();
    syncBucketFromSelection();
}
export function deselectAll(): void {
    if (state.isTextEditing) finishTextEdit();
    state.selection = [];
    state.guideSel = null;
    applySelectionClasses();
    state.geoRatioLocked = false;
    updateGeoLockButton();
    endRelLayer();
    updateUI();
}
export function toggleSelection(id: string, additive: boolean): void {
    if (additive) {
        const i = state.selection.indexOf(id);
        if (i >= 0) state.selection.splice(i, 1); else state.selection.push(id);
    } else {
        if (state.selection.length > 1 && state.selection.includes(id)) return;
        state.selection = [id];
    }
    refreshGeoRatio();
    applySelectionClasses();
    updateUI();
    syncBucketFromSelection();
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