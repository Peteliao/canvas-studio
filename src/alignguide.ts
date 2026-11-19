/* 描边对齐高亮预览：物件边界的高对比流动虚线 + 描边落点色带 + 模式标签
 * 只在悬停试穿、点击应用后的短暂反馈、或用户开启「边界虚线常显」时出现，不写入模型与历史 */
import { STROKE_ALIGN_LABELS, STROKE_SVG_TYPES, SVG_NS } from './constants';
import { selectedEls } from './model';
import { nodeMap, state } from './state';
import { alignZoneMarkup, boundaryMarkup } from './style';
import { $opt, clamp, finite, round2 } from './utils';
import type { CanvasElement, StrokeAlign } from './types';

const MODE_COLOR: Record<StrokeAlign, string> = { outside: '#f79009', center: '#4f6bff', inside: '#12b886' };
const MODE_HINT: Record<StrokeAlign, string> = {
    outside: '描边在边界外', center: '描边压在边界上', inside: '描边在边界内'
};

let preview: StrokeAlign | null = null;
let flash: StrokeAlign | null = null;
let flashTimer = 0;
let raf = 0;
let persistent = false;

function targets(): CanvasElement[] {
    return selectedEls().filter(e => !e.locked && e.type !== 'line' && e.type !== 'curve');
}
function currentAlign(): StrokeAlign {
    const el = targets()[0];
    return el && el.stroke && el.stroke.align ? el.stroke.align : 'center';
}
function activeMode(): StrokeAlign | null {
    return preview || flash || (persistent ? currentAlign() : null);
}
function clearDom(): void {
    document.querySelectorAll('.align-boundary, .align-zone-layer, .align-badge').forEach(n => n.remove());
    document.querySelectorAll('.canvas-element.sa-highlight').forEach(n => n.classList.remove('sa-highlight'));
}
export function syncBoundaryToggle(): void {
    const b = $opt<HTMLButtonElement>('btnBoundaryGuide');
    if (!b) return;
    b.classList.toggle('active', persistent);
    b.setAttribute('aria-pressed', String(persistent));
    b.title = persistent
        ? '边界虚线常显已开启：点击关闭（悬停三个模式按钮时始终高亮）'
        : '边界虚线常显：开启后选中物件始终高亮蓝色虚线边界与描边落点色带';
}
/** 重建全部高亮节点：虚线线宽、色带宽度、标签字号都按缩放折算，保持屏幕恒定尺寸 */
export function refreshAlignHighlight(): void {
    clearDom();
    syncBoundaryToggle();
    const mode = activeMode();
    if (!mode) return;
    const els = targets();
    if (!els.length) return;
    const z = clamp(finite(state.zoom, 1), 0.05, 16);
    els.forEach((el, i) => {
        const d = nodeMap.get(el.id);
        if (!d) return;
        d.classList.add('sa-highlight');
        if (i === 0) {
            const badge = document.createElement('div');
            badge.className = 'align-badge';
            badge.dataset.align = mode;
            badge.style.setProperty('--ab-color', MODE_COLOR[mode]);
            badge.style.fontSize = `${round2(10 / z)}px`;
            badge.innerHTML = `<span class="ab-dot"></span><span>蓝色虚线 = 物件边界</span><b>${STROKE_ALIGN_LABELS[mode]}</b><span class="ab-hint">${MODE_HINT[mode]}</span>`;
            d.appendChild(badge);
        }
        if (!STROKE_SVG_TYPES.includes(el.type)) return;   // 文本按字形描边，不画矩形边界框
        const sw = el.stroke ? Math.max(0, finite(el.stroke.width, 0)) : 0;
        const pad = Math.max(sw * 2, 14 / z) + 8 / z;
        const place = (svg: SVGSVGElement): void => {
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('viewBox', `${round2(-pad)} ${round2(-pad)} ${round2(el.w + pad * 2)} ${round2(el.h + pad * 2)}`);
            svg.style.left = `${round2(-pad)}px`;
            svg.style.top = `${round2(-pad)}px`;
            svg.style.width = `${round2(el.w + pad * 2)}px`;
            svg.style.height = `${round2(el.h + pad * 2)}px`;
            svg.style.setProperty('--ab-color', MODE_COLOR[mode]);
        };
        // 落点色带放在真实描边之下：粗描边保持原色不被染色，细/零描边时仍能看到落点提示
        const zone = document.createElementNS(SVG_NS, 'svg');
        zone.classList.add('align-zone-layer');
        zone.dataset.align = mode;
        place(zone);
        zone.innerHTML = alignZoneMarkup(el, mode, el.w, el.h, z);
        const strokeLayer = d.querySelector('.stroke-overlay');
        if (strokeLayer) d.insertBefore(zone, strokeLayer);
        else d.appendChild(zone);
        // 高亮虚线始终浮在最上层
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.classList.add('align-boundary');
        svg.dataset.align = mode;
        place(svg);
        svg.style.setProperty('--ab-glow', `${round2(1.4 / z)}px`);
        svg.style.setProperty('--ab-cycle', `${round2(-12 / z)}`);
        svg.innerHTML = `<g class="ab-guide">${boundaryMarkup(el, el.w, el.h, z)}</g>`;
        d.appendChild(svg);
    });
}
/** 同一帧内的多次模型 / 视图刷新合并为一次重建 */
export function scheduleAlignHighlight(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; refreshAlignHighlight(); });
}
/** 悬停试穿：立即高亮，并取消点击后的短暂反馈以免叠加 */
export function showAlignPreview(align: StrokeAlign): void {
    clearTimeout(flashTimer);
    flashTimer = 0;
    flash = null;
    preview = align;
    refreshAlignHighlight();
}
export function hideAlignPreview(): void {
    if (!preview) return;
    preview = null;
    refreshAlignHighlight();
}
/** 点击应用后保留 ~1.8 秒高亮，让用户看清最终落点；再次悬停会立刻接管 */
export function flashAlignHighlight(align: StrokeAlign, ms = 1800): void {
    clearTimeout(flashTimer);
    preview = null;
    flash = align;
    refreshAlignHighlight();
    flashTimer = window.setTimeout(() => {
        flash = null;
        flashTimer = 0;
        refreshAlignHighlight();
    }, ms);
}
export function toggleBoundaryGuide(): void {
    persistent = !persistent;
    refreshAlignHighlight();
}
export function isBoundaryGuideOn(): boolean {
    return persistent;
}
/** 窗口失焦 / 模型整体替换时清掉临时高亮，避免留下悬空节点 */
export function resetAlignHighlight(): void {
    clearTimeout(flashTimer);
    flashTimer = 0;
    preview = null;
    flash = null;
    refreshAlignHighlight();
}
