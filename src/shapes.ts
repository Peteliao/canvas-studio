/* 形状特征参数：所有渲染/导出/布尔运算共用的动态点位生成 */
import { POLYGON_POINTS } from './constants';
import type { CanvasElement, ElementType } from './types';
import { clamp, round2 } from './utils';

export interface ShapeParamSpec {
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
    def: number;
    unit?: string;
}

const p = (key: string, label: string, min: number, max: number, step: number, def: number, unit = ''): ShapeParamSpec =>
    ({ key, label, min, max, step, def, unit });

export const SHAPE_PARAM_SPECS: Partial<Record<ElementType, ShapeParamSpec[]>> = {
    rect: [p('corner', '圆角', 0, 500, 1, 0, 'px')],
    circle: [p('sweep', '扇形角度', 10, 360, 1, 360, '°'), p('rotate', '起始角度', -180, 180, 1, 0, '°')],
    triangle: [p('apex', '顶点位置', 0, 100, 1, 50, '%')],
    star: [p('points', '角数', 3, 20, 1, 5, '个'), p('inner', '内径比例', 5, 95, 1, 37, '%')],
    arrow: [p('head', '箭头长度', 20, 100, 1, 40, '%'), p('shaft', '杆粗', 10, 100, 1, 60, '%')],
    hexagon: [p('sides', '边数', 3, 12, 1, 6, '边')],
    pentagon: [p('sides', '边数', 3, 12, 1, 5, '边')],
    diamond: [p('waist', '腰线位置', 20, 80, 1, 50, '%')],
    trapezoid: [p('top', '顶边宽度', 0, 100, 1, 56, '%')],
    parallelogram: [p('slant', '倾斜度', 0, 50, 1, 25, '%')],
    cross: [p('arm', '臂宽', 10, 80, 1, 30, '%')],
    semicircle: [p('arch', '拱高', 20, 100, 1, 100, '%')],
    heart: [p('cleft', '凹口深度', 0, 60, 1, 27.4, '%')],
    cloud: [p('puff', '蓬松度', 50, 160, 1, 100, '%')],
    moon: [p('thickness', '月牙厚度', 50, 150, 1, 100, '%')],
    speech: [p('tail', '尾巴位置', 10, 90, 1, 43, '%'), p('tailSize', '尾巴长度', 40, 160, 1, 100, '%')],
    drop: [p('tip', '上尖长度', 40, 160, 1, 100, '%')]
};

export function shapeParamSpecs(type: ElementType): ShapeParamSpec[] | null {
    return SHAPE_PARAM_SPECS[type] || null;
}

/** 校验并清洗存档中的形状参数，未知键直接丢弃，数值按规格夹取 */
export function sanitizeShapeParams(type: ElementType, raw: unknown): Record<string, number> {
    const specs = SHAPE_PARAM_SPECS[type];
    const out: Record<string, number> = {};
    if (!specs || !raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;
    specs.forEach(s => {
        if (s.key === 'corner') return;
        const v = Number(o[s.key]);
        if (Number.isFinite(v)) out[s.key] = clamp(round2(v), s.min, s.max);
    });
    return out;
}

const num = (el: CanvasElement, key: string, def: number): number => {
    const v = el.shapeParams && el.shapeParams[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
};
const has = (el: CanvasElement, key: string): boolean => {
    const v = el.shapeParams && el.shapeParams[key];
    return typeof v === 'number' && Number.isFinite(v);
};

function normalizeBox(pts: [number, number][]): [number, number][] {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    if (!(maxX > minX) || !(maxY > minY)) return pts;
    return pts.map(([x, y]) => [round2((x - minX) / (maxX - minX) * 100), round2((y - minY) / (maxY - minY) * 100)]);
}

function normalizeY(pts: [number, number][]): [number, number][] {
    let min = Infinity, max = -Infinity;
    pts.forEach(([, y]) => { if (y < min) min = y; if (y > max) max = y; });
    if (!(max > min)) return pts;
    return pts.map(([x, y]) => [x, round2((y - min) / (max - min) * 100)]);
}

function ngon(sides: number): [number, number][] {
    const pts: [number, number][] = [];
    for (let i = 0; i < sides; i++) {
        const a = (-90 + i * 360 / sides) * Math.PI / 180;
        pts.push([50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)]);
    }
    return normalizeBox(pts);
}

/** 归一化百分比点位；null 表示使用原生 rect/圆形（完整圆）渲染 */
export function shapePoints(el: CanvasElement): [number, number][] | null {
    const t = el.type;
    const base = POLYGON_POINTS[t];
    if (t === 'circle') {
        const sweep = clamp(num(el, 'sweep', 360), 10, 360);
        if (sweep >= 360) return null;
        const rot = clamp(num(el, 'rotate', 0), -180, 180);
        const start = (rot - 90) * Math.PI / 180;
        const n = Math.max(12, Math.ceil(sweep / 3));
        const pts: [number, number][] = [[50, 50]];
        for (let i = 0; i <= n; i++) {
            const a = start + sweep * Math.PI / 180 * i / n;
            pts.push([round2(50 + 50 * Math.cos(a)), round2(50 + 50 * Math.sin(a))]);
        }
        return pts;
    }
    if (!base) return null;

    if (t === 'triangle' && has(el, 'apex')) {
        const x = clamp(num(el, 'apex', 50), 0, 100);
        return [[x, 0], [0, 100], [100, 100]];
    }
    if (t === 'star' && (has(el, 'points') || has(el, 'inner'))) {
        const n = Math.round(clamp(num(el, 'points', 5), 3, 20));
        const innerR = 50 * clamp(num(el, 'inner', 37), 5, 95) / 100;
        const pts: [number, number][] = [];
        for (let i = 0; i < n * 2; i++) {
            const a = (-90 + i * 180 / n) * Math.PI / 180;
            const r = i % 2 === 0 ? 50 : innerR;
            pts.push([round2(50 + r * Math.cos(a)), round2(50 + r * Math.sin(a))]);
        }
        return pts;
    }
    if ((t === 'hexagon' || t === 'pentagon') && has(el, 'sides')) {
        const defSides = t === 'pentagon' ? 5 : 6;
        return ngon(Math.round(clamp(num(el, 'sides', defSides), 3, 12)));
    }
    if (t === 'arrow' && (has(el, 'head') || has(el, 'shaft'))) {
        const head = clamp(num(el, 'head', 40), 20, 100);
        const half = clamp(num(el, 'shaft', 60), 10, 100) / 2;
        const hx = 100 - head;
        return [[0, 50 - half], [hx, 50 - half], [hx, 0], [100, 50], [hx, 100], [hx, 50 + half], [0, 50 + half]];
    }
    if (t === 'diamond' && has(el, 'waist')) {
        const w = clamp(num(el, 'waist', 50), 20, 80);
        return [[50, 0], [100, w], [50, 100], [0, w]];
    }
    if (t === 'trapezoid' && has(el, 'top')) {
        const d = clamp(num(el, 'top', 56), 0, 100) / 2;
        return [[50 - d, 0], [50 + d, 0], [100, 100], [0, 100]];
    }
    if (t === 'parallelogram' && has(el, 'slant')) {
        const s = clamp(num(el, 'slant', 25), 0, 50);
        return [[s, 0], [100, 0], [100 - s, 100], [0, 100]];
    }
    if (t === 'cross' && has(el, 'arm')) {
        const h = clamp(num(el, 'arm', 30), 10, 80) / 2;
        return [[50 - h, 0], [50 + h, 0], [50 + h, 50 - h], [100, 50 - h], [100, 50 + h], [50 + h, 50 + h],
            [50 + h, 100], [50 - h, 100], [50 - h, 50 + h], [0, 50 + h], [0, 50 - h], [50 - h, 50 - h]];
    }
    if (t === 'semicircle' && has(el, 'arch')) {
        const f = clamp(num(el, 'arch', 100), 20, 100) / 100;
        return base.map(([x, y]) => [x, round2(100 - (100 - y) * f)]);
    }
    if (t === 'heart' && has(el, 'cleft')) {
        const f = clamp(num(el, 'cleft', 27.4), 0, 60) / 27.4;
        return base.map(([x, y]) => (Math.abs(x - 50) <= 3 && y < 35 ? [x, round2(y * f)] : [x, y]));
    }
    if (t === 'cloud' && has(el, 'puff')) {
        const f = clamp(num(el, 'puff', 100), 50, 160) / 100;
        if (f === 1) return base;
        return normalizeY(base.map(([x, y]) => [x, round2(y < 60 ? 55 + (y - 55) * f : y)]));
    }
    if (t === 'moon' && has(el, 'thickness')) {
        const f = clamp(num(el, 'thickness', 100), 50, 150) / 100;
        const innerStart = base.findIndex(([x, y], i) => i > 20 && x > 85 && y > 90);
        return base.map(([x, y], i) => (i >= innerStart && innerStart > 0 ? [round2(100 - (100 - x) * f), y] : [x, y]));
    }
    if (t === 'speech' && (has(el, 'tail') || has(el, 'tailSize'))) {
        const shift = has(el, 'tail') ? clamp(num(el, 'tail', 43), 10, 90) - 43 : 0;
        const f = clamp(num(el, 'tailSize', 100), 40, 160) / 100;
        return base.map(([x, y]) => (y > 78.4
            ? [round2(clamp(x + shift, 0, 100)), round2(Math.min(100, 78.4 + (y - 78.4) * f))]
            : [x, y]));
    }
    if (t === 'drop' && has(el, 'tip')) {
        const f = clamp(num(el, 'tip', 100), 40, 160) / 100;
        if (f === 1) return base;
        return normalizeY(base.map(([x, y]) => [x, round2(y < 60 ? 60 - (60 - y) * f : y)]));
    }
    return base;
}

/** CSS clip-path；null 表示无裁剪（rect）或完整圆 */
export function shapeClipPath(el: CanvasElement): string | null {
    const pts = shapePoints(el);
    if (!pts) return null;
    return `polygon(${pts.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
}
