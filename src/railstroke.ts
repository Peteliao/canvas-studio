/* 左侧色板卡：描边粗细滑块（作用于选中物件，等同属性面板描边宽度） */
import { $, $opt, clamp, finite } from './utils';
import { makeLine, makeStroke, selectedEls } from './model';
import { syncElement } from './render';
import { scheduleCommit } from './history';
import type { CanvasElement } from './types';

function widthTargets(): CanvasElement[] {
    return selectedEls().filter(e => !e.locked && e.type !== 'text');
}

function elementWidth(el: CanvasElement): number {
    return el.type === 'line' || el.type === 'curve'
        ? finite(el.line && el.line.width, 1)
        : finite(el.stroke && el.stroke.width, 0);
}

export function syncRailStrokeWidth(): void {
    const input = $opt<HTMLInputElement>('railStrokeWidth');
    if (!input) return;
    const row = $opt('railStrokeRow'), val = $opt('railStrokeWidthVal');
    const el = widthTargets()[0];
    const disabled = !el;
    input.disabled = disabled;
    if (row) row.classList.toggle('disabled', disabled);
    const v = el ? Math.round(elementWidth(el)) : 0;
    input.value = String(v);
    if (val) val.textContent = disabled ? '—' : String(v);
    const hint = disabled ? '选中物件后可调整描边粗细' : '描边粗细：拖动调整选中物件';
    input.title = hint;
    if (row) row.title = hint;
}

export function applyRailStrokeWidth(): void {
    const input = $opt<HTMLInputElement>('railStrokeWidth');
    if (!input) return;
    const v = clamp(finite(input.value, 0), 0, 30);
    const els = widthTargets();
    if (!els.length) { syncRailStrokeWidth(); return; }
    els.forEach(e => {
        if (e.type === 'line' || e.type === 'curve') {
            e.line = makeLine(Object.assign({}, e.line, { width: Math.max(1, v) }));
        } else {
            e.stroke = makeStroke(Object.assign({}, e.stroke, { width: v }));
        }
        syncElement(e.id);
    });
    const first = els[0];
    if (first.type === 'line' || first.type === 'curve') {
        const lw = String(Math.max(1, Math.round(v)));
        $<HTMLInputElement>('lineWidthRange').value = lw;
        $<HTMLInputElement>('lineWidthInput').value = lw;
    } else {
        $<HTMLInputElement>('strokeWidth').value = String(first.stroke.width);
        $('strokeWidthVal').textContent = String(first.stroke.width);
    }
    syncRailStrokeWidth();
    scheduleCommit();
}
