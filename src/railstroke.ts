/* 填充/描边弹窗：描边粗细滑块与数值输入（作用于选中物件） */
import { $opt, clamp, finite } from './utils';
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

export function syncPaintStrokeWidth(): void {
    const range = $opt<HTMLInputElement>('paintPopWidthRange');
    const num = $opt<HTMLInputElement>('paintPopWidthNum');
    const row = $opt('paintPopWidth');
    const hint = $opt('paintPopWidthHint');
    if (!range || !num || !row) return;
    const el = widthTargets()[0];
    const disabled = !el;
    range.disabled = disabled;
    num.disabled = disabled;
    row.classList.toggle('disabled', disabled);
    const v = el ? Math.round(elementWidth(el)) : 0;
    if (document.activeElement !== range) range.value = String(v);
    if (document.activeElement !== num) num.value = disabled ? '' : String(v);
    const tip = disabled ? '选中物件后可调整描边粗细' : '拖动滑块或输入数值，实时生效';
    range.title = tip;
    num.title = tip;
    if (hint) hint.textContent = tip;
}

export function applyPaintStrokeWidth(source: 'range' | 'number'): void {
    const range = $opt<HTMLInputElement>('paintPopWidthRange');
    const num = $opt<HTMLInputElement>('paintPopWidthNum');
    if (!range || !num) return;
    const raw = source === 'range' ? range.value : num.value;
    if (raw.trim() === '') { syncPaintStrokeWidth(); return; }
    const v = clamp(finite(raw, 0), 0, 30);
    const els = widthTargets();
    if (!els.length) { syncPaintStrokeWidth(); return; }
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
        const lr = $opt<HTMLInputElement>('lineWidthRange');
        const li = $opt<HTMLInputElement>('lineWidthInput');
        if (lr) lr.value = lw;
        if (li) li.value = lw;
    } else {
        const sw = $opt<HTMLInputElement>('strokeWidth');
        const swv = $opt('strokeWidthVal');
        if (sw) sw.value = String(first.stroke.width);
        if (swv) swv.textContent = String(first.stroke.width);
    }
    syncPaintStrokeWidth();
    scheduleCommit(120);
}
