/* 样式计算：填充 CSS、描边/投影滤镜、波浪线几何 */
import { HEX_RE, SVG_NS, STROKE_SVG_TYPES } from './constants';
import { shapePoints } from './shapes';
import type { CanvasElement, Fill, LineSpec } from './types';
import { clamp, finite, round2 } from './utils';

/** 两色按比例混合（t=0 取 a，t=1 取 b），用于透明特效的高光/暗部派生 */
export function mixHex(a: string, b: string, t: number): string {
    if (!HEX_RE.test(a) || !HEX_RE.test(b)) return a;
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    const f = (sh: number): number => {
        const ca = (x >> sh) & 255, cb = (y >> sh) & 255;
        return Math.round(ca + (cb - ca) * clamp(t, 0, 1));
    };
    return '#' + ((f(16) << 16) | (f(8) << 8) | f(0)).toString(16).padStart(6, '0');
}
export function effectTintColors(base: string, light: number): { start: string; end: string } {
    return { start: mixHex(base, '#ffffff', light), end: mixHex(base, '#000000', 0.1) };
}
/** 透明特效元素换色：以主色重算渐变高光/暗部，保留模式与透明度 */
export function applyEffectTint(el: CanvasElement, base: string): boolean {
    if (typeof el.effectTint !== 'number' || !HEX_RE.test(base)) return false;
    el.fill.enabled = true;
    el.fill.color = base;
    if (el.fill.mode !== 'solid') {
        const c = effectTintColors(base, el.effectTint);
        el.fill.start = c.start;
        el.fill.end = c.end;
    }
    return true;
}
export function hexToRgba(hex: string, alpha: number): string {
    if (!HEX_RE.test(hex)) return hex;
    if (alpha >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
export function fillToCSS(f: Fill): string {
    if (!f.enabled) return 'transparent';
    const a = clamp(finite(f.alpha, 1), 0, 1);
    const s = hexToRgba(f.start, a), e = hexToRgba(f.end, a);
    if (f.mode === 'linear') return `linear-gradient(${f.angle}deg, ${s}, ${e})`;
    if (f.mode === 'radial') return `radial-gradient(ellipse at ${f.posX}% ${f.posY}%, ${s}, ${e})`;
    if (f.mode === 'conic') return `conic-gradient(from ${f.angle}deg at ${f.posX}% ${f.posY}%, ${s}, ${e})`;
    return hexToRgba(f.color, a);
}
/** 描边：常规形状用 SVG 轮廓叠加（支持虚线），boolean 用多重 drop-shadow 贴合遮罩；投影基于 alpha */
export function shapeFilter(el: CanvasElement): string {
    const parts: string[] = [];
    const st = el.stroke;
    if (st && st.width > 0 && !STROKE_SVG_TYPES.includes(el.type)) {
        const w = Math.min(st.width, 12);
        const offsets: [number, number][] = [[w, 0], [-w, 0], [0, w], [0, -w]];
        if (w > 2) offsets.push([w * .7, w * .7], [-w * .7, w * .7], [w * .7, -w * .7], [-w * .7, -w * .7]);
        offsets.forEach(([x, y]) => parts.push(`drop-shadow(${round2(x)}px ${round2(y)}px 0 ${st.color})`));
    }
    const sh = el.shadow;
    if (sh && sh.enabled) {
        const ox = sh.type === 'glow' ? 0 : sh.x, oy = sh.type === 'glow' ? 0 : sh.y;
        parts.push(`drop-shadow(${ox}px ${oy}px ${sh.blur}px ${hexToRgba(sh.color, sh.opacity)})`);
    }
    return parts.join(' ');
}
/** 生成描边 SVG 叠加层的内部标记（像素坐标，与导出保持一致的居中描边） */
export function strokeOverlayMarkup(el: CanvasElement, w: number, h: number): string {
    const st = el.stroke;
    if (!st || st.width <= 0 || !STROKE_SVG_TYPES.includes(el.type)) return '';
    const dash = st.style === 'dashed' ? ` stroke-dasharray="${st.width * 3} ${st.width * 2}"`
        : st.style === 'dotted' ? ` stroke-dasharray="0.1 ${st.width * 1.8}" stroke-linecap="round"` : '';
    const attrs = `fill="none" stroke="${st.color}" stroke-width="${st.width}"${dash}`;
    const pts = shapePoints(el);
    if (pts) {
        return `<polygon points="${pts.map(([x, y]) => `${round2(x * w / 100)},${round2(y * h / 100)}`).join(' ')}" stroke-linejoin="round" ${attrs}/>`;
    }
    if (el.type === 'circle') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`;
    const rx = Math.min(el.borderRadius, w / 2, h / 2);
    return `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ${attrs}/>`;
}
export function wavyGeom(line: LineSpec): { amp: number; period: number } {
    const amp = line.width * 0.5 + line.wavyAmp * 1.5;
    const period = Math.max(line.width * 2 + 10, 45 - line.wavyAmp * 1.5);
    return { amp, period };
}
/** 一个波浪周期（两段二次贝塞尔）的弧长，采样计算 */
export function wavyPeriodLength(period: number, amp: number): number {
    let len = 0;
    const quad = (p0: [number, number], p1: [number, number], p2: [number, number]): void => {
        let px = p0[0], py = p0[1];
        for (let i = 1; i <= 32; i++) {
            const t = i / 32, u = 1 - t;
            const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
            const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
            len += Math.hypot(x - px, y - py);
            px = x; py = y;
        }
    };
    quad([0, 0], [period / 4, -amp], [period / 2, 0]);
    quad([period / 2, 0], [period * 3 / 4, amp], [period, 0]);
    return len;
}
/** 波浪线的虚线/点线规格：每周期整数个循环保证 repeat-x 瓦片无缝；
 *  点线再偏移半周期，让圆点远离瓦片接缝，避免圆头帽被裁切 */
export function wavyDashSpec(line: LineSpec): { dash: string; offset: number } | null {
    if (line.style !== 'wavy' || !line.dash || line.dash === 'solid') return null;
    const { amp, period } = wavyGeom(line);
    const L = wavyPeriodLength(period, amp);
    if (line.dash === 'dashed') return { dash: `${round2(L / 8)} ${round2(L / 8)}`, offset: 0 };
    const n = Math.max(4, Math.floor(L / (0.1 + line.width * 1.2 + 0.5)));
    const gap = round2(L / n - 0.1);
    return { dash: `0.1 ${gap}`, offset: round2((0.1 + gap) / 2) };
}
export function wavyDataURI(line: LineSpec): string {
    const stroke = line.width;
    const { amp, period } = wavyGeom(line);
    const h = Math.max(stroke * 4, amp * 2 + stroke * 2);
    const cy = h / 2;
    const spec = wavyDashSpec(line);
    const cap = line.dash === 'dashed' ? 'butt' : 'round';
    const dash = spec ? ` stroke-dasharray="${spec.dash}" stroke-dashoffset="${spec.offset}"` : '';
    const svg = `<svg xmlns="${SVG_NS}" width="${period}" height="${h}"><path d="M 0 ${cy} Q ${period / 4} ${cy - amp}, ${period / 2} ${cy} T ${period} ${cy}" fill="none" stroke="${line.color}" stroke-width="${stroke}" stroke-linecap="${cap}"${dash}/></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
export function lineHeightFor(el: CanvasElement): number {
    if (el.type !== 'line') return el.h;
    const ln = el.line!;
    return ln.style === 'wavy'
        ? Math.max(ln.width * 4, (ln.width * 0.5 + ln.wavyAmp * 1.5) * 2 + ln.width * 2)
        : Math.max(1, ln.width);
}