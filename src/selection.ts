/* 选择 */
import { state } from './state';
import { $, setIcon } from './utils';
import { getEl } from './model';
import { applySelectionClasses } from './render';
import { updateUI } from './panel';
import { commit } from './history';
import { finishTextEdit } from './richtext';
import { endRelLayer } from './layers';
import { expandGroupIds } from './layerlist';
import { syncBucketFromSelection } from './bucket';

export function setSelection(ids: string[]): void {
    const valid = ids.filter(id => !!getEl(id));
    state.selection = expandGroupIds(valid);
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
    if (state.geoRatioLocked && state.selection.length === 1) {
        const el = getEl(state.selection[0]);
        if (el) state.geoRatio = el.w / Math.max(1, el.h);
    }
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