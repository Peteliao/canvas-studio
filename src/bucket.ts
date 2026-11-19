import { HEX_RE, PRESET_COLORS } from './constants';
import { state, nodeMap } from './state';
import { $opt, clamp, finite, toast } from './utils';
import { getEl, makeStroke, curveFillOn, curveStrokeOn, selectedEls } from './model';
import { hexToRgba } from './style';
import { syncElement } from './render';
import { saveSettings } from './db';
import { commit, scheduleCommit } from './history';
import { clientToWorld, worldToLocalPoint } from './interaction';
import { syncPaintStrokeWidth, applyPaintStrokeWidth } from './railstroke';
import { updateUI } from './panel';
import type { BucketSlot, CanvasElement } from './types';

const BUCKET_FILL_DEFAULT = '#4f6bff', BUCKET_STROKE_DEFAULT = '#1c2230';

export const bucketSlotLabel = (s: BucketSlot): string => s === 'stroke' ? '描边' : '填充';

export function bucketColor(slot: BucketSlot): string {
    const s = state.settings;
    const v = slot === 'stroke' ? s.bucketStrokeColor : s.bucketFillColor;
    if (v === 'none') return 'none';
    return HEX_RE.test(v) ? v : (slot === 'stroke' ? BUCKET_STROKE_DEFAULT : BUCKET_FILL_DEFAULT);
}

/** 色槽显示文案：无填充/无描边，或大写 HEX */
export function bucketColorLabel(slot: BucketSlot): string {
    const c = bucketColor(slot);
    return c === 'none' ? '无' + bucketSlotLabel(slot) : c.toUpperCase();
}

export function setBucketColor(slot: BucketSlot, color: string): void {
    if (color !== 'none' && !HEX_RE.test(color)) return;
    if (slot === 'stroke') state.settings.bucketStrokeColor = color;
    else state.settings.bucketFillColor = color;
    state.bucketSlot = slot;
    saveSettings();
    syncBucketSwatch();
}

/** 非颜料桶工具且有选中物件时，色槽点击 / “无”直接编辑选中物件，而非设置涂色 */
export function bucketEditsSelection(): boolean {
    return state.tool !== 'bucket' && state.selection.length > 0;
}

let pickerEditsSelection = false;
let paintAnchor: HTMLElement | null = null;

export function isPaintPopoverOpen(): boolean {
    const p = $opt('paintPopover');
    return !!p && !p.hidden;
}

export function closePaintPopover(): void {
    const p = $opt('paintPopover');
    if (p) p.hidden = true;
    paintAnchor?.classList.remove('popover-open');
    paintAnchor = null;
}

function ensurePaintSwatches(): void {
    const box = $opt('paintPopSwatches');
    if (!box || box.childElementCount) return;
    PRESET_COLORS.slice(0, 14).forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'paint-pop-swatch';
        b.dataset.paintColor = c;
        b.style.background = c;
        b.title = c.toUpperCase();
        b.setAttribute('aria-label', '颜色 ' + c.toUpperCase());
        box.appendChild(b);
    });
}

export function syncPaintPopover(): void {
    const p = $opt('paintPopover');
    if (!p || p.hidden) return;
    const slot = state.bucketSlot || 'fill';
    const label = bucketSlotLabel(slot);
    const color = bucketColor(slot);
    const title = $opt('paintPopTitle'), hex = $opt('paintPopHex');
    const chip = $opt('paintPopChip'), none = $opt<HTMLButtonElement>('paintPopNone');
    const width = $opt('paintPopWidth');
    if (title) title.textContent = label + '设置';
    if (hex) hex.textContent = color === 'none' ? '无' + label : color.toUpperCase();
    if (chip) {
        chip.style.background = color === 'none' ? '' : color;
        chip.classList.toggle('none', color === 'none');
    }
    if (none) {
        none.textContent = '无' + label;
        none.classList.toggle('active', color === 'none');
        none.title = bucketEditsSelection()
            ? '去掉选中物件的' + label
            : '把' + label + '色槽设为“无”，颜料桶不再涂' + label;
    }
    const sw = $opt('paintPopSwatches');
    if (sw) {
        sw.querySelectorAll<HTMLElement>('[data-paint-color]').forEach(b => {
            b.classList.toggle('active', b.dataset.paintColor === color);
        });
    }
    if (width) width.hidden = slot !== 'stroke';
    if (slot === 'stroke') syncPaintStrokeWidth();
}

/** 点击左侧色槽：打开自定义设置弹窗（颜色 / 无填充无描边 / 描边粗细） */
export function openBucketPicker(slot: BucketSlot = 'fill', editsSelection = false, anchor?: HTMLElement | null): void {
    const p = $opt('paintPopover');
    if (!p) return;
    const nextAnchor = anchor || $opt(slot === 'stroke' ? 'bucketStrokeSlot' : 'bucketFillSlot');
    const same = !p.hidden && paintAnchor === nextAnchor && state.bucketSlot === slot;
    state.bucketSlot = slot;
    pickerEditsSelection = editsSelection;
    if (same) { closePaintPopover(); return; }
    paintAnchor?.classList.remove('popover-open');
    paintAnchor = nextAnchor;
    paintAnchor?.classList.add('popover-open');
    ensurePaintSwatches();
    p.hidden = false;
    syncBucketSwatch();
    const r = paintAnchor?.getBoundingClientRect();
    const pw = p.offsetWidth || 222, ph = p.offsetHeight || 260;
    const left = clamp((r ? r.right + 10 : 76), 8, Math.max(8, window.innerWidth - pw - 8));
    const top = clamp((r ? r.top - 6 : 120), 8, Math.max(8, window.innerHeight - ph - 8));
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
}

/** 弹窗中的“选择颜色…”：打开原生取色器，保留弹窗 */
export function openNativePaintPicker(): void {
    const input = $opt<HTMLInputElement>('bucketColorInput');
    if (!input) return;
    const slot = state.bucketSlot || 'fill';
    const cur = bucketColor(slot);
    input.value = cur === 'none' ? (slot === 'stroke' ? BUCKET_STROKE_DEFAULT : BUCKET_FILL_DEFAULT) : cur;
    if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch { /* 回退到 click */ }
    }
    input.click();
}

/** 弹窗色板：立即应用到选中物件或当前色槽 */
export function applyPaintColorNow(color: string): void {
    if (!HEX_RE.test(color)) return;
    const slot = state.bucketSlot || 'fill';
    if (pickerEditsSelection && bucketEditsSelection()) applySlotToSelection(slot, color);
    else setBucketColor(slot, color);
}

/** 弹窗“无填充/无描边”：编辑选中物件或把色槽设为无 */
export function applyPaintNone(): void {
    const slot = state.bucketSlot || 'fill';
    if (pickerEditsSelection && bucketEditsSelection()) {
        const changed = applySlotToSelection(slot, 'none');
        toast(changed ? '已去除选中物件的' + bucketSlotLabel(slot) : '选中物件没有可去除的' + bucketSlotLabel(slot), changed ? 'success' : 'error');
    } else {
        setBucketColor(slot, 'none');
        toast('色槽已设为无' + bucketSlotLabel(slot), 'success');
    }
}

export function bindPaintPopoverControls(): void {
    ensurePaintSwatches();
    $opt('paintPopPick')?.addEventListener('click', () => openNativePaintPicker());
    $opt('paintPopNone')?.addEventListener('click', () => applyPaintNone());
    $opt('paintPopClose')?.addEventListener('click', () => closePaintPopover());
    $opt('paintPopSwatches')?.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('[data-paint-color]');
        if (b && b.dataset.paintColor) applyPaintColorNow(b.dataset.paintColor);
    });
    const range = $opt<HTMLInputElement>('paintPopWidthRange');
    const num = $opt<HTMLInputElement>('paintPopWidthNum');
    range?.addEventListener('input', () => applyPaintStrokeWidth('range'));
    num?.addEventListener('input', () => applyPaintStrokeWidth('number'));
    num?.addEventListener('change', () => applyPaintStrokeWidth('number'));
    document.addEventListener('pointerdown', e => {
        const p = $opt('paintPopover');
        if (!p || p.hidden) return;
        const t = e.target as Element;
        if (p.contains(t) || t.closest('#bucketFillSlot, #bucketStrokeSlot')) return;
        closePaintPopover();
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !isPaintPopoverOpen()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closePaintPopover();
    }, true);
    window.addEventListener('resize', () => closePaintPopover());
}

/** 拖动取色器时实时预览；确认由 commitBucketPicker 落历史并提示 */
export function previewBucketPicker(color: string): void {
    if (!HEX_RE.test(color)) return;
    const slot = state.bucketSlot || 'fill';
    if (pickerEditsSelection && bucketEditsSelection()) {
        selectedEls().forEach(e => { applyBucketColor(e, slot, color); });
        setBucketColor(slot, color);
        scheduleCommit();
        return;
    }
    setBucketColor(slot, color);
    if (state.tool === 'bucket') syncBucketSwatch();
}

/** 取色器确认：编辑选中物件 或 设置颜料桶涂色 */
export function commitBucketPicker(color: string): void {
    const slot = state.bucketSlot || 'fill';
    const edit = pickerEditsSelection;
    pickerEditsSelection = false;
    if (edit && bucketEditsSelection()) {
        if (applySlotToSelection(slot, color)) toast('已修改选中物件' + bucketSlotLabel(slot) + '色', 'success');
    } else {
        setBucketColor(slot, color);
    }
}

/** 把填充/描边颜色（或 'none'）应用到选中物件并同步色槽，返回是否有改动 */
export function applySlotToSelection(slot: BucketSlot, color: string): boolean {
    let changed = false;
    selectedEls().forEach(e => { if (applyBucketColor(e, slot, color)) changed = true; });
    if (changed) commit();
    setBucketColor(slot, color);
    syncBucketFromSelection();
    if (changed) updateUI();
    return changed;
}

export function syncBucketSwatch(): void {
    const fill = bucketColor('fill'), stroke = bucketColor('stroke');
    const fChip = $opt('bucketFillChip'), sChip = $opt('bucketStrokeChip');
    if (fChip) { fChip.style.background = fill === 'none' ? '' : fill; fChip.classList.toggle('none', fill === 'none'); }
    if (sChip) { sChip.style.background = stroke === 'none' ? '' : stroke; sChip.classList.toggle('none', stroke === 'none'); }
    const fSlot = $opt('bucketFillSlot'), sSlot = $opt('bucketStrokeSlot');
    const editHint = bucketEditsSelection() ? '：点击打开设置并修改选中物件' : '：点击打开颜色与样式设置';
    if (fSlot) {
        fSlot.title = '填充色 ' + bucketColorLabel('fill') + editHint;
        fSlot.classList.toggle('active', state.bucketSlot !== 'stroke');
    }
    if (sSlot) {
        sSlot.title = '描边色 ' + bucketColorLabel('stroke') + editHint;
        sSlot.classList.toggle('active', state.bucketSlot === 'stroke');
    }
    syncPaintPopover();
    const btn = $opt('railBucket');
    if (btn) btn.title = '颜料桶 (B)：填充 ' + bucketColorLabel('fill') + ' · 描边 ' + bucketColorLabel('stroke')
        + '；点内部改填充、点边缘改描边，Shift 强制描边，Alt+点击吸色，拖动连续上色';
}

/** 读取元素在指定色槽上的当前状态；无填充/无描边返回 'none'（渐变取起始色） */
export function elementSlotColor(el: CanvasElement, slot: BucketSlot): string {
    if (slot === 'stroke') {
        if (el.type === 'line') return el.line!.color;
        if (el.type === 'curve') return curveStrokeOn(el) ? el.line!.color : 'none';
        if (el.type === 'text') return 'none';
        return el.stroke && el.stroke.width > 0 ? el.stroke.color : 'none';
    }
    if (el.type === 'line' || el.image) return 'none';
    if (el.type === 'curve') return curveFillOn(el) ? (el.fill.mode === 'solid' ? el.fill.color : el.fill.start) : 'none';
    if (!el.fill.enabled) return 'none';
    return el.fill.mode === 'solid' ? el.fill.color : el.fill.start;
}

/** 选中单个物件时，双色槽自动获取其填充色与描边状态 */
export function syncBucketFromSelection(): void {
    if (state.selection.length !== 1) return;
    const el = getEl(state.selection[0]);
    if (!el) return;
    state.settings.bucketFillColor = elementSlotColor(el, 'fill');
    state.settings.bucketStrokeColor = elementSlotColor(el, 'stroke');
    saveSettings();
    syncBucketSwatch();
}

export function bucketHitElement(x: number, y: number, target?: EventTarget | null): CanvasElement | null {
    const t = target as HTMLElement | null;
    let d: HTMLElement | null = t && t.closest ? t.closest<HTMLElement>('.canvas-element') : null;
    // 尺寸标注、选框手柄等浮层可能盖在元素中心，逐层向下找真正的画布元素
    if (!d && typeof document.elementsFromPoint === 'function') {
        for (const n of document.elementsFromPoint(x, y)) {
            const c = n.closest<HTMLElement>('.canvas-element');
            if (c) { d = c; break; }
        }
    }
    if (!d) {
        const node = document.elementFromPoint(x, y);
        if (node && node.closest) d = node.closest<HTMLElement>('.canvas-element');
    }
    return d ? getEl(d.dataset.id || '') : null;
}

/** 交互识别：点在描边带上改描边，点在内部改填充；无填充概念的元素一律按描边处理 */
export function bucketDetectTarget(el: CanvasElement | null, x: number, y: number, e?: { shiftKey: boolean }): BucketSlot {
    if (!el) return 'fill';
    if (e && e.shiftKey) return 'stroke';
    if (el.type === 'line' || (el.type === 'curve' && !(el.curve && el.curve.closed))) return 'stroke';
    const loc = worldToLocalPoint(el, clientToWorld(x, y));
    const edgePx = 8 / (state.zoom || 1);   // 边缘命中带按屏幕像素换算到元素局部坐标
    if (el.type === 'curve') {
        const d = nodeMap.get(el.id);
        const path = d && d.querySelector<SVGPathElement>('.curve-svg path');
        if (path && typeof path.isPointInStroke === 'function' && typeof DOMPoint === 'function') {
            const old = path.getAttribute('stroke-width');
            try {
                // 临时放大描边命中带，缩放后也能轻松点到细描边
                path.setAttribute('stroke-width', String(2 * edgePx + finite(el.line!.width, 3)));
                const pt = new DOMPoint(loc.x, loc.y);
                if (path.isPointInStroke(pt)) return 'stroke';
                if (path.isPointInFill(pt)) return 'fill';
                return 'stroke';   // 路径之外视为描边带，便于重新启用已关闭的描边
            } catch { /* 回退到内部判定 */ }
            finally {
                if (old !== null) path.setAttribute('stroke-width', old);
                else path.removeAttribute('stroke-width');
            }
        }
        return 'fill';
    }
    const sw = Math.max(edgePx, finite(el.stroke && el.stroke.width, 0) + edgePx);
    if (loc.x <= sw || loc.y <= sw || loc.x >= el.w - sw || loc.y >= el.h - sw) return 'stroke';
    return 'fill';
}

/** 按识别结果写入对应颜色：stroke 改描边，fill 改填充；'none' 表示无填充/无描边 */
export function applyBucketColor(el: CanvasElement | null, target: BucketSlot, color: string): boolean {
    if (!el || el.locked || el.visible === false) return false;
    const none = color === 'none';
    if (!none && !HEX_RE.test(color)) return false;
    const stroke = target === 'stroke';
    if (stroke && (el.type === 'line' || el.type === 'curve')) {
        if (none) {
            if (el.type === 'line') return false;   // 线条本身就是描边，不支持“无”
            el.curve!.strokeOn = false;
        } else {
            el.line!.color = color;
            if (el.type === 'curve') {
                el.curve!.strokeOn = true;
                el.stroke = makeStroke(Object.assign({}, el.stroke, { color, gradient: null }));
            }
        }
    } else if (stroke && el.type === 'text') {
        if (none) return false;   // 文本没有描边概念
        el.fill.enabled = true;
        el.fill.color = color;
        el.text!.runs.forEach(r => { r.color = ''; });
    } else if (stroke) {
        el.stroke = makeStroke(Object.assign({}, el.stroke, none ? { width: 0, gradient: null } : {
            color, gradient: null, width: Math.max(1, finite(el.stroke && el.stroke.width, 0))
        }));
    } else if (el.type === 'line' || (el.type === 'curve' && !(el.curve && el.curve.closed))) {
        if (none) return false;   // 开放路径只有描边
        el.line!.color = color;
    } else if (el.type === 'text') {
        if (none) el.fill.enabled = false;
        else {
            el.fill.enabled = true;
            el.fill.color = color;
            el.text!.runs.forEach(r => { r.color = ''; });
        }
    } else if (none) {
        if (el.image) return false;   // 图片没有可去掉的底色
        if (el.type === 'curve') el.curve!.filled = false;
        else el.fill.enabled = false;
    } else {
        el.fill.enabled = true;
        el.fill.mode = 'solid';
        el.fill.color = color;
        if (el.type === 'curve') el.curve!.filled = true;
    }
    syncElement(el.id);
    return true;
}

/* -------------------- 颜料桶悬停预览 -------------------- */
let bucketHoverEl: string | null = null;

export function hideBucketHover(): void {
    const tip = $opt('bucketHover');
    if (tip) tip.classList.remove('on');
    const d = bucketHoverEl ? nodeMap.get(bucketHoverEl) : undefined;
    if (d) {
        delete d.dataset.bucketTarget;
        d.style.removeProperty('--bucket-hi');
        d.style.removeProperty('--bucket-hi-fade');
    }
    bucketHoverEl = null;
}

export function updateBucketHover(e: MouseEvent): void {
    const tip = $opt('bucketHover');
    if (!tip) return;
    const el = bucketHitElement(e.clientX, e.clientY, e.target);
    if (!el || el.locked || el.visible === false) { hideBucketHover(); return; }
    const target = bucketDetectTarget(el, e.clientX, e.clientY, e);
    const color = bucketColor(target);
    if (bucketHoverEl !== el.id) hideBucketHover();
    const d = nodeMap.get(el.id);
    if (!d) { hideBucketHover(); return; }
    bucketHoverEl = el.id;
    d.dataset.bucketTarget = target;
    const none = color === 'none';
    d.style.setProperty('--bucket-hi', none ? 'transparent' : color);
    if (target === 'stroke' || none) d.style.removeProperty('--bucket-hi-fade');
    else d.style.setProperty('--bucket-hi-fade', hexToRgba(color, .22));
    const chip = $opt('bucketHoverChip'), text = $opt('bucketHoverText');
    if (chip) { chip.style.background = none ? '' : color; chip.classList.toggle('none', none); }
    if (text) text.textContent = bucketSlotLabel(target) + ' · ' + (none ? '无' + bucketSlotLabel(target) : color.toUpperCase());
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
    tip.classList.add('on');
}