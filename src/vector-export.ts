import { state } from './state';
import { shapePoints } from './shapes';
import { finite, round2 } from './utils';
import { curveFillOn, curvePathD, curveStrokeOn } from './model';
import { fillStops, gradientDefMarkup, hexToRgba, lineHeightFor, strokeDefMarkup, wavyDashSpec, wavyGeom } from './style';
import { canvasTextWidth, textMeasureCtx } from './render';
import { layoutText } from './exporter';
import type { ExportBounds } from './export-bounds';
import type { CanvasElement, Fill } from './types';

function xmlEscape(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function fillDefs(id: string, f: Fill): { def: string; ref: string } {
    if (!f.enabled) return { def: '', ref: 'none' };
    if (f.mode === 'solid') return { def: '', ref: hexToRgba(f.color, finite(f.alpha, 1)) };
    const def = gradientDefMarkup(id, f.mode, f.angle, f.posX, f.posY, fillStops(f), finite(f.alpha, 1));
    return { def, ref: `url(#${id})` };
}

function shapeSVG(el: CanvasElement, ref: string, strokeRef: string, idx: number, defs: string[]): string {
    const st = el.stroke && el.stroke.width > 0 ? el.stroke : null;
    const align = st ? (st.align || 'center') : 'center';
    const paint = (fill: string, extra = ''): string => {
        const dyn = shapePoints(el);
        if (dyn) {
            const pts = dyn.map(([x, y]) => `${x * el.w / 100},${y * el.h / 100}`).join(' ');
            return `<polygon points="${pts}" fill="${fill}"${extra}/>`;
        }
        if (el.type === 'circle') return `<ellipse cx="${el.w / 2}" cy="${el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" fill="${fill}"${extra}/>`;
        return `<rect x="0" y="0" width="${el.w}" height="${el.h}" rx="${el.borderRadius}" fill="${fill}"${extra}/>`;
    };
    const strokeAttr = !st ? '' : ` stroke="${strokeRef}" stroke-width="${align === 'center' ? st.width : st.width * 2}"`
        + (st.style === 'dashed' ? ' stroke-dasharray="8 5"' : st.style === 'dotted' ? ' stroke-dasharray="2 4"' : '');
    const base = paint(ref, strokeAttr);
    if (!st || align === 'center') return base;
    const pad = st.width * 2 + 4;
    if (align === 'inside') {
        defs.push(`<clipPath id="sc${idx}" clipPathUnits="userSpaceOnUse">${paint('#000')}</clipPath>`);
        return `<g clip-path="url(#sc${idx})">${base}</g>`;
    }
    defs.push(`<mask id="sm${idx}" maskUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${el.w + pad * 2}" height="${el.h + pad * 2}">`
        + `<rect x="${-pad}" y="${-pad}" width="${el.w + pad * 2}" height="${el.h + pad * 2}" fill="#fff"/>${paint('#000')}</mask>`);
    // 遮罩只能套在描边上，否则字形内的填充也会被黑色遮掉
    return paint(ref) + `<g mask="url(#sm${idx})">${paint('none', strokeAttr + ' stroke-linejoin="round"')}</g>`;
}

export interface SVGExportOpts { bounds: ExportBounds; elements: CanvasElement[]; transparent?: boolean; }

export function buildSVG(opts: SVGExportOpts): string {
    const b = opts.bounds, els = opts.elements;
    const defs: string[] = [], masks: string[] = [];
    const body: string[] = [];
    if (!opts.transparent) {
        const bg = fillDefs('svgBg', state.model.canvas.background);
        defs.push(bg.def);
        body.push(`<rect x="0" y="0" width="${b.w}" height="${b.h}" fill="${bg.ref}"/>`);
    }
    els.forEach((el, i) => {
        if (!el.exportVisible || !el.visible) return;
        const h = el.type === 'line' ? lineHeightFor(el) : el.h;
        const tx = el.x - b.x, ty = el.y - b.y;
        const px = el.pivotX * el.w, py = el.pivotY * h;
        const kx = Math.tan((el.skewX || 0) * Math.PI / 180);
        const ky = Math.tan((el.skewY || 0) * Math.PI / 180);
        const skew = (kx || ky) ? ` skewX(${el.skewX}) skewY(${el.skewY})` : '';
        const transform = `translate(${tx + px} ${ty + py}) rotate(${el.rotation})${skew} translate(${-px} ${-py})`;
        const opacity = ` opacity="${el.opacity}"`;
        const blend = el.blendMode && el.blendMode !== 'normal' ? ` style="mix-blend-mode:${el.blendMode}"` : '';
        const shadow = el.shadow && el.shadow.enabled
            ? `<filter id="sh${i}"><feDropShadow dx="${el.shadow.type === 'glow' ? 0 : el.shadow.x}" dy="${el.shadow.type === 'glow' ? 0 : el.shadow.y}" stdDeviation="${el.shadow.blur / 3}" flood-color="${el.shadow.color}" flood-opacity="${el.shadow.opacity}"/></filter>` : '';
        if (shadow) defs.push(shadow);
        const filter = shadow ? ` filter="url(#sh${i})"` : '';
        let inner = '';
        if (el.type === 'text') {
            const t = el.text!;
            const ctx = textMeasureCtx();
            const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, t, run, text));
            const lh = t.fontSize * t.lineHeight;
            const buildSpans = (mask: boolean, maskFill = '#fff'): string => {
                const out: string[] = [];
                let lineY = 0;
                lines.forEach((tokens, li) => {
                    if (li > 0 && tokens.paraStart) lineY += t.paraSpacing;
                    const inset = tokens.paraStart ? Math.min(t.indent, el.w) : 0;
                    const avail = Math.max(1, el.w - inset);
                    const total = tokens.reduce((a, tok) => a + tok.w, 0);
                    const gaps = tokens.length - 1;
                    const justify = t.align === 'justify' && li < lines.length - 1 && !lines[li].forcedEnd && gaps > 0;
                    const extra = justify ? Math.max(0, avail - total) / gaps : 0;
                    let x = t.align === 'center' ? inset + (avail - total) / 2 : t.align === 'right' ? el.w - total : inset;
                    const y = round2(lineY);
                    tokens.forEach(tok => {
                        const r = tok.run;
                        const attrs = ` x="${round2(x)}" y="${y}"`;
                        const weight = r.bold ? 700 : t.fontWeight;
                        const style = r.italic ? ' font-style="italic"' : '';
                        const deco = r.underline ? ' text-decoration="underline"' : '';
                        const fill = mask ? ` fill="${maskFill}"` : (r.color ? ` fill="${r.color}"` : '');
                        out.push(`<tspan${attrs} font-weight="${weight}"${style}${deco}${fill}>${xmlEscape(tok.text)}</tspan>`);
                        x += tok.w + extra;
                    });
                    lineY += lh;
                });
                return out.join('');
            };
            const head = `<text font-family="${xmlEscape(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}" letter-spacing="${t.letterSpacing}" dominant-baseline="text-before-edge"`;
            const fill = ` fill="${el.fill.enabled ? hexToRgba(el.fill.color, finite(el.fill.alpha, 1)) : 'none'}"`;
            const st = el.stroke && el.stroke.width > 0 ? el.stroke : null;
            if (!st) {
                inner = `${head}${fill}>${buildSpans(false)}</text>`;
            } else {
                const align = st.align || 'center';
                let strokeRef = st.color;
                if (st.gradient) {
                    defs.push(strokeDefMarkup('ts' + i, st.gradient));
                    strokeRef = `url(#ts${i})`;
                }
                const sw = align === 'center' ? st.width : st.width * 2;
                if (align === 'inside') {
                    defs.push(`<mask id="tm${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="${el.w}" height="${el.h}"><text font-family="${xmlEscape(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}" letter-spacing="${t.letterSpacing}" dominant-baseline="text-before-edge" fill="#fff">${buildSpans(true)}</text></mask>`);
                    inner = `${head}${fill}>${buildSpans(false)}</text>`
                        + `<g mask="url(#tm${i})">${head} fill="none" stroke="${strokeRef}" stroke-width="${sw}" stroke-linejoin="round">${buildSpans(false)}</text></g>`;
                } else if (align === 'outside') {
                    const pad = sw + 6;
                    defs.push(`<mask id="tm${i}" maskUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${el.w + pad * 2}" height="${el.h + pad * 2}">`
                        + `<rect x="${-pad}" y="${-pad}" width="${el.w + pad * 2}" height="${el.h + pad * 2}" fill="#fff"/>`
                        + `<text font-family="${xmlEscape(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}" letter-spacing="${t.letterSpacing}" dominant-baseline="text-before-edge" fill="#000">${buildSpans(true, '#000')}</text></mask>`);
                    inner = `${head}${fill}>${buildSpans(false)}</text>`
                        + `<g mask="url(#tm${i})">${head} fill="none" stroke="${strokeRef}" stroke-width="${sw}" stroke-linejoin="round">${buildSpans(false)}</text></g>`;
                } else {
                    inner = `${head}${fill} stroke="${strokeRef}" stroke-width="${sw}" stroke-linejoin="round">${buildSpans(false)}</text>`;
                }
            }
        } else if (el.type === 'line') {
            const ln = el.line!, y = h / 2;
            if (ln.style === 'wavy') {
                const { amp, period } = wavyGeom(ln);
                const spec = wavyDashSpec(ln);
                let d = `M 0 ${round2(y)}`;
                for (let x = 0; x < el.w; x += period / 2) {
                    d += ` Q ${round2(x + period / 4)} ${round2(y + (Math.floor(x / (period / 2)) % 2 ? amp : -amp))} ${round2(x + period / 2)} ${round2(y)}`;
                }
                const dash = spec ? ` stroke-dasharray="${spec.dash}" stroke-dashoffset="${spec.offset}"` : '';
                const cap = ln.dash === 'dashed' ? 'butt' : 'round';
                // 与编辑器/PNG 一致：波形超出元素宽度的部分裁掉
                defs.push(`<clipPath id="lc${i}"><rect x="0" y="0" width="${el.w}" height="${h}"/></clipPath>`);
                inner = `<g clip-path="url(#lc${i})"><path d="${d}" fill="none" stroke="${ln.color}" stroke-width="${ln.width}" stroke-linecap="${cap}"${dash}/></g>`;
            } else {
                const dash = ln.style === 'dashed' ? ' stroke-dasharray="10 6"' : ln.style === 'dotted' ? ' stroke-dasharray="2 4"' : '';
                inner = `<line x1="0" y1="${y}" x2="${el.w}" y2="${y}" stroke="${ln.color}" stroke-width="${ln.width}" stroke-linecap="round"${dash}/>`;
            }
        } else if (el.type === 'curve') {
            const ln = el.line!;
            const dash = ln.style === 'dashed' ? ` stroke-dasharray="${ln.width * 3} ${ln.width * 2}"`
                : ln.style === 'dotted' ? ` stroke-dasharray="0.1 ${ln.width * 1.8}"` : '';
            const fd = curveFillOn(el) ? fillDefs('g' + i, el.fill) : null;
            if (fd && fd.def) defs.push(fd.def);
            let strokeRef = ln.color;
            if (curveStrokeOn(el) && el.stroke.gradient) {
                defs.push(strokeDefMarkup('cs' + i, el.stroke.gradient));
                strokeRef = `url(#cs${i})`;
            }
            inner = `<path d="${curvePathD(el.curve, el.w, el.h)}" fill="${fd ? fd.ref : 'none'}" stroke="${strokeRef}" stroke-width="${curveStrokeOn(el) ? ln.width : 0}" stroke-linecap="round"${dash}/>`;
        } else if (el.image && state.assets[el.image.assetId]) {
            inner = `<image x="0" y="0" width="${el.w}" height="${el.h}" preserveAspectRatio="none" href="${state.assets[el.image.assetId]}"/>`;
        } else {
            const f = fillDefs('g' + i, el.fill);
            defs.push(f.def);
            let strokeRef = el.stroke.color;
            if (el.stroke.gradient) {
                defs.push(strokeDefMarkup('s' + i, el.stroke.gradient));
                strokeRef = `url(#s${i})`;
            }
            inner = shapeSVG(el, f.ref, strokeRef, i, defs);
        }
        let maskAttr = '';
        if (el.maskAssetId && state.assets[el.maskAssetId]) {
            const mid = 'm' + i;
            masks.push(`<mask id="${mid}"><image x="0" y="0" width="${el.w}" height="${el.h}" href="${state.assets[el.maskAssetId]}"/></mask>`);
            maskAttr = ` mask="url(#${mid})"`;
        }
        body.push(`<g transform="${transform}"${opacity}${blend}${filter}${maskAttr}>${inner}</g>`);
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}"><defs>${defs.join('')}${masks.join('')}</defs>${body.join('')}</svg>`;
}

/** 单页 PDF：把 JPEG 以 DCTDecode 图像 XObject 嵌入，纯前端构造 */
export function buildPDF(jpegDataURL: string, w: number, h: number): Blob {
    if (!/^data:image\/jpeg;base64,/.test(jpegDataURL) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        throw new Error('PDF 图片编码失败');
    }
    const base64 = String(jpegDataURL).split(',')[1] || '';
    if (!base64) throw new Error('PDF 图片编码失败');
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const enc = new TextEncoder();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const objOffsets = [0, 0, 0, 0, 0, 0];
    let length = 0;
    const push = (data: string | Uint8Array<ArrayBuffer>) => {
        const u = typeof data === 'string' ? enc.encode(data) : data;
        chunks.push(u); length += u.length;
    };
    push('%PDF-1.4\n');
    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
        `<< /Length ${content.length} >>\nstream\n${content}endstream`,
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`
    ];
    objs.forEach((o, i) => { objOffsets[i + 1] = length; push(`${i + 1} 0 obj\n${o}`); if (i !== 4) push('\nendobj\n'); });
    push(bytes); push('\nendstream\nendobj\n');
    const xrefStart = length;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) xref += String(objOffsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(xref);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
}