/* 全局快捷键 */
import { state } from './state';
import { $, round2, dialogCancel, visibleModalId } from './utils';
import { selectedEls } from './model';
import { undo, redo, scheduleCommit } from './history';
import { fitToScreen } from './view';
import { setSelection, deselectAll, setTransformMode } from './selection';
import { duplicateSelected, deleteSelected, addShape, moveSelected } from './elements';
import { exportConfig } from './project';
import { groupSelected, ungroupSelected, expandGroupIds } from './layerlist';
import { toggleSetting, toggleMeasureType } from './theme';
import { newProject } from './projects';
import { showShortcuts } from './actions';
import { setTool } from './tools';
import { finishPen, cancelPen, renderPenDraft } from './interaction';
import { finishTextEdit, startTextEdit } from './richtext';
import { currentGuide, guideGeom, drawGuides, deleteGuide } from './guides';
import { drawMeasure } from './measure';
import { endRelLayer } from './layers';
import { closeModal } from './cropper';
import { copyToClipboardSystem, pasteFromClipboardSystem } from './clipboard';
import { cancelStylePick, exitIsolation } from './selectiontools';

export function isInputActive(): boolean {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable);
}
// 仅文本录入类控件（文本输入框 / 多行文本 / 下拉 / 可编辑区）需要拦截快捷键；
// 滑块、颜色、开关等控件聚焦时快捷键应照常工作。
export function isTextEntryActive(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return false;
    if (a.isContentEditable) return true;
    if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
    if (a.tagName === 'INPUT') {
        const type = (a as HTMLInputElement).type;
        return type !== 'range' && type !== 'color' && type !== 'checkbox' && type !== 'radio'
            && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file';
    }
    return false;
}
const FULLWIDTH_DIGITS = '１２３４５６';
/** 兼容中文输入法的 Process/Unidentified 键值、全角数字与小键盘 */
function measureDigit(e: KeyboardEvent): number | null {
    const k = e.key;
    if (k.length === 1) {
        if (k >= '1' && k <= '6') return Number(k);
        const i = FULLWIDTH_DIGITS.indexOf(k);
        return i >= 0 ? i + 1 : null;
    }
    if (k !== 'Process' && k !== 'Unidentified' && k !== '') return null;
    const m = /^(?:Digit|Numpad)([1-6])$/.exec(e.code);
    if (m) return Number(m[1]);
    if (e.keyCode >= 49 && e.keyCode <= 54) return e.keyCode - 48;
    if (e.keyCode >= 97 && e.keyCode <= 102) return e.keyCode - 96;
    return null;
}

export function bindHotkeys(): void {
    document.addEventListener('keydown', e => {
        const modalId = visibleModalId();
        if (modalId) {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (modalId === 'appDialog') dialogCancel();
                else closeModal(modalId);
            }
            return;
        }
        if (e.isComposing) return;
        const keyTarget = e.target instanceof HTMLElement ? e.target : null;
        if (keyTarget?.closest('button, a, [role="button"]') && (e.key === 'Enter' || e.code === 'Space')) return;
        const ctrl = e.ctrlKey || e.metaKey;
        // 数字键 1–5（或 Alt+1–5）：五类标注；6（或 Alt+6）：智能捕捉
        // 放在文本拦截之前：颜色/滑块等控件聚焦后也能直接使用；输入框内保留普通数字，
        // 但 Alt+数字 始终生效，避免焦点在数值框时快捷键失效
        const digit = measureDigit(e);
        const altToggle = digit !== null && e.altKey && !ctrl && !e.getModifierState('AltGraph');
        const plainToggle = digit !== null && !e.altKey && !ctrl && !isTextEntryActive();
        if (digit !== null && (altToggle || plainToggle) && !e.repeat) {
            e.preventDefault();
            if (digit === 6) { toggleSetting('snap', '智能捕捉'); return; }
            const kinds = ['size', 'canvas', 'gap', 'align', 'guide'] as const;
            const kind = kinds[digit - 1];
            if (kind) toggleMeasureType(kind);
            return;
        }
        const typing = isInputActive();

        // 编辑态一律让浏览器原生处理，避免文本内撤销误重建画布 / 丢字
        if (typing) {
            if (ctrl && e.key === 'Enter') {
                e.preventDefault();
                if (state.isTextEditing) finishTextEdit();
                else if (document.activeElement) (document.activeElement as HTMLElement).blur();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (state.isTextEditing) finishTextEdit();
                else if ($('exportModal').style.display === 'flex') closeModal('exportModal');
                else if (document.activeElement) (document.activeElement as HTMLElement).blur();
            }
            return;
        }
        if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
        if (ctrl && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
        if (e.altKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) { e.preventDefault(); fitToScreen(); return; }
        if (ctrl && e.code === 'KeyC') { e.preventDefault(); void copyToClipboardSystem(); return; }
        if (ctrl && e.code === 'KeyV') { e.preventDefault(); void pasteFromClipboardSystem(); return; }
        if (ctrl && e.code === 'KeyA') { e.preventDefault(); setSelection(expandGroupIds(state.model.elements.map(x => x.id))); return; }
        if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicateSelected(); return; }
        if (ctrl && e.code === 'KeyS') { e.preventDefault(); void exportConfig(); return; }
        if (ctrl && e.code === 'KeyG') { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); return; }
        if (ctrl && e.code === 'Quote') { e.preventDefault(); toggleSetting('grid', '网格'); return; }
        if (ctrl && e.altKey && e.code === 'KeyN') { e.preventDefault(); void newProject(); return; }
        if (!ctrl && !e.altKey && e.key === '?') { e.preventDefault(); showShortcuts(); return; }
        if (!ctrl && !e.altKey && (e.key === 'v' || e.key === 'V')) { setTool('select'); return; }
        if (!ctrl && !e.altKey && (e.key === 'h' || e.key === 'H')) { setTool('pan'); return; }
        if (!ctrl && !e.altKey && (e.key === 't' || e.key === 'T')) { setTool('text'); return; }
        if (!ctrl && !e.altKey && (e.key === 'p' || e.key === 'P')) { setTool(state.tool === 'pen' ? 'select' : 'pen'); return; }
        if (!ctrl && !e.altKey && (e.key === 'b' || e.key === 'B')) { setTool('bucket'); return; }
        if (!ctrl && !e.altKey && (e.key === 'r' || e.key === 'R')) { addShape('rect'); return; }
        if (state.pen) {
            if (e.key === 'Enter') { e.preventDefault(); finishPen(false); return; }
            if (e.key === 'Escape') { e.preventDefault(); cancelPen(); return; }
            if (e.key === 'Backspace') {
                e.preventDefault();
                if (state.pen.nodes.length > 1) state.pen.nodes.pop();
                else cancelPen();
                renderPenDraft();
                return;
            }
        }
        if (!ctrl && !e.altKey && (e.key === 'Enter' || e.key === 'F2')) {
            const els = selectedEls();
            if (els.length === 1 && els[0].type === 'text' && !els[0].locked) { e.preventDefault(); startTextEdit(els[0]); }
            return;
        }

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
            if (state.guideSel) {
                const g = currentGuide();
                if (!g) return;
                e.preventDefault();
                const step = state.moveStep * (e.shiftKey ? 10 : 1);
                const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
                const dy = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
                const { n } = guideGeom(g);
                const d = n.x * dx + n.y * dy;   // 只沿法向移动才会改变距离
                g.x = round2(g.x + n.x * d);
                g.y = round2(g.y + n.y * d);
                drawGuides(); drawMeasure(); scheduleCommit(160);
                return;
            }
            if (!state.selection.length) return;
            e.preventDefault();
            const step = state.moveStep * (e.shiftKey ? 10 : 1);
            moveSelected(e.code === 'ArrowUp' ? 0 : e.code === 'ArrowDown' ? 0 : e.code === 'ArrowLeft' ? -step : step,
                e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0);
            return;
        }
        if (e.code === 'Space' && !state.spaceDown) {
            e.preventDefault(); state.spaceDown = true;
            $('viewport').classList.add('panning'); return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (state.guideSel) deleteGuide(state.guideSel);
            else deleteSelected();
            return;
        }
        if (e.key === 'Escape') {
            const openModal = ['shortcutsModal', 'selftestModal', 'aboutModal', 'exportModal', 'cropModal']
                .find(id => $(id).style.display === 'flex');
            if (openModal) closeModal(openModal);
            else if (state.stylePickSource) cancelStylePick();
            else if (state.isolating) exitIsolation();
            else if (state.layerPick) endRelLayer();
            else if (state.interaction && state.interaction.kind === 'crop') state.interaction = null;
            else if (state.transformMode) setTransformMode(false);
            else deselectAll();
        }
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space') {
            state.spaceDown = false;
            $('viewport').classList.remove('panning');
        }
    });
}