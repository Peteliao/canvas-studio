/* 检查器中的形状特征参数卡片：按选中类型动态生成滑块 + 数值输入 */
import { $, clamp, round2 } from './utils';
import { state } from './state';
import { getEl } from './model';
import { syncElement } from './render';
import { scheduleCommit } from './history';
import { shapeParamSpecs } from './shapes';
import type { ShapeParamSpec } from './shapes';
import type { CanvasElement, ElementType } from './types';

let builtType: ElementType | null = null;

function valueOf(el: CanvasElement, spec: ShapeParamSpec): number {
    if (spec.key === 'corner') return el.borderRadius;
    const v = el.shapeParams[spec.key];
    return typeof v === 'number' && Number.isFinite(v) ? v : spec.def;
}

function buildRows(specs: ShapeParamSpec[]): void {
    const rows = $('shapeParamRows');
    rows.innerHTML = '';
    specs.forEach(spec => {
        const row = document.createElement('div');
        row.className = 'shape-param-row';
        row.dataset.key = spec.key;
        row.innerHTML =
            `<span class="control-label">${spec.label}</span>` +
            `<input type="range" class="shape-param-range" min="${spec.min}" max="${spec.max}" step="${spec.step}" aria-label="${spec.label}">` +
            `<input type="number" class="num-mini shape-param-num" min="${spec.min}" max="${spec.max}" step="${spec.step}" aria-label="${spec.label}数值">` +
            `<span class="shape-param-unit">${spec.unit || ''}</span>`;
        rows.appendChild(row);
    });
}

export function syncShapeParamPanel(el: CanvasElement | null): void {
    const card = $('shapeParamCard');
    const specs = el ? shapeParamSpecs(el.type) : null;
    if (!el || !specs || !specs.length) {
        card.style.display = 'none';
        builtType = null;
        $('shapeParamRows').innerHTML = '';
        return;
    }
    card.style.display = 'block';
    if (el.type !== builtType) {
        buildRows(specs);
        builtType = el.type;
    }
    $('shapeParamHint').textContent = el.type === 'rect'
        ? '圆角与下方填充卡片同步 · 实时生效'
        : '基于基础轮廓实时调整 · 导出与画布一致';
    const rows = $('shapeParamRows');
    specs.forEach(spec => {
        const row = rows.querySelector<HTMLElement>(`.shape-param-row[data-key="${spec.key}"]`);
        if (!row) return;
        const v = valueOf(el, spec);
        const range = row.querySelector<HTMLInputElement>('.shape-param-range');
        const num = row.querySelector<HTMLInputElement>('.shape-param-num');
        if (range && document.activeElement !== range) range.value = String(v);
        if (num && document.activeElement !== num) num.value = String(round2(v));
        if (range) range.disabled = el.locked;
        if (num) num.disabled = el.locked;
    });
}

function applyParam(el: CanvasElement, spec: ShapeParamSpec, raw: string): void {
    if (el.locked) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const v = clamp(round2(parsed), spec.min, spec.max);
    if (spec.key === 'corner') {
        el.borderRadius = v;
        const radiusInput = $<HTMLInputElement>('borderRadiusInput');
        const radiusVal = $('radiusVal');
        if (document.activeElement !== radiusInput) radiusInput.value = String(Math.round(v));
        radiusVal.textContent = String(Math.round(v));
    } else {
        el.shapeParams[spec.key] = v;
    }
    const row = $('shapeParamRows').querySelector<HTMLElement>(`.shape-param-row[data-key="${spec.key}"]`);
    if (row) {
        const range = row.querySelector<HTMLInputElement>('.shape-param-range');
        const num = row.querySelector<HTMLInputElement>('.shape-param-num');
        if (range && document.activeElement !== range) range.value = String(v);
        if (num && document.activeElement !== num) num.value = String(v);
    }
    syncElement(el.id);
    scheduleCommit(120);
}

function targetRow(e: Event): { el: CanvasElement; spec: ShapeParamSpec; input: HTMLInputElement } | null {
    const input = e.target as HTMLElement;
    if (!(input instanceof HTMLInputElement)) return null;
    const row = input.closest<HTMLElement>('.shape-param-row');
    if (!row || !row.dataset.key) return null;
    if (state.selection.length !== 1) return null;
    const el = getEl(state.selection[0]);
    if (!el) return null;
    const spec = shapeParamSpecs(el.type)?.find(s => s.key === row.dataset.key);
    return spec ? { el, spec, input } : null;
}

export function bindShapeParamControls(): void {
    const rows = $('shapeParamRows');
    rows.addEventListener('input', e => {
        const t = targetRow(e);
        if (!t) return;
        applyParam(t.el, t.spec, t.input.value);
    });
    rows.addEventListener('change', e => {
        const t = targetRow(e);
        if (!t || t.input.type !== 'number') return;
        const v = clamp(round2(Number(t.input.value)), t.spec.min, t.spec.max);
        if (Number.isFinite(v)) t.input.value = String(v);
    });
}
