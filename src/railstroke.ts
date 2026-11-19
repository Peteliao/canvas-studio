/* 填充/描边弹窗：描边粗细滑块与数值输入（作用于选中物件） */
import { $opt, clamp, finite } from './utils';
import { getEl, makeLine, makeStroke, selectedEls } from './model';
import { syncElement } from './render';
import { commit, hasPendingCommit, scheduleCommit } from './history';
import type { CanvasElement, Stroke, StrokeAlign } from './types';

function widthTargets(): CanvasElement[] {
    return selectedEls().filter(e => !e.locked && e.type !== 'text');
}

function elementWidth(el: CanvasElement): number {
    return el.type === 'line' || el.type === 'curve'
        ? finite(el.line && el.line.width, 1)
        : finite(el.stroke && el.stroke.width, 0);
}

/** 属性面板与左侧描边弹层共用同一份对齐状态 */
export function syncStrokeAlignControls(): void {
    const el = selectedEls()[0];
    const disabled = !el || el.type === 'line' || el.type === 'curve';
    const align: StrokeAlign = el && el.stroke && el.stroke.align ? el.stroke.align : 'center';
    (['outside', 'center', 'inside'] as const).forEach(a => {
        const cap = a[0].toUpperCase() + a.slice(1);
        [$opt<HTMLButtonElement>('btnStroke' + cap), $opt<HTMLButtonElement>('paintPopAlign' + cap)].forEach(b => {
            if (!b) return;
            b.classList.toggle('active', !disabled && align === a);
            b.setAttribute('aria-checked', String(!disabled && align === a));
            b.disabled = disabled;
        });
    });
}

/* -------------------- 描边对齐悬停试穿 -------------------- */
interface AlignPreviewRec { id: string; original: Stroke; applied: Stroke }
let alignPreview: AlignPreviewRec[] | null = null;
let previewBtn: Element | null = null;
let previewAlign: StrokeAlign | null = null;

function previewTargets(): CanvasElement[] {
    return selectedEls().filter(e => !e.locked && e.type !== 'line' && e.type !== 'curve');
}

/** 悬停试穿：快照原描边后临时改 align，只重绘、不落历史；点击时再正式提交 */
export function beginStrokeAlignPreview(align: StrokeAlign, btn?: Element | null): void {
    const els = previewTargets();
    if (!els.length) return;
    if (alignPreview && previewAlign === align && previewBtn === btn) return;
    if (!alignPreview) {
        if (hasPendingCommit()) commit(); // 先结算滑块的防抖提交，避免历史/自动保存混入未提交的试穿状态
        alignPreview = [];
    }
    // 撤销/外部替换后旧快照失效：引用不符的记录丢弃并重新快照
    alignPreview = alignPreview.filter(r => {
        const el = getEl(r.id);
        return !!el && el.stroke === r.applied;
    });
    els.forEach(e => {
        let rec = alignPreview!.find(r => r.id === e.id);
        if (!rec) {
            rec = { id: e.id, original: e.stroke, applied: makeStroke(null) };
            alignPreview!.push(rec);
        }
        rec.applied = Object.assign({}, rec.original, { align });
        e.stroke = rec.applied;
        syncElement(e.id);
    });
    previewBtn = btn || null;
    previewAlign = align;
    document.querySelectorAll('[data-act="strokeAlign"]').forEach(b => b.classList.toggle('previewing', b === btn));
}

/** 结束试穿：还原快照；描边引用已被撤销/替换的元素跳过，避免覆盖新状态 */
export function endStrokeAlignPreview(): void {
    const recs = alignPreview;
    alignPreview = null;
    previewBtn = null;
    previewAlign = null;
    document.querySelectorAll('[data-act="strokeAlign"].previewing').forEach(b => b.classList.remove('previewing'));
    if (!recs) return;
    recs.forEach(r => {
        const el = getEl(r.id);
        if (!el || el.stroke !== r.applied) return;
        el.stroke = r.original;
        syncElement(r.id);
    });
}

export function bindStrokeAlignPreview(): void {
    const btnOf = (t: EventTarget | null): HTMLButtonElement | null =>
        t instanceof Element ? t.closest<HTMLButtonElement>('[data-act="strokeAlign"]') : null;
    document.addEventListener('pointerover', e => {
        const b = btnOf(e.target);
        if (!b || b.disabled) return;
        const a = b.dataset.arg;
        if (a === 'outside' || a === 'center' || a === 'inside') beginStrokeAlignPreview(a, b);
    });
    document.addEventListener('pointerout', e => {
        if (!btnOf(e.target)) return;
        if (btnOf(e.relatedTarget)) return;
        endStrokeAlignPreview();
    });
    window.addEventListener('blur', () => endStrokeAlignPreview());
}

export function syncPaintStrokeWidth(): void {
    syncStrokeAlignControls();
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
