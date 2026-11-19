/* 内置自检 */
import { VERSION, DB_NAME, HEX_RE, SHADOW_PRESETS, POLYGON_POINTS, CLIP_PATHS, VECTOR_SHAPE_PRESETS, TYPES } from './constants';
import type { CanvasElement, AABB, ElementType, CurveNode, SnapPoint } from './types';
import { state } from './state';
import { $, iconEl } from './utils';
import { validateProject, snapshotJSON, makeFill, makeLine, makeStroke, makeShadow, makeText, buildElement, validateElement,
    curvePathD, curveFillOn, curveStrokeOn, validateGuide, curveSegPts, splitCubic, cubicAt, sortedElements,
    curveNodesBox, curveLocalBox, selectedEls } from './model';
import { elementSnapPoints, nearestSnapPoint, nearestPointSnap } from './snappoints';
import { applyEffectTint, fillToCSS, shapeFilter, lineHeightFor, wavyDashSpec, wavyDataURI, strokeOverlayMarkup } from './style';
import { buildSVG, buildPDF } from './vector-export';
import { SHAPE_PARAM_SPECS, shapePoints, shapeClipPath, sanitizeShapeParams } from './shapes';
import { getAABB, setPivot, elementLocalToWorld, elementWorldToLocal } from './geometry';
import { textMeasureCtx, canvasTextWidth, applyAutoSize, renderAll, syncElement } from './render';
import { layoutText, exportBoundsFor, textStrokeLayers } from './exporter';
import { bucketColor, elementSlotColor, applyBucketColor } from './bucket';
import { neighborGapsFor, alignmentMeasures, drawMeasure } from './measure';
import type { GapMeasure, AlignMeasure } from './measure';
import { boxGuideMeasure } from './guides';
import { setSelection, toggleSelection } from './selection';
import { linkCompatibility, linkSelected, unlinkSelected, syncLinkedOnCommit, resetLinkSnapshots } from './linked';
import { dbAvailable } from './db';
import { EFFECT_PRESETS } from './effects';
import { applyStyleToElement, styleOptionEnabled, canConvertShape, convertElementShape } from './selectiontools';
import { showFitFloat, hideFitFloat } from './view';
import { beginStrokeAlignPreview, endStrokeAlignPreview } from './railstroke';

export function runSelfTest(): void {
    const results: { name: string; ok: boolean; detail: string }[] = [];
    const check = (name: string, fn: () => string | void): void => {
        try { const detail = fn(); results.push({ name, ok: true, detail: detail || '通过' }); }
        catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
    };
    const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };
    check('数据模型可用', () => { assert(state.model && Array.isArray(state.model.elements), '模型未初始化'); return `${state.model.elements.length} 个元素`; });
    check('项目 schema 校验', () => {
        const p = validateProject(JSON.parse(snapshotJSON()));
        assert(p.version === VERSION && p.elements.length === state.model.elements.length, '往返元素数不一致');
        return 'v' + p.version;
    });
    check('渲染节点与模型一致', () => {
        const a = document.querySelectorAll('.canvas-element').length;
        assert(a === state.model.elements.length, `DOM ${a} ≠ 模型 ${state.model.elements.length}`);
        return a + ' 个节点';
    });
    check('四种填充模式', () => {
        ['solid', 'linear', 'radial', 'conic'].forEach(m => assert(fillToCSS(makeFill({ mode: m })).length > 0, m + ' 生成失败'));
        return 'solid/linear/radial/conic';
    });
    check('多色标渐变与描边渐变', () => {
        const stops = [
            { color: '#ff0000', pos: 0 }, { color: '#00ff00', pos: 30 },
            { color: '#0000ff', pos: 70 }, { color: '#ffffff', pos: 100 }
        ];
        const f = makeFill({ mode: 'linear', stops });
        assert(f.stops.length === 4 && f.start === '#ff0000' && f.end === '#ffffff', '多色标未保留或首尾未同步');
        const css = fillToCSS(f);
        assert(css.includes('30%') && css.includes('70%'), 'CSS 渐变缺少中间色标');
        const round = validateElement(Object.assign(buildElement('rect', 0, 0), { fill: f }));
        assert(round.fill.stops.length === 4, '存档往返丢失色标');
        const el = buildElement('rect', 0, 0);
        el.fill = f;
        el.stroke = makeStroke({
            width: 3, color: '#1f2937',
            gradient: { mode: 'linear', angle: 45, posX: 50, posY: 50, stops: stops.slice(0, 3) }
        });
        const overlay = strokeOverlayMarkup(el, el.w, el.h);
        assert(overlay.includes('<defs>') && overlay.includes('stroke="url(#stg_'), '画布描边未使用渐变');
        assert((overlay.match(/<stop /g) || []).length === 3, '描边渐变色标数量异常');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('stroke="url(#s0)"') && svg.includes('id="s0"'), 'SVG 导出缺少渐变描边');
        assert(applyBucketColor(el, 'stroke', '#123456') && el.stroke.gradient === null, '纯色描边应清除旧渐变');
        const curve = buildElement('curve', 0, 0);
        curve.line = makeLine({ width: 3, color: '#1f2937' });
        curve.curve!.strokeOn = true;
        curve.stroke = makeStroke({
            width: 3, color: '#1f2937',
            gradient: { mode: 'linear', angle: 30, posX: 50, posY: 50, stops: stops.slice(0, 3) }
        });
        const csvg = buildSVG({ bounds: { x: 0, y: 0, w: curve.w, h: curve.h }, elements: [curve], transparent: true });
        assert(csvg.includes('id="cs0"') && csvg.includes('stroke="url(#cs0)"'), '曲线描边渐变未导出');
        return '4 色标填充 · 3 色标描边 · 曲线描边渐变 · 存档/导出一致';
    });
    check('样式刷复制填充与描边', () => {
        const src = buildElement('rect', 0, 0);
        src.fill = makeFill({
            mode: 'linear', color: '#112233', alpha: 0.6,
            stops: [{ color: '#ff0000', pos: 0 }, { color: '#00ff00', pos: 50 }, { color: '#0000ff', pos: 100 }]
        });
        src.stroke = makeStroke({
            color: '#ff8800', width: 5,
            gradient: { mode: 'linear', angle: 30, posX: 50, posY: 50,
                stops: [{ color: '#ff8800', pos: 0 }, { color: '#22cc88', pos: 100 }] }
        });
        const dst = buildElement('circle', 10, 10);
        dst.stroke = makeStroke({ color: '#000000', width: 1 });
        assert(styleOptionEnabled(src, dst, 'all'), '全部样式选项不可用');
        assert(applyStyleToElement(src, dst, 'all'), '样式应用失败');
        assert(dst.fill.mode === 'linear' && dst.fill.stops.length === 3 && Math.abs(dst.fill.alpha - 0.6) < 1e-6, '填充未完整复制');
        assert(dst.stroke.width === 5 && dst.stroke.color === '#ff8800' && !!dst.stroke.gradient
            && dst.stroke.gradient.stops.length === 2, '描边未完整复制');
        const line = buildElement('line', 0, 0);
        assert(!styleOptionEnabled(src, line, 'all') && styleOptionEnabled(src, line, 'strokeWidth'), '线条目标能力判断异常');
        const text = buildElement('text', 0, 0);
        assert(styleOptionEnabled(src, text, 'stroke') && styleOptionEnabled(src, text, 'fill'), '文本描边/填充能力判断异常');
        src.stroke.align = 'outside';
        text.stroke = makeStroke({ color: '#000000', width: 1 });
        assert(applyStyleToElement(src, text, 'stroke') && text.stroke.align === 'outside', '文本未复制描边对齐');
        return '填充/描边/粗细 · 目标能力过滤 · 文本描边对齐';
    });
    check('线条四样式', () => {
        ['solid', 'dashed', 'dotted', 'wavy'].forEach(s => assert(lineHeightFor(makeSelfLine(s)) > 0, s + ' 高度异常'));
        ['dashed', 'dotted'].forEach(d => {
            const ln = makeLine({ style: 'wavy', dash: d });
            assert(wavyDashSpec(ln), '波浪' + d + ' 规格缺失');
            assert(wavyDataURI(ln).includes('stroke-dasharray'), '波浪' + d + ' 瓦片缺 dash');
        });
        assert(!wavyDashSpec(makeLine({ style: 'wavy', dash: 'solid' })), '实线波浪不应有 dash');
        const wavyEl = buildElement('line', 0, 0);
        wavyEl.line = makeLine({ style: 'wavy', dash: 'dashed' });
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: 200, h: 40 }, elements: [wavyEl], transparent: true });
        assert(svg.includes('<path') && svg.includes('stroke-dasharray'), 'SVG 波浪虚线导出异常');
        return 'solid/dashed/dotted/wavy · 波浪可虚/点';
    });
    check('曲线元素与路径', () => {
        const el = buildElement('curve', 0, 0);
        assert(el.curve && Array.isArray(el.curve.nodes) && el.curve.nodes.length >= 2, '曲线节点缺失');
        const d = curvePathD(el.curve!, el.w, el.h);
        assert(d.startsWith('M ') && d.includes(' C '), '路径数据异常');
        const v = validateElement(el);
        assert(v.type === 'curve' && v.curve!.nodes.length === el.curve!.nodes.length && v.line, '校验往返丢失曲线');
        // 旧版单段四点曲线存档（v3）自动迁移为两节点路径
        const legacy = validateElement({
            id: 'el_legacy', type: 'curve', x: 0, y: 0, w: 100, h: 100,
            curve: { x1: 0, y1: 1, cx1: 0.3, cy1: 0, cx2: 0.7, cy2: 1, x2: 1, y2: 0 },
            line: { width: 2 }
        });
        assert(legacy.curve!.nodes.length === 2 && legacy.curve!.nodes[0].ox === 0.3, '旧版曲线未迁移');
        // De Casteljau 分割：插入节点后形状不变（分割点落在曲线上）
        const pts = curveSegPts(legacy.curve!.nodes, 0, 1, legacy.w, legacy.h);
        const sp = splitCubic(pts, 0.5);
        const expect = cubicAt(pts[0], pts[1], pts[2], pts[3], 0.5);
        assert(Math.abs(sp.mid.x - expect.x) < 0.001 && Math.abs(sp.mid.y - expect.y) < 0.001, '节点分割点偏离曲线');
        return el.curve!.nodes.length + ' 节点 · 兼容旧版·可闭合';
    });
    check('曲线真实边界（贝塞尔极值）', () => {
        const nodes: CurveNode[] = [
            { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0.5, t: 'cusp' },
            { x: 1, y: 0, ix: 1, iy: 0.5, ox: 1, oy: 0, t: 'cusp' }
        ];
        const b = curveNodesBox(nodes, 100, 200, false);
        assert(Math.abs(b.left) < 0.001 && Math.abs(b.top) < 0.001, '边界起点错误');
        assert(Math.abs(b.right - 100) < 0.001, '边界右端错误');
        assert(Math.abs(b.bottom - 75) < 0.01, '未按曲线极值计算下边界：' + b.bottom);
        assert(Math.abs(b.h - 75) < 0.01 && b.h < 100, '高度不应包含外伸控制柄');
        const el = buildElement('curve', 20, 30);
        el.w = 100; el.h = 200;
        el.curve = { nodes, closed: false, filled: false, strokeOn: true };
        const lb = curveLocalBox(el);
        assert(Math.abs(lb.w - 100) < 0.01 && Math.abs(lb.h - 75) < 0.01, '元素局部边界与路径不一致');
        const aabb = getAABB(el);
        assert(aabb.left === 20 && aabb.top === 30 && Math.abs(aabb.w - 100) < 0.01, '元素框与视觉路径未重合');
        return '极值 75 / 控制柄外伸 100 · 对齐无间隙';
    });
    check('捕捉点生成与吸附', () => {
        const circle = buildElement('circle', 100, 100);
        circle.w = 100; circle.h = 100;
        const cps = elementSnapPoints(circle);
        assert(cps.length === 5, '圆形应有圆心 + 4 象限点，实际 ' + cps.length);
        assert(cps.some(p => p.kind === 'center' && p.x === 150 && p.y === 150), '缺圆心');
        assert(cps.filter(p => p.kind === 'quadrant').length === 4, '象限点数量异常');
        const near = nearestSnapPoint({ x: 101, y: 151 }, 8, new Set(), cps);
        assert(near && near.kind === 'quadrant' && near.x === 100 && near.y === 150, '象限点未命中');
        assert(!nearestSnapPoint({ x: 180, y: 180 }, 8, new Set(), cps), '超出阈值不应吸附');
        const rect = buildElement('rect', 0, 0);
        const rps = elementSnapPoints(rect);
        assert(rps.some(p => p.kind === 'endpoint') && rps.some(p => p.kind === 'midpoint'), '矩形缺少端点 / 中点');
        assert(rps.filter(p => p.kind === 'golden').length === 12, '黄金分割点数量异常');
        const rot = buildElement('rect', 0, 0);
        rot.w = 100; rot.h = 100; rot.rotation = 90;
        const rp = elementSnapPoints(rot);
        assert(rp.some(p => Math.abs(p.x - 100) < 0.01 && Math.abs(p.y) < 0.01), '旋转后捕捉点未跟随');
        const target: SnapPoint = { x: 100, y: 100, kind: 'center', label: '中心' };
        const source: SnapPoint = { x: 0, y: 0, kind: 'endpoint', label: '端点' };
        const snap = nearestPointSnap([source], [target], 96, 104, 8);
        assert(snap && snap.dx === 4 && snap.dy === -4 && snap.target === target, '移动吸附偏移错误');
        assert(!nearestPointSnap([source], [target], 80, 80, 8), '超出阈值仍吸附');
        // 曲线的中点 / 黄金分割必须沿贝塞尔路径，不能落在外接矩形内部
        const curve = buildElement('curve', 0, 0);
        curve.w = 100; curve.h = 100;
        const cnodes: CurveNode[] = [
            { x: 0, y: 1, ix: 0, iy: 1, ox: 0.25, oy: 0, t: 'smooth' },
            { x: 1, y: 1, ix: 0.75, iy: 0, ox: 1, oy: 1, t: 'smooth' }
        ];
        curve.curve = { nodes: cnodes, closed: false, filled: false, strokeOn: true };
        const cps2 = elementSnapPoints(curve);
        const onCurve: { x: number; y: number }[] = [];
        for (let i = 0; i < cnodes.length - 1; i++) {
            const cp = curveSegPts(cnodes, i, i + 1, curve.w, curve.h);
            for (let s = 0; s <= 2048; s++) onCurve.push(cubicAt(cp[0], cp[1], cp[2], cp[3], s / 2048));
        }
        const pathDist = (p: SnapPoint): number => Math.min(...onCurve.map(q => Math.hypot(q.x - (p.x - curve.x), q.y - (p.y - curve.y))));
        const cGolden = cps2.filter(p => p.kind === 'golden');
        const cMid = cps2.filter(p => p.kind === 'midpoint');
        assert(cGolden.length === 2 && cMid.length === 1, '曲线黄金分割 / 中点数量异常');
        assert(cGolden.every(p => pathDist(p) < 0.05) && cMid.every(p => pathDist(p) < 0.05), '曲线特征点未落在路径上');
        return '圆心 / 象限 / 端点 / 中点 / 黄金分割 · 旋转跟随 · 曲线沿路径';
    });
    check('闭合曲线填充', () => {
        const el = buildElement('curve', 0, 0);
        el.curve!.closed = true;
        assert(!curveFillOn(el), '旧存档默认应保持只描边');
        el.curve!.filled = true;
        el.fill = makeFill({ mode: 'solid', color: '#ff0000' });
        assert(curveFillOn(el), '填充启用标记未生效');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.toLowerCase().includes('fill="#ff0000"'), 'SVG 导出缺少曲线填充');
        const open = buildElement('curve', 0, 0);
        open.curve!.filled = true;
        assert(!curveFillOn(open), '开放路径不应填充');
        return '闭合可填充 · 开放只描边 · 旧存档兼容';
    });
    check('颜料桶双色槽与曲线描边', () => {
        const el = buildElement('curve', 0, 0);
        assert(el.curve!.strokeOn !== false, '旧存档默认应显示描边');
        el.curve!.strokeOn = false;
        assert(!curveStrokeOn(el), '描边开关未生效');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('stroke-width="0"'), 'SVG 导出未遵循描边开关');
        const okSlot = (c: string): boolean => c === 'none' || HEX_RE.test(c);
        assert(okSlot(bucketColor('fill')) && okSlot(bucketColor('stroke')), '双色槽取值异常');
        return '填充 / 描边双色 · 描边开关 · 导出一致';
    });
    check('无填充 / 无描边', () => {
        const el = buildElement('rect', 0, 0);
        assert(elementSlotColor(el, 'fill') !== 'none', '默认填充应被获取');
        assert(elementSlotColor(el, 'stroke') === 'none', '默认无描边应被获取');
        assert(applyBucketColor(el, 'fill', 'none'), '无填充写入失败');
        assert(!el.fill.enabled && elementSlotColor(el, 'fill') === 'none', '无填充状态未生效');
        assert(fillToCSS(el.fill) === 'transparent', '无填充 CSS 应为透明');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('fill="none"'), 'SVG 导出缺少无填充');
        assert(applyBucketColor(el, 'fill', '#123456') && el.fill.enabled, '重新上色应恢复填充');
        assert(applyBucketColor(el, 'stroke', 'none') && el.stroke!.width === 0, '无描边应宽度归零');
        const cv = buildElement('curve', 0, 0);
        cv.curve!.closed = true; cv.curve!.filled = true;
        assert(applyBucketColor(cv, 'fill', 'none') && !curveFillOn(cv), '曲线无填充未生效');
        assert(applyBucketColor(cv, 'stroke', 'none') && !curveStrokeOn(cv), '曲线无描边未生效');
        cv.stroke = makeStroke({
            width: 3, color: '#1f2937',
            gradient: { mode: 'linear', angle: 45, posX: 50, posY: 50, stops: [{ color: '#ff0000', pos: 0 }, { color: '#00ff00', pos: 100 }] }
        });
        assert(applyBucketColor(cv, 'stroke', '#123456') && cv.stroke.gradient === null && cv.line!.color === '#123456', '曲线纯色描边应清除渐变');
        const ln = buildElement('line', 0, 0);
        assert(!applyBucketColor(ln, 'stroke', 'none'), '线条不应支持无描边');
        return '取色 · 无填充/无描边 · 重新上色恢复';
    });
    check('投影增强（类型/不透明度/发光/预设）', () => {
        const legacy = makeShadow({ enabled: true, color: '#000000', x: 8, y: 8, blur: 16 });
        assert(legacy.type === 'drop' && legacy.opacity === 0.72, '旧存档投影默认值异常');
        const el = buildElement('rect', 0, 0);
        el.shadow = makeShadow({ enabled: true, type: 'drop', color: '#123456', x: 10, y: 0, blur: 8, opacity: 0.5 });
        const css = shapeFilter(el);
        assert(css.includes('drop-shadow(10px 0px 8px') && css.includes('0.5'), '画布投影未用自定义不透明度');
        el.shadow = makeShadow({ enabled: true, type: 'glow', color: '#123456', x: 10, y: 20, blur: 8, opacity: 0.9 });
        assert(shapeFilter(el).includes('drop-shadow(0px 0px 8px'), '发光应零偏移');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('dx="0"') && svg.includes('flood-opacity="0.9"'), 'SVG 发光/不透明度异常');
        ['soft', 'hard', 'long', 'neon'].forEach(k => assert(!!SHADOW_PRESETS[k], '缺少预设 ' + k));
        assert(SHADOW_PRESETS.neon.type === 'glow', '霓虹预设应为发光');
        return 'drop/glow · 不透明度 · 旧存档兼容 · 4 预设';
    });
    check('旋转中心（枢轴）', () => {
        const el = buildElement('rect', 100, 100);
        el.rotation = 30;
        const before = getAABB(el);
        setPivot(el, 0, 0, true);
        assert(el.pivotX === 0 && el.pivotY === 0, '枢轴未更新');
        const after = getAABB(el);
        assert(Math.abs(before.cx - after.cx) < 0.51 && Math.abs(before.cy - after.cy) < 0.51, '改变枢轴后图形位置漂移');
        return '切换枢轴图形保持不动';
    });
    check('旋转 + 倾斜几何', () => {
        const el = buildElement('rect', 120, 80);
        el.w = 160; el.h = 90;
        el.rotation = 25; el.skewX = 30; el.skewY = -12;
        el.pivotX = 0.3; el.pivotY = 0.7;
        [[0, 0], [160, 0], [160, 90], [0, 90], [73, 41]].forEach(([lx, ly]) => {
            const w = elementLocalToWorld(el, lx, ly);
            const back = elementWorldToLocal(el, w);
            assert(Math.abs(back.x - lx) < 1e-6 && Math.abs(back.y - ly) < 1e-6, '局部/世界坐标往返偏差');
        });
        const box = getAABB(el);
        assert(box.w > el.w && box.h > el.h, '倾斜旋转后 AABB 未扩张');
        const before = getAABB(el);
        setPivot(el, 0.1, 0.2, true);
        const after = getAABB(el);
        assert(Math.abs(before.cx - after.cx) < 0.6 && Math.abs(before.cy - after.cy) < 0.6, '倾斜后切换枢轴图形漂移');
        const v = validateElement(Object.assign(buildElement('rect', 0, 0), { skewX: 200, skewY: -200 }));
        assert(v.skewX === 85 && v.skewY === -85, '倾斜角未限幅');
        return '坐标往返 · AABB 扩张 · 枢轴保形 · ±85° 限幅';
    });
    check('虚线描边渲染', () => {
        const el = buildElement('rect', 0, 0);
        el.stroke = makeStroke({ width: 3, style: 'dashed', color: '#000000' });
        assert(strokeOverlayMarkup(el, el.w, el.h).includes('stroke-dasharray'), '虚线 dasharray 缺失');
        el.stroke = makeStroke({ width: 3, style: 'dotted', color: '#000000' });
        assert(strokeOverlayMarkup(el, el.w, el.h).includes('stroke-linecap="round"'), '点线圆点缺失');
        return 'SVG 描边叠加层';
    });
    check('矢量形状库', () => {
        assert(VECTOR_SHAPE_PRESETS.length === 12, '矢量形状预设数量异常');
        VECTOR_SHAPE_PRESETS.forEach(p => {
            const pts = POLYGON_POINTS[p.type];
            assert(pts && pts.length >= 3, p.type + ' 缺少多边形点');
            pts.forEach(([x, y]) => assert(x >= 0 && x <= 100 && y >= 0 && y <= 100, p.type + ' 坐标越界'));
            assert(CLIP_PATHS[p.type] && CLIP_PATHS[p.type].startsWith('polygon('), p.type + ' 缺少 clip-path');
            const el = buildElement(p.type, 0, 0);
            assert(el.w === p.w && el.h === p.h, p.type + ' 默认尺寸与预设不一致');
        });
        const heart = buildElement('heart', 0, 0);
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: heart.w, h: heart.h }, elements: [heart], transparent: true });
        assert(svg.includes('<polygon'), 'SVG 导出缺少多边形');
        return VECTOR_SHAPE_PRESETS.length + ' 种矢量形状 · 渲染/导出可用';
    });
    check('透明特效图案库', () => {
        assert(EFFECT_PRESETS.length >= 6, '特效预设数量不足');
        const keys = new Set<string>();
        EFFECT_PRESETS.forEach(p => {
            assert(!keys.has(p.key), '预设 key 重复: ' + p.key);
            keys.add(p.key);
            assert(TYPES.includes(p.type), p.key + ' 类型未注册');
            assert(p.alpha > 0 && p.alpha < 1, p.key + ' 应带透明度');
            assert(HEX_RE.test(p.color) && p.light > 0 && p.light < 1, p.key + ' 颜色/高光参数异常');
        });
        const blob = buildElement('blob', 0, 0);
        const basePts = shapePoints(blob);
        assert(basePts && basePts.length > 30, '流体基础轮廓点数不足');
        blob.shapeParams = { lobes: 7, depth: 32 };
        const dyn = shapePoints(blob);
        assert(dyn && dyn.length > 30 && JSON.stringify(dyn) !== JSON.stringify(basePts), '流体参数未改变轮廓');
        const el = buildElement('drop', 0, 0);
        el.effectTint = 0.6;
        el.fill = makeFill({ mode: 'radial', color: '#3366ff', start: '#cce6ff', end: '#0033aa', alpha: 0.8 });
        assert(applyEffectTint(el, '#ff0000'), '特效换色未命中');
        assert(el.fill.start !== '#cce6ff' && el.fill.end !== '#0033aa', '渐变高光/暗部未重算');
        assert(el.fill.alpha === 0.8 && el.fill.mode === 'radial', '换色不应改变透明度/模式');
        const round = validateElement(JSON.parse(JSON.stringify(el)));
        assert(round.effectTint === 0.6, '特效标记存档往返丢失');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('radialGradient') && svg.includes('polygon'), 'SVG 导出缺少透明渐变多边形');
        return EFFECT_PRESETS.length + ' 个预设 · 换色保留渐变与透明度';
    });
    check('形状参数（16 种）', () => {
        const types: ElementType[] = ['rect', 'circle', 'triangle', 'star', 'hexagon', 'pentagon', 'diamond', 'trapezoid',
            'parallelogram', 'cross', 'semicircle', 'heart', 'cloud', 'moon', 'speech', 'drop'];
        const probes: Partial<Record<ElementType, Record<string, number>>> = {
            circle: { sweep: 180 }, triangle: { apex: 75 }, star: { points: 7, inner: 50 },
            hexagon: { sides: 8 }, pentagon: { sides: 8 }, diamond: { waist: 65 }, trapezoid: { top: 30 },
            parallelogram: { slant: 40 }, cross: { arm: 45 }, semicircle: { arch: 70 }, heart: { cleft: 40 },
            cloud: { puff: 120 }, moon: { thickness: 130 }, speech: { tail: 70, tailSize: 130 }, drop: { tip: 80 }
        };
        types.forEach(t => assert(SHAPE_PARAM_SPECS[t] && SHAPE_PARAM_SPECS[t]!.length > 0, t + ' 缺少参数规格'));
        assert(SHAPE_PARAM_SPECS.rect![0].key === 'corner', '矩形参数应为圆角');
        Object.entries(probes).forEach(([t, params]) => {
            const el = buildElement(t as ElementType, 0, 0);
            Object.entries(params).forEach(([key, v]) => {
                const before = JSON.stringify(shapePoints(el));
                el.shapeParams[key] = v;
                assert(JSON.stringify(shapePoints(el)) !== before, t + '.' + key + ' 未改变轮廓');
            });
            assert(!!shapeClipPath(el), t + ' 参数化后缺少 clip-path');
            const [key, v] = Object.entries(params)[0];
            const round = validateElement(JSON.parse(JSON.stringify(el)));
            assert(round.shapeParams[key] === v, t + ' 参数存档往返丢失');
        });
        const clean = sanitizeShapeParams('star', { points: 99, inner: -10, bomb: 1 });
        assert(clean.points === 20 && clean.inner === 5 && !('bomb' in clean), '参数清洗异常');
        const star = buildElement('star', 0, 0);
        star.shapeParams = { points: 7, inner: 40 };
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: star.w, h: star.h }, elements: [star], transparent: true });
        const m = /<polygon points="([^"]+)"/.exec(svg);
        assert(m && m[1].trim().split(/\s+/).length === 14, 'SVG 星形顶点数异常');
        return types.length + ' 种 · 实时轮廓 · 存档/导出一致';
    });
    check('文本换行与自动尺寸', () => {
        const el = buildElement('text', 0, 0);
        el.w = 120;
        el.text = makeText({ fontSize: 20, runs: [{ text: '画布工作室离线设计编辑器长文本换行测试' }] });
        const ctx = textMeasureCtx();
        const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, el.text!, run, text));
        assert(lines.length > 1, '长文本未换行');
        el.text!.sizeMode = 'autoH';
        applyAutoSize(el);
        assert(el.h >= lines.length * el.text!.fontSize * el.text!.lineHeight - 1, '自动高度未随内容增长');
        return lines.length + ' 行 · 自动高度生效';
    });
    check('多行段落 / 段落间距 / 首行缩进', () => {
        const el = buildElement('text', 0, 0);
        el.w = 400;
        el.text = makeText({ fontSize: 20, paraSpacing: 12, indent: 30,
            runs: [{ text: '第一段\n第二段\n\n第四段' }] });
        const ctx = textMeasureCtx();
        const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, el.text!, run, text));
        assert(lines.length === 4, '空段落未保留为独立行：' + lines.length);
        assert(lines[0].paraStart && lines[1].paraStart && lines[2].paraStart && lines[3].paraStart, '段落起始标记异常');
        assert(lines[2].length === 0, '空段落应无排版原子');
        const narrow = buildElement('text', 0, 0);
        narrow.w = 80;
        narrow.text = makeText({ fontSize: 20, indent: 30, runs: [{ text: '一二三四五六七八九十' }] });
        const nlines = layoutText(narrow, narrow.w, (run, text) => canvasTextWidth(ctx, narrow.text!, run, text));
        const firstW = nlines[0].reduce((a, t) => a + t.w, 0);
        assert(firstW <= narrow.w - narrow.text!.indent + 0.5, '首行未扣除缩进宽度');
        narrow.text!.sizeMode = 'autoH';
        narrow.h = 1;
        applyAutoSize(narrow);
        const lh = narrow.text!.fontSize * narrow.text!.lineHeight;
        const spacingTotal = (nlines.length - 1) * narrow.text!.paraSpacing;
        assert(narrow.h >= nlines.length * lh + spacingTotal - 1, '自动高度未计入段落间距');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('x="30" y="0"'), 'SVG 首行缩进未生效');
        assert(svg.includes(`y="${el.text!.fontSize * el.text!.lineHeight + el.text!.paraSpacing}"`), 'SVG 段落间距未生效');
        return '4 行（含空段）· 缩进换行 · 间距计入自动高度';
    });
    check('文本描边三种对齐', () => {
        const el = buildElement('text', 0, 0);
        el.w = 240; el.h = 60;
        el.text = makeText({ fontSize: 24, runs: [{ text: '描边文字' }] });
        el.stroke = makeStroke({ width: 4, color: '#ff3300', align: 'center' });
        const alpha = (c: HTMLCanvasElement): boolean => {
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
            return false;
        };
        const layers = textStrokeLayers(el, 1);
        assert(layers && layers.pad > 0 && layers.stroke.width > 0, '文本描边图层缺失');
        assert(alpha(layers!.fill) && alpha(layers!.stroke), '文本填充/描边图层为空');
        const svgFor = (): string => buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svgFor().includes('stroke-width="4"') && !svgFor().includes('paint-order="stroke"'), '居中描边导出异常');
        el.stroke!.align = 'outside';
        const outLayers = textStrokeLayers(el, 1);
        assert(outLayers && alpha(outLayers.stroke), '居外描边图层为空（多字遮罩合成异常）');
        const outSvg = svgFor();
        assert(outSvg.includes('<mask id="tm0"') && outSvg.includes('stroke-width="8"') && !outSvg.includes('paint-order'), '居外描边遮罩缺失');
        el.fill.enabled = false;
        assert(svgFor().includes('fill="none"') && svgFor().includes('<mask id="tm0"'), '无填充居外描边导出异常');
        el.fill.enabled = true;
        el.stroke!.align = 'inside';
        const inLayers = textStrokeLayers(el, 1);
        assert(inLayers && alpha(inLayers.stroke), '居内描边图层为空（多字遮罩合成异常）');
        assert(svgFor().includes('<mask id="tm0"') && svgFor().includes('stroke-width="8"'), '居内描边遮罩缺失');
        ['btnStrokeOutside', 'btnStrokeCenter', 'btnStrokeInside', 'paintPopAlignOutside', 'paintPopAlignCenter', 'paintPopAlignInside'].forEach(id => assert(!!document.getElementById(id), '缺少描边对齐按钮 ' + id));
        return '填充/描边分层 · 外/中/内导出 · 三图标按钮（属性面板 + 左侧弹层）';
    });
    check('描边对齐悬停试穿', () => {
        const prevSel = state.selection.slice();
        const el = selectedEls().find(e => e.type !== 'line' && e.type !== 'curve' && !e.locked)
            || state.model.elements.find(e => e.type !== 'line' && e.type !== 'curve' && !e.locked);
        if (!el) return '当前无矩形/文本可测，跳过';
        const original = el.stroke;
        try {
            if (!state.selection.includes(el.id)) setSelection([el.id]);
            const target = original.align === 'outside' ? 'inside' : 'outside';
            beginStrokeAlignPreview(target);
            assert(el.stroke !== original && el.stroke.align === target, '悬停未即时切换对齐');
            endStrokeAlignPreview();
            assert(el.stroke === original, '移出未按快照还原描边');
        } finally {
            endStrokeAlignPreview();
            el.stroke = original;
            syncElement(el.id);
            setSelection(prevSel);
        }
        return '悬停即时预览 · 移出按引用还原';
    });
    check('形状转换', () => {
        const el = buildElement('rect', 10, 20);
        el.name = '矩形 1';
        el.w = 260; el.h = 140;
        el.shapeParams = { corner: 18 };
        el.fill = makeFill({ mode: 'linear', color: '#3366ff' });
        el.stroke = makeStroke({ width: 6, color: '#ff6600', align: 'outside' });
        assert(canConvertShape(el), '矩形应可转换');
        assert(convertElementShape(el, 'trapezoid'), '转换为梯形失败');
        assert(el.type === 'trapezoid' && el.name === '梯形 1' && Object.keys(el.shapeParams).length === 0, '转换未更新类型/名称/参数');
        assert(el.x === 10 && el.y === 20 && el.w === 260 && el.h === 140, '转换不应改变位置尺寸');
        assert(el.fill.mode === 'linear' && el.stroke.width === 6 && el.stroke.align === 'outside', '转换不应改变填充描边');
        assert(!convertElementShape(el, 'text' as ElementType) && el.type === 'trapezoid', '非轮廓类型不应转换');
        ['parallelogram', 'pentagon', 'heart', 'blob'].forEach(t => {
            const probe = buildElement(t as ElementType, 0, 0);
            assert(canConvertShape(probe), t + ' 应可参与形状转换');
        });
        assert(!canConvertShape(buildElement('text', 0, 0)) && !canConvertShape(buildElement('line', 0, 0)), '文本/线条不应转换');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('<polygon') && svg.includes('mask="url(#sm0)"'), '转换后 SVG 轮廓/描边异常');
        const masked = svg.split('<g mask="url(#sm0)">');
        assert(masked.length === 2 && masked[0].includes('fill="url(#g0)"'), '居外描边遮罩误遮了填充');
        assert(masked[1].includes('fill="none"') && masked[1].includes('stroke-width="12"'), '居外描边未单独分层');
        return '矩形 → 梯形 · 保留样式几何 · 命名同步';
    });
    check('缩放/平移浮钮', () => {
        const btn = document.getElementById('fitFloatBtn') as HTMLButtonElement | null;
        assert(btn && btn.classList.contains('fit-float'), '缺少「适应屏幕」浮钮');
        showFitFloat(window.innerWidth / 2, window.innerHeight / 2);
        assert(!btn!.hidden, '浮钮未显示');
        assert(btn!.style.left.endsWith('px') && btn!.style.top.endsWith('px'), '浮钮未定位到指针附近');
        hideFitFloat(true);
        assert(btn!.hidden, '浮钮未隐藏');
        return '指针附近浮现 · 可点击 · 自动消失已绑定';
    });
    check('富文本无 HTML 注入', () => {
        const nodes = document.querySelectorAll('.text-content *');
        let bad = 0;
        nodes.forEach(n => { if (n.tagName === 'SCRIPT' || n.tagName === 'IMG' || n.tagName === 'IFRAME') bad++; });
        assert(bad === 0, '画布文本内发现注入元素');
        return '仅 span / textContent';
    });
    check('完全离线（无外部资源）', () => {
        const ext = document.querySelectorAll('link[href^="http"],script[src^="http"],img[src^="http"]').length;
        assert(ext === 0, '发现 ' + ext + ' 处外链');
        return '0 个外部请求';
    });
    check('本地存储可写', () => {
        localStorage.setItem('__selftest__', '1'); localStorage.removeItem('__selftest__');
        return 'localStorage 正常';
    });
    check('IndexedDB 资源库', () => dbAvailable ? '已连接 ' + DB_NAME : '不可用（已降级内联存储）');
    check('SVG 导出生成', () => {
        const svg = buildSVG({ bounds: exportBoundsFor('canvas')!, elements: sortedElements(), transparent: false });
        assert(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'SVG 结构异常');
        return Math.round(svg.length / 1024) + ' KB';
    });
    check('PDF 导出生成', () => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const pdf = buildPDF(c.toDataURL('image/jpeg'), 8, 8);
        assert(pdf.size > 100, 'PDF 体积异常');
        return Math.round(pdf.size / 1024 * 10) / 10 + ' KB';
    });
    check('画布 2D 导出可用', () => {
        const c = document.createElement('canvas'); c.width = c.height = 8;
        assert(typeof c.getContext('2d')!.createLinearGradient === 'function', '2D 上下文异常');
        return 'Canvas 2D 正常';
    });
    check('主题与设置持久化', () => {
        assert(state.settings && typeof state.settings.theme === 'string', '设置未加载');
        return state.settings.theme;
    });
    check('图层与组合元数据', () => {
        const bad = state.model.elements.filter(e => !e.name || e.visible === undefined || e.stroke === undefined).length;
        assert(bad === 0, bad + ' 个元素元数据缺失');
        return '字段完整';
    });
    check('组合选择（同组联动）', () => {
        const prevElements = state.model.elements, prevSelection = state.selection.slice();
        const g1 = buildElement('rect', 0, 0), g2 = buildElement('circle', 100, 0), solo = buildElement('rect', 200, 0);
        g1.groupId = 'grp_selftest'; g2.groupId = 'grp_selftest';
        try {
            state.model.elements = [g1, g2, solo];
            renderAll();
            setSelection([g1.id]);
            assert(state.selection.length === 2 && state.selection.includes(g2.id), '点击组内成员未选中整组');
            assert(!state.selection.includes(solo.id), '不应选中组外元素');
            setSelection([solo.id]);
            toggleSelection(g2.id, true);
            assert(state.selection.length === 3 && state.selection.includes(g1.id), 'Ctrl 追加组内成员未保留整组');
            toggleSelection(g1.id, true);
            assert(state.selection.length === 1 && state.selection.includes(solo.id), 'Ctrl 取消组内成员未整组移除');
            return '单击成员同选整组 · 追加/取消按整组';
        } finally {
            state.model.elements = prevElements;
            renderAll();
            setSelection(prevSelection);
        }
    });
    check('关联副本同步与断开', () => {
        const prevElements = state.model.elements, prevSelection = state.selection.slice();
        const a = buildElement('rect', 10, 20), b = buildElement('rect', 200, 40);
        a.w = 120; b.w = 160;
        try {
            state.model.elements = [a, b];
            renderAll();
            setSelection([a.id, b.id]);
            linkSelected();
            assert(!!a.linkId && a.linkId === b.linkId, '未建立相同 linkId');
            a.fill.color = '#ff3300';
            a.stroke = makeStroke({ width: 7, color: '#22cc88' });
            a.w = 180; a.borderRadius = 16;
            assert(syncLinkedOnCommit(), '提交时未传播关联属性');
            assert(b.fill.color === '#ff3300' && b.stroke!.width === 7 && b.w === 180 && b.borderRadius === 16, '关联属性未同步');
            assert(b.x === 200 && b.y === 40, '关联同步不应移动副本');
            b.stroke!.width = 3;
            syncLinkedOnCommit();
            assert(a.stroke!.width === 3, '副本修改未回传');
            const c = buildElement('circle', 400, 0);
            state.model.elements.push(c);
            renderAll();
            setSelection([a.id, c.id]);
            const compat = linkCompatibility();
            assert(!compat.ok && compat.reason.includes('矩形') && compat.reason.includes('圆形'), '异类关联未拒绝');
            const lid = a.linkId;
            linkSelected();
            assert(a.linkId === lid && !c.linkId, '异类关联不应改写 linkId');
            setSelection([a.id, b.id]);
            unlinkSelected();
            assert(!a.linkId && !b.linkId, '断开后仍残留 linkId');
            const t1 = buildElement('text', 0, 0), t2 = buildElement('text', 260, 0);
            t1.text = makeText({ fontSize: 24, runs: [{ text: '甲一' }, { text: '甲二' }] });
            t2.text = makeText({ fontSize: 18, runs: [{ text: '乙一' }, { text: '乙二' }] });
            state.model.elements = [t1, t2];
            renderAll();
            setSelection([t1.id, t2.id]);
            linkSelected();
            t1.text!.fontSize = 33;
            t1.text!.runs[0].color = '#ff00ff';
            t1.text!.runs[1].bold = true;
            syncLinkedOnCommit();
            assert(t2.text!.fontSize === 33 && t2.text!.runs[0].color === '#ff00ff' && t2.text!.runs[1].bold, '文本样式未同步');
            assert(t2.text!.runs[0].text === '乙一' && t2.text!.runs[1].text === '乙二', '关联同步不应覆盖文字内容');
            return '样式/尺寸双向同步 · 文本样式同步 · 异类拒绝 · 断开清除';
        } finally {
            state.model.elements = prevElements;
            resetLinkSnapshots();
            renderAll();
            setSelection(prevSelection);
        }
    });
    check('标注数值可编辑', () => {
        const el = state.model.elements.find(e => !e.locked);
        if (!el) throw new Error('没有可编辑的元素');
        const prevSel = state.selection.slice();
        const prevGuides = state.settings.guides;
        const x0 = el.x, w0 = el.w;
        try {
            state.settings.guides = true;
            setSelection([el.id]);
            drawMeasure();
            const nums = document.querySelectorAll<HTMLElement>('#measureLayer .measure-num');
            assert(nums.length >= 3, '可编辑数值数量不足');
            nums[0].click();
            const input = document.querySelector<HTMLInputElement>('#measureLayer .measure-input');
            assert(input, '点击数值未打开输入框');
            input!.value = String(w0 + 123);
            input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            assert(!document.querySelector('#measureLayer .measure-input'), 'Esc 未关闭输入框');
            assert(el.x === x0 && el.w === w0, '取消编辑不应改动元素');
            return nums.length + ' 处数值可编辑';
        } finally {
            state.settings.guides = prevGuides;
            setSelection(prevSel);
            drawMeasure();
        }
    });
    check('物件间距标注', () => {
        const mk = (id: string, x: number, y: number): CanvasElement =>
            ({ id, type: 'rect', x, y, w: 100, h: 100, rotation: 0, pivotX: 0.5, pivotY: 0.5, visible: true } as CanvasElement);
        const box = { left: 200, top: 200, right: 300, bottom: 300, cx: 250, cy: 250 } as AABB;
        const els = [mk('L', 50, 200), mk('R', 350, 220), mk('R2', 500, 220), mk('T', 220, 60), mk('B', 240, 380),
            mk('D', 900, 900), Object.assign(mk('H', 350, 200), { visible: false })];
        const by: Record<string, GapMeasure> = {};
        neighborGapsFor(box, els, []).forEach(g => { by[g.side] = g; });
        assert(by.left && by.left.gap === 50 && by.left.otherId === 'L', '左间距错误');
        assert(by.right && by.right.gap === 50 && by.right.otherId === 'R', '右间距应取最近邻');
        assert(by.top && by.top.gap === 40 && by.top.otherId === 'T', '上间距错误');
        assert(by.bottom && by.bottom.gap === 80 && by.bottom.otherId === 'B', '下间距错误');
        assert(Object.values(by).every(g => g.otherId !== 'D'), '斜对角不应产生间距');
        const ov: Record<string, GapMeasure> = {};
        neighborGapsFor(box, [mk('O', 250, 220)], []).forEach(g => { ov[g.side] = g; });
        assert(ov.right && ov.right.gap === -50 && ov.bottom && ov.bottom.gap === -80, '重叠物件应显示负间距');
        const tie: Record<string, GapMeasure> = {};
        neighborGapsFor(box, [mk('O', 250, 220), mk('R', 350, 220)], []).forEach(g => { tie[g.side] = g; });
        assert(tie.right && tie.right.otherId === 'R', '同绝对距离时优先分离侧');
        const ex = neighborGapsFor(box, els, ['L', 'R', 'T', 'B']);
        assert(ex.length === 1 && ex[0].side === 'right' && ex[0].otherId === 'R2' && ex[0].gap === 200, '排除选区后应取次近邻');
        const hiddenOnly = neighborGapsFor(box, [Object.assign(mk('H', 350, 200), { visible: false })], []);
        assert(hiddenOnly.length === 0, '隐藏物件不应参与间距');
        return '四向最近邻 · 重叠负值 · 排除/隐藏/斜对角跳过';
    });
    check('边缘对齐差', () => {
        const mk = (id: string, x: number, y: number, w: number, h: number): CanvasElement =>
            ({ id, type: 'rect', x, y, w, h, rotation: 0, pivotX: 0.5, pivotY: 0.5, visible: true } as CanvasElement);
        const box = { left: 100, top: 300, right: 200, bottom: 304, cx: 150, cy: 302 } as AABB;
        const al = alignmentMeasures(box, [mk('S', 400, 430, 200, 200)], []);
        const by: Record<string, AlignMeasure> = {};
        al.forEach(a => { by[a.edge] = a; });
        assert(al.length === 2, '每个方向只保留差值更小的一条边');
        assert(by.top && by.top.delta === -130, '顶边对齐差错误');
        assert(by.left && by.left.delta === -300, '左边对齐差错误');
        assert(!by.bottom && !by.right, '差值更大的边不应重复标注');
        assert(al.every(a => a.otherId === 'S'), '斜向邻居也应参与对齐测距');
        const hidden = alignmentMeasures(box, [Object.assign(mk('H', 400, 430, 200, 200), { visible: false })], []);
        assert(hidden.length === 0, '隐藏物件不应参与对齐');
        const selfOnly = alignmentMeasures(box, [mk('X', 100, 300, 100, 4)], ['X']);
        assert(selfOnly.length === 0, '排除选区后无邻居');
        return '每向单边带符号对齐差 · 斜向邻居 · 隐藏/排除跳过';
    });
    check('辅助线与测距', () => {
        const gH = validateGuide({ id: 'g_h', angle: 0, x: 0, y: 100 });
        const gV = validateGuide({ id: 'g_v', angle: 90, x: 50, y: 0 });
        const box = { left: 200, top: 200, right: 300, bottom: 300, cx: 250, cy: 250 } as AABB;
        const mh = boxGuideMeasure(box, gH);
        assert(mh.dist === 100 && mh.sign === 1, '水平辅助线距离错误');
        const mv = boxGuideMeasure(box, gV);
        assert(Math.abs(mv.dist - 150) < 1e-6 && mv.sign === -1, '垂直辅助线距离错误');
        const gD = validateGuide({ id: 'g_d', angle: 45, x: 250, y: 250 });
        assert(boxGuideMeasure(box, gD).dist === 0, '穿过选区的辅助线距离应为 0');
        const base = JSON.parse(snapshotJSON());
        const proj = validateProject(Object.assign(base, { guides: [gH, gV] }));
        assert(proj.guides.length === 2, '项目存档应包含辅助线');
        let dup = false;
        try { validateProject(Object.assign(JSON.parse(snapshotJSON()), { guides: [gH, gH] })); }
        catch { dup = true; }
        assert(dup, '重复辅助线 id 应被拒绝');
        return '水平/垂直/旋转测距 · 存档往返';
    });
    const list = $('selftestList'), sum = $('selftestSummary');
    const bad = results.filter(r => !r.ok).length;
    sum.className = 'selftest-summary ' + (bad ? 'fail' : 'pass');
    sum.textContent = bad ? `${results.length - bad} 项通过，${bad} 项失败` : `全部 ${results.length} 项通过 · 编辑器运行正常`;
    list.textContent = '';
    results.forEach(r => {
        const d = document.createElement('div'); d.className = 'selftest-item' + (r.ok ? '' : ' bad');
        d.appendChild(iconEl(r.ok ? 'check' : 'close'));
        const n = document.createElement('span'); n.textContent = r.name; d.appendChild(n);
        const det = document.createElement('span'); det.className = 'detail'; det.textContent = r.detail; d.appendChild(det);
        list.appendChild(d);
    });
    $('selftestModal').style.display = 'flex';
}
function makeSelfLine(style: string): CanvasElement {
    return { type: 'line', w: 100, h: 4, line: makeLine({ style, width: 4, wavyAmp: 5 }) } as CanvasElement;
}