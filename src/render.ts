/* DOM 渲染层：模型 → 画布节点 */
import { SVG_NS, STROKE_SVG_TYPES } from './constants';
import type { CanvasElement, TextRun, TextStyle, TextSizeMode } from './types';
import { state, nodeMap } from './state';
import { $, iconEl, round2 } from './utils';
import { getEl, sortedElements, curveFillOn, curveStrokeOn, curvePathD, lineDashArray, curveNodeHasIn, curveNodeHasOut } from './model';
import { fillToCSS, shapeFilter, strokeOverlayMarkup, strokeDefMarkup, wavyDataURI, lineHeightFor } from './style';
import { fillDefs } from './vector-export';
import { fontForRun, layoutText, textStrokeLayers } from './exporter';
import { finishTextEdit } from './richtext';
import { renderPenDraft } from './interaction';
import { refreshStudioPanels, onViewChanged } from './tools';
import { shapeClipPath } from './shapes';

export function buildNode(el: CanvasElement): HTMLDivElement {
    const d = document.createElement('div');
    d.className = 'canvas-element' + (el.type === 'text' ? ' text-element' : '');
    d.dataset.id = el.id;

    const shape = document.createElement('div');
    shape.className = 'shape-layer';
    d.appendChild(shape);

    if (STROKE_SVG_TYPES.includes(el.type)) {
        const ov = document.createElementNS(SVG_NS, 'svg');
        ov.setAttribute('class', 'stroke-overlay');
        ov.setAttribute('aria-hidden', 'true');
        d.appendChild(ov);
    }
    if (el.type === 'curve') {
        const cv = document.createElementNS(SVG_NS, 'svg');
        cv.setAttribute('class', 'curve-svg');
        cv.setAttribute('aria-hidden', 'true');
        const defs = document.createElementNS(SVG_NS, 'defs');
        cv.appendChild(defs);
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('fill', 'none');
        cv.appendChild(path);
        d.appendChild(cv);
        const guides = document.createElementNS(SVG_NS, 'svg');
        guides.setAttribute('class', 'curve-guides');
        guides.setAttribute('aria-hidden', 'true');
        d.appendChild(guides);
        const holder = document.createElement('div');
        holder.className = 'curve-nodes';
        d.appendChild(holder);
    }
    if (el.type === 'text') {
        const t = document.createElement('div');
        t.className = 'text-content';
        d.appendChild(t);
        const sc = document.createElement('canvas');
        sc.className = 'text-stroke-canvas';
        sc.setAttribute('aria-hidden', 'true');
        d.appendChild(sc);
    }
    ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].forEach(dir => {
        const r = document.createElement('div');
        r.className = 'resizer resizer-' + dir;
        r.dataset.dir = dir;
        r.title = '拖动缩放；按住 Ctrl / ⌘ 拖动：以该点锚定移动并吸附特征点';
        d.appendChild(r);
    });
    const rotLine = document.createElement('div'); rotLine.className = 'rotator-line'; d.appendChild(rotLine);
    const rot = document.createElement('div'); rot.className = 'rotator'; rot.title = '拖拽旋转（Shift 吸附 15°）；悬停显示旋转中心'; rot.setAttribute('role', 'button'); rot.setAttribute('aria-label', '拖拽旋转；悬停显示旋转中心'); d.appendChild(rot);
    const pivot = document.createElement('div'); pivot.className = 'pivot-handle'; pivot.title = '旋转中心：拖拽移动，双击复位'; pivot.setAttribute('role', 'button'); pivot.setAttribute('aria-label', '旋转中心：拖拽移动，双击复位'); d.appendChild(pivot);
    const linkBadge = document.createElement('span'); linkBadge.className = 'link-badge'; linkBadge.title = '关联副本：样式与尺寸同步'; linkBadge.appendChild(iconEl('link')); d.appendChild(linkBadge);
    // 枢轴手柄默认隐藏，避免盖住内容/拦截双击；悬停旋转柄或旋转时才浮现
    // 指针离开后延迟收起，留出从旋转柄移向准星的操作时间；悬停期间保持可见
    const showPeek = (): void => { clearTimeout(d._peekTimer); if (!el.locked) d.classList.add('pivot-peek'); };
    d._hidePeekLater = () => {
        clearTimeout(d._peekTimer);
        d._peekTimer = window.setTimeout(() => {
            const it = state.interaction;
            if ((it && (it.kind === 'pivot' || it.kind === 'rotate')) || d.matches(':hover')) return;
            d.classList.remove('pivot-peek');
        }, 1200);
    };
    rot.addEventListener('pointerenter', showPeek);
    pivot.addEventListener('pointerenter', showPeek);
    d.addEventListener('pointerenter', () => clearTimeout(d._peekTimer));
    d.addEventListener('pointerleave', d._hidePeekLater);
    const badge = document.createElement('span'); badge.className = 'lock-badge'; badge.appendChild(iconEl('lock')); d.appendChild(badge);

    syncNode(el, d);
    return d;
}
export function renderRuns(container: HTMLElement, el: CanvasElement): void {
    container.textContent = '';
    const t = el.text!;
    container.style.fontSize = t.fontSize + 'px';
    container.style.fontFamily = t.fontFamily;
    container.style.fontWeight = String(t.fontWeight);
    container.style.lineHeight = String(t.lineHeight);
    container.style.letterSpacing = t.letterSpacing + 'px';
    container.style.textAlign = t.align;
    container.style.textIndent = t.indent > 0 ? t.indent + 'px' : '0';
    container.style.color = el.fill.enabled ? el.fill.color : 'transparent';
    let para: HTMLElement = document.createElement('div');
    para.className = 'text-para';
    container.appendChild(para);
    const newPara = (): void => {
        para = document.createElement('div');
        para.className = 'text-para';
        if (t.paraSpacing > 0) para.style.paddingTop = t.paraSpacing + 'px';
        container.appendChild(para);
    };
    t.runs.forEach(run => {
        run.text.split('\n').forEach((part, pi) => {
            if (pi > 0) newPara();
            if (!part) return;
            const span = document.createElement('span');
            span.textContent = part;
            if (run.bold) { span.style.fontWeight = '700'; span.dataset.b = '1'; }
            if (run.italic) { span.style.fontStyle = 'italic'; span.dataset.i = '1'; }
            if (run.underline) { span.style.textDecoration = 'underline'; span.dataset.u = '1'; }
            if (run.color) { span.style.color = run.color; span.dataset.color = run.color; }
            para.appendChild(span);
        });
    });
    // 空段落需要占位 <br> 撑出行高（末尾段落的 br 会被 parseRuns 视为占位符）
    container.querySelectorAll<HTMLElement>('.text-para').forEach(p => {
        if (!p.childNodes.length) p.appendChild(document.createElement('br'));
    });
}
/* 离屏 DOM 测量：与编辑器 HTML 排版完全一致的宽高 */
let textMeasurer: HTMLDivElement | null = null;
export function measureTextDom(el: CanvasElement, maxW: number | null): { w: number; h: number } {
    if (!textMeasurer) {
        textMeasurer = document.createElement('div');
        textMeasurer.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
        document.body.appendChild(textMeasurer);
    }
    renderRuns(textMeasurer, el);
    textMeasurer.style.width = maxW == null ? 'max-content' : maxW + 'px';
    textMeasurer.style.whiteSpace = maxW == null ? 'pre' : 'pre-wrap';
    textMeasurer.style.wordBreak = 'break-word';
    return { w: textMeasurer.scrollWidth, h: textMeasurer.scrollHeight };
}
let textMeasureCanvas: HTMLCanvasElement | null = null;
export function textMeasureCtx(): CanvasRenderingContext2D {
    if (!textMeasureCanvas) textMeasureCanvas = document.createElement('canvas');
    const ctx = textMeasureCanvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 上下文');
    return ctx;
}
export function canvasTextWidth(ctx: CanvasRenderingContext2D, t: TextStyle, run: TextRun, text: string): number {
    ctx.font = fontForRun(run, t);
    let w = 0;
    for (const ch of text) w += ctx.measureText(ch).width + t.letterSpacing;
    return w;
}
/** 自动尺寸：取 DOM 与导出排版两者较大值，保证编辑器和导出都不裁切 */
export function applyAutoSize(el: CanvasElement): void {
    const t = el.text!;
    const mode = t.sizeMode;
    if (!mode || mode === 'fixed') return;
    const lh = t.fontSize * t.lineHeight;
    const maxW = mode === 'autoH' ? el.w : 1e9;
    const dom = measureTextDom(el, mode === 'autoH' ? el.w : null);
    const ctx = textMeasureCtx();
    const lines = layoutText(el, maxW, (run, text) => canvasTextWidth(ctx, t, run, text));
    const paraBreaks = lines.reduce((n, ln, i) => n + (i > 0 && ln.paraStart ? 1 : 0), 0);
    const canvasH = lines.length * lh + paraBreaks * t.paraSpacing;
    const canvasW = lines.reduce((m, ln) => {
        const total = ln.reduce((a, tok) => a + tok.w, 0);
        return Math.max(m, total + (ln.paraStart ? t.indent : 0));
    }, 0);
    if (mode === 'autoWH') el.w = round2(Math.max(20, dom.w, canvasW) + 2);
    el.h = round2(Math.max(lh, dom.h, canvasH));
}
export function updateTextStats(el: CanvasElement | null): void {
    const n = $('textStats');
    if (!n || !el || el.type !== 'text') return;
    const t = el.text!;
    const text = t.runs.map(r => r.text).join('');
    const chars = text.replace(/\n/g, '').length;
    const ctx = textMeasureCtx();
    const maxW = t.sizeMode === 'autoWH' ? 1e9 : el.w;
    const lines = layoutText(el, maxW, (run, s) => canvasTextWidth(ctx, t, run, s)).length;
    const modeNames: Record<TextSizeMode, string> = { fixed: '固定尺寸', autoH: '自动高度', autoWH: '自动宽高' };
    const mode = modeNames[t.sizeMode] || '固定尺寸';
    n.textContent = `${chars} 字符 · ${lines} 行 · ${mode}`;
}
export function syncNode(el: CanvasElement, d: HTMLDivElement): void {
    const s = d.style;
    const renderH = el.type === 'line' ? lineHeightFor(el) : el.h;
    s.left = el.x + 'px';
    s.top = el.y + 'px';
    s.width = el.w + 'px';
    s.height = renderH + 'px';
    s.transform = `rotate(${el.rotation}deg) skew(${el.skewX || 0}deg, ${el.skewY || 0}deg)`;
    s.transformOrigin = `${el.pivotX * 100}% ${el.pivotY * 100}%`;
    s.zIndex = String(el.zIndex);
    s.opacity = String(el.opacity);
    d.dataset.locked = String(el.locked);
    d.dataset.exportVisible = String(el.exportVisible);
    d.dataset.rotation = String(el.rotation);
    d.dataset.skewX = String(el.skewX || 0);
    d.dataset.skewY = String(el.skewY || 0);
    d.dataset.visible = String(el.visible);
    d.classList.toggle('group-member', !!el.groupId);
    d.classList.toggle('linked', !!el.linkId);
    s.mixBlendMode = el.blendMode && el.blendMode !== 'normal' ? el.blendMode : '';
    s.display = el.visible ? '' : 'none';

    const pivot = d.querySelector<HTMLElement>('.pivot-handle');
    if (pivot) {
        pivot.style.left = (el.pivotX * 100) + '%';
        pivot.style.top = (el.pivotY * 100) + '%';
        pivot.classList.toggle('custom', Math.abs(el.pivotX - 0.5) > 0.001 || Math.abs(el.pivotY - 0.5) > 0.001);
        d.classList.toggle('pivot-custom', Math.abs(el.pivotX - 0.5) > 0.001 || Math.abs(el.pivotY - 0.5) > 0.001);
    }

    const shape = d.querySelector<HTMLElement>('.shape-layer');
    if (!shape) return;
    const ss = shape.style;
    ss.cssText = '';
    ss.width = '100%'; ss.height = '100%';
    const clip = shapeClipPath(el);
    ss.borderRadius = el.type === 'circle' ? (clip ? '0' : '50%') : el.borderRadius + 'px';
    if (clip) ss.clipPath = clip;

    if (el.type === 'line') {
        const ln = el.line!;
        if (ln.style === 'wavy') {
            const uri = wavyDataURI(ln);
            ss.backgroundImage = `url("${uri}")`;
            ss.backgroundRepeat = 'repeat-x';
            ss.backgroundPosition = 'center';
            ss.clipPath = 'none';
            ss.borderRadius = '0';
        } else {
            ss.borderTop = `${ln.width}px ${ln.style} ${ln.color}`;
            ss.clipPath = 'none';
            ss.borderRadius = '0';
        }
    } else if (el.type === 'curve') {
        ss.background = 'transparent';
        ss.clipPath = 'none';
        ss.borderRadius = '0';
        syncCurveNode(el, d, renderH);
    } else if (el.type === 'text') {
        ss.background = 'transparent';
        ss.clipPath = 'none';
        ss.borderRadius = '0';
        const tc = d.querySelector<HTMLElement>('.text-content');
        if (tc && !(state.isTextEditing && state.editingId === el.id)) renderRuns(tc, el);
        syncTextStrokeCanvas(el, d);
    } else {
        ss.background = fillToCSS(el.fill);
        if (el.image && state.assets[el.image.assetId]) {
            ss.backgroundImage = `url("${state.assets[el.image.assetId]}")`;
            ss.backgroundSize = '100% 100%';
            ss.backgroundRepeat = 'no-repeat';
        }
        if (el.maskAssetId && state.assets[el.maskAssetId]) {
            const mask = `url("${state.assets[el.maskAssetId]}")`;
            ss.maskImage = mask; ss.webkitMaskImage = mask;
            ss.maskSize = '100% 100%'; ss.webkitMaskSize = '100% 100%';
            ss.maskRepeat = 'no-repeat'; ss.webkitMaskRepeat = 'no-repeat';
        }
        const filter = shapeFilter(el);
        if (filter) ss.filter = filter;
    }

    const ov = d.querySelector<SVGSVGElement>('.stroke-overlay');
    if (ov) {
        ov.setAttribute('viewBox', `0 0 ${el.w} ${renderH}`);
        ov.innerHTML = strokeOverlayMarkup(el, el.w, renderH);
        const f = shapeFilter(el);
        ov.style.filter = f || '';
    }
}
/** 文本描边显示层：与 PNG 导出共用同一套分层渲染，保证内外对齐一致 */
function syncTextStrokeCanvas(el: CanvasElement, d: HTMLDivElement): void {
    const cv = d.querySelector<HTMLCanvasElement>('.text-stroke-canvas');
    if (!cv) return;
    const st = el.stroke;
    const enabled = !!st && st.width > 0;
    d.classList.toggle('has-text-stroke', enabled);
    if (!enabled || (state.isTextEditing && state.editingId === el.id)) {
        cv.style.display = 'none';
        return;
    }
    const maxDim = Math.max(1, el.w, el.h) + Math.min(st!.width, 60) * 2 + 16;
    const scale = Math.min(2, Math.max(0.5, 4096 / maxDim));
    const layers = textStrokeLayers(el, scale);
    if (!layers) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    if (cv.width !== layers.fill.width) cv.width = layers.fill.width;
    if (cv.height !== layers.fill.height) cv.height = layers.fill.height;
    cv.style.width = (el.w + layers.pad * 2) + 'px';
    cv.style.height = (el.h + layers.pad * 2) + 'px';
    cv.style.left = (-layers.pad) + 'px';
    cv.style.top = (-layers.pad) + 'px';
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(layers.fill, 0, 0);
    c.drawImage(layers.stroke, 0, 0);
    if (!cv.dataset.fontHooked) {
        cv.dataset.fontHooked = '1';
        const fonts = document.fonts;
        if (fonts && fonts.ready) {
            void fonts.ready.then(() => {
                const e2 = getEl(el.id), d2 = nodeMap.get(el.id);
                if (e2 && d2) syncTextStrokeCanvas(e2, d2);
            });
        }
    }
}
/** 同步曲线路径、节点方块、控制柄与切线。节点数量变化时重建手柄 DOM */
export function syncCurveNode(el: CanvasElement, d: HTMLDivElement, h: number): void {
    const c = el.curve!, ln = el.line!, w = el.w;
    const cv = d.querySelector<SVGSVGElement>('.curve-svg');
    if (cv) {
        cv.setAttribute('viewBox', `0 0 ${w} ${h}`);
        cv.setAttribute('preserveAspectRatio', 'none');
        const fd = curveFillOn(el) ? fillDefs('cf_' + el.id, el.fill) : null;
        const sg = curveStrokeOn(el) ? el.stroke?.gradient : null;
        const defs = cv.querySelector('defs');
        if (defs) defs.innerHTML = (fd ? fd.def : '') + (sg ? strokeDefMarkup('csg_' + el.id, sg) : '');
        const path = cv.querySelector('path');
        if (path) {
            path.setAttribute('d', curvePathD(c, w, h));
            path.setAttribute('fill', fd ? fd.ref : 'none');
            path.setAttribute('stroke', sg ? `url(#csg_${el.id})` : ln.color);
            path.setAttribute('stroke-width', String(curveStrokeOn(el) ? ln.width : 0));
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            const dash = lineDashArray(ln);
            if (dash) path.setAttribute('stroke-dasharray', dash);
            else path.removeAttribute('stroke-dasharray');
        }
    }
    const nodes = c.nodes;
    let holder = d.querySelector<HTMLDivElement>('.curve-nodes');
    if (!holder || holder.childElementCount !== nodes.length * 3) {
        if (!holder) {
            holder = document.createElement('div');
            holder.className = 'curve-nodes';
            d.appendChild(holder);
        }
        holder.textContent = '';
        nodes.forEach((_, i) => {
            const nd = document.createElement('div');
            nd.className = 'curve-node';
            nd.dataset.i = String(i);
            nd.title = `节点 ${i + 1}：拖拽移动 · 双击删除 · Ctrl+点击切换平滑/尖角 · Ctrl+拖拽锚定移动`;
            holder!.appendChild(nd);
            ['in', 'out'].forEach(k => {
                const hd = document.createElement('div');
                hd.className = 'curve-ctrl';
                hd.dataset.i = String(i);
                hd.dataset.h = k;
                hd.title = '控制柄：拖拽调弧度 · Alt 断开对称 · Shift 15° 吸附';
                holder!.appendChild(hd);
            });
        });
    }
    // 切线层：当前节点的两条控制柄引线
    const guides = d.querySelector<SVGSVGElement>('.curve-guides');
    const sel = (state.nodeSel && state.nodeSel.id === el.id) ? state.nodeSel.i : -1;
    if (guides) {
        guides.setAttribute('viewBox', `0 0 ${w} ${h}`);
        guides.setAttribute('preserveAspectRatio', 'none');
        const active = sel >= 0 ? nodes[sel] : null;
        if (!active || el.locked) {
            guides.textContent = '';
        } else {
            guides.textContent = '';
            (['in', 'out'] as const).forEach(k => {
                const has = k === 'in' ? curveNodeHasIn(active) : curveNodeHasOut(active);
                if (!has) return;
                const ln2 = document.createElementNS(SVG_NS, 'line');
                ln2.setAttribute('x1', String(active.x * w)); ln2.setAttribute('y1', String(active.y * h));
                ln2.setAttribute('x2', String((k === 'in' ? active.ix : active.ox) * w));
                ln2.setAttribute('y2', String((k === 'in' ? active.iy : active.oy) * h));
                guides.appendChild(ln2);
            });
        }
    }
    holder.querySelectorAll<HTMLDivElement>('.curve-node').forEach(nd => {
        const i = Number(nd.dataset.i), n = nodes[i];
        if (!n) return;
        nd.style.left = (n.x * 100) + '%';
        nd.style.top = (n.y * 100) + '%';
        nd.classList.toggle('sel', sel === i);
    });
    holder.querySelectorAll<HTMLDivElement>('.curve-ctrl').forEach(hd => {
        const i = Number(hd.dataset.i), n = nodes[i];
        if (!n) return;
        const k = hd.dataset.h;
        const hx = k === 'in' ? n.ix : n.ox, hy = k === 'in' ? n.iy : n.oy;
        const has = k === 'in' ? curveNodeHasIn(n) : curveNodeHasOut(n);
        hd.style.left = (hx * 100) + '%';
        hd.style.top = (hy * 100) + '%';
        hd.classList.toggle('on', sel === i && has);
    });
}
export function syncElement(id: string): void {
    const el = getEl(id), d = nodeMap.get(id);
    if (el && d) syncNode(el, d);
    else renderAll();
}
export function renderAll(): void {
    if (state.isTextEditing) finishTextEdit();   // 重建前先回写编辑内容，避免丢字
    // 模型被整体替换（撤销 / 载入 / 新建）时丢弃钢笔草稿，避免画在旧坐标上
    if (state.pen) { state.pen = null; renderPenDraft(); }
    const c = $('canvas');
    c.textContent = '';
    nodeMap.clear();
    syncNodeSel();
    const frag = document.createDocumentFragment();
    sortedElements().forEach(el => {
        const d = buildNode(el);
        nodeMap.set(el.id, d);
        frag.appendChild(d);
    });
    c.appendChild(frag);
    const box = document.createElement('div');
    box.id = 'selectionBox';
    c.appendChild(box);
    applySelectionClasses();
    refreshStudioPanels();
}
export function applySelectionClasses(): void {
    const set = new Set(state.selection);
    const solo = state.selection.length === 1 ? state.selection[0] : null;
    if (state.selection.length) state.guideSel = null;
    nodeMap.forEach((d, id) => {
        d.classList.toggle('active', set.has(id));
        d.classList.toggle('solo', id === solo);
        d.classList.toggle('transform-mode', state.transformMode && set.has(id));
    });
    syncNodeSel();
    // 选中状态变化后刷新曲线节点/控制柄的显示
    if (solo && nodeMap.has(solo)) {
        const el = getEl(solo);
        if (el && el.type === 'curve') syncElement(solo);
    }
}
/** 曲线节点选择跟随当前单选对象；换选时自动选中第一个节点，控制柄随之可见 */
export function syncNodeSel(): void {
    const solo = state.selection.length === 1 ? getEl(state.selection[0]) : null;
    if (solo && solo.type === 'curve') {
        if (!state.nodeSel || state.nodeSel.id !== solo.id) state.nodeSel = { id: solo.id, i: 0 };
        const n = solo.curve!.nodes.length;
        if (state.nodeSel.i >= n) state.nodeSel.i = n - 1;
    } else {
        state.nodeSel = null;
    }
}
export function syncCanvasSize(): void {
    const c = state.model.canvas;
    const canvas = $('canvas');
    canvas.style.width = c.w + 'px';
    canvas.style.height = c.h + 'px';
    canvas.style.background = fillToCSS(c.background);
    $<HTMLInputElement>('canvasW').value = String(Math.round(c.w));
    $<HTMLInputElement>('canvasH').value = String(Math.round(c.h));
}
export function syncTransform(): void {
    $('transformLayer').style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    $('zoomDisplay').textContent = Math.round(state.zoom * 100) + '%';
    $('viewport').style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
    onViewChanged();
}