import { HEX_RE } from './constants';
import { state, nodeMap } from './state';
import { $opt, finite } from './utils';
import { getEl, makeStroke } from './model';
import { hexToRgba } from './style';
import { syncElement } from './render';
import { saveSettings } from './db';
import { clientToWorld, worldToLocalPoint } from './interaction';
import type { BucketSlot, CanvasElement } from './types';

const BUCKET_FILL_DEFAULT = '#4f6bff', BUCKET_STROKE_DEFAULT = '#1c2230';

export const bucketSlotLabel = (s: BucketSlot): string => s === 'stroke' ? '描边' : '填充';

export function bucketColor(slot: BucketSlot): string {
    const s = state.settings;
    const v = slot === 'stroke' ? s.bucketStrokeColor : s.bucketFillColor;
    return HEX_RE.test(v) ? v : (slot === 'stroke' ? BUCKET_STROKE_DEFAULT : BUCKET_FILL_DEFAULT);
}

export function setBucketColor(slot: BucketSlot, color: string): void {
    if (!HEX_RE.test(color)) return;
    if (slot === 'stroke') state.settings.bucketStrokeColor = color;
    else state.settings.bucketFillColor = color;
    state.bucketSlot = slot;
    saveSettings();
    syncBucketSwatch();
}

/** 为指定色槽打开隐藏的原生取色器 */
export function openBucketPicker(slot?: BucketSlot): void {
    const input = $opt<HTMLInputElement>('bucketColorInput');
    if (!input) return;
    state.bucketSlot = slot || 'fill';
    input.value = bucketColor(state.bucketSlot);
    syncBucketSwatch();
    if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch { /* 回退到 click */ }
    }
    input.click();
}

export function syncBucketSwatch(): void {
    const fill = bucketColor('fill'), stroke = bucketColor('stroke');
    const fChip = $opt('bucketFillChip'), sChip = $opt('bucketStrokeChip');
    if (fChip) fChip.style.background = fill;
    if (sChip) sChip.style.background = stroke;
    const fSlot = $opt('bucketFillSlot'), sSlot = $opt('bucketStrokeSlot');
    if (fSlot) {
        fSlot.title = '填充色 ' + fill.toUpperCase() + '：点此选色';
        fSlot.classList.toggle('active', state.bucketSlot !== 'stroke');
    }
    if (sSlot) {
        sSlot.title = '描边色 ' + stroke.toUpperCase() + '：点此选色';
        sSlot.classList.toggle('active', state.bucketSlot === 'stroke');
    }
    const btn = $opt('railBucket');
    if (btn) btn.title = '颜料桶 (B)：填充 ' + fill.toUpperCase() + ' · 描边 ' + stroke.toUpperCase()
        + '；点内部改填充、点边缘改描边，Shift 强制描边，Alt+点击吸色，拖动连续上色';
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

/** 按识别结果写入对应颜色：stroke 改描边，fill 改填充 */
export function applyBucketColor(el: CanvasElement | null, target: BucketSlot, color: string): boolean {
    if (!el || el.locked || el.visible === false || !HEX_RE.test(color)) return false;
    const stroke = target === 'stroke';
    if (stroke && (el.type === 'line' || el.type === 'curve')) {
        el.line!.color = color;
        if (el.type === 'curve') el.curve!.strokeOn = true;
    } else if (stroke && el.type === 'text') {
        el.fill.color = color;
        el.text!.runs.forEach(r => { r.color = ''; });
    } else if (stroke) {
        el.stroke = makeStroke(Object.assign({}, el.stroke, {
            color, width: Math.max(1, finite(el.stroke && el.stroke.width, 0))
        }));
    } else if (el.type === 'line' || (el.type === 'curve' && !(el.curve && el.curve.closed))) {
        el.line!.color = color;
    } else if (el.type === 'text') {
        el.fill.color = color;
        el.text!.runs.forEach(r => { r.color = ''; });
    } else {
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
    d.style.setProperty('--bucket-hi', color);
    if (target === 'stroke') d.style.removeProperty('--bucket-hi-fade');
    else d.style.setProperty('--bucket-hi-fade', hexToRgba(color, .22));
    const chip = $opt('bucketHoverChip'), text = $opt('bucketHoverText');
    if (chip) chip.style.background = color;
    if (text) text.textContent = bucketSlotLabel(target) + ' · ' + color.toUpperCase();
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
    tip.classList.add('on');
}