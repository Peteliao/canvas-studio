/* 内置自检 */
import { VERSION, DB_NAME, HEX_RE } from './constants';
import type { CanvasElement, AABB } from './types';
import { state } from './state';
import { $, iconEl } from './utils';
import { validateProject, snapshotJSON, makeFill, makeLine, makeStroke, makeText, buildElement, validateElement,
    curvePathD, curveFillOn, curveStrokeOn, validateGuide, curveSegPts, splitCubic, cubicAt, sortedElements } from './model';
import { fillToCSS, lineHeightFor, wavyDashSpec, wavyDataURI, strokeOverlayMarkup } from './style';
import { buildSVG, buildPDF } from './vector-export';
import { getAABB, setPivot } from './geometry';
import { textMeasureCtx, canvasTextWidth, applyAutoSize } from './render';
import { layoutText, exportBoundsFor } from './exporter';
import { bucketColor, elementSlotColor, applyBucketColor } from './bucket';
import { neighborGapsFor, alignmentMeasures, drawMeasure } from './measure';
import type { GapMeasure, AlignMeasure } from './measure';
import { boxGuideMeasure } from './guides';
import { setSelection } from './selection';
import { dbAvailable } from './db';

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
        const ln = buildElement('line', 0, 0);
        assert(!applyBucketColor(ln, 'stroke', 'none'), '线条不应支持无描边');
        return '取色 · 无填充/无描边 · 重新上色恢复';
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
    check('虚线描边渲染', () => {
        const el = buildElement('rect', 0, 0);
        el.stroke = makeStroke({ width: 3, style: 'dashed', color: '#000000' });
        assert(strokeOverlayMarkup(el, el.w, el.h).includes('stroke-dasharray'), '虚线 dasharray 缺失');
        el.stroke = makeStroke({ width: 3, style: 'dotted', color: '#000000' });
        assert(strokeOverlayMarkup(el, el.w, el.h).includes('stroke-linecap="round"'), '点线圆点缺失');
        return 'SVG 描边叠加层';
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