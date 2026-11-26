/* 模型与 schema 校验：所有存档/历史/项目文件的统一入口 */
import {
    VERSION, COMPAT_VERSIONS, TYPES, FILL_MODES, LINE_STYLES, TEXT_ALIGNS, STROKE_STYLES, STROKE_ALIGNS,
    BLEND_MODES, SHADOW_TYPES, TYPE_LABELS, MAX_CANVAS_SIDE, MAX_CURVE_NODES, CURVE_NODE_TYPES, DATA_IMAGE_RE,
    VECTOR_SHAPE_TYPES, VECTOR_SHAPE_PRESETS
} from './constants';
import type {
    Fill, Stroke, StrokeGradient, Shadow, TextStyle, TextRun, LineSpec, Curve, CurveNode,
    CanvasElement, Guide, Model, ElementType, StrokeStyle, StrokeAlign,
    TextSizeMode, CurveNodeType, FontWeight, Point, Box
} from './types';
import { state, nodeMap } from './state';
import { sanitizeShapeParams } from './shapes';
import { dbAvailable } from './db';
import { clamp, finite, normalizeStops, validColor, round2, round3, uid } from './utils';
import { makeImage } from './image-ref';

export { makeImage } from './image-ref';

const enumOf = <T extends string | number>(list: T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
const asRecord = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});

export function makeFill(raw: unknown): Fill {
    const o = asRecord(raw);
    const stops = normalizeStops(o.stops) || [
        { color: validColor(o.start, '#ffffff'), pos: 0 },
        { color: validColor(o.end, '#dddddd'), pos: 100 }
    ];
    return {
        enabled: o.enabled !== false,
        mode: enumOf(FILL_MODES, o.mode, 'solid'),
        color: validColor(o.color, '#cccccc'),
        start: stops[0].color,
        end: stops[stops.length - 1].color,
        stops,
        angle: clamp(finite(o.angle, 90), 0, 360),
        posX: clamp(finite(o.posX, 50), 0, 100),
        posY: clamp(finite(o.posY, 50), 0, 100),
        alpha: clamp(finite(o.alpha, 1), 0, 1)
    };
}
export function makeStrokeGradient(raw: unknown): StrokeGradient | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = asRecord(raw);
    const mode = enumOf(FILL_MODES, o.mode, 'solid');
    if (mode === 'solid') return null;
    return {
        mode,
        stops: normalizeStops(o.stops) || [{ color: '#ffffff', pos: 0 }, { color: '#1f2937', pos: 100 }],
        angle: clamp(finite(o.angle, 45), 0, 360),
        posX: clamp(finite(o.posX, 50), 0, 100),
        posY: clamp(finite(o.posY, 50), 0, 100)
    };
}
export function makeStroke(raw: unknown): Stroke {
    const o = asRecord(raw);
    return {
        color: validColor(o.color, '#1f2937'),
        width: clamp(finite(o.width, 0), 0, 60),
        style: enumOf(STROKE_STYLES, o.style, 'solid'),
        align: enumOf<StrokeAlign>(STROKE_ALIGNS, o.align, 'center'),
        gradient: makeStrokeGradient(o.gradient)
    };
}
export function makeShadow(raw: unknown): Shadow {
    const o = asRecord(raw);
    return {
        enabled: !!o.enabled,
        type: enumOf(SHADOW_TYPES, o.type, 'drop'),
        color: validColor(o.color, '#000000'),
        x: clamp(finite(o.x, 8), -100, 100),
        y: clamp(finite(o.y, 8), -100, 100),
        blur: clamp(finite(o.blur, 16), 0, 120),
        opacity: clamp(finite(o.opacity, 0.72), 0, 1)
    };
}
function makeRun(raw: unknown): TextRun {
    const r = asRecord(raw);
    return {
        text: typeof r.text === 'string' ? r.text.slice(0, 20000) : '',
        bold: !!r.bold, italic: !!r.italic, underline: !!r.underline,
        color: validColor(r.color, '')
    };
}
export function makeText(raw: unknown): TextStyle {
    const o = asRecord(raw);
    const runs: TextRun[] = Array.isArray(o.runs) ? (o.runs as unknown[]).slice(0, 2000).map(makeRun) : [];
    if (!runs.length) runs.push({ text: '双击输入文本', bold: false, italic: false, underline: false, color: '' });
    return {
        runs,
        fontSize: clamp(finite(o.fontSize, 30), 1, 500),
        fontFamily: typeof o.fontFamily === 'string' && o.fontFamily.length < 200 ? o.fontFamily : 'sans-serif',
        fontWeight: enumOf<FontWeight>([100, 300, 400, 500, 700, 900], o.fontWeight, 400),
        lineHeight: clamp(finite(o.lineHeight, 1.2), 0.3, 5),
        letterSpacing: clamp(finite(o.letterSpacing, 0), -20, 100),
        paraSpacing: clamp(finite(o.paraSpacing, 0), 0, 300),
        indent: clamp(finite(o.indent, 0), 0, 600),
        align: enumOf(TEXT_ALIGNS, o.align, 'left'),
        sizeMode: enumOf<TextSizeMode>(['fixed', 'autoH', 'autoWH'], o.sizeMode, 'fixed')
    };
}
export function makeLine(raw: unknown): LineSpec {
    const o = asRecord(raw);
    return {
        style: enumOf(LINE_STYLES, o.style, 'solid'),
        width: clamp(finite(o.width, 4), 1, 50),
        color: validColor(o.color, '#000000'),
        wavyAmp: clamp(finite(o.wavyAmp, 5), 1, 20),
        dash: enumOf<StrokeStyle>(['solid', 'dashed', 'dotted'], o.dash, 'solid')
    };
}
/** 贝塞尔路径：节点以元素宽高的比例存储，缩放元素时路径随之缩放
 *  控制柄与锚点重合表示该侧为直线段，支持任意节点数、开放/闭合路径 */
export function makeCurveNode(raw: unknown): CurveNode {
    const o = asRecord(raw);
    const pt = (v: unknown, d: number): number => clamp(round3(finite(v, d)), -3, 4);
    const x = pt(o.x, 0), y = pt(o.y, 0);
    return {
        x, y,
        ix: pt(o.ix, x), iy: pt(o.iy, y),
        ox: pt(o.ox, x), oy: pt(o.oy, y),
        t: enumOf<CurveNodeType>(CURVE_NODE_TYPES, o.t, 'smooth')
    };
}
export function makeCurve(raw: unknown): Curve {
    const o = asRecord(raw);
    if (Array.isArray(o.nodes) && o.nodes.length >= 2) {
        return { nodes: (o.nodes as unknown[]).slice(0, MAX_CURVE_NODES).map(makeCurveNode), closed: !!o.closed,
            filled: !!o.filled, strokeOn: o.strokeOn !== false };
    }
    // 旧版单段贝塞尔（四点）→ 两节点路径，形状完全一致
    const pt = (v: unknown, d: number): number => clamp(round3(finite(v, d)), -3, 4);
    const x1 = pt(o.x1, 0.02), y1 = pt(o.y1, 0.85);
    const cx1 = pt(o.cx1, 0.28), cy1 = pt(o.cy1, 0.05);
    const cx2 = pt(o.cx2, 0.72), cy2 = pt(o.cy2, 0.95);
    const x2 = pt(o.x2, 0.98), y2 = pt(o.y2, 0.15);
    return {
        nodes: [
            { x: x1, y: y1, ix: x1, iy: y1, ox: cx1, oy: cy1, t: 'cusp' },
            { x: x2, y: y2, ix: cx2, iy: cy2, ox: x2, oy: y2, t: 'cusp' }
        ],
        closed: false,
        filled: false,
        strokeOn: true
    };
}
/** 仅「闭合 + 已启用填充」才绘制填充；开放路径只描边，避免隐式闭合产生意外色块 */
export function curveFillOn(el: CanvasElement | null): boolean {
    return !!(el && el.type === 'curve' && el.curve && el.curve.closed && el.curve.filled && el.fill.enabled);
}
/** 曲线描边是否显示（旧存档无 strokeOn 字段时默认显示） */
export function curveStrokeOn(el: CanvasElement | null): boolean {
    return !!(el && el.type === 'curve' && el.curve && el.curve.strokeOn !== false);
}
/** 单段路径：两侧控制柄都贴着锚点即输出直线，否则输出三次贝塞尔 */
export function curveSegD(a: CurveNode, b: CurveNode, w: number, h: number): string {
    const x1 = a.x * w, y1 = a.y * h, x2 = b.x * w, y2 = b.y * h;
    const c1x = a.ox * w, c1y = a.oy * h, c2x = b.ix * w, c2y = b.iy * h;
    const flat = Math.abs(c1x - x1) < 1e-6 && Math.abs(c1y - y1) < 1e-6 &&
        Math.abs(c2x - x2) < 1e-6 && Math.abs(c2y - y2) < 1e-6;
    if (flat) return ` L ${round2(x2)} ${round2(y2)}`;
    return ` C ${round2(c1x)} ${round2(c1y)}, ${round2(c2x)} ${round2(c2y)}, ${round2(x2)} ${round2(y2)}`;
}
export function curvePathD(c: Curve | null, w: number, h: number): string {
    const n = c && c.nodes;
    if (!n || !n.length) return '';
    let d = `M ${round2(n[0].x * w)} ${round2(n[0].y * h)}`;
    for (let i = 1; i < n.length; i++) d += curveSegD(n[i - 1], n[i], w, h);
    if (c.closed && n.length > 1) d += curveSegD(n[n.length - 1], n[0], w, h) + ' Z';
    return d;
}
/** 曲线段的端点（像素坐标），含起止控制点，用于分割与命中测试 */
export function curveSegPts(nodes: CurveNode[], a: number, b: number, w: number, h: number): [Point, Point, Point, Point] {
    const A = nodes[a], B = nodes[b];
    return [
        { x: A.x * w, y: A.y * h },
        { x: A.ox * w, y: A.oy * h },
        { x: B.ix * w, y: B.iy * h },
        { x: B.x * w, y: B.y * h }
    ];
}
export function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const m = 1 - t;
    const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
/** 把一段贝塞尔在 t 处切开，返回左右两段（控制点列表），用于插入节点 */
export function splitCubic(pts: [Point, Point, Point, Point], t: number): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point]; mid: Point } {
    const lerp = (a: Point, b: Point): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const [p0, p1, p2, p3] = pts;
    const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
    const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
    const mid = lerp(p012, p123);
    return { left: [p0, p01, p012, mid], right: [mid, p123, p23, p3], mid };
}
/** 节点是否带控制柄（用于判断直线/曲线连接） */
export function curveNodeHasIn(n: CurveNode): boolean { return Math.abs(n.ix - n.x) > 1e-6 || Math.abs(n.iy - n.y) > 1e-6; }
export function curveNodeHasOut(n: CurveNode): boolean { return Math.abs(n.ox - n.x) > 1e-6 || Math.abs(n.oy - n.y) > 1e-6; }
function cubicValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const out: number[] = [];
    if (Math.abs(a) < 1e-9) {
        if (Math.abs(b) > 1e-9) {
            const t = -c / b;
            if (t > 0 && t < 1) out.push(t);
        }
        return out;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return out;
    const root = Math.sqrt(disc);
    [-b - root, -b + root].forEach(v => {
        const t = v / (2 * a);
        if (t > 0 && t < 1) out.push(t);
    });
    return out;
}
/** 路径在指定单位下的实际视觉范围（贝塞尔极值），不含外伸控制柄 */
export function curveNodesBox(nodes: CurveNode[], w: number, h: number, closed: boolean): Box {
    if (!nodes.length) return { left: 0, top: 0, right: 0, bottom: 0, w: 1, h: 1 };
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const put = (x: number, y: number): void => { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); };
    const segs = closed ? nodes.length : nodes.length - 1;
    if (!segs) {
        const n = nodes[0];
        put(n.x * w, n.y * h);
    }
    for (let i = 0; i < segs; i++) {
        const A = nodes[i], B = nodes[(i + 1) % nodes.length];
        const x0 = A.x * w, y0 = A.y * h;
        const x1 = A.ox * w, y1 = A.oy * h;
        const x2 = B.ix * w, y2 = B.iy * h;
        const x3 = B.x * w, y3 = B.y * h;
        put(x0, y0); put(x3, y3);
        const ts = new Set([...cubicExtrema(x0, x1, x2, x3), ...cubicExtrema(y0, y1, y2, y3)]);
        ts.forEach(tv => put(cubicValue(x0, x1, x2, x3, tv), cubicValue(y0, y1, y2, y3, tv)));
    }
    return { left: l, top: t, right: r, bottom: b, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}
export function curveLocalBox(el: CanvasElement): Box {
    const c = el.curve!;
    return curveNodesBox(c.nodes, el.w, el.h, c.closed);
}
export function lineDashArray(ln: LineSpec): string {
    if (ln.style === 'dashed') return `${ln.width * 3} ${ln.width * 2}`;
    if (ln.style === 'dotted') return `0.1 ${ln.width * 1.8}`;
    return '';
}
export function validateElement(raw: unknown): CanvasElement {
    if (!raw || typeof raw !== 'object') throw new Error('元素数据不是对象');
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_]{1,120}$/.test(r.id)) throw new Error('元素 id 不合法');
    if (!TYPES.includes(r.type as ElementType)) throw new Error('未知元素类型: ' + String(r.type).slice(0, 40));
    const type = r.type as ElementType;
    let line: LineSpec | null = null;
    if (type === 'line') line = makeLine(r.line);
    else if (type === 'curve') { line = makeLine(r.line); if (line.style === 'wavy') line.style = 'solid'; }
    const el: CanvasElement = {
        id: r.id,
        type,
        x: clamp(finite(r.x, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        y: clamp(finite(r.y, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        w: clamp(finite(r.w, 200), 1, MAX_CANVAS_SIDE),
        h: clamp(finite(r.h, 150), 1, MAX_CANVAS_SIDE),
        rotation: clamp(finite(r.rotation, 0), -36000, 36000),
        skewX: clamp(finite(r.skewX, 0), -85, 85),
        skewY: clamp(finite(r.skewY, 0), -85, 85),
        pivotX: clamp(finite(r.pivotX, 0.5), -2, 3),
        pivotY: clamp(finite(r.pivotY, 0.5), -2, 3),
        zIndex: clamp(finite(r.zIndex, 1), 0, 100000),
        locked: !!r.locked,
        exportVisible: r.exportVisible !== false,
        opacity: clamp(finite(r.opacity, 1), 0, 1),
        borderRadius: clamp(finite(r.borderRadius, 0), 0, 10000),
        shapeParams: sanitizeShapeParams(type, r.shapeParams),
        fill: makeFill(r.fill),
        text: type === 'text' ? makeText(r.text) : null,
        line,
        curve: type === 'curve' ? makeCurve(r.curve) : null,
        image: makeImage(r.image),
        maskAssetId: typeof r.maskAssetId === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(r.maskAssetId) ? r.maskAssetId : null,
        // ---- V12：图层元数据与视觉效果 ----
        name: typeof r.name === 'string' ? r.name.slice(0, 80) : (TYPE_LABELS[type] || '元素'),
        visible: r.visible !== false,
        groupId: typeof r.groupId === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(r.groupId) ? r.groupId : null,
        linkId: typeof r.linkId === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(r.linkId) ? r.linkId : null,
        stroke: makeStroke(r.stroke),
        shadow: makeShadow(r.shadow),
        blendMode: enumOf(BLEND_MODES, r.blendMode, 'normal'),
        effectTint: typeof r.effectTint === 'number' && Number.isFinite(r.effectTint)
            ? clamp(round2(r.effectTint), 0, 1) : null
    };
    return el;
}
export function validateGuide(raw: unknown): Guide {
    if (!raw || typeof raw !== 'object') throw new Error('辅助线数据不是对象');
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_]{1,120}$/.test(r.id)) throw new Error('辅助线 id 不合法');
    return {
        id: r.id,
        angle: clamp(finite(r.angle, 0), -36000, 36000),
        x: clamp(finite(r.x, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        y: clamp(finite(r.y, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE)
    };
}
export function validateAssets(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const r = raw as Record<string, unknown>;
    Object.keys(r).slice(0, 5000).forEach(k => {
        const v = r[k];
        if (/^[A-Za-z0-9_]{1,120}$/.test(k) && typeof v === 'string' && v.length < 40 * 1024 * 1024 && DATA_IMAGE_RE.test(v)) {
            out[k] = v;
        }
    });
    return out;
}
/** 统一入口：自动保存快照、撤销历史条目、项目文件都经过这里 */
export function validateProject(raw: unknown): Model {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目数据格式不正确');
    const r = raw as Record<string, unknown>;
    // 兼容旧存档：v2 补齐图层元数据，v3 的单段曲线自动迁移为多节点路径
    if (!COMPAT_VERSIONS.includes(r.version as number)) throw new Error('项目版本不匹配（需要 v' + VERSION + '）');
    const c = r.canvas as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object') throw new Error('缺少画布设置');
    const w = clamp(finite(c.w, 800), 1, MAX_CANVAS_SIDE);
    const h = clamp(finite(c.h, 800), 1, MAX_CANVAS_SIDE);
    if (!Array.isArray(r.elements)) throw new Error('元素列表格式不正确');
    if (r.elements.length > 5000) throw new Error('元素数量超出上限');
    const ids = new Set<string>();
    const elements = (r.elements as unknown[]).map(e => {
        const el = validateElement(e);
        if (ids.has(el.id)) throw new Error('存在重复的元素 id');
        ids.add(el.id);
        return el;
    });
    const guides: Guide[] = [];
    if (r.guides !== undefined) {
        if (!Array.isArray(r.guides)) throw new Error('辅助线列表格式不正确');
        if (r.guides.length > 200) throw new Error('辅助线数量超出上限');
        const gids = new Set<string>();
        (r.guides as unknown[]).forEach(g => {
            const gd = validateGuide(g);
            if (gids.has(gd.id)) throw new Error('存在重复的辅助线 id');
            gids.add(gd.id);
            guides.push(gd);
        });
    }
    return {
        version: VERSION,
        name: typeof r.name === 'string' ? r.name.slice(0, 80) : '未命名设计',
        canvas: { w, h, background: makeFill(c.background), lockedRatio: !!c.lockedRatio },
        elements,
        guides,
        assets: r.assets ? validateAssets(r.assets) : undefined
    };
}
export function defaultModel(): Model {
    const mk = (id: string, x: number, y: number, color: string, z: number): CanvasElement => validateElement({
        id, type: 'rect', x, y, w: 200, h: 200, rotation: 0, zIndex: z,
        locked: false, exportVisible: true, opacity: 1, borderRadius: 0,
        fill: { mode: 'solid', color, start: '#ffffff', end: '#dddddd', angle: 90, posX: 50, posY: 50 }
    });
    return {
        version: VERSION,
        name: '未命名设计',
        canvas: { w: 800, h: 800, lockedRatio: false, background: makeFill({ mode: 'solid', color: '#ffffff' }) },
        elements: [mk('el_1', 50, 50, '#ffcccb', 1), mk('el_2', 150, 150, '#add8e6', 2)],
        guides: []
    };
}
export function getEl(id: string): CanvasElement | null { return state.model.elements.find(e => e.id === id) || null; }
export function selectedEls(): CanvasElement[] { return state.selection.map(getEl).filter((e): e is CanvasElement => !!e); }
export function nextZIndex(): number {
    return state.model.elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1;
}
export function normalizeZ(): void {
    state.model.elements.slice().sort((a, b) => a.zIndex - b.zIndex).forEach((e, i) => { e.zIndex = i + 1; });
    nodeMap.forEach((d, id) => {
        const el = getEl(id);
        if (el) d.style.zIndex = String(el.zIndex);
    });
}
export function sortedElements(): CanvasElement[] {
    return state.model.elements.slice().sort((a, b) => a.zIndex - b.zIndex);
}
export function snapshotJSON(): string {
    return JSON.stringify({
        version: VERSION,
        name: state.model.name || '未命名设计',
        canvas: state.model.canvas,
        elements: state.model.elements,
        guides: state.model.guides || [],
        // IndexedDB 不可用时降级为内联资源，保证数据不静默丢失
        assets: dbAvailable ? undefined : state.assets
    });
}
export function buildElement(type: ElementType, x: number, y: number): CanvasElement {
    const base: Record<string, unknown> = {
        id: uid('el'), type, x, y, w: 200, h: 150, rotation: 0, skewX: 0, skewY: 0, zIndex: nextZIndex(),
        locked: false, exportVisible: true, opacity: 1, borderRadius: 0,
        shapeParams: {},
        fill: makeFill({ mode: 'solid', color: '#cccccc' }),
        text: null, line: null, image: null, maskAssetId: null,
        effectTint: null
    };
    if (type === 'circle') { base.w = 150; base.h = 150; }
    if (type === 'triangle' || type === 'star') { base.w = 150; base.h = 150; }
    if (VECTOR_SHAPE_TYPES.includes(type)) {
        const preset = VECTOR_SHAPE_PRESETS.find(p => p.type === type);
        if (preset) { base.w = preset.w; base.h = preset.h; }
    }
    if (type === 'arrow') { base.w = 200; base.h = 100; }
    if (type === 'line') {
        base.w = 300; base.h = 4;
        base.line = makeLine({ style: 'solid', width: 4, color: '#000000', wavyAmp: 5 });
    }
    if (type === 'curve') {
        base.w = 300; base.h = 160;
        base.line = makeLine({ style: 'solid', width: 4, color: '#000000' });
        base.curve = makeCurve({});
    }
    if (type === 'text') {
        base.w = 300; base.h = 54;
        base.text = makeText({ fontSize: 30 });
        base.fill = makeFill({ mode: 'solid', color: '#000000' });
    }
    if (type === 'image') { base.w = 300; base.h = 200; }
    base.name = TYPE_LABELS[type] + ' ' + (state.model.elements.length + 1);
    return validateElement(base);
}