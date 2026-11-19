/* 选中物件浮动工具条：临时隔离显示 + 样式刷 + 形状转换 */
import type { CanvasElement, ElementType, StrokeAlign, StrokeGradient } from './types';
import { TYPE_LABELS, VECTOR_SHAPE_TYPES, FLUID_SHAPE_TYPES, SHAPE_MENU_BASIC } from './constants';
import { state, nodeMap } from './state';
import { $, $opt, clamp, deepCopy, elementIconEl, iconEl, toast } from './utils';
import { getEl, selectedEls, curveFillOn, curveStrokeOn, makeStroke } from './model';
import { selectionAABB } from './geometry';
import { renderAll, syncElement, syncNode } from './render';
import { updateUI } from './panel';
import { commit } from './history';

export type StyleMode = 'all' | 'fill' | 'strokeWidth' | 'stroke' | 'width';
interface SourceStroke { color: string; width: number; gradient: StrokeGradient | null; align: StrokeAlign; }

const STYLE_OPTIONS: { mode: StyleMode; icon: string; label: string; short: string; cls?: string }[] = [
    { mode: 'all', icon: 'style-all', label: '全部样式：填充 + 描边 + 粗细', short: '全部样式', cls: 'style-all' },
    { mode: 'fill', icon: 'style-fill', label: '应用填充', short: '填充' },
    { mode: 'strokeWidth', icon: 'style-stroke-width', label: '应用描边和粗细', short: '描边和粗细' },
    { mode: 'stroke', icon: 'style-stroke', label: '应用描边', short: '描边' },
    { mode: 'width', icon: 'style-width', label: '应用描边粗细', short: '粗细' }
];

/** 可互相转换的轮廓类形状（线条 / 曲线 / 文本 / 图片 / 布尔不参与） */
const CONVERTIBLE: ElementType[] = [...SHAPE_MENU_BASIC, 'arrow', ...VECTOR_SHAPE_TYPES, ...FLUID_SHAPE_TYPES];

export function canConvertShape(el: CanvasElement): boolean {
    return CONVERTIBLE.includes(el.type);
}

/** 纯模型转换：保留填充/描边/投影/几何，仅替换轮廓类型 */
export function convertElementShape(e: CanvasElement, type: ElementType): boolean {
    if (!CONVERTIBLE.includes(type)) return false;
    const oldLabel = TYPE_LABELS[e.type] || '';
    e.type = type;
    e.shapeParams = {};
    if (oldLabel && (e.name === oldLabel || e.name.startsWith(oldLabel + ' '))) {
        e.name = TYPE_LABELS[type] + e.name.slice(oldLabel.length);
    }
    return true;
}

export function convertSelectedShape(type: ElementType): void {
    if (!CONVERTIBLE.includes(type)) return;
    const els = selectedEls().filter(e => !e.locked && canConvertShape(e));
    if (!els.length) { toast('请先选中一个可转换的形状', 'error'); return; }
    const newLabel = TYPE_LABELS[type];
    els.forEach(e => { convertElementShape(e, type); });
    renderAll();
    updateUI();
    commit();
    syncSelectionTools();
    toast(els.length > 1 ? `已转换 ${els.length} 个形状为${newLabel}` : `已转换为${newLabel}`, 'success');
}

let convertMenuBound = false;
function hideConvertMenu(): void {
    const menu = $opt('shapeConvertMenu');
    if (menu) menu.hidden = true;
}
function openConvertMenu(): void {
    const menu = $opt('shapeConvertMenu');
    const anchor = $opt('selectionTools');
    const el = selectedEls()[0];
    if (!menu || !anchor || !el || !canConvertShape(el) || el.locked) return;
    menu.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'convert-hint';
    hint.textContent = '转换保留填充、描边、投影与位置尺寸';
    menu.appendChild(hint);
    CONVERTIBLE.forEach(type => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = '转换为' + TYPE_LABELS[type];
        b.setAttribute('aria-label', b.title);
        b.classList.toggle('active', el.type === type);
        b.appendChild(elementIconEl(type));
        const span = document.createElement('span');
        span.textContent = TYPE_LABELS[type];
        b.appendChild(span);
        b.addEventListener('click', ev => {
            ev.preventDefault(); ev.stopPropagation();
            hideConvertMenu();
            if (el.type !== type) convertSelectedShape(type);
        });
        menu.appendChild(b);
    });
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const mr = menu.getBoundingClientRect();
    const vr = $('viewport').getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    let x = ar.left;
    let y = ar.bottom + 6;
    if (x + mr.width > vr.right - 8) x = vr.right - mr.width - 8;
    if (y + mr.height > vr.bottom - 8) y = ar.top - mr.height - 6;
    menu.style.left = clamp(x, vr.left + 8, Math.max(vr.left + 8, vr.right - mr.width - 8)) + 'px';
    menu.style.top = clamp(y, vr.top + 8, Math.max(vr.top + 8, vr.bottom - mr.height - 8)) + 'px';
    if (!convertMenuBound) {
        convertMenuBound = true;
        document.addEventListener('pointerdown', ev => {
            const m = $opt('shapeConvertMenu');
            if (!m || m.hidden) return;
            const t = ev.target as HTMLElement;
            if (t.closest('.shape-convert-menu') || t.closest('#btnQuickConvert')) return;
            hideConvertMenu();
        }, true);
    }
}

let measureRefresh: (() => void) | null = null;
let styleMenuTargetId: string | null = null;
let stylePreview: { targetId: string; mode: StyleMode } | null = null;

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
    if (el.type === 'line') {
        return { color: el.line?.color || '#000000', width: Math.max(0, el.line?.width || 0), gradient: null, align: 'center' };
    }
    if (el.type === 'curve') {
        if (!curveStrokeOn(el)) return null;
        return {
            color: el.line?.color || '#000000',
            width: Math.max(0, el.line?.width || 0),
            gradient: el.stroke?.gradient ? deepCopy(el.stroke.gradient) : null,
            align: 'center'
        };
    }
    if (!el.stroke || !(el.stroke.width > 0)) return null;
    return {
        color: el.stroke.color,
        width: el.stroke.width,
        gradient: el.stroke.gradient ? deepCopy(el.stroke.gradient) : null,
        align: el.stroke.align || 'center'
    };
}

function targetSupports(target: CanvasElement, mode: StyleMode): boolean {
    if (mode === 'fill') return target.type !== 'line' && !(target.type === 'curve' && !target.curve?.closed);
    return true;
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
        align: stroke.align,
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

/** 只渲染到 DOM 的临时预览，不修改模型，避免自动保存吸入预览状态 */
function previewStyleOption(target: CanvasElement, mode: StyleMode): void {
    const source = getEl(state.stylePickSource || '');
    if (!source || !styleOptionEnabled(source, target, mode)) {
        clearStylePreview();
        return;
    }
    if (stylePreview && stylePreview.targetId === target.id && stylePreview.mode === mode) return;
    clearStylePreview();
    const preview = deepCopy(target);
    if (!applyStyleToElement(source, preview, mode)) return;
    const d = nodeMap.get(target.id);
    if (!d) return;
    syncNode(preview, d);
    stylePreview = { targetId: target.id, mode };
}

function clearStylePreview(restore = true): void {
    const preview = stylePreview;
    stylePreview = null;
    if (!restore || !preview) return;
    const el = getEl(preview.targetId), d = nodeMap.get(preview.targetId);
    if (el && d) syncNode(el, d);
}

function hideStyleMenu(): void {
    clearStylePreview();
    const menu = $opt('styleBrushMenu');
    if (menu) { menu.hidden = true; menu.textContent = ''; }
    styleMenuTargetId = null;
}

function openStyleMenu(target: CanvasElement, clientX: number, clientY: number): void {
    const source = getEl(state.stylePickSource || '');
    const menu = $opt('styleBrushMenu');
    if (!source || !menu) return;
    clearStylePreview();
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
        b.addEventListener('pointerenter', () => {
            if (b.disabled) clearStylePreview();
            else previewStyleOption(target, opt.mode);
        });
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
    clearStylePreview(false);
    if (!applyStyleToElement(source, target, opt.mode)) return;
    syncElement(target.id);
    commit();
    toast(`已应用${opt.short}到「${target.name}」`, 'success');
    hideStyleMenu();
}

/** 右键：确认悬停中的样式选项并结束样式刷；未悬停时直接结束 */
export function confirmStyleCommand(): boolean {
    if (!state.stylePickSource) return false;
    const preview = stylePreview;
    const source = getEl(state.stylePickSource);
    const target = preview ? getEl(preview.targetId) : null;
    const opt = preview ? STYLE_OPTIONS.find(o => o.mode === preview.mode) : undefined;
    clearStylePreview(false);
    hideStyleMenu();
    const applied = !!(preview && source && target && opt && applyStyleToElement(source, target, opt.mode));
    if (applied && target && opt) {
        syncElement(target.id);
        commit();
        toast(`已应用${opt.short}到「${target.name}」`, 'success');
    }
    cancelStylePick(applied);
    return true;
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
    const convertBtn = $opt<HTMLButtonElement>('btnQuickConvert');
    const sep = $opt('quickToolsSep');
    const single = selected.length === 1;
    const convertible = single && !selected[0].locked && canConvertShape(selected[0]);
    if (convertBtn) {
        convertBtn.hidden = !convertible;
        if (convertBtn.dataset.icon !== 'convert') {
            convertBtn.textContent = '';
            convertBtn.appendChild(iconEl('convert'));
            convertBtn.dataset.icon = 'convert';
        }
        const menu = $opt('shapeConvertMenu');
        convertBtn.classList.toggle('active', !!menu && !menu.hidden);
        convertBtn.title = '转换形状：改为平行四边形、梯形、星形等';
        convertBtn.setAttribute('aria-label', convertBtn.title);
        if (!convertible) hideConvertMenu();
    }
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
    $('btnQuickConvert').addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const menu = $opt('shapeConvertMenu');
        if (menu && !menu.hidden) hideConvertMenu();
        else openConvertMenu();
        syncSelectionTools();
    });
    $('btnQuickStyle').addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (state.stylePickSource) cancelStylePick();
        else startStylePick();
    });
    const menu = $opt('styleBrushMenu');
    if (menu) {
        menu.addEventListener('pointerleave', () => clearStylePreview());
        menu.addEventListener('pointerover', e => {
            if (!(e.target as HTMLElement).closest('button')) clearStylePreview();
        });
    }
    window.addEventListener('blur', () => clearStylePreview());
}

/* 点击面板/检查器时收起样式选项，但保持样式刷模式 */
document.addEventListener('pointerdown', e => {
    const menu = $opt('styleBrushMenu');
    if (!menu || menu.hidden) return;
    const t = e.target as HTMLElement;
    if (t.closest('.style-brush-menu')) return;
    hideStyleMenu();
}, true);
