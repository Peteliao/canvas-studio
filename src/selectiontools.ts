/* 选中物件浮动工具条：临时隔离显示 + 样式刷 */
import type { CanvasElement, StrokeGradient } from './types';
import { state } from './state';
import { $, $opt, clamp, deepCopy, iconEl, toast } from './utils';
import { getEl, selectedEls, curveFillOn, curveStrokeOn, makeStroke } from './model';
import { selectionAABB } from './geometry';
import { syncElement } from './render';
import { commit } from './history';

export type StyleMode = 'all' | 'fill' | 'strokeWidth' | 'stroke' | 'width';
interface SourceStroke { color: string; width: number; gradient: StrokeGradient | null; }

const STYLE_OPTIONS: { mode: StyleMode; icon: string; label: string; short: string; cls?: string }[] = [
    { mode: 'all', icon: 'style-all', label: '全部样式：填充 + 描边 + 粗细', short: '全部样式', cls: 'style-all' },
    { mode: 'fill', icon: 'style-fill', label: '应用填充', short: '填充' },
    { mode: 'strokeWidth', icon: 'style-stroke-width', label: '应用描边和粗细', short: '描边和粗细' },
    { mode: 'stroke', icon: 'style-stroke', label: '应用描边', short: '描边' },
    { mode: 'width', icon: 'style-width', label: '应用描边粗细', short: '粗细' }
];

let measureRefresh: (() => void) | null = null;
let styleMenuTargetId: string | null = null;

/** 由 measure 模块注入重绘钩子，避免直接循环依赖 */
export function setSelectionToolsMeasureRefresh(fn: () => void): void {
    measureRefresh = fn;
}
function refreshMeasure(): void { measureRefresh?.(); }

function sourceHasFill(el: CanvasElement): boolean {
    if (el.type === 'line') return false;
    if (el.type === 'curve') return curveFillOn(el);
    return !!el.fill.enabled;
}

function sourceStroke(el: CanvasElement): SourceStroke | null {
    if (el.type === 'text') return null;
    if (el.type === 'line') {
        return { color: el.line?.color || '#000000', width: Math.max(0, el.line?.width || 0), gradient: null };
    }
    if (el.type === 'curve') {
        if (!curveStrokeOn(el)) return null;
        return {
            color: el.line?.color || '#000000',
            width: Math.max(0, el.line?.width || 0),
            gradient: el.stroke?.gradient ? deepCopy(el.stroke.gradient) : null
        };
    }
    if (!el.stroke || !(el.stroke.width > 0)) return null;
    return {
        color: el.stroke.color,
        width: el.stroke.width,
        gradient: el.stroke.gradient ? deepCopy(el.stroke.gradient) : null
    };
}

function targetSupports(target: CanvasElement, mode: StyleMode): boolean {
    if (mode === 'fill') return target.type !== 'line' && !(target.type === 'curve' && !target.curve?.closed);
    return target.type !== 'text';
}

export function styleOptionEnabled(source: CanvasElement, target: CanvasElement, mode: StyleMode): boolean {
    const fill = sourceHasFill(source);
    const stroke = sourceStroke(source);
    if (mode === 'fill') return fill && targetSupports(target, 'fill');
    if (mode === 'stroke') return !!stroke && targetSupports(target, 'stroke');
    if (mode === 'width') return !!stroke && stroke.width > 0 && targetSupports(target, 'width');
    if (mode === 'strokeWidth') return !!stroke && stroke.width > 0 && targetSupports(target, 'strokeWidth');
    return fill && !!stroke && stroke.width > 0 && targetSupports(target, 'fill') && targetSupports(target, 'stroke');
}

function applyStroke(target: CanvasElement, stroke: SourceStroke): void {
    const gradient = stroke.gradient ? deepCopy(stroke.gradient) : null;
    if (target.type === 'line') {
        target.line!.color = stroke.color;
        return;
    }
    if (target.type === 'curve') {
        target.curve!.strokeOn = true;
        target.line!.color = stroke.color;
        target.stroke = Object.assign({}, target.stroke || makeStroke(null), { color: stroke.color, gradient });
        return;
    }
    const prev = target.stroke || makeStroke(null);
    target.stroke = Object.assign({}, prev, {
        color: stroke.color,
        gradient,
        width: prev.width > 0 ? prev.width : 1
    });
}

function applyWidth(target: CanvasElement, width: number): void {
    if (target.type === 'line' || target.type === 'curve') {
        target.line!.width = width;
        if (target.type === 'curve') target.curve!.strokeOn = true;
    } else {
        target.stroke.width = width;
    }
}

/** 纯模型操作：供交互与自检复用 */
export function applyStyleToElement(source: CanvasElement, target: CanvasElement, mode: StyleMode): boolean {
    if (!styleOptionEnabled(source, target, mode)) return false;
    if (mode === 'fill' || mode === 'all') {
        target.fill = deepCopy(source.fill);
        if (target.type === 'text') target.text!.runs.forEach(r => { r.color = ''; });
        if (target.type === 'curve') target.curve!.filled = true;
    }
    const stroke = sourceStroke(source);
    if ((mode === 'stroke' || mode === 'strokeWidth' || mode === 'all') && stroke) applyStroke(target, stroke);
    if ((mode === 'width' || mode === 'strokeWidth' || mode === 'all') && stroke) applyWidth(target, stroke.width);
    return true;
}

function hideStyleMenu(): void {
    const menu = $opt('styleBrushMenu');
    if (menu) { menu.hidden = true; menu.textContent = ''; }
    styleMenuTargetId = null;
}

function openStyleMenu(target: CanvasElement, clientX: number, clientY: number): void {
    const source = getEl(state.stylePickSource || '');
    const menu = $opt('styleBrushMenu');
    if (!source || !menu) return;
    menu.textContent = '';
    STYLE_OPTIONS.forEach((opt, i) => {
        if (i === 1) {
            const sep = document.createElement('span');
            sep.className = 'style-sep';
            sep.setAttribute('aria-hidden', 'true');
            menu.appendChild(sep);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = opt.cls || '';
        b.title = opt.label;
        b.setAttribute('aria-label', opt.label);
        b.appendChild(iconEl(opt.icon));
        b.disabled = !styleOptionEnabled(source, target, opt.mode);
        if (b.disabled) b.title = opt.label + '（源物件缺少该项或目标不支持）';
        b.addEventListener('pointerdown', ev => { ev.stopPropagation(); });
        b.addEventListener('click', ev => {
            ev.preventDefault(); ev.stopPropagation();
            if (b.disabled) return;
            applyStyleFromMenu(opt);
        });
        menu.appendChild(b);
    });
    menu.hidden = false;
    styleMenuTargetId = target.id;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const mr = menu.getBoundingClientRect();
    const vr = $('viewport').getBoundingClientRect();
    let x = clientX + 14;
    let y = clientY + 14;
    if (x + mr.width > vr.right - 8) x = clientX - mr.width - 14;
    if (y + mr.height > vr.bottom - 8) y = clientY - mr.height - 14;
    x = clamp(x, vr.left + 8, Math.max(vr.left + 8, vr.right - mr.width - 8));
    y = clamp(y, vr.top + 8, Math.max(vr.top + 8, vr.bottom - mr.height - 8));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function applyStyleFromMenu(opt: { mode: StyleMode; short: string }): void {
    const source = getEl(state.stylePickSource || '');
    const target = getEl(styleMenuTargetId || '');
    if (!source || !target) { hideStyleMenu(); cancelStylePickCore(); return; }
    if (!applyStyleToElement(source, target, opt.mode)) return;
    syncElement(target.id);
    commit();
    toast(`已应用${opt.short}到「${target.name}」`, 'success');
    hideStyleMenu();
}

function setIsolationCore(on: boolean): void {
    state.isolating = on;
    const canvas = $opt('canvas');
    if (canvas) canvas.classList.toggle('isolating', on);
}

function cancelStylePickCore(): void {
    state.stylePickSource = null;
    hideStyleMenu();
    $opt('viewport')?.classList.remove('style-picking');
}

export function cancelStylePick(silent = false): void {
    if (!state.stylePickSource) { hideStyleMenu(); return; }
    cancelStylePickCore();
    syncSelectionTools();
    if (!silent) toast('已退出样式刷');
}

export function startStylePick(): void {
    if (state.selection.length !== 1) return;
    const source = getEl(state.selection[0]);
    if (!source) return;
    if (state.isolating) {
        setIsolationCore(false);
        refreshMeasure();
    }
    state.stylePickSource = source.id;
    hideStyleMenu();
    $('viewport').classList.add('style-picking');
    syncSelectionTools();
    toast('样式刷：点击目标物件，选择要应用的样式；可连续应用，Esc 退出', 'success');
}

export function toggleIsolation(): void {
    if (!state.selection.length) return;
    if (state.stylePickSource) cancelStylePickCore();
    const on = !state.isolating;
    setIsolationCore(on);
    syncSelectionTools();
    refreshMeasure();
    toast(on ? '已隔离：只显示选中物件' : '已显示全部物件', 'success');
}

export function exitIsolation(silent = false): void {
    if (!state.isolating) return;
    setIsolationCore(false);
    syncSelectionTools();
    refreshMeasure();
    if (!silent) toast('已显示全部物件');
}

/** 样式刷模式下拦截画布点击：点目标物件弹出选项，点空白退出 */
export function handleStylePickPointerDown(e: PointerEvent): boolean {
    if (!state.stylePickSource) return false;
    const source = getEl(state.stylePickSource);
    if (!source || !state.selection.includes(source.id) || state.tool !== 'select') {
        cancelStylePickCore();
        return false;
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>('.canvas-element');
    if (!target) {
        cancelStylePick(true);
        e.preventDefault();
        return true;
    }
    const el = getEl(target.dataset.id || '');
    if (!el) { cancelStylePickCore(); return false; }
    e.preventDefault();
    if (el.id === source.id) {
        toast('这是样式源，请点击其它物件', '');
        return true;
    }
    if (el.locked) {
        toast('目标物件已锁定，无法应用样式', '');
        return true;
    }
    openStyleMenu(el, e.clientX, e.clientY);
    return true;
}

function viewportRightLimit(vw: number): number {
    const insp = $opt('inspector');
    if (!insp || insp.classList.contains('collapsed') || getComputedStyle(insp).position !== 'absolute') return vw - 6;
    const ir = insp.getBoundingClientRect(), vr = $('viewport').getBoundingClientRect();
    if (ir.left >= vr.right || ir.right <= vr.left) return vw - 6;
    return clamp(ir.left - vr.left - 12, 140, vw - 6);
}

export function syncSelectionTools(): void {
    const tools = $opt('selectionTools');
    if (!tools) return;
    const selected = selectedEls();
    const visible = state.tool === 'select' && selected.length > 0 && !state.isTextEditing && !state.guideSel;

    if (!selected.length || state.tool !== 'select') {
        if (state.isolating) setIsolationCore(false);
        if (state.stylePickSource) cancelStylePickCore();
    } else if (state.stylePickSource && !state.selection.includes(state.stylePickSource)) {
        cancelStylePickCore();
    }
    $opt('canvas')?.classList.toggle('isolating', state.isolating);

    if (!visible) {
        tools.hidden = true;
        hideStyleMenu();
        return;
    }

    const isolateBtn = $opt<HTMLButtonElement>('btnQuickIsolate');
    const styleBtn = $opt<HTMLButtonElement>('btnQuickStyle');
    const sep = $opt('quickToolsSep');
    const single = selected.length === 1;
    if (isolateBtn) {
        const icon = state.isolating ? 'eye' : 'eye-off';
        if (isolateBtn.dataset.icon !== icon) {
            isolateBtn.textContent = '';
            isolateBtn.appendChild(iconEl(icon));
            isolateBtn.dataset.icon = icon;
        }
        isolateBtn.classList.toggle('active', state.isolating);
        const title = state.isolating ? '显示全部物件' : '隐藏其它物件（隔离）';
        isolateBtn.title = title;
        isolateBtn.setAttribute('aria-label', title);
    }
    if (styleBtn) {
        styleBtn.hidden = !single;
        if (styleBtn.dataset.icon !== 'style-brush') {
            styleBtn.textContent = '';
            styleBtn.appendChild(iconEl('style-brush'));
            styleBtn.dataset.icon = 'style-brush';
        }
        const active = !!state.stylePickSource;
        styleBtn.classList.toggle('active', active);
        const title = active ? '退出样式刷（Esc）' : '样式刷：复制填充、描边与粗细';
        styleBtn.title = title;
        styleBtn.setAttribute('aria-label', title);
    }
    if (sep) sep.hidden = !single;

    tools.hidden = false;
    const box = selectionAABB();
    if (!box) { tools.hidden = true; return; }
    const vp = $('viewport');
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const w = tools.offsetWidth || (single ? 68 : 34);
    const h = tools.offsetHeight || 34;
    const zoom = state.zoom || 1;
    const screenRight = state.pan.x + box.right * zoom;
    const screenTop = state.pan.y + box.top * zoom;
    const screenBottom = state.pan.y + box.bottom * zoom;
    const limit = viewportRightLimit(vw);
    const maxX = Math.max(6, Math.min(vw - w - 6, limit - w));
    let x = clamp(screenRight - w, 6, maxX);
    let y = screenTop - h - 9;
    if (y < 6) y = screenBottom + 9;
    y = clamp(y, 6, Math.max(6, vh - h - 6));
    tools.style.left = x + 'px';
    tools.style.top = y + 'px';
}

let toolsBound = false;
export function bindSelectionTools(): void {
    if (toolsBound) return;
    toolsBound = true;
    $('btnQuickIsolate').addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        toggleIsolation();
    });
    $('btnQuickStyle').addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (state.stylePickSource) cancelStylePick();
        else startStylePick();
    });
}

/* 点击面板/检查器时收起样式选项，但保持样式刷模式 */
document.addEventListener('pointerdown', e => {
    const menu = $opt('styleBrushMenu');
    if (!menu || menu.hidden) return;
    const t = e.target as HTMLElement;
    if (t.closest('.style-brush-menu')) return;
    hideStyleMenu();
}, true);
