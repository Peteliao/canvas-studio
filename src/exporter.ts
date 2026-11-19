import { EXPORT_BLEND, MAX_EXPORT_PIXELS } from './constants';
import { state } from './state';
import { $, clamp, downloadBlob, finite, loadImage, toast } from './utils';
import { curveFillOn, curveStrokeOn, selectedEls, sortedElements } from './model';
import { canvasGradient, fillStops, hexToRgba, lineHeightFor, wavyDashSpec, wavyGeom } from './style';
import { canvasTextWidth } from './render';
import { getAABB } from './geometry';
import { shapePath } from './boolean';
import { buildPDF, buildSVG } from './vector-export';
import { batchExport, updateExportSummary } from './actions';
import type { CanvasElement, Fill, TextLine, TextRun, TextStyle } from './types';

export interface ExportBounds { x: number; y: number; w: number; h: number; }
export interface ExportOpts {
    transparent?: boolean;
    elements?: CanvasElement[];
    bounds?: ExportBounds;
    opaqueBackground?: string | null;
}

export function paintFill(ctx: CanvasRenderingContext2D, fill: Fill, w: number, h: number): void {
    if (!fill.enabled) { ctx.fillStyle = 'rgba(0,0,0,0)'; return; }
    if (fill.mode === 'solid') { ctx.fillStyle = fill.color; return; }
    const stops = fillStops(fill), alpha = finite(fill.alpha, 1);
    const g = canvasGradient(ctx, fill.mode, fill.angle, fill.posX, fill.posY, stops, alpha, w, h)
        || canvasGradient(ctx, 'linear', 135, 50, 50, stops, alpha, w, h);
    if (g) ctx.fillStyle = g;
}

export function fontForRun(run: TextRun, t: TextStyle): string {
    return `${run.italic ? 'italic ' : ''}${run.bold ? 700 : t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
}

/* 排版原子：CJK 逐字可断行，西文按单词，空白独立成原子 */
const TEXT_ATOM_RE = /([⺀-﫿！-｠、-〿])|([^\s⺀-﫿！-｠、-〿]+)|(\s+)/g;

/** 贪心换行排版：编辑器自动尺寸与 PNG/SVG 导出共用同一套行模型 */
export function layoutText(el: CanvasElement, maxW: number, measure: (run: TextRun, text: string) => number): TextLine[] {
    const lines: TextLine[] = [[]];
    let cur = 0;
    const newline = (forced?: boolean) => { if (forced) lines[lines.length - 1].forcedEnd = true; lines.push([]); cur = 0; };
    el.text!.runs.forEach(run => {
        run.text.split('\n').forEach((part, pi) => {
            if (pi > 0) newline(true);
            if (!part) return;
            (part.match(TEXT_ATOM_RE) || []).forEach(atom => {
                const w = measure(run, atom);
                if (cur + w > maxW + 0.5 && cur > 0) {
                    newline();
                    if (/^\s+$/.test(atom)) return;
                }
                if (w > maxW) {
                    for (const ch of atom) {
                        const cw = measure(run, ch);
                        if (cur + cw > maxW + 0.5 && cur > 0) newline();
                        lines[lines.length - 1].push({ run, text: ch, w: cw });
                        cur += cw;
                    }
                    return;
                }
                lines[lines.length - 1].push({ run, text: atom, w });
                cur += w;
            });
        });
    });
    return lines;
}

function drawTextRuns(ctx: CanvasRenderingContext2D, el: CanvasElement): void {
    const t = el.text!;
    const lh = t.fontSize * t.lineHeight;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, t, run, text));
    lines.forEach((tokens, lineIndex) => {
        const total = tokens.reduce((a, tok) => a + tok.w, 0);
        const gaps = tokens.length - 1;
        const justify = t.align === 'justify' && lineIndex < lines.length - 1 && !lines[lineIndex].forcedEnd && gaps > 0;
        const extra = justify ? (el.w - total) / gaps : 0;
        let x = t.align === 'center' ? (el.w - total) / 2 : t.align === 'right' ? el.w - total : 0;
        const y = lineIndex * lh;
        tokens.forEach(tok => {
            const r = tok.run;
            ctx.font = fontForRun(r, t);
            ctx.fillStyle = r.color || (el.fill.enabled ? el.fill.color : 'rgba(0,0,0,0)');
            // 逐字符绘制以支持字间距
            let cx = x;
            for (const ch of tok.text) {
                ctx.fillText(ch, cx, y);
                cx += ctx.measureText(ch).width + t.letterSpacing;
            }
            if (r.underline) {
                ctx.fillRect(x, y + t.fontSize * 0.95, tok.w, Math.max(1, t.fontSize / 16));
            }
            x += tok.w + extra;
        });
    });
}

function drawLineElement(ctx: CanvasRenderingContext2D, el: CanvasElement): void {
    const ln = el.line!;
    const h = lineHeightFor(el);
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = ln.width;
    ctx.lineCap = 'round';
    const y = h / 2;
    if (ln.style === 'wavy') {
        const { amp, period } = wavyGeom(ln);
        const spec = wavyDashSpec(ln);
        if (spec) {
            ctx.setLineDash(spec.dash.split(' ').map(Number));
            ctx.lineDashOffset = spec.offset;
            ctx.lineCap = ln.dash === 'dashed' ? 'butt' : 'round';
        }
        ctx.beginPath(); ctx.moveTo(0, y);
        for (let x = 0; x < el.w; x += period / 2) {
            ctx.quadraticCurveTo(x + period / 4, y + (Math.floor(x / (period / 2)) % 2 ? amp : -amp), x + period / 2, y);
        }
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.lineCap = 'round';
        return;
    }
    if (ln.style === 'dashed') ctx.setLineDash([ln.width * 3, ln.width * 2]);
    else if (ln.style === 'dotted') ctx.setLineDash([ln.width, ln.width * 1.5]);
    else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(ln.width / 2, y); ctx.lineTo(el.w - ln.width / 2, y); ctx.stroke();
    ctx.setLineDash([]);
}

function drawCurveElement(ctx: CanvasRenderingContext2D, el: CanvasElement): void {
    const ln = el.line!, c = el.curve!, w = el.w, h = el.h;
    const nodes = c.nodes;
    if (!nodes || nodes.length < 2) return;
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = ln.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (ln.style === 'dashed') ctx.setLineDash([ln.width * 3, ln.width * 2]);
    else if (ln.style === 'dotted') ctx.setLineDash([0.1, ln.width * 1.8]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(nodes[0].x * w, nodes[0].y * h);
    const seg = (a: typeof nodes[0], b: typeof nodes[0]) => {
        const flat = Math.abs(a.ox - a.x) < 1e-6 && Math.abs(a.oy - a.y) < 1e-6 &&
            Math.abs(b.ix - b.x) < 1e-6 && Math.abs(b.iy - b.y) < 1e-6;
        if (flat) ctx.lineTo(b.x * w, b.y * h);
        else ctx.bezierCurveTo(a.ox * w, a.oy * h, b.ix * w, b.iy * h, b.x * w, b.y * h);
    };
    for (let i = 1; i < nodes.length; i++) seg(nodes[i - 1], nodes[i]);
    if (c.closed && nodes.length > 1) { seg(nodes[nodes.length - 1], nodes[0]); ctx.closePath(); }
    if (curveFillOn(el)) {
        ctx.save();
        ctx.globalAlpha = clamp(ctx.globalAlpha * finite(el.fill.alpha, 1), 0, 1);
        paintFill(ctx, el.fill, w, h);
        ctx.fill();
        ctx.restore();
    }
    if (curveStrokeOn(el)) ctx.stroke();
    ctx.setLineDash([]);
}

async function drawElementContent(c: CanvasRenderingContext2D, el: CanvasElement): Promise<void> {
    if (el.type === 'line') { drawLineElement(c, el); return; }
    if (el.type === 'curve') { drawCurveElement(c, el); return; }
    if (el.type === 'text') { drawTextRuns(c, el); return; }
    c.save();
    shapePath(c, el, el.w, el.h);
    c.clip();
    if (el.image && state.assets[el.image.assetId]) {
        try {
            const img = await loadImage(state.assets[el.image.assetId]);
            c.drawImage(img, 0, 0, el.w, el.h);
        } catch (err) { console.warn('图片渲染失败', (err as Error).message); }
    } else {
        c.save();
        c.globalAlpha = clamp(c.globalAlpha * finite(el.fill.alpha, 1), 0, 1);
        paintFill(c, el.fill, el.w, el.h);
        c.fillRect(0, 0, el.w, el.h);
        c.restore();
    }
    c.restore();
}

export async function drawExportElement(ctx: CanvasRenderingContext2D, el: CanvasElement, originX?: number, originY?: number): Promise<void> {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    ctx.save();
    ctx.globalAlpha = el.opacity;
    if (el.blendMode && el.blendMode !== 'normal' && EXPORT_BLEND[el.blendMode]) {
        ctx.globalCompositeOperation = EXPORT_BLEND[el.blendMode];
    }
    // N5：投影
    if (el.shadow && el.shadow.enabled) {
        const sc = ctx.__exportScale || 1;
        ctx.shadowColor = hexToRgba(el.shadow.color, el.shadow.opacity);
        ctx.shadowBlur = el.shadow.blur * sc;
        ctx.shadowOffsetX = (el.shadow.type === 'glow' ? 0 : el.shadow.x) * sc;
        ctx.shadowOffsetY = (el.shadow.type === 'glow' ? 0 : el.shadow.y) * sc;
    }
    ctx.translate((el.x - (originX || 0)) + el.pivotX * el.w, (el.y - (originY || 0)) + el.pivotY * h);
    ctx.rotate(el.rotation * Math.PI / 180);
    ctx.translate(-el.pivotX * el.w, -el.pivotY * h);

    if (el.maskAssetId && state.assets[el.maskAssetId]) {
        // 布尔结果：先绘内容到离屏画布，再以遮罩裁剪，避免污染主画布合成状态
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(el.w));
        off.height = Math.max(1, Math.round(el.h));
        const oc = off.getContext('2d');
        if (!oc) throw new Error('Canvas 2D context unavailable');
        await drawElementContent(oc, el);
        try {
            const maskImg = await loadImage(state.assets[el.maskAssetId]);
            oc.globalCompositeOperation = 'destination-in';
            oc.drawImage(maskImg, 0, 0, el.w, el.h);
            oc.globalCompositeOperation = 'source-over';
        } catch (err) { console.warn('遮罩渲染失败', (err as Error).message); }
        ctx.drawImage(off, 0, 0, el.w, el.h);
    } else {
        await drawElementContent(ctx, el);
    }
    // N5：描边（贴在形状外轮廓上，异形用 clipPath 多边形）
    if (el.stroke && el.stroke.width > 0 && el.type !== 'text' && el.type !== 'line') {
        ctx.save();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        const sg = el.stroke.gradient;
        ctx.strokeStyle = (sg && canvasGradient(ctx, sg.mode, sg.angle, sg.posX, sg.posY, sg.stops, 1, el.w, h)) || el.stroke.color;
        ctx.lineWidth = Math.min(el.stroke.width, 40);
        if (el.stroke.style === 'dashed') ctx.setLineDash([el.stroke.width * 3, el.stroke.width * 2]);
        else if (el.stroke.style === 'dotted') ctx.setLineDash([el.stroke.width, el.stroke.width * 1.5]);
        shapePath(ctx, el, el.w, el.h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }
    ctx.restore();
}

export async function renderModelToCanvas(scale: number, opts?: ExportOpts): Promise<HTMLCanvasElement> {
    // 等待内置字体加载完成，避免首次使用思源字体导出时回退到系统字体
    if (typeof document.fonts !== 'undefined' && document.fonts.ready) await document.fonts.ready;
    const o = opts || {};
    const bounds = o.bounds || { x: 0, y: 0, w: state.model.canvas.w, h: state.model.canvas.h };
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bounds.w * scale));
    c.height = Math.max(1, Math.round(bounds.h * scale));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.__exportScale = scale;
    ctx.scale(scale, scale);
    if (o.opaqueBackground) { ctx.fillStyle = o.opaqueBackground; ctx.fillRect(0, 0, bounds.w, bounds.h); }
    else if (!o.transparent) {
        paintFill(ctx, state.model.canvas.background, bounds.w, bounds.h);
        ctx.fillRect(0, 0, bounds.w, bounds.h);
    }
    const list = o.elements || sortedElements();
    for (const el of list) {
        if (!el.exportVisible || !el.visible) continue;
        await drawExportElement(ctx, el, bounds.x, bounds.y);
    }
    return c;
}

export function exportBoundsFor(scope: string): ExportBounds | null {
    if (scope !== 'selection') return { x: 0, y: 0, w: state.model.canvas.w, h: state.model.canvas.h };
    const sel = selectedEls().filter(e => e.exportVisible && e.visible);
    if (!sel.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    sel.forEach(e => { const a = getAABB(e); l = Math.min(l, a.left); t = Math.min(t, a.top); r = Math.max(r, a.right); b = Math.max(b, a.bottom); });
    const pad = 8;
    return { x: Math.max(0, l - pad), y: Math.max(0, t - pad), w: Math.min(state.model.canvas.w, r + pad) - Math.max(0, l - pad), h: Math.min(state.model.canvas.h, b + pad) - Math.max(0, t - pad) };
}

export function exportElementsFor(scope: string): CanvasElement[] {
    return scope === 'selection' ? selectedEls().filter(e => e.exportVisible && e.visible) : sortedElements();
}

export function showExportModal(): void {
    $<HTMLInputElement>('exportW').value = String(Math.round(state.model.canvas.w));
    $('exportModal').style.display = 'flex';
    updateExportSummary();
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), mime, quality);
    });
}

export async function doExport(): Promise<void> {
    const exportW = Number($<HTMLInputElement>('exportW').value);
    if (!Number.isFinite(exportW) || !Number.isInteger(exportW) || exportW < 16 || exportW > 16000) {
        toast('导出宽度必须是 16–16000 之间的整数', 'error'); return;
    }
    const format = $<HTMLSelectElement>('exportFormat').value;
    const scope = $<HTMLSelectElement>('exportScope').value;
    const transparent = $<HTMLInputElement>('exportTransparent').checked;
    const quality = clamp(finite($<HTMLInputElement>('exportQuality').value, 92), 10, 100) / 100;
    const name = ($<HTMLInputElement>('exportName').value || 'design').trim().replace(/[\\/:*?"<>|]/g, '_');
    const btn = document.querySelector<HTMLButtonElement>('[data-act="doExport"]');
    if (btn) btn.disabled = true;
    try {
        if (scope === 'batch') { await batchExport(name, format, transparent, quality); return; }
        const bounds = exportBoundsFor(scope);
        if (!bounds || bounds.w <= 0 || bounds.h <= 0) { toast('请先选中要导出的元素', 'error'); return; }
        const elements = exportElementsFor(scope);
        if (format === 'svg') {
            const svg = buildSVG({ bounds, elements, transparent });
            downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), name + '.svg');
            toast(`已导出 SVG（${Math.round(bounds.w)}×${Math.round(bounds.h)}）`, 'success');
        } else {
            const targetH = Math.round(exportW * bounds.h / bounds.w);
            const targetPixels = exportW * targetH;
            if (targetPixels > MAX_EXPORT_PIXELS) { toast(`导出尺寸过大（${exportW}×${targetH}），请将宽度调小`, 'error'); return; }
            const superSample = clamp(Math.sqrt(MAX_EXPORT_PIXELS / targetPixels), 1, 3);
            const scale = exportW / bounds.w * superSample;
            const opaque = (format === 'jpeg' || format === 'pdf') ? '#ffffff' : null;
            const large = await renderModelToCanvas(scale, { transparent: transparent && !opaque, opaqueBackground: opaque, bounds, elements });
            const final = document.createElement('canvas');
            final.width = exportW; final.height = targetH;
            const ctx = final.getContext('2d');
            if (!ctx) throw new Error('Canvas 2D context unavailable');
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(large, 0, 0, exportW, targetH);
            if (format === 'pdf') {
                const jpeg = final.toDataURL('image/jpeg', quality);
                const pdf = buildPDF(jpeg, exportW, targetH);
                downloadBlob(new Blob([pdf], { type: 'application/pdf' }), name + '.pdf');
                toast(`已导出 PDF（${exportW}×${targetH}）`, 'success');
            } else {
                const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
                let blob = await canvasToBlob(final, mime, quality);
                if (mime === 'image/webp' && blob.type !== 'image/webp') {
                    toast('当前浏览器不支持 WebP，已改用 PNG', 'error');
                    blob = await canvasToBlob(final, 'image/png');
                    downloadBlob(blob, name + '.png');
                } else {
                    downloadBlob(blob, name + '.' + (format === 'jpeg' ? 'jpg' : format));
                }
                toast(`已导出 ${format.toUpperCase()}（${exportW}×${targetH}）`, 'success');
            }
        }
        $('exportModal').style.display = 'none';
    } catch (e) {
        console.warn('导出失败：', (e as Error).message);
        toast('导出失败：' + (e as Error).message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}