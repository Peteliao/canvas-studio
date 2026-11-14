/* Canvas Editor Pro V11 — 纯前端 / 零依赖 / 完全离线
   架构：结构化模型（唯一数据源）→ 渲染层 → 历史与存储 → 离线工具层 */
(function () {
'use strict';

/* ==================== 1. 常量 ==================== */
const VERSION = 4;
const COMPAT_VERSIONS = [2, 3, 4];   // v2 旧格式 / v3 单段曲线 / v4 多节点贝塞尔
const STORAGE_KEY = 'canvas_autosave_v2';
const LEGACY_KEY = 'canvas_autosave_v1';
const SETTINGS_KEY = 'canvas_studio_settings_v3';
const DB_NAME = 'CanvasAssetsDB';
const DB_STORE = 'assets';
const DB_PROJECTS = 'projects';
const DB_VERSIONS = 'versions';
const MAX_HISTORY = 50;
const MAX_EXPORT_PIXELS = 16 * 1000 * 1000;
const MAX_CANVAS_SIDE = 20000;
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

const TYPES = ['rect', 'circle', 'triangle', 'star', 'arrow', 'line', 'curve', 'text', 'image', 'boolean'];
const FILL_MODES = ['solid', 'linear', 'radial', 'conic'];
const LINE_STYLES = ['solid', 'dashed', 'dotted', 'wavy'];
const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'];
const TYPE_LABELS = { rect: '矩形', circle: '圆形', triangle: '三角形', star: '五角星', arrow: '箭头', line: '线条', curve: '曲线', text: '文本', image: '图片', boolean: '布尔图形', group: '组合' };
const TYPE_ICONS = { rect: 'square', circle: 'circle', triangle: 'triangle', star: 'star', arrow: 'arrow', line: 'line', curve: 'curve', text: 'font', image: 'image', boolean: 'union' };
// 这些类型的描边用 SVG 轮廓叠加渲染，虚线/点线在画布上即时可见（boolean 沿用 drop-shadow 以贴合遮罩）
const STROKE_SVG_TYPES = ['rect', 'circle', 'triangle', 'star', 'arrow', 'image'];
const EXPORT_BLEND = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference' };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

const CLIP_PATHS = {
    triangle: 'polygon(50% 0%, 0% 100%, 100% 100%)',
    star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
    arrow: 'polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)'
};
const POLYGON_POINTS = {
    triangle: [[50, 0], [0, 100], [100, 100]],
    star: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]],
    arrow: [[0, 20], [60, 20], [60, 0], [100, 50], [60, 100], [60, 80], [0, 80]]
};

/* ==================== 2. 状态 ==================== */
const state = {
    model: null,                 // { version, canvas:{w,h,background,lockedRatio}, elements:[] }
    assets: {},                  // assetId -> dataURL
    selection: [],               // element ids
    guideSel: null,              // 选中的辅助线 id
    zoom: 1,
    pan: { x: 0, y: 0 },
    clipboard: [],
    elBgMode: 'solid',
    geoRatioLocked: false,
    geoRatio: 1,
    canvasRatioLocked: false,
    canvasRatio: 1,
    moveStep: 1,
    isTextEditing: false,
    editingId: null,
    layerPick: null,             // { type:'under'|'above' }
    spaceDown: false,
    interaction: null,           // { kind, ... }
    boxCache: null,
    hiddenAssetsDirty: new Set(),
    // ---- V12 扩展状态 ----
    tool: 'select',
    bucketSlot: 'fill',          // 颜料桶最近编辑的色槽：fill | stroke
    nodeSel: null,               // 曲线节点选择 { id, i }
    pen: null,                   // 钢笔草稿 { nodes:[{x,y,ix,iy,ox,oy,t}], closed, cursor }
    settings: null,              // 主题 / 吸附 / 网格 / 标尺 / 标注 / 色板 / 最近颜色
    projectId: null,
    projectName: '未命名设计',
    activeTab: 'design',
    alignBase: 'selection',
    snapLines: [],               // 当前显示的吸附参考线（世界坐标）
    touchPoints: new Map(),
    pinch: null,
    clipboardSerial: ''
};

let db = null;
let dbAvailable = false;
let undoStack = [];
let historyIndex = -1;
let isApplyingHistory = false;
let commitTimer = null;
let toastTimer = null;
let dialogState = null;
let rafPending = false;
let pendingPointer = null;
let cropState = null;            // { id, assetId, ratio, naturalW, naturalH, rect }
const nodeMap = new Map();       // element id -> DOM node
const imageCache = new Map();    // assetId -> HTMLImageElement

/* ==================== 3. 基础工具 ==================== */
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, d) => {
    if (v === '' || v === null || v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};
const uid = prefix => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const deepCopy = o => JSON.parse(JSON.stringify(o));
const round2 = v => Math.round(v * 100) / 100;
const round3 = v => Math.round(v * 1000) / 1000;
const validColor = (v, d) => (typeof v === 'string' && HEX_RE.test(v) ? v : d);

function iconEl(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
    svg.appendChild(use);
    return svg;
}
function setIcon(button, name) {
    if (!button) return;
    button.textContent = '';
    button.appendChild(iconEl(name));
}

function toast(message, kind) {
    const t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3600);
}

function appConfirm(text, options) {
    return new Promise(resolve => {
        dialogState = { mode: 'confirm', resolve };
        $('appDialogTitle').textContent = (options && options.title) || '请确认';
        $('appDialogText').textContent = text;
        $('appDialogInput').style.display = 'none';
        $('appDialog').style.display = 'flex';
        $('dialogOk').focus();
    });
}
function appPrompt(text, defaultValue, options) {
    return new Promise(resolve => {
        dialogState = { mode: 'prompt', resolve };
        $('appDialogTitle').textContent = (options && options.title) || '请输入';
        $('appDialogText').textContent = text;
        const input = $('appDialogInput');
        input.style.display = 'block';
        input.value = defaultValue || '';
        $('appDialog').style.display = 'flex';
        input.focus(); input.select();
    });
}
function dialogOk() {
    if (!dialogState) return;
    const s = dialogState; dialogState = null;
    const value = s.mode === 'prompt' ? $('appDialogInput').value.trim() : true;
    $('appDialog').style.display = 'none';
    s.resolve(value || (s.mode === 'prompt' ? null : true));
}
function dialogCancel() {
    if (!dialogState) return;
    const s = dialogState; dialogState = null;
    $('appDialog').style.display = 'none';
    s.resolve(null);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('文件读取失败'));
        r.readAsDataURL(file);
    });
}
function pickFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = accept || '';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); }, { once: true });
        input.click();
    });
}
function loadImage(src) {
    if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { imageCache.set(src, img); resolve(img); };
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
    });
}

/* ==================== 4. IndexedDB（读写两端齐全） ==================== */
function openDB() {
    return new Promise(resolve => {
        if (!window.indexedDB) { resolve(false); return; }
        let req;
        try { req = indexedDB.open(DB_NAME, 2); }
        catch (e) { resolve(false); return; }
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
            if (!d.objectStoreNames.contains(DB_PROJECTS)) d.createObjectStore(DB_PROJECTS, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(DB_VERSIONS)) d.createObjectStore(DB_VERSIONS, { keyPath: 'id' });
        };
        req.onsuccess = () => { db = req.result; dbAvailable = true; resolve(true); };
        req.onerror = () => { dbAvailable = false; resolve(false); };
        req.onblocked = () => { dbAvailable = false; resolve(false); };
    });
}
function idbPut(id, value) {
    return new Promise(resolve => {
        if (!db) { resolve(false); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(value, id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}
function idbGet(id) {
    return new Promise(resolve => {
        if (!db) { resolve(null); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readonly');
            const r = tx.objectStore(DB_STORE).get(id);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}
function idbAll() {
    return new Promise(resolve => {
        if (!db) { resolve({}); return; }
        const out = {};
        try {
            const tx = db.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            tx.oncomplete = () => {
                keysReq.result.forEach((k, i) => { out[k] = valsReq.result[i]; });
                resolve(out);
            };
            tx.onerror = () => resolve({});
        } catch (e) { resolve({}); }
    });
}
function idbClear() {
    return new Promise(resolve => {
        if (!db) { resolve(false); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}
async function putAsset(id, dataURL) {
    state.assets[id] = dataURL;
    imageCache.delete(dataURL);
    const ok = await idbPut(id, dataURL);
    if (!ok) state.hiddenAssetsDirty.add(id);
    return ok;
}
/** 通用 object store 操作：项目列表与版本快照 (N8) */
function storeAll(name) {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve([]); return; }
        try {
            const r = db.transaction(name, 'readonly').objectStore(name).getAll();
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => resolve([]);
        } catch (e) { resolve([]); }
    });
}
function storePut(name, value) {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve(false); return; }
        try {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).put(value);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}
function storeDelete(name, key) {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve(false); return; }
        try {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}
function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); return true; }
    catch (e) { return false; }
}
function loadSettings() {
    const s = {
        theme: 'light', contrast: 'normal', snap: true, grid: false, rulers: true,
        guides: true, guideLines: true, gridSize: 20, alignBase: 'selection', inspectorVisible: true, inspectorFolded: false,
        activeTab: 'design', recentColors: [], palette: [], projectId: null, projectName: '未命名设计',
        bucketFillColor: '#4f6bff', bucketStrokeColor: '#1c2230'
    };
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return s;
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') {
            Object.keys(s).forEach(k => { if (o[k] !== undefined && typeof o[k] === typeof s[k]) s[k] = o[k]; });
            if (Array.isArray(o.recentColors)) s.recentColors = o.recentColors.filter(c => HEX_RE.test(c)).slice(0, 16);
            if (Array.isArray(o.palette)) s.palette = o.palette.filter(c => HEX_RE.test(c)).slice(0, 32);
        }
    } catch (e) { /* 使用默认设置 */ }
    if (!HEX_RE.test(s.bucketFillColor)) s.bucketFillColor = '#4f6bff';
    if (!HEX_RE.test(s.bucketStrokeColor)) s.bucketStrokeColor = '#1c2230';
    return s;
}
function useColor(color) {
    if (!HEX_RE.test(color)) return;
    const list = state.settings.recentColors.filter(c => c.toLowerCase() !== color.toLowerCase());
    list.unshift(color.toUpperCase());
    state.settings.recentColors = list.slice(0, 16);
    saveSettings();
    renderSwatches();
    syncBucketSwatch();
}

/* ==================== 5. 模型与 schema 校验 ==================== */
function makeFill(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        mode: FILL_MODES.includes(o.mode) ? o.mode : 'solid',
        color: validColor(o.color, '#cccccc'),
        start: validColor(o.start, '#ffffff'),
        end: validColor(o.end, '#dddddd'),
        angle: clamp(finite(o.angle, 90), 0, 360),
        posX: clamp(finite(o.posX, 50), 0, 100),
        posY: clamp(finite(o.posY, 50), 0, 100),
        alpha: clamp(finite(o.alpha, 1), 0, 1)
    };
}
function makeStroke(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        color: validColor(o.color, '#1f2937'),
        width: clamp(finite(o.width, 0), 0, 60),
        style: STROKE_STYLES.includes(o.style) ? o.style : 'solid'
    };
}
function makeShadow(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: !!o.enabled,
        color: validColor(o.color, '#000000'),
        x: clamp(finite(o.x, 8), -100, 100),
        y: clamp(finite(o.y, 8), -100, 100),
        blur: clamp(finite(o.blur, 16), 0, 120)
    };
}
function makeText(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const runs = Array.isArray(o.runs) ? o.runs.slice(0, 2000).map(r => ({
        text: typeof r.text === 'string' ? r.text.slice(0, 20000) : '',
        bold: !!r.bold, italic: !!r.italic, underline: !!r.underline,
        color: validColor(r.color, '')
    })) : [];
    if (!runs.length) runs.push({ text: '双击输入文本', bold: false, italic: false, underline: false, color: '' });
    return {
        runs,
        fontSize: clamp(finite(o.fontSize, 30), 1, 500),
        fontFamily: typeof o.fontFamily === 'string' && o.fontFamily.length < 200 ? o.fontFamily : 'sans-serif',
        fontWeight: [100, 300, 400, 500, 700, 900].includes(o.fontWeight) ? o.fontWeight : 400,
        lineHeight: clamp(finite(o.lineHeight, 1.2), 0.3, 5),
        letterSpacing: clamp(finite(o.letterSpacing, 0), -20, 100),
        align: TEXT_ALIGNS.includes(o.align) ? o.align : 'left',
        sizeMode: ['fixed', 'autoH', 'autoWH'].includes(o.sizeMode) ? o.sizeMode : 'fixed'
    };
}
function makeLine(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        style: LINE_STYLES.includes(o.style) ? o.style : 'solid',
        width: clamp(finite(o.width, 4), 1, 50),
        color: validColor(o.color, '#000000'),
        wavyAmp: clamp(finite(o.wavyAmp, 5), 1, 20),
        dash: ['solid', 'dashed', 'dotted'].includes(o.dash) ? o.dash : 'solid'
    };
}
/** 贝塞尔路径：节点以元素宽高的比例存储，缩放元素时路径随之缩放
 *  node = { x, y, ix, iy, ox, oy, t }：锚点 + 入/出控制柄（绝对比例坐标），t = 节点类型
 *  控制柄与锚点重合表示该侧为直线段，支持任意节点数、开放/闭合路径 */
const MAX_CURVE_NODES = 200;
const CURVE_NODE_TYPES = ['smooth', 'cusp'];
function makeCurveNode(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const pt = (v, d) => clamp(round3(finite(v, d)), -3, 4);
    const x = pt(o.x, 0), y = pt(o.y, 0);
    return {
        x, y,
        ix: pt(o.ix, x), iy: pt(o.iy, y),
        ox: pt(o.ox, x), oy: pt(o.oy, y),
        t: CURVE_NODE_TYPES.includes(o.t) ? o.t : 'smooth'
    };
}
function makeCurve(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    if (Array.isArray(o.nodes) && o.nodes.length >= 2) {
        return { nodes: o.nodes.slice(0, MAX_CURVE_NODES).map(makeCurveNode), closed: !!o.closed,
            filled: !!o.filled, strokeOn: o.strokeOn !== false };
    }
    // 旧版单段贝塞尔（四点）→ 两节点路径，形状完全一致
    const pt = (v, d) => clamp(round3(finite(v, d)), -3, 4);
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
function curveFillOn(el) {
    return !!(el && el.type === 'curve' && el.curve && el.curve.closed && el.curve.filled);
}
/** 曲线描边是否显示（旧存档无 strokeOn 字段时默认显示） */
function curveStrokeOn(el) {
    return !!(el && el.type === 'curve' && el.curve && el.curve.strokeOn !== false);
}
/** 单段路径：两侧控制柄都贴着锚点即输出直线，否则输出三次贝塞尔 */
function curveSegD(a, b, w, h) {
    const x1 = a.x * w, y1 = a.y * h, x2 = b.x * w, y2 = b.y * h;
    const c1x = a.ox * w, c1y = a.oy * h, c2x = b.ix * w, c2y = b.iy * h;
    const flat = Math.abs(c1x - x1) < 1e-6 && Math.abs(c1y - y1) < 1e-6 &&
        Math.abs(c2x - x2) < 1e-6 && Math.abs(c2y - y2) < 1e-6;
    if (flat) return ` L ${round2(x2)} ${round2(y2)}`;
    return ` C ${round2(c1x)} ${round2(c1y)}, ${round2(c2x)} ${round2(c2y)}, ${round2(x2)} ${round2(y2)}`;
}
function curvePathD(c, w, h) {
    const n = c && c.nodes;
    if (!n || !n.length) return '';
    let d = `M ${round2(n[0].x * w)} ${round2(n[0].y * h)}`;
    for (let i = 1; i < n.length; i++) d += curveSegD(n[i - 1], n[i], w, h);
    if (c.closed && n.length > 1) d += curveSegD(n[n.length - 1], n[0], w, h) + ' Z';
    return d;
}
/** 曲线段的端点（像素坐标），含起止控制点，用于分割与命中测试 */
function curveSegPts(nodes, a, b, w, h) {
    const A = nodes[a], B = nodes[b];
    return [
        { x: A.x * w, y: A.y * h },
        { x: A.ox * w, y: A.oy * h },
        { x: B.ix * w, y: B.iy * h },
        { x: B.x * w, y: B.y * h }
    ];
}
function cubicAt(p0, p1, p2, p3, t) {
    const m = 1 - t;
    const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
/** 把一段贝塞尔在 t 处切开，返回左右两段（控制点列表），用于插入节点 */
function splitCubic(pts, t) {
    const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const [p0, p1, p2, p3] = pts;
    const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
    const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
    const mid = lerp(p012, p123);
    return { left: [p0, p01, p012, mid], right: [mid, p123, p23, p3], mid };
}
/** 节点是否带控制柄（用于判断直线/曲线连接） */
function curveNodeHasIn(n) { return Math.abs(n.ix - n.x) > 1e-6 || Math.abs(n.iy - n.y) > 1e-6; }
function curveNodeHasOut(n) { return Math.abs(n.ox - n.x) > 1e-6 || Math.abs(n.oy - n.y) > 1e-6; }
/** 路径在世界坐标（相对元素）中的范围，含控制柄，用于“适配边框” */
function curveLocalBox(el) {
    const c = el.curve, w = el.w, h = el.h;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const put = (x, y) => { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); };
    c.nodes.forEach(n => {
        put(n.x * w, n.y * h);
        put(n.ix * w, n.iy * h);
        put(n.ox * w, n.oy * h);
    });
    return { left: l, top: t, right: r, bottom: b, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}
function lineDashArray(ln) {
    if (ln.style === 'dashed') return `${ln.width * 3} ${ln.width * 2}`;
    if (ln.style === 'dotted') return `0.1 ${ln.width * 1.8}`;
    return '';
}
function makeImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.assetId !== 'string' || !raw.assetId) return null;
    return {
        assetId: raw.assetId.slice(0, 120),
        originalAssetId: typeof raw.originalAssetId === 'string' ? raw.originalAssetId.slice(0, 120) : raw.assetId.slice(0, 120),
        crop: null
    };
}
function validateElement(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('元素数据不是对象');
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_]{1,120}$/.test(raw.id)) throw new Error('元素 id 不合法');
    if (!TYPES.includes(raw.type)) throw new Error('未知元素类型: ' + String(raw.type).slice(0, 40));
    const el = {
        id: raw.id,
        type: raw.type,
        x: clamp(finite(raw.x, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        y: clamp(finite(raw.y, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        w: clamp(finite(raw.w, 200), 1, MAX_CANVAS_SIDE),
        h: clamp(finite(raw.h, 150), 1, MAX_CANVAS_SIDE),
        rotation: clamp(finite(raw.rotation, 0), -36000, 36000),
        pivotX: clamp(finite(raw.pivotX, 0.5), -2, 3),
        pivotY: clamp(finite(raw.pivotY, 0.5), -2, 3),
        zIndex: clamp(finite(raw.zIndex, 1), 0, 100000),
        locked: !!raw.locked,
        exportVisible: raw.exportVisible !== false,
        opacity: clamp(finite(raw.opacity, 1), 0, 1),
        borderRadius: clamp(finite(raw.borderRadius, 0), 0, 10000),
        fill: makeFill(raw.fill),
        text: raw.type === 'text' ? makeText(raw.text) : null,
        line: raw.type === 'line' ? makeLine(raw.line)
            : raw.type === 'curve' ? (() => { const l = makeLine(raw.line); if (l.style === 'wavy') l.style = 'solid'; return l; })()
            : null,
        curve: raw.type === 'curve' ? makeCurve(raw.curve) : null,
        image: makeImage(raw.image),
        maskAssetId: typeof raw.maskAssetId === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(raw.maskAssetId) ? raw.maskAssetId : null,
        // ---- V12：图层元数据与视觉效果 ----
        name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : (TYPE_LABELS[raw.type] || '元素'),
        visible: raw.visible !== false,
        groupId: typeof raw.groupId === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(raw.groupId) ? raw.groupId : null,
        stroke: makeStroke(raw.stroke),
        shadow: makeShadow(raw.shadow),
        blendMode: BLEND_MODES.includes(raw.blendMode) ? raw.blendMode : 'normal'
    };
    return el;
}
function validateGuide(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('辅助线数据不是对象');
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_]{1,120}$/.test(raw.id)) throw new Error('辅助线 id 不合法');
    return {
        id: raw.id,
        angle: clamp(finite(raw.angle, 0), -36000, 36000),
        x: clamp(finite(raw.x, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE),
        y: clamp(finite(raw.y, 0), -MAX_CANVAS_SIDE, MAX_CANVAS_SIDE)
    };
}
function validateAssets(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).slice(0, 5000).forEach(k => {
        const v = raw[k];
        if (/^[A-Za-z0-9_]{1,120}$/.test(k) && typeof v === 'string' && v.length < 40 * 1024 * 1024 && DATA_IMAGE_RE.test(v)) {
            out[k] = v;
        }
    });
    return out;
}
/** 统一入口：自动保存快照、撤销历史条目、项目文件都经过这里 */
function validateProject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目数据格式不正确');
    // 兼容旧存档：v2 补齐图层元数据，v3 的单段曲线自动迁移为多节点路径
    if (!COMPAT_VERSIONS.includes(raw.version)) throw new Error('项目版本不匹配（需要 v' + VERSION + '）');
    const c = raw.canvas;
    if (!c || typeof c !== 'object') throw new Error('缺少画布设置');
    const w = clamp(finite(c.w, 800), 1, MAX_CANVAS_SIDE);
    const h = clamp(finite(c.h, 800), 1, MAX_CANVAS_SIDE);
    if (!Array.isArray(raw.elements)) throw new Error('元素列表格式不正确');
    if (raw.elements.length > 5000) throw new Error('元素数量超出上限');
    const ids = new Set();
    const elements = raw.elements.map(e => {
        const el = validateElement(e);
        if (ids.has(el.id)) throw new Error('存在重复的元素 id');
        ids.add(el.id);
        return el;
    });
    const guides = [];
    if (raw.guides !== undefined) {
        if (!Array.isArray(raw.guides)) throw new Error('辅助线列表格式不正确');
        if (raw.guides.length > 200) throw new Error('辅助线数量超出上限');
        const gids = new Set();
        raw.guides.forEach(g => {
            const gd = validateGuide(g);
            if (gids.has(gd.id)) throw new Error('存在重复的辅助线 id');
            gids.add(gd.id);
            guides.push(gd);
        });
    }
    return {
        version: VERSION,
        name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '未命名设计',
        canvas: { w, h, background: makeFill(c.background), lockedRatio: !!c.lockedRatio },
        elements,
        guides,
        assets: raw.assets ? validateAssets(raw.assets) : undefined
    };
}
function defaultModel() {
    const mk = (id, x, y, color, z) => validateElement({
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
function getEl(id) { return state.model.elements.find(e => e.id === id) || null; }
function selectedEls() { return state.selection.map(getEl).filter(Boolean); }
function nextZIndex() {
    return state.model.elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1;
}
function normalizeZ() {
    state.model.elements.slice().sort((a, b) => a.zIndex - b.zIndex).forEach((e, i) => { e.zIndex = i + 1; });
    nodeMap.forEach((d, id) => {
        const el = getEl(id);
        if (el) d.style.zIndex = String(el.zIndex);
    });
}
function sortedElements() {
    return state.model.elements.slice().sort((a, b) => a.zIndex - b.zIndex);
}
function snapshotJSON() {
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
function buildElement(type, x, y) {
    const base = {
        id: uid('el'), type, x, y, w: 200, h: 150, rotation: 0, zIndex: nextZIndex(),
        locked: false, exportVisible: true, opacity: 1, borderRadius: 0,
        fill: makeFill({ mode: 'solid', color: '#cccccc' }),
        text: null, line: null, image: null, maskAssetId: null
    };
    if (type === 'circle') { base.w = 150; base.h = 150; }
    if (type === 'triangle' || type === 'star') { base.w = 150; base.h = 150; }
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

/* ==================== 6. 样式计算 ==================== */
function hexToRgba(hex, alpha) {
    if (!HEX_RE.test(hex)) return hex;
    if (alpha >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function fillToCSS(f) {
    const a = clamp(finite(f.alpha, 1), 0, 1);
    const s = hexToRgba(f.start, a), e = hexToRgba(f.end, a);
    if (f.mode === 'linear') return `linear-gradient(${f.angle}deg, ${s}, ${e})`;
    if (f.mode === 'radial') return `radial-gradient(ellipse at ${f.posX}% ${f.posY}%, ${s}, ${e})`;
    if (f.mode === 'conic') return `conic-gradient(from ${f.angle}deg at ${f.posX}% ${f.posY}%, ${s}, ${e})`;
    return hexToRgba(f.color, a);
}
/** 描边：常规形状用 SVG 轮廓叠加（支持虚线），boolean 用多重 drop-shadow 贴合遮罩；投影基于 alpha */
function shapeFilter(el) {
    const parts = [];
    const st = el.stroke;
    if (st && st.width > 0 && !STROKE_SVG_TYPES.includes(el.type)) {
        const w = Math.min(st.width, 12);
        const offsets = [[w, 0], [-w, 0], [0, w], [0, -w]];
        if (w > 2) offsets.push([w * .7, w * .7], [-w * .7, w * .7], [w * .7, -w * .7], [-w * .7, -w * .7]);
        offsets.forEach(([x, y]) => parts.push(`drop-shadow(${round2(x)}px ${round2(y)}px 0 ${st.color})`));
    }
    const sh = el.shadow;
    if (sh && sh.enabled) {
        parts.push(`drop-shadow(${sh.x}px ${sh.y}px ${sh.blur}px ${hexToRgba(sh.color, .72)})`);
    }
    return parts.join(' ');
}
/** 生成描边 SVG 叠加层的内部标记（像素坐标，与导出保持一致的居中描边） */
function strokeOverlayMarkup(el, w, h) {
    const st = el.stroke;
    if (!st || st.width <= 0 || !STROKE_SVG_TYPES.includes(el.type)) return '';
    const dash = st.style === 'dashed' ? ` stroke-dasharray="${st.width * 3} ${st.width * 2}"`
        : st.style === 'dotted' ? ` stroke-dasharray="0.1 ${st.width * 1.8}" stroke-linecap="round"` : '';
    const attrs = `fill="none" stroke="${st.color}" stroke-width="${st.width}"${dash}`;
    if (el.type === 'circle') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`;
    if (POLYGON_POINTS[el.type]) {
        const pts = POLYGON_POINTS[el.type].map(([x, y]) => `${round2(x * w / 100)},${round2(y * h / 100)}`).join(' ');
        return `<polygon points="${pts}" stroke-linejoin="round" ${attrs}/>`;
    }
    const rx = Math.min(el.borderRadius, w / 2, h / 2);
    return `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ${attrs}/>`;
}
function wavyGeom(line) {
    const amp = line.width * 0.5 + line.wavyAmp * 1.5;
    const period = Math.max(line.width * 2 + 10, 45 - line.wavyAmp * 1.5);
    return { amp, period };
}
/** 一个波浪周期（两段二次贝塞尔）的弧长，采样计算 */
function wavyPeriodLength(period, amp) {
    let len = 0;
    const quad = (p0, p1, p2) => {
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
function wavyDashSpec(line) {
    if (line.style !== 'wavy' || !line.dash || line.dash === 'solid') return null;
    const { amp, period } = wavyGeom(line);
    const L = wavyPeriodLength(period, amp);
    if (line.dash === 'dashed') return { dash: `${round2(L / 8)} ${round2(L / 8)}`, offset: 0 };
    const n = Math.max(4, Math.floor(L / (0.1 + line.width * 1.2 + 0.5)));
    const gap = round2(L / n - 0.1);
    return { dash: `0.1 ${gap}`, offset: round2((0.1 + gap) / 2) };
}
function wavyDataURI(line) {
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
function lineHeightFor(el) {
    if (el.type !== 'line') return el.h;
    return el.line.style === 'wavy'
        ? Math.max(el.line.width * 4, (el.line.width * 0.5 + el.line.wavyAmp * 1.5) * 2 + el.line.width * 2)
        : Math.max(1, el.line.width);
}

/* ==================== 7. DOM 渲染层 ==================== */
function buildNode(el) {
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
    }
    ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].forEach(dir => {
        const r = document.createElement('div');
        r.className = 'resizer resizer-' + dir;
        r.dataset.dir = dir;
        d.appendChild(r);
    });
    const rotLine = document.createElement('div'); rotLine.className = 'rotator-line'; d.appendChild(rotLine);
    const rot = document.createElement('div'); rot.className = 'rotator'; rot.title = '拖拽旋转（Shift 吸附 15°）；悬停显示旋转中心'; rot.setAttribute('role', 'button'); rot.setAttribute('aria-label', '拖拽旋转；悬停显示旋转中心'); d.appendChild(rot);
    const pivot = document.createElement('div'); pivot.className = 'pivot-handle'; pivot.title = '旋转中心：拖拽移动，双击复位'; pivot.setAttribute('role', 'button'); pivot.setAttribute('aria-label', '旋转中心：拖拽移动，双击复位'); d.appendChild(pivot);
    // 枢轴手柄默认隐藏，避免盖住内容/拦截双击；悬停旋转柄或旋转时才浮现
    // 指针离开后延迟收起，留出从旋转柄移向准星的操作时间；悬停期间保持可见
    const showPeek = () => { clearTimeout(d._peekTimer); if (!el.locked) d.classList.add('pivot-peek'); };
    d._hidePeekLater = () => {
        clearTimeout(d._peekTimer);
        d._peekTimer = setTimeout(() => {
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
function renderRuns(container, el) {
    container.textContent = '';
    const t = el.text;
    container.style.fontSize = t.fontSize + 'px';
    container.style.fontFamily = t.fontFamily;
    container.style.fontWeight = String(t.fontWeight);
    container.style.lineHeight = String(t.lineHeight);
    container.style.letterSpacing = t.letterSpacing + 'px';
    container.style.textAlign = t.align;
    container.style.color = el.fill.color;
    t.runs.forEach(run => {
        const span = document.createElement('span');
        span.textContent = run.text;
        if (run.bold) { span.style.fontWeight = '700'; span.dataset.b = '1'; }
        if (run.italic) { span.style.fontStyle = 'italic'; span.dataset.i = '1'; }
        if (run.underline) { span.style.textDecoration = 'underline'; span.dataset.u = '1'; }
        if (run.color) { span.style.color = run.color; span.dataset.color = run.color; }
        container.appendChild(span);
    });
}
/* 离屏 DOM 测量：与编辑器 HTML 排版完全一致的宽高 */
let textMeasurer = null;
function measureTextDom(el, maxW) {
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
let textMeasureCanvas = null;
function textMeasureCtx() {
    if (!textMeasureCanvas) textMeasureCanvas = document.createElement('canvas');
    return textMeasureCanvas.getContext('2d');
}
function canvasTextWidth(ctx, t, run, text) {
    ctx.font = fontForRun(run, t);
    let w = 0;
    for (const ch of text) w += ctx.measureText(ch).width + t.letterSpacing;
    return w;
}
/** 自动尺寸：取 DOM 与导出排版两者较大值，保证编辑器和导出都不裁切 */
function applyAutoSize(el) {
    const mode = el.text.sizeMode;
    if (!mode || mode === 'fixed') return;
    const t = el.text;
    const lh = t.fontSize * t.lineHeight;
    const maxW = mode === 'autoH' ? el.w : 1e9;
    const dom = measureTextDom(el, mode === 'autoH' ? el.w : null);
    const ctx = textMeasureCtx();
    const lines = layoutText(el, maxW, (run, text) => canvasTextWidth(ctx, t, run, text));
    const canvasH = lines.length * lh;
    const canvasW = lines.reduce((m, ln) => Math.max(m, ln.reduce((a, tok) => a + tok.w, 0)), 0);
    if (mode === 'autoWH') el.w = round2(Math.max(20, dom.w, canvasW) + 2);
    el.h = round2(Math.max(lh, dom.h, canvasH));
}
function updateTextStats(el) {
    const n = $('textStats');
    if (!n || !el || el.type !== 'text') return;
    const text = el.text.runs.map(r => r.text).join('');
    const chars = text.replace(/\n/g, '').length;
    const ctx = textMeasureCtx();
    const maxW = el.text.sizeMode === 'autoWH' ? 1e9 : el.w;
    const lines = layoutText(el, maxW, (run, s) => canvasTextWidth(ctx, el.text, run, s)).length;
    const mode = { fixed: '固定尺寸', autoH: '自动高度', autoWH: '自动宽高' }[el.text.sizeMode] || '固定尺寸';
    n.textContent = `${chars} 字符 · ${lines} 行 · ${mode}`;
}
function syncNode(el, d) {
    const s = d.style;
    const renderH = el.type === 'line' ? lineHeightFor(el) : el.h;
    s.left = el.x + 'px';
    s.top = el.y + 'px';
    s.width = el.w + 'px';
    s.height = renderH + 'px';
    s.transform = `rotate(${el.rotation}deg)`;
    s.transformOrigin = `${el.pivotX * 100}% ${el.pivotY * 100}%`;
    s.zIndex = String(el.zIndex);
    s.opacity = String(el.opacity);
    d.dataset.locked = String(el.locked);
    d.dataset.exportVisible = String(el.exportVisible);
    d.dataset.rotation = String(el.rotation);
    d.dataset.visible = String(el.visible);
    d.classList.toggle('group-member', !!el.groupId);
    s.mixBlendMode = el.blendMode && el.blendMode !== 'normal' ? el.blendMode : '';
    s.display = el.visible ? '' : 'none';

    const pivot = d.querySelector('.pivot-handle');
    if (pivot) {
        pivot.style.left = (el.pivotX * 100) + '%';
        pivot.style.top = (el.pivotY * 100) + '%';
        pivot.classList.toggle('custom', Math.abs(el.pivotX - 0.5) > 0.001 || Math.abs(el.pivotY - 0.5) > 0.001);
        d.classList.toggle('pivot-custom', Math.abs(el.pivotX - 0.5) > 0.001 || Math.abs(el.pivotY - 0.5) > 0.001);
    }

    const shape = d.querySelector('.shape-layer');
    if (!shape) return;
    const ss = shape.style;
    ss.cssText = '';
    ss.width = '100%'; ss.height = '100%';
    ss.borderRadius = el.type === 'circle' ? '50%' : el.borderRadius + 'px';
    if (CLIP_PATHS[el.type]) ss.clipPath = CLIP_PATHS[el.type];

    if (el.type === 'line') {
        const ln = el.line;
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
        const tc = d.querySelector('.text-content');
        if (tc && !(state.isTextEditing && state.editingId === el.id)) renderRuns(tc, el);
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

    const ov = d.querySelector('.stroke-overlay');
    if (ov) {
        ov.setAttribute('viewBox', `0 0 ${el.w} ${renderH}`);
        ov.innerHTML = strokeOverlayMarkup(el, el.w, renderH);
        const f = shapeFilter(el);
        ov.style.filter = f || '';
    }
}
/** 同步曲线路径、节点方块、控制柄与切线。节点数量变化时重建手柄 DOM */
function syncCurveNode(el, d, h) {
    const c = el.curve, ln = el.line, w = el.w;
    const cv = d.querySelector('.curve-svg');
    if (cv) {
        cv.setAttribute('viewBox', `0 0 ${w} ${h}`);
        cv.setAttribute('preserveAspectRatio', 'none');
        const fd = curveFillOn(el) ? fillDefs('cf_' + el.id, el.fill) : null;
        const defs = cv.querySelector('defs');
        if (defs) defs.innerHTML = fd ? fd.def : '';
        const path = cv.querySelector('path');
        path.setAttribute('d', curvePathD(c, w, h));
        path.setAttribute('fill', fd ? fd.ref : 'none');
        path.setAttribute('stroke', ln.color);
        path.setAttribute('stroke-width', String(curveStrokeOn(el) ? ln.width : 0));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        const dash = lineDashArray(ln);
        if (dash) path.setAttribute('stroke-dasharray', dash);
        else path.removeAttribute('stroke-dasharray');
    }
    const nodes = c.nodes;
    let holder = d.querySelector('.curve-nodes');
    if (!holder || holder.childElementCount !== nodes.length * 3) {
        if (!holder) {
            holder = document.createElement('div');
            holder.className = 'curve-nodes';
            d.appendChild(holder);
        }
        holder.textContent = '';
        nodes.forEach((n, i) => {
            const nd = document.createElement('div');
            nd.className = 'curve-node';
            nd.dataset.i = String(i);
            nd.title = `节点 ${i + 1}：拖拽移动 · 双击删除 · Ctrl+点击切换平滑/尖角`;
            holder.appendChild(nd);
            ['in', 'out'].forEach(k => {
                const hd = document.createElement('div');
                hd.className = 'curve-ctrl';
                hd.dataset.i = String(i);
                hd.dataset.h = k;
                hd.title = '控制柄：拖拽调弧度 · Alt 断开对称 · Shift 15° 吸附';
                holder.appendChild(hd);
            });
        });
    }
    // 切线层：当前节点的两条控制柄引线
    const guides = d.querySelector('.curve-guides');
    const sel = (state.nodeSel && state.nodeSel.id === el.id) ? state.nodeSel.i : -1;
    if (guides) {
        guides.setAttribute('viewBox', `0 0 ${w} ${h}`);
        guides.setAttribute('preserveAspectRatio', 'none');
        const active = sel >= 0 ? nodes[sel] : null;
        if (!active || el.locked) {
            guides.textContent = '';
        } else {
            guides.textContent = '';
            ['in', 'out'].forEach(k => {
                const has = k === 'in' ? curveNodeHasIn(active) : curveNodeHasOut(active);
                if (!has) return;
                const ln2 = document.createElementNS(SVG_NS, 'line');
                ln2.setAttribute('x1', active.x * w); ln2.setAttribute('y1', active.y * h);
                ln2.setAttribute('x2', (k === 'in' ? active.ix : active.ox) * w);
                ln2.setAttribute('y2', (k === 'in' ? active.iy : active.oy) * h);
                guides.appendChild(ln2);
            });
        }
    }
    holder.querySelectorAll('.curve-node').forEach(nd => {
        const i = Number(nd.dataset.i), n = nodes[i];
        if (!n) return;
        nd.style.left = (n.x * 100) + '%';
        nd.style.top = (n.y * 100) + '%';
        nd.classList.toggle('sel', sel === i);
    });
    holder.querySelectorAll('.curve-ctrl').forEach(hd => {
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
function syncElement(id) {
    const el = getEl(id), d = nodeMap.get(id);
    if (el && d) syncNode(el, d);
    else renderAll();
}
function renderAll() {
    if (state.isTextEditing) finishTextEdit();   // 重建前先回写编辑内容，避免丢字
    // 模型被整体替换（撤销 / 载入 / 新建）时丢弃钢笔草稿，避免画在旧坐标上
    if (state.pen) { state.pen = null; if (typeof renderPenDraft === 'function') renderPenDraft(); }
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
    if (typeof refreshStudioPanels === 'function') refreshStudioPanels();
}
function applySelectionClasses() {
    const set = new Set(state.selection);
    const solo = state.selection.length === 1 ? state.selection[0] : null;
    if (state.selection.length) state.guideSel = null;
    nodeMap.forEach((d, id) => {
        d.classList.toggle('active', set.has(id));
        d.classList.toggle('solo', id === solo);
    });
    syncNodeSel();
    // 选中状态变化后刷新曲线节点/控制柄的显示
    if (solo && nodeMap.has(solo)) {
        const el = getEl(solo);
        if (el && el.type === 'curve') syncElement(solo);
    }
}
/** 曲线节点选择跟随当前单选对象；换选时自动选中第一个节点，控制柄随之可见 */
function syncNodeSel() {
    const solo = state.selection.length === 1 ? getEl(state.selection[0]) : null;
    if (solo && solo.type === 'curve') {
        if (!state.nodeSel || state.nodeSel.id !== solo.id) state.nodeSel = { id: solo.id, i: 0 };
        const n = solo.curve.nodes.length;
        if (state.nodeSel.i >= n) state.nodeSel.i = n - 1;
    } else {
        state.nodeSel = null;
    }
}
function syncCanvasSize() {
    const c = state.model.canvas;
    const canvas = $('canvas');
    canvas.style.width = c.w + 'px';
    canvas.style.height = c.h + 'px';
    canvas.style.background = fillToCSS(c.background);
    $('canvasW').value = Math.round(c.w);
    $('canvasH').value = Math.round(c.h);
}
function syncTransform() {
    $('transformLayer').style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    $('zoomDisplay').textContent = Math.round(state.zoom * 100) + '%';
    $('viewport').style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
    if (typeof onViewChanged === 'function') onViewChanged();
}

/* ==================== 8. 历史、自动保存与载入 ==================== */
function updateUndoRedoButtons() {
    $('btnUndo').style.opacity = historyIndex > 0 ? '1' : '0.35';
    $('btnRedo').style.opacity = historyIndex < undoStack.length - 1 ? '1' : '0.35';
}
function saveAuto(json) {
    try {
        localStorage.setItem(STORAGE_KEY, json);
        return true;
    } catch (e) {
        toast('本地存储空间不足，请立即用「保存项目」导出 .canvas 文件，以免内容丢失', 'error');
        return false;
    }
}
/** 连续滑块/输入只提交一次历史，避免 50 步被瞬间耗尽 */
function scheduleCommit(delay) {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, delay === undefined ? 220 : delay);
}
function commit() {
    clearTimeout(commitTimer);
    if (isApplyingHistory) return;
    normalizeZ();
    const json = snapshotJSON();
    // 编辑中的防抖提交只自动保存，避免每次击键都产生一条撤销记录
    if (state.isTextEditing) { saveAuto(json); return; }
    if (historyIndex >= 0 && undoStack[historyIndex] === json) { saveAuto(json); return; }
    undoStack = undoStack.slice(0, historyIndex + 1);
    undoStack.push(json);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    historyIndex = undoStack.length - 1;
    saveAuto(json);
    updateUndoRedoButtons();
    flushAssets();
    if (typeof queueProjectSave === 'function') queueProjectSave();
    const dot = $('saveDot'); if (dot) dot.classList.remove('dirty');
}
async function flushAssets() {
    if (!dbAvailable || !state.hiddenAssetsDirty.size) return;
    const ids = Array.from(state.hiddenAssetsDirty);
    state.hiddenAssetsDirty.clear();
    for (const id of ids) {
        if (state.assets[id]) await idbPut(id, state.assets[id]);
    }
}
function applySnapshot(json, keepHistory) {
    let parsed;
    try { parsed = validateProject(JSON.parse(json)); }
    catch (e) { toast('数据载入失败：' + e.message, 'error'); return false; }
    state.isTextEditing = false;
    state.editingId = null;
    state.interaction = null;
    state.model = { version: VERSION, name: parsed.name || state.projectName, canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
    state.guideSel = null;
    if (parsed.assets) Object.assign(state.assets, parsed.assets);
    state.selection = [];
    commitTimer && clearTimeout(commitTimer);
    renderAll();
    syncCanvasSize();
    syncBackgroundControls();
    updateUI();
    if (!keepHistory) { /* 由调用方管理历史 */ }
    return true;
}
function undo() {
    if (historyIndex <= 0) return;
    isApplyingHistory = true;
    historyIndex--;
    applySnapshot(undoStack[historyIndex], true);
    saveAuto(undoStack[historyIndex]);
    isApplyingHistory = false;
    updateUndoRedoButtons();
}
function redo() {
    if (historyIndex >= undoStack.length - 1) return;
    isApplyingHistory = true;
    historyIndex++;
    applySnapshot(undoStack[historyIndex], true);
    saveAuto(undoStack[historyIndex]);
    isApplyingHistory = false;
    updateUndoRedoButtons();
}
async function loadAuto() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
        const parsed = validateProject(JSON.parse(raw));
        const stored = await idbAll();
        state.assets = Object.assign({}, stored, parsed.assets || {});
        state.model = { version: VERSION, name: parsed.name || state.projectName || '未命名设计', canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
        undoStack = [snapshotJSON()];
        historyIndex = 0;
        return true;
    } catch (e) {
        console.warn('自动保存数据不可用：', e.message);
        toast('本地存档无法读取（' + e.message + '），已载入空白画布；原数据未被覆盖', 'error');
        return false;
    }
}

/* ==================== 9. 视图 / 缩放（鼠标锚点） ==================== */
function viewportRect() { return $('viewport').getBoundingClientRect(); }
function setZoom(next, clientX, clientY) {
    const vr = viewportRect();
    const ax = (clientX === undefined ? vr.left + vr.width / 2 : clientX) - vr.left;
    const ay = (clientY === undefined ? vr.top + vr.height / 2 : clientY) - vr.top;
    const old = state.zoom;
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const worldX = (ax - state.pan.x) / old;
    const worldY = (ay - state.pan.y) / old;
    state.zoom = z;
    state.pan.x = ax - worldX * z;
    state.pan.y = ay - worldY * z;
    syncTransform();
}
function adjustZoom(delta, clientX, clientY) { setZoom(state.zoom + delta, clientX, clientY); }
function resetView() {
    const vr = viewportRect();
    state.zoom = 1;
    state.pan.x = (vr.width - state.model.canvas.w) / 2;
    state.pan.y = (vr.height - state.model.canvas.h) / 2;
    syncTransform();
}
function fitToScreen() {
    const vr = viewportRect();
    const pad = 40;
    const cw = state.model.canvas.w, ch = state.model.canvas.h;
    const z = clamp(Math.min((vr.width - pad) / cw, (vr.height - pad) / ch), MIN_ZOOM, 5);
    state.zoom = z;
    state.pan.x = (vr.width - cw * z) / 2;
    state.pan.y = (vr.height - ch * z) / 2;
    syncTransform();
}
function canvasCenterFor(w, h) {
    const vr = viewportRect();
    const worldX = (vr.width / 2 - state.pan.x) / state.zoom;
    const worldY = (vr.height / 2 - state.pan.y) / state.zoom;
    return { x: worldX - w / 2, y: worldY - h / 2 };
}

/* ==================== 10. 统一几何（旋转感知 AABB，支持自定义枢轴） ==================== */
function getAABB(el) {
    const rad = el.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const vw = el.w * Math.abs(cos) + h * Math.abs(sin);
    const vh = el.w * Math.abs(sin) + h * Math.abs(cos);
    // 旋转围绕枢轴进行：先求未旋转中心相对枢轴的偏移，再旋转该偏移
    const px = el.x + el.pivotX * el.w, py = el.y + el.pivotY * h;
    const ox = el.w / 2 - el.pivotX * el.w, oy = h / 2 - el.pivotY * h;
    const cx = px + ox * cos - oy * sin;
    const cy = py + ox * sin + oy * cos;
    return { left: cx - vw / 2, top: cy - vh / 2, right: cx + vw / 2, bottom: cy + vh / 2, w: vw, h: vh, cx, cy };
}
/** 元素枢轴的世界坐标 */
function pivotWorld(el) {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    return { x: el.x + el.pivotX * el.w, y: el.y + el.pivotY * h };
}
/** 旋转手柄的世界坐标（用于让尺寸标注避开它） */
function rotatorWorld(el) {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const ox = el.w / 2 - el.pivotX * el.w, oy = -27 - el.pivotY * h;
    const p = pivotWorld(el);
    return { x: p.x + ox * cos - oy * sin, y: p.y + ox * sin + oy * cos };
}
/** 设置枢轴（比例坐标）。keepShape=true 时补偿 x/y，使图形在屏幕上保持不动 */
function setPivot(el, fx, fy, keepShape) {
    fx = clamp(finite(fx, 0.5), -2, 3);
    fy = clamp(finite(fy, 0.5), -2, 3);
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    if (keepShape && el.rotation) {
        const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const p1x = el.pivotX * el.w, p1y = el.pivotY * h;
        const p2x = fx * el.w, p2y = fy * h;
        const dx = p2x - p1x, dy = p2y - p1y;
        const nx = el.x + p1x + dx * cos - dy * sin;
        const ny = el.y + p1y + dx * sin + dy * cos;
        el.x = round2(nx - p2x);
        el.y = round2(ny - p2y);
    }
    el.pivotX = round2(fx * 100) / 100;
    el.pivotY = round2(fy * 100) / 100;
}
function selectionAABB() {
    const els = selectedEls();
    if (!els.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    els.forEach(el => {
        const a = getAABB(el);
        l = Math.min(l, a.left); t = Math.min(t, a.top);
        r = Math.max(r, a.right); b = Math.max(b, a.bottom);
    });
    return { left: l, top: t, right: r, bottom: b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}
function normalizeZFromOrder(order) {
    order.forEach((el, i) => { el.zIndex = i + 1; });
}

/* ==================== 11. 选择 ==================== */
function setSelection(ids) {
    const valid = ids.filter(id => !!getEl(id));
    state.selection = typeof expandGroupIds === 'function' ? expandGroupIds(valid) : valid;
    applySelectionClasses();
    updateUI();
}
function deselectAll() {
    if (state.isTextEditing) finishTextEdit();
    state.selection = [];
    state.guideSel = null;
    applySelectionClasses();
    state.geoRatioLocked = false;
    updateGeoLockButton();
    endRelLayer();
    updateUI();
}
function toggleSelection(id, additive) {
    if (additive) {
        const i = state.selection.indexOf(id);
        if (i >= 0) state.selection.splice(i, 1); else state.selection.push(id);
    } else {
        if (state.selection.length > 1 && state.selection.includes(id)) return;
        state.selection = [id];
    }
    applySelectionClasses();
    updateUI();
}
function updateGeoLockButton() {
    const btn = $('btnGeoLock');
    btn.classList.toggle('active', state.geoRatioLocked);
    setIcon(btn, state.geoRatioLocked ? 'link' : 'unlink');
}
function toggleSelectionLock() {
    state.geoRatioLocked = !state.geoRatioLocked;
    if (state.geoRatioLocked && state.selection.length === 1) {
        const el = getEl(state.selection[0]);
        state.geoRatio = el.w / Math.max(1, el.h);
    }
    updateGeoLockButton();
}
function toggleCanvasLock() {
    state.canvasRatioLocked = !state.canvasRatioLocked;
    state.model.canvas.lockedRatio = state.canvasRatioLocked;
    const btn = $('btnCanvasLock');
    btn.classList.toggle('active', state.canvasRatioLocked);
    setIcon(btn, state.canvasRatioLocked ? 'link' : 'unlink');
    if (state.canvasRatioLocked) state.canvasRatio = state.model.canvas.w / state.model.canvas.h;
    commit();
}

/* ==================== 12. 面板回填 ==================== */
function showOnly(mode) {
    $('bgSolidControls').style.display = mode === 'solid' ? 'flex' : 'none';
    $('bgGradientControls').style.display = mode === 'solid' ? 'none' : 'block';
    $('bgAngleRow').style.display = mode === 'radial' ? 'none' : 'flex';
    $('bgPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
}
function syncBackgroundControls() {
    const f = state.model.canvas.background;
    $('bgType').value = f.mode;
    $('bgColorPicker').value = f.color;
    $('bgColorHex').value = f.color.toUpperCase();
    $('gradStart').value = f.start;
    $('gradEnd').value = f.end;
    $('gradAngle').value = f.angle;
    $('gradAngleInput').value = f.angle;
    $('gradPosX').value = f.posX;
    $('gradPosY').value = f.posY;
    showOnly(f.mode);
    const btn = $('btnCanvasLock');
    state.canvasRatioLocked = !!state.model.canvas.lockedRatio;
    state.canvasRatio = state.model.canvas.w / state.model.canvas.h;
    btn.classList.toggle('active', state.canvasRatioLocked);
    setIcon(btn, state.canvasRatioLocked ? 'link' : 'unlink');
}
function syncElBackgroundControls(f) {
    $('elBgType').value = f.mode;
    $('elColorInput').value = f.color;
    $('elColorHex').value = f.color.toUpperCase();
    $('elAlphaInput').value = Math.round(clamp(finite(f.alpha, 1), 0, 1) * 100);
    $('elAlphaVal').textContent = $('elAlphaInput').value + '%';
    $('elGradStart').value = f.start;
    $('elGradEnd').value = f.end;
    $('elGradAngle').value = f.angle;
    $('elGradAngleInput').value = f.angle;
    $('elGradPosX').value = f.posX;
    $('elGradPosY').value = f.posY;
    state.elBgMode = f.mode;
    $('elBgSolidControls').style.display = f.mode === 'solid' ? 'block' : 'none';
    $('elBgGradientControls').style.display = f.mode === 'solid' ? 'none' : 'block';
    $('elAngleRow').style.display = f.mode === 'radial' ? 'none' : 'flex';
    $('elPosRow').style.display = (f.mode === 'radial' || f.mode === 'conic') ? 'flex' : 'none';
}
/* -------------------- 曲线填充面板（仅闭合路径） -------------------- */
function syncCurveFillControls(el) {
    const isCurve = !!(el && el.type === 'curve');
    $('shapeFillControls').style.display = isCurve ? 'none' : 'block';
    $('curveFillControls').style.display = isCurve ? 'block' : 'none';
    if (!isCurve) return;
    const f = el.fill, c = el.curve;
    $('curveFillEnabled').checked = !!c.filled;
    $('curveFillEnabled').disabled = !c.closed || !!el.locked;
    $('curveFillMode').value = f.mode;
    $('curveFillColor').value = f.color;
    $('curveFillHex').textContent = f.color.toUpperCase();
    $('curveFillGradStart').value = f.start;
    $('curveFillGradEnd').value = f.end;
    $('curveFillAngle').value = f.angle;
    $('curveFillAngleVal').textContent = Math.round(f.angle) + '°';
    $('curveFillAlpha').value = Math.round(f.alpha * 100);
    $('curveFillAlphaVal').textContent = Math.round(f.alpha * 100) + '%';
    $('curveStrokeEnabled').checked = c.strokeOn !== false;
    $('curveStrokeColor').value = el.line.color;
    $('curveStrokeHex').textContent = el.line.color.toUpperCase();
    const grad = f.mode !== 'solid';
    $('curveFillSolidRow').style.display = grad ? 'none' : 'flex';
    $('curveFillGradControls').style.display = grad ? 'block' : 'none';
}
function updateCurveFill() {
    const el = selectedEls().find(e => e.type === 'curve' && !e.locked);
    if (!el) return;
    const f = makeFill({
        mode: $('curveFillMode').value,
        color: $('curveFillColor').value,
        start: $('curveFillGradStart').value,
        end: $('curveFillGradEnd').value,
        angle: $('curveFillAngle').value,
        alpha: $('curveFillAlpha').value / 100
    });
    el.fill = f;
    el.curve.filled = $('curveFillEnabled').checked && el.curve.closed;
    $('curveFillHex').textContent = f.color.toUpperCase();
    $('curveFillAngleVal').textContent = Math.round(f.angle) + '°';
    $('curveFillAlphaVal').textContent = Math.round($('curveFillAlpha').value) + '%';
    const grad = f.mode !== 'solid';
    $('curveFillSolidRow').style.display = grad ? 'none' : 'flex';
    $('curveFillGradControls').style.display = grad ? 'block' : 'none';
    syncElement(el.id);
    scheduleCommit();
}
function updateCurveStroke() {
    const el = selectedEls().find(e => e.type === 'curve' && !e.locked);
    if (!el) return;
    el.curve.strokeOn = $('curveStrokeEnabled').checked;
    el.line.color = $('curveStrokeColor').value;
    $('curveStrokeHex').textContent = el.line.color.toUpperCase();
    syncElement(el.id);
    scheduleCommit();
}
function updatePropPanel(el) {
    $('geoX').value = Math.round(el.x);
    $('geoY').value = Math.round(el.y);
    $('geoW').value = Math.round(el.w);
    $('geoH').value = Math.round(el.type === 'line' ? lineHeightFor(el) : el.h);
    $('geoR').value = Math.round(el.rotation);
    syncPivotInputs(el);
    $('chkExportVisible').checked = el.exportVisible;
    $('opacityInput').value = Math.round(el.opacity * 100);
    $('opacityVal').textContent = Math.round(el.opacity * 100);
    $('borderRadiusInput').value = Math.round(el.borderRadius);
    $('radiusVal').textContent = Math.round(el.borderRadius);
    syncElBackgroundControls(el.fill);

    const isLine = el.type === 'line', isCurve = el.type === 'curve', isText = el.type === 'text';
    $('appearanceBlock').style.display = 'block';
    syncCurveFillControls(el);
    $('elBgType').disabled = isLine || isCurve || isText;
    $('lineSpecific').style.display = (isLine || isCurve) ? 'block' : 'none';
    $('textSpecific').style.display = isText ? 'block' : 'none';
    // 线条/曲线的描边由专属面板控制，禁用通用描边控件避免“无效控件”
    ['strokeColor', 'strokeWidth', 'strokeStyle'].forEach(id => { $(id).disabled = isLine || isCurve; });

    if (isLine || isCurve) {
        $('linePanelTitle').textContent = isCurve ? '曲线样式' : '线条样式';
        $('lineStyleSeg').classList.toggle('no-wavy', isCurve);
        syncLineStyleSeg(el.line.style);
        $('lineWidthRange').value = el.line.width;
        $('lineWidthInput').value = el.line.width;
        $('wavyAmpRange').value = el.line.wavyAmp;
        $('wavyAmpInput').value = el.line.wavyAmp;
        $('wavyControlRow').style.display = el.line.style === 'wavy' ? 'flex' : 'none';
        $('wavyDashRow').style.display = el.line.style === 'wavy' ? 'flex' : 'none';
        syncWavyDashSeg(el.line.dash);
        $('elColorInput').value = el.line.color;
        $('elColorHex').value = el.line.color.toUpperCase();
    }
    if (typeof updateCurveNodePanel === 'function') updateCurveNodePanel(isCurve ? el : null);
    if (isText) {
        const t = el.text;
        $('fontSizeInput').value = t.fontSize;
        $('lineHeightInput').value = t.lineHeight;
        $('letterSpacingInput').value = t.letterSpacing;
        const match = `${t.fontFamily}|${t.fontWeight}`;
        const sel = $('fontFamilyInput');
        let found = Array.from(sel.options).some(o => o.value === match);
        if (!found) found = Array.from(sel.options).some(o => o.value === `${t.fontFamily}|400`);
        if (found) sel.value = Array.from(sel.options).find(o => o.value === match || o.value === `${t.fontFamily}|400`).value;
        else sel.selectedIndex = 0;
        $('btnBold').classList.toggle('active', t.fontWeight >= 700);
        $('btnItalic').classList.toggle('active', t.runs.some(r => r.italic));
        $('btnUnderline').classList.toggle('active', t.runs.some(r => r.underline));
        ['left', 'center', 'right', 'justify'].forEach(a => $('btnAlign' + a[0].toUpperCase() + a.slice(1)).classList.toggle('active', t.align === a));
        $('textSizeMode').value = t.sizeMode || 'fixed';
        $('fontWeightInput').value = String(t.fontWeight);
        updateTextStats(el);
    }
}
function updateUI() {
    const n = state.selection.length;
    $('selectionPanel').style.display = n > 0 ? 'block' : 'none';
    $('emptyHint').style.display = n > 0 ? 'none' : 'block';
    const ehTitle = $('emptyHint').querySelector('.empty-title');
    const ehDesc = $('emptyHint').querySelector('.empty-desc');
    if (n === 0 && state.guideSel) {
        ehTitle.textContent = '辅助线已选中';
        ehDesc.textContent = '拖动移动 · 拖回标尺或 Delete 删除 · 双击或浮控输入角度旋转';
    } else {
        ehTitle.textContent = '未选中元素';
        ehDesc.textContent = '从左侧工具架插入元素，或点击画布上的元素开始编辑';
    }
    $('alignTools').style.display = n > 0 ? 'flex' : 'none';
    $('distributeTools').style.display = n >= 3 ? 'flex' : 'none';
    $('booleanTools').style.display = n > 1 ? 'flex' : 'none';
    $('groupTools').style.display = n > 0 ? 'flex' : 'none';
    $('selCountBadge').textContent = n;
    if (typeof refreshStudioUI === 'function') refreshStudioUI();
    if (!n) return;
    const allLocked = selectedEls().every(e => e.locked);
    setIcon($('btnLockToggle'), allLocked ? 'lock' : 'unlock');
    $('singlePropControls').style.display = n === 1 ? 'block' : 'none';
    if (n === 1) {
        updatePropPanel(getEl(state.selection[0]));
    } else {
        // 多选时彻底隐藏单选专属面板，避免残留上一次的状态
        $('lineSpecific').style.display = 'none';
        $('textSpecific').style.display = 'none';
        $('appearanceBlock').style.display = 'block';
        $('elBgType').disabled = false;
    }
    if (typeof syncStyleControls === 'function') syncStyleControls();
}

/* ==================== 13. 交互（Pointer Events + rAF） ==================== */
function clientToWorld(clientX, clientY) {
    const vr = viewportRect();
    return {
        x: (clientX - vr.left - state.pan.x) / state.zoom,
        y: (clientY - vr.top - state.pan.y) / state.zoom
    };
}
/** 世界坐标 → 元素未旋转局部坐标（含自定义枢轴补偿） */
function worldToLocalPoint(el, world) {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const P = pivotWorld(el);
    const dx = world.x - P.x, dy = world.y - P.y;
    return { x: el.pivotX * el.w + dx * cos + dy * sin, y: el.pivotY * h - dx * sin + dy * cos };
}
/** 局部像素坐标 → 曲线比例坐标 */
function curveNorm(el, loc) {
    return {
        x: clamp(round3(loc.x / Math.max(1, el.w)), -3, 4),
        y: clamp(round3(loc.y / Math.max(1, el.h)), -3, 4)
    };
}
/** 平滑节点：让两侧控制柄共线（保留各自长度） */
function smoothNodeHandles(el, i) {
    const n = el.curve.nodes[i];
    const hasIn = curveNodeHasIn(n), hasOut = curveNodeHasOut(n);
    if (hasOut && hasIn) {
        const lo = Math.hypot(n.ox - n.x, n.oy - n.y);
        const li = Math.hypot(n.ix - n.x, n.iy - n.y);
        if (lo < 1e-6) return;
        const ux = (n.ox - n.x) / lo, uy = (n.oy - n.y) / lo;
        n.ix = clamp(round3(n.x - ux * li), -3, 4);
        n.iy = clamp(round3(n.y - uy * li), -3, 4);
    } else if (hasOut) {
        n.ix = clamp(round3(n.x * 2 - n.ox), -3, 4);
        n.iy = clamp(round3(n.y * 2 - n.oy), -3, 4);
    } else if (hasIn) {
        n.ox = clamp(round3(n.x * 2 - n.ix), -3, 4);
        n.oy = clamp(round3(n.y * 2 - n.iy), -3, 4);
    }
}
/** 拖动一侧控制柄后，另一侧保持共线（平滑节点），保留其原长度 */
function mirrorCurveHandle(n, moved) {
    if (n.t === 'cusp') return;
    const lIn = Math.hypot(n.ix - n.x, n.iy - n.y);
    const lOut = Math.hypot(n.ox - n.x, n.oy - n.y);
    const vx = moved === 'out' ? n.ox - n.x : n.ix - n.x;
    const vy = moved === 'out' ? n.oy - n.y : n.iy - n.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return;
    const target = (moved === 'out' ? lIn : lOut) > 1e-6 ? (moved === 'out' ? lIn : lOut) : len;
    const ux = -vx / len, uy = -vy / len;
    if (moved === 'out') {
        n.ix = clamp(round3(n.x + ux * target), -3, 4);
        n.iy = clamp(round3(n.y + uy * target), -3, 4);
    } else {
        n.ox = clamp(round3(n.x + ux * target), -3, 4);
        n.oy = clamp(round3(n.y + uy * target), -3, 4);
    }
}
function showSizeTooltip(x, y, w, h) {
    const t = $('sizeTooltip');
    t.style.display = 'block';
    t.style.left = (x + 15) + 'px'; t.style.top = (y + 15) + 'px';
    t.textContent = `W:${w} H:${h}`;
}
function showAngleTooltip(x, y, deg) {
    const t = $('sizeTooltip');
    t.style.display = 'block';
    t.style.left = (x + 15) + 'px'; t.style.top = (y + 15) + 'px';
    const norm = ((Math.round(deg) % 360) + 360) % 360;
    t.textContent = `∠ ${norm}°`;
}
function hideSizeTooltip() { $('sizeTooltip').style.display = 'none'; }
/** 旋转时在视口上绘制：枢轴→指针参考线 + 角度弧 + 度数标签（屏幕坐标） */
function drawRotateGuide(it, clientX, clientY, delta, shown) {
    const layer = $('guidesLayer');
    if (!layer) return;
    layer.textContent = '';
    const vr = viewportRect();
    const px = state.pan.x + it.center.x * state.zoom;
    const py = state.pan.y + it.center.y * state.zoom;
    const mx = clientX - vr.left, my = clientY - vr.top;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rotate-guide');
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', px); line.setAttribute('y1', py);
    line.setAttribute('x2', mx); line.setAttribute('y2', my);
    svg.appendChild(line);
    const r = 34;
    const a0 = it.startAngle, a1 = a0 + delta * Math.PI / 180;
    const large = Math.abs(delta) > 180 ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', `M ${px + r * Math.cos(a0)} ${py + r * Math.sin(a0)} A ${r} ${r} 0 ${large} ${sweep} ${px + r * Math.cos(a1)} ${py + r * Math.sin(a1)}`);
    svg.appendChild(arc);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('r', 4);
    svg.appendChild(dot);
    const label = document.createElementNS(SVG_NS, 'text');
    const norm = ((Math.round(shown === undefined ? delta : shown) % 360) + 360) % 360;
    label.setAttribute('x', px + 10); label.setAttribute('y', py - 10);
    label.textContent = norm + '°';
    svg.appendChild(label);
    layer.appendChild(svg);
}

function initCanvasInteraction() {
    const viewport = $('viewport');
    viewport.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        adjustZoom(e.deltaY > 0 ? -0.1 : 0.1, e.clientX, e.clientY);
    }, { passive: false });

    window.addEventListener('pointerdown', onPointerDown);
    // 从标尺拖出辅助线：上标尺→水平线，左标尺→垂直线；拖回标尺放弃/删除
    [['rulerH', 0], ['rulerV', 90]].forEach(([id, angle]) => {
        $(id).addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (state.settings.guideLines === false) {
                state.settings.guideLines = true;
                saveSettings();
                setToggleButton('btnGuideLines', true);
            }
            const world = clientToWorld(e.clientX, e.clientY);
            const g = {
                id: 'gd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                angle, x: round2(world.x), y: round2(world.y)
            };
            state.model.guides.push(g);
            selectGuide(g.id);
            state.interaction = { kind: 'guidemove', id: g.id, start: world, ox: g.x, oy: g.y, deleteHint: false };
            drawGuides(); drawMeasure();
            if (!state.guideTipShown) {
                state.guideTipShown = true;
                toast('辅助线：拖动移动；双击或选中后输入角度旋转；拖回标尺或按 Delete 删除', 'success');
            }
        });
    });
    window.addEventListener('dblclick', e => {
        if (state.tool === 'bucket') { e.preventDefault(); return; }
        if (state.tool === 'pen' && state.pen) { finishPen(false); e.preventDefault(); return; }
        const gn = e.target.closest && e.target.closest('.guide-line');
        if (gn) {
            selectGuide(gn.dataset.id);
            const inp = document.querySelector('#guideCtrl .gc-angle');
            if (inp) { inp.focus(); inp.select(); }
            e.preventDefault();
            return;
        }
        if (e.target.closest && e.target.closest('.pivot-handle')) {
            const d = e.target.closest('.canvas-element');
            const el = d && getEl(d.dataset.id);
            if (el && !el.locked) {
                if (el.type === 'text') startTextEdit(el);
                else resetPivot();
                e.preventDefault();
            }
            return;
        }
        const d = e.target.closest && e.target.closest('.canvas-element');
        if (!d) return;
        const el = getEl(d.dataset.id);
        if (!el) return;
        if (el.type === 'curve' && !el.locked && handleCurveDoubleTap(el, e)) { e.preventDefault(); return; }
        handleDoubleTap(el);
    });
    window.addEventListener('pointermove', e => {
        pendingPointer = e;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; onPointerMove(pendingPointer); });
    });
    window.addEventListener('pointerup', endInteraction);
    window.addEventListener('pointercancel', endInteraction);
    window.addEventListener('blur', () => { state.spaceDown = false; endInteraction(); });
}

function handleDoubleTap(el) {
    if (el.locked) return;
    if (el.type === 'text') startTextEdit(el);
    else if (el.type === 'curve') {
        if (state.selection.length !== 1) setSelection([el.id]);
        toast('双击线段插入节点，双击节点删除；右侧「节点编辑」可闭合/断开、平滑/尖角', 'success');
    }
    else if (el.type === 'line') toast('在右侧「线条样式」中切换实线 / 虚线 / 点线 / 波浪', 'success');
    else openCropModal(el.id);
}
/** 曲线双击：线段上加点，节点上删点 */
function handleCurveDoubleTap(el, e) {
    const nodeDiv = e.target.closest && e.target.closest('.curve-node');
    if (nodeDiv) {
        const i = Number(nodeDiv.dataset.i);
        if (state.selection.length !== 1) setSelection([el.id]);
        removeCurveNode(el, i);
        return true;
    }
    const loc = worldToLocalPoint(el, clientToWorld(e.clientX, e.clientY));
    const hit = curveSegHit(el, loc, 9 / state.zoom);
    if (hit) {
        if (state.selection.length !== 1) setSelection([el.id]);
        insertCurveNode(el, hit.a, hit.b, hit.t);
        return true;
    }
    return false;
}
function isChromeUI(target) {
    return !!(target.closest && (target.closest('.topbar') || target.closest('.contextbar') ||
        target.closest('.tool-rail') || target.closest('.inspector') || target.closest('.statusbar') ||
        target.closest('.modal') || target.closest('.toast') || target.closest('.ruler') ||
        target.closest('.measure-tag') || target.closest('.guide-ctrl')));
}
function onPointerDown(e) {
    if (e.button !== 0) return;
    const target = e.target;
    // 颜料桶下尺寸标注浮层不拦截点击，交由 bucketHitElement 穿透到下方元素
    const bucketMeasure = state.tool === 'bucket' && target.closest && target.closest('.measure-tag');
    if (!bucketMeasure && isChromeUI(target)) return;   // 点击面板不退出编辑态

    const guideNode = target.closest('.guide-line');
    if (guideNode) {
        const g = (state.model.guides || []).find(x => x.id === guideNode.dataset.id);
        if (!g) return;
        selectGuide(g.id);
        const world = clientToWorld(e.clientX, e.clientY);
        state.interaction = { kind: 'guidemove', id: g.id, start: world, ox: g.x, oy: g.y, deleteHint: false };
        e.preventDefault(); return;
    }

    if (!target.closest('.canvas-element') && state.isTextEditing) finishTextEdit();

    if (state.layerPick) {
        const d = target.closest('.canvas-element');
        if (d) { handleLayerPick(d.dataset.id); e.stopPropagation(); return; }
        endRelLayer(); return;
    }
    if (state.spaceDown || state.tool === 'pan') {
        state.interaction = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
        $('viewport').classList.add('panning');
        e.preventDefault(); return;
    }
    if (state.tool === 'bucket') {
        if (state.isTextEditing) finishTextEdit();
        const hit = bucketHitElement(e.clientX, e.clientY, e.target);
        const target = bucketDetectTarget(hit, e.clientX, e.clientY, e);
        if (e.altKey) {
            if (hit) {
                const c = target === 'stroke'
                    ? (hit.line ? hit.line.color : (hit.stroke ? hit.stroke.color : hit.fill.color))
                    : hit.fill.color;
                useColor(c);
                setBucketColor(target, c);
                toast('已吸取' + bucketSlotLabel(target) + '色 ' + c.toUpperCase(), 'success');
            }
            e.preventDefault(); return;
        }
        const painted = new Set();
        if (hit && applyBucketColor(hit, target, bucketColor(target))) {
            painted.add(hit.id);
            setSelection([hit.id]);
        }
        state.interaction = { kind: 'bucketpaint', painted };
        e.preventDefault(); return;
    }
    if (state.tool === 'pen') {
        if (state.isTextEditing) finishTextEdit();
        penPointerDown(e);
        e.preventDefault(); return;
    }
    if (state.tool === 'text') {
        const td = target.closest('.canvas-element');
        if (td) {
            const tel = getEl(td.dataset.id);
            if (tel && tel.type === 'text' && !tel.locked) {
                setSelection([tel.id]); setTool('select'); startTextEdit(tel);
                e.preventDefault(); return;
            }
        } else if (target === $('canvas') || target === $('viewport') || target === $('transformLayer')) {
            const world = clientToWorld(e.clientX, e.clientY);
            state.interaction = { kind: 'textcreate', start: world, current: world };
            const box = $('selectionBox');
            box.style.display = 'block';
            box.style.left = world.x + 'px'; box.style.top = world.y + 'px';
            box.style.width = '0px'; box.style.height = '0px';
            e.preventDefault(); return;
        }
    }

    const resizer = target.closest('.resizer');
    const rotator = target.closest('.rotator');
    const pivotH = target.closest('.pivot-handle');
    const ctrlH = target.closest('.curve-ctrl');
    const nodeH = target.closest('.curve-node');
    const d = target.closest('.canvas-element');

    if (pivotH && d) {
        const el = getEl(d.dataset.id);
        if (!el || el.locked) return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const h = el.type === 'line' ? lineHeightFor(el) : el.h;
        state.interaction = {
            kind: 'pivot', id: el.id, w: el.w, h,
            x: el.x, y: el.y, fx: el.pivotX, fy: el.pivotY, rotation: el.rotation
        };
        pivotH.classList.add('dragging');
        d.classList.add('pivot-peek');
        clearTimeout(d._peekTimer);
        e.preventDefault(); return;
    }
    if (ctrlH && d) {
        const el = getEl(d.dataset.id);
        if (!el || el.locked || el.type !== 'curve') return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        state.nodeSel = { id: el.id, i: Number(ctrlH.dataset.i) };
        state.interaction = { kind: 'cctrl', id: el.id, i: Number(ctrlH.dataset.i), h: ctrlH.dataset.h };
        ctrlH.classList.add('dragging');
        syncElement(el.id);
        e.preventDefault(); return;
    }
    if (nodeH && d) {
        const el = getEl(d.dataset.id);
        if (!el || el.locked || el.type !== 'curve') return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const i = Number(nodeH.dataset.i);
        const n = el.curve.nodes[i];
        if (!n) return;
        if (e.ctrlKey || e.metaKey) {
            n.t = n.t === 'cusp' ? 'smooth' : 'cusp';
            if (n.t === 'smooth') smoothNodeHandles(el, i);
            state.nodeSel = { id: el.id, i };
            syncElement(el.id);
            updateCurveNodePanel(el);
            commit();
            e.preventDefault(); return;
        }
        state.nodeSel = { id: el.id, i };
        state.interaction = {
            kind: 'cnode', id: el.id, i,
            start: clientToWorld(e.clientX, e.clientY),
            ox: n.x, oy: n.y
        };
        nodeH.classList.add('dragging');
        syncElement(el.id);
        e.preventDefault(); return;
    }
    if (resizer && d) {
        const el = getEl(d.dataset.id);
        if (!el || el.locked) return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const box = selectionAABB();
        state.interaction = {
            kind: 'resize', dir: resizer.dataset.dir, startX: e.clientX, startY: e.clientY,
            box, items: selectedEls().filter(x => !x.locked).map(x => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h }))
        };
        e.preventDefault(); return;
    }
    if (rotator && d) {
        const el = getEl(d.dataset.id);
        if (!el || el.locked) return;
        if (!state.selection.includes(el.id)) setSelection([el.id]);
        const box = selectionAABB();
        const items = selectedEls().filter(x => !x.locked);
        // 单选围绕自身枢轴旋转；多选围绕选区中心旋转
        const center = items.length === 1 ? pivotWorld(items[0]) : { x: box.cx, y: box.cy };
        items.forEach(x => { const n = nodeMap.get(x.id); if (n) { n.classList.add('pivot-peek'); clearTimeout(n._peekTimer); } });
        const vr = viewportRect();
        state.interaction = {
            kind: 'rotate', box, center, single: items.length === 1,
            startAngle: Math.atan2(e.clientY - (vr.top + state.pan.y + center.y * state.zoom), e.clientX - (vr.left + state.pan.x + center.x * state.zoom)),
            items: items.map(x => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, rotation: x.rotation, pivotX: x.pivotX, pivotY: x.pivotY }))
        };
        e.preventDefault(); return;
    }
    if (d) {
        const id = d.dataset.id;
        if (state.isTextEditing && state.editingId === id) return;
        if (state.isTextEditing) finishTextEdit();
        if (e.altKey) {
            state.selection = state.selection.filter(x => x !== id);
            applySelectionClasses(); updateUI();
        } else {
            toggleSelection(id, e.ctrlKey || e.metaKey);
        }
        const movable = selectedEls().filter(x => !x.locked);
        if (movable.length) {
            state.interaction = {
                kind: 'drag', startX: e.clientX, startY: e.clientY,
                items: movable.map(x => ({ id: x.id, x: x.x, y: x.y }))
            };
        }
        e.preventDefault(); return;
    }

    // 空白处：框选
    if (target === $('canvas') || target === $('viewport') || target === $('transformLayer') || target.id === 'selectionBox') {
        const world = clientToWorld(e.clientX, e.clientY);
        state.boxCache = sortedElements().map(el => ({ id: el.id, a: getAABB(el) }));
        state.interaction = {
            kind: 'box', start: world, additive: e.ctrlKey || e.metaKey, subtractive: e.altKey,
            initial: state.selection.slice(), current: world
        };
        if (!state.interaction.additive && !state.interaction.subtractive) deselectAll();
        const box = $('selectionBox');
        box.style.display = 'block';
        box.style.left = world.x + 'px'; box.style.top = world.y + 'px';
        box.style.width = '0px'; box.style.height = '0px';
        e.preventDefault();
    }
}
function onPointerMove(e) {
    if (!e) return;
    const it = state.interaction;
    if (!it) {
        if (state.tool === 'bucket') { updateBucketHover(e); return; }
        if (state.tool === 'pen' && state.pen) {
            const w = penPointFromEvent(e);
            const pen = state.pen;
            const last = pen.nodes[pen.nodes.length - 1];
            if (last && (Math.abs(w.x - pen.cursor.x) > 0.2 || Math.abs(w.y - pen.cursor.y) > 0.2)) {
                pen.cursor = w;
                renderPenDraft();
            }
        }
        return;
    }
    if (it.kind === 'pan') {
        state.pan.x += e.clientX - it.lastX;
        state.pan.y += e.clientY - it.lastY;
        it.lastX = e.clientX; it.lastY = e.clientY;
        syncTransform(); return;
    }
    if (it.kind === 'textcreate') {
        const cur = clientToWorld(e.clientX, e.clientY);
        it.current = cur;
        const box = $('selectionBox');
        box.style.left = Math.min(it.start.x, cur.x) + 'px';
        box.style.top = Math.min(it.start.y, cur.y) + 'px';
        box.style.width = Math.abs(cur.x - it.start.x) + 'px';
        box.style.height = Math.abs(cur.y - it.start.y) + 'px';
        return;
    }
    if (it.kind === 'box') {
        const cur = clientToWorld(e.clientX, e.clientY);
        it.current = cur;
        const left = Math.min(it.start.x, cur.x), top = Math.min(it.start.y, cur.y);
        const w = Math.abs(cur.x - it.start.x), h = Math.abs(cur.y - it.start.y);
        const box = $('selectionBox');
        box.style.left = left + 'px'; box.style.top = top + 'px';
        box.style.width = w + 'px'; box.style.height = h + 'px';
        const rect = { left, top, right: left + w, bottom: top + h };
        let ids = it.initial.slice();
        state.boxCache.forEach(o => {
            const a = o.a;
            const hit = !(rect.right < a.left || rect.left > a.right || rect.bottom < a.top || rect.top > a.bottom);
            if (!hit) return;
            if (it.subtractive) ids = ids.filter(id => id !== o.id);
            else if (!ids.includes(o.id)) ids.push(o.id);
        });
        state.selection = ids;
        applySelectionClasses();
        $('selCountBadge').textContent = ids.length;
        return;
    }
    if (it.kind === 'bucketpaint') {
        const el = bucketHitElement(e.clientX, e.clientY);
        if (el && !it.painted.has(el.id)) {
            const t = bucketDetectTarget(el, e.clientX, e.clientY, e);
            if (applyBucketColor(el, t, bucketColor(t))) it.painted.add(el.id);
        }
        updateBucketHover(e);
        return;
    }
    if (it.kind === 'pendrag') {
        penDragMove(e);
        return;
    }
    if (it.kind === 'guidemove') {
        const g = (state.model.guides || []).find(x => x.id === it.id);
        if (!g) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const { n } = guideGeom(g);
        const d = n.x * (world.x - it.start.x) + n.y * (world.y - it.start.y);
        g.x = round2(it.ox + n.x * d);
        g.y = round2(it.oy + n.y * d);
        it.deleteHint = isOverRuler(e.clientX, e.clientY);
        drawGuides();
        drawMeasure();
        return;
    }
    if (it.kind === 'drag') {
        const dx = (e.clientX - it.startX) / state.zoom;
        const dy = (e.clientY - it.startY) / state.zoom;
        let mx = dx, my = dy;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; }
        // N3：智能吸附（画布中心/边缘 + 其他元素边缘/中心）
        if (!e.altKey && typeof applyDragSnap === 'function') {
            const snapped = applyDragSnap(it, mx, my);
            mx = snapped.mx; my = snapped.my;
            drawSnapGuides(snapped.guides);
        }
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            el.x = round2(o.x + mx); el.y = round2(o.y + my);
            syncElement(el.id);
        });
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        if (typeof drawMeasure === 'function') drawMeasure();
        return;
    }
    if (it.kind === 'resize') {
        const dx = (e.clientX - it.startX) / state.zoom;
        const dy = (e.clientY - it.startY) / state.zoom;
        const b = it.box;
        let left = b.left, top = b.top, right = b.right, bottom = b.bottom;
        if (it.dir.includes('w')) left += dx;
        if (it.dir.includes('e')) right += dx;
        if (it.dir.includes('n')) top += dy;
        if (it.dir.includes('s')) bottom += dy;
        if (right - left < 8) { if (it.dir.includes('w')) left = right - 8; else right = left + 8; }
        if (bottom - top < 8) { if (it.dir.includes('n')) top = bottom - 8; else bottom = top + 8; }
        let sx = (right - left) / Math.max(1, b.w), sy = (bottom - top) / Math.max(1, b.h);
        if (e.shiftKey) { const s = Math.max(sx, sy); sx = s; sy = s; }
        const ax = it.dir.includes('w') ? b.right : b.left;
        const ay = it.dir.includes('n') ? b.bottom : b.top;
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            el.x = round2(ax + (o.x - ax) * sx);
            el.y = round2(ay + (o.y - ay) * sy);
            el.w = round2(Math.max(1, o.w * sx));
            el.h = round2(Math.max(1, o.h * sy));
            syncElement(el.id);
        });
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        showSizeTooltip(e.clientX, e.clientY, Math.round((right - left)), Math.round((bottom - top)));
        if (typeof drawMeasure === 'function') drawMeasure();
        return;
    }
    if (it.kind === 'rotate') {
        const vr = viewportRect();
        const cx = vr.left + state.pan.x + it.center.x * state.zoom;
        const cy = vr.top + state.pan.y + it.center.y * state.zoom;
        const cur = Math.atan2(e.clientY - cy, e.clientX - cx);
        let delta = (cur - it.startAngle) * 180 / Math.PI;
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        const rad = delta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        it.items.forEach(o => {
            const el = getEl(o.id); if (!el) return;
            const hh = el.type === 'line' ? lineHeightFor(el) : el.h;
            // 围绕旋转中心转动每个元素的枢轴，再反推元素左上角，兼容任意自定义枢轴
            const pxw = o.x + o.pivotX * o.w, pyw = o.y + o.pivotY * hh;
            const nx = it.center.x + (pxw - it.center.x) * cos - (pyw - it.center.y) * sin;
            const ny = it.center.y + (pxw - it.center.x) * sin + (pyw - it.center.y) * cos;
            el.x = round2(nx - o.pivotX * o.w);
            el.y = round2(ny - o.pivotY * hh);
            el.rotation = round2(o.rotation + delta);
            syncElement(el.id);
        });
        if (it.items.length === 1) syncGeoInputs(getEl(it.items[0].id));
        const shown = it.single ? getEl(it.items[0].id).rotation : delta;
        showAngleTooltip(e.clientX, e.clientY, shown);
        drawRotateGuide(it, e.clientX, e.clientY, delta, shown);
        if (typeof drawMeasure === 'function') drawMeasure();
        return;
    }
    if (it.kind === 'pivot') {
        const el = getEl(it.id); if (!el) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const rad = it.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        // 以交互起点为基准：指针世界坐标 → 元素未旋转局部坐标，图形保持原位
        const P1x = it.x + it.fx * it.w, P1y = it.y + it.fy * it.h;
        const dx = world.x - P1x, dy = world.y - P1y;
        let lx = it.fx * it.w + dx * cos + dy * sin;
        let ly = it.fy * it.h - dx * sin + dy * cos;
        let fx = lx / it.w, fy = ly / it.h;
        // 靠近九宫格锚点时自动吸附
        const thr = 8 / state.zoom;
        [0, 0.5, 1].forEach(a => {
            if (Math.abs(fx - a) * it.w < thr) fx = a;
            if (Math.abs(fy - a) * it.h < thr) fy = a;
        });
        setPivot(el, fx, fy, true);
        syncElement(el.id);
        syncGeoInputs(el);
        if (typeof drawMeasure === 'function') drawMeasure();
        return;
    }
    if (it.kind === 'cnode') {
        const el = getEl(it.id); if (!el || !el.curve) return;
        const n = el.curve.nodes[it.i]; if (!n) return;
        const world = clientToWorld(e.clientX, e.clientY);
        const loc = worldToLocalPoint(el, world);
        const sLoc = worldToLocalPoint(el, it.start);
        let dx = loc.x - sLoc.x, dy = loc.y - sLoc.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const nx = clamp(round3(it.ox + dx / el.w), -3, 4);
        const ny = clamp(round3(it.oy + dy / el.h), -3, 4);
        const mx = nx - n.x, my = ny - n.y;
        n.x = nx; n.y = ny;
        n.ix = clamp(round3(n.ix + mx), -3, 4); n.iy = clamp(round3(n.iy + my), -3, 4);
        n.ox = clamp(round3(n.ox + mx), -3, 4); n.oy = clamp(round3(n.oy + my), -3, 4);
        syncElement(el.id);
        syncGeoInputs(el);
        drawMeasure();
        return;
    }
    if (it.kind === 'cctrl') {
        const el = getEl(it.id); if (!el || !el.curve) return;
        const n = el.curve.nodes[it.i]; if (!n) return;
        const world = clientToWorld(e.clientX, e.clientY);
        let loc = worldToLocalPoint(el, world);
        if (e.shiftKey) {
            // 控制柄方向 15° 吸附
            const vx = loc.x - n.x * el.w, vy = loc.y - n.y * el.h;
            let ang = Math.atan2(vy, vx);
            const step = Math.PI / 12;
            ang = Math.round(ang / step) * step;
            const len = Math.hypot(vx, vy);
            loc = { x: n.x * el.w + Math.cos(ang) * len, y: n.y * el.h + Math.sin(ang) * len };
        }
        const p = curveNorm(el, loc);
        if (it.h === 'out') { n.ox = p.x; n.oy = p.y; }
        else { n.ix = p.x; n.iy = p.y; }
        if (!e.altKey) mirrorCurveHandle(n, it.h);
        else n.t = 'cusp';
        syncElement(el.id);
        return;
    }
}
function endInteraction() {
    const it = state.interaction;
    if (!it || it.kind === 'crop') return;   // 裁剪框交互由裁剪器自行收尾，不提交画布历史
    if (it.kind === 'textcreate') {
        $('selectionBox').style.display = 'none';
        state.interaction = null;
        createTextFromRect(it.start, it.current || it.start);
    } else if (it.kind === 'box') {
        $('selectionBox').style.display = 'none';
        state.boxCache = null;
        state.selection = state.selection.filter(id => !!getEl(id));
        updateUI();
    } else if (it.kind === 'guidemove') {
        // 拖回标尺 = 删除（含刚拖出又放弃的情况）
        if (it.deleteHint) deleteGuide(it.id, true);
        commit();
        drawGuides();
    } else if (it.kind === 'bucketpaint') {
        if (it.painted.size) {
            const sel = state.selection.length === 1 ? getEl(state.selection[0]) : null;
            if (sel && it.painted.has(sel.id)) updatePropPanel(sel);
            commit();
            toast(`已为 ${it.painted.size} 个元素上色（按位置识别填充 / 描边）`, 'success');
        }
    } else if (it.kind === 'pendrag') {
        // 钢笔取点结束：草稿仍在，等下一次点击或结束命令
    } else if (it.kind !== 'pan') {
        // 手动缩放后文本退出自动尺寸，避免下一帧又被内容撑回去
        if (it.kind === 'resize') {
            selectedEls().forEach(x => {
                if (x.type === 'text' && x.text.sizeMode !== 'fixed') { x.text.sizeMode = 'fixed'; syncElement(x.id); }
            });
            if (state.selection.length === 1) updatePropPanel(getEl(state.selection[0]));
        }
        if (it.kind === 'cnode' || it.kind === 'cctrl') updateCurveNodePanel(getEl(it.id));
        commit();
    }
    hideSizeTooltip();
    document.querySelectorAll('.pivot-handle.dragging, .curve-node.dragging, .curve-ctrl.dragging').forEach(n => n.classList.remove('dragging'));
    const endedKind = state.interaction ? state.interaction.kind : null;
    document.querySelectorAll('.canvas-element.pivot-peek').forEach(n => {
        // 交互结束但指针仍停在元素上时延迟收起，便于继续调整枢轴
        if (endedKind && n.matches(':hover') && n._hidePeekLater) n._hidePeekLater();
        else n.classList.remove('pivot-peek');
    });
    $('viewport').classList.remove('panning');
    state.interaction = null;
    if (typeof clearSnapGuides === 'function') clearSnapGuides();
    if (typeof refreshStudioUI === 'function') refreshStudioUI();
}
/* -------------------- 曲线：节点编辑（增删 / 平滑 / 闭合 / 适配） -------------------- */
function curveSelectedIndex(el) {
    if (!el || !el.curve) return 0;
    const n = el.curve.nodes.length;
    const i = state.nodeSel && state.nodeSel.id === el.id ? state.nodeSel.i : 0;
    return clamp(i, 0, Math.max(0, n - 1));
}
/** 线段列表：[起点索引, 终点索引]，闭合路径含末→首段 */
function curveSegments(el) {
    const n = el.curve.nodes.length;
    const segs = [];
    for (let i = 1; i < n; i++) segs.push([i - 1, i]);
    if (el.curve.closed && n > 1) segs.push([n - 1, 0]);
    return segs;
}
/** 命中测试：返回最近的线段与参数 t（局部像素坐标） */
function curveSegHit(el, loc, tol) {
    let best = null;
    curveSegments(el).forEach(([a, b]) => {
        const pts = curveSegPts(el.curve.nodes, a, b, el.w, el.h);
        for (let s = 0; s <= 48; s++) {
            const t = s / 48;
            const p = cubicAt(pts[0], pts[1], pts[2], pts[3], t);
            const d = Math.hypot(p.x - loc.x, p.y - loc.y);
            if (!best || d < best.d) best = { d, a, b, t };
        }
    });
    return best && best.d <= tol ? best : null;
}
/** 在指定线段的 t 处插入节点（De Casteljau 分割，形状不变） */
function insertCurveNode(el, a, b, t) {
    const nodes = el.curve.nodes;
    const A = nodes[a], B = nodes[b];
    if (!A || !B) return;
    const px = p => ({ x: round3(p.x / Math.max(1, el.w)), y: round3(p.y / Math.max(1, el.h)) });
    const flat = !curveNodeHasOut(A) && !curveNodeHasIn(B);
    const pts = curveSegPts(nodes, a, b, el.w, el.h);
    const split = splitCubic(pts, clamp(t, 0.05, 0.95));
    const mid = px(split.mid);
    const nn = { x: mid.x, y: mid.y, ix: mid.x, iy: mid.y, ox: mid.x, oy: mid.y, t: 'smooth' };
    if (flat) {
        A.ox = A.x; A.oy = A.y;
        B.ix = B.x; B.iy = B.y;
    } else {
        const cA = px(split.left[1]), cB = px(split.right[2]);
        A.ox = clamp(cA.x, -3, 4); A.oy = clamp(cA.y, -3, 4);
        B.ix = clamp(cB.x, -3, 4); B.iy = clamp(cB.y, -3, 4);
        nn.ix = clamp(px(split.left[2]).x, -3, 4); nn.iy = clamp(px(split.left[2]).y, -3, 4);
        nn.ox = clamp(px(split.right[1]).x, -3, 4); nn.oy = clamp(px(split.right[1]).y, -3, 4);
    }
    const at = b === 0 ? nodes.length : b;
    nodes.splice(at, 0, nn);
    state.nodeSel = { id: el.id, i: at };
    renderAll();
    updateCurveNodePanel(el);
    commit();
    toast('已插入节点（形状保持不变）', 'success');
}
function removeCurveNode(el, i) {
    const nodes = el.curve.nodes;
    if (nodes.length <= 2) { toast('曲线至少保留 2 个节点', 'error'); return; }
    nodes.splice(i, 1);
    if (el.curve.closed && nodes.length < 3) el.curve.closed = false;
    state.nodeSel = { id: el.id, i: clamp(i - 1, 0, nodes.length - 1) };
    renderAll();
    updateCurveNodePanel(el);
    commit();
    toast('已删除节点', 'success');
}
/** 把元素边框收紧到路径实际范围（含控制柄），路径位置保持不动 */
function fitCurveBox(el) {
    const b = curveLocalBox(el);
    const pad = 2;
    const offX = b.left - pad, offY = b.top - pad;
    const nw = Math.max(4, round2(b.w + pad * 2)), nh = Math.max(4, round2(b.h + pad * 2));
    const oldW = el.w, oldH = el.h;
    // 局部坐标平移 off，保持形状在屏幕上的位置（兼容旋转与自定义枢轴）
    const rad = el.rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const oldPivot = pivotWorld(el);
    const plx = el.pivotX * nw, ply = el.pivotY * nh;
    const ox = offX + plx - el.pivotX * oldW;
    const oy = offY + ply - el.pivotY * oldH;
    el.x = round2(oldPivot.x + ox * cos - oy * sin - plx);
    el.y = round2(oldPivot.y + ox * sin + oy * cos - ply);
    el.curve.nodes.forEach(n => {
        n.x = clamp(round3((n.x * oldW - offX) / nw), -3, 4);
        n.y = clamp(round3((n.y * oldH - offY) / nh), -3, 4);
        n.ix = clamp(round3((n.ix * oldW - offX) / nw), -3, 4);
        n.iy = clamp(round3((n.iy * oldH - offY) / nh), -3, 4);
        n.ox = clamp(round3((n.ox * oldW - offX) / nw), -3, 4);
        n.oy = clamp(round3((n.oy * oldH - offY) / nh), -3, 4);
    });
    el.w = nw; el.h = nh;
    renderAll();
    updateCurveNodePanel(el);
    updatePropPanel(el);
    commit();
    toast('边框已收紧到路径范围', 'success');
}
function curveOp(action) {
    const el = selectedEls()[0];
    if (!el || el.type !== 'curve') { toast('请先选中一条曲线', 'error'); return; }
    if (el.locked) { toast('元素已锁定，无法编辑节点', 'error'); return; }
    const c = el.curve;
    const i = curveSelectedIndex(el);
    if (action === 'close') {
        if (c.nodes.length < 2) return;
        c.closed = true;
    } else if (action === 'open') {
        c.closed = false;
    } else if (action === 'add') {
        const segs = curveSegments(el);
        const seg = segs.find(sg => sg[0] === i) || segs[segs.length - 1];
        if (!seg) return;
        insertCurveNode(el, seg[0], seg[1], 0.5);
        return;
    } else if (action === 'del') {
        removeCurveNode(el, i);
        return;
    } else if (action === 'smooth' || action === 'cusp') {
        const n = c.nodes[i];
        if (!n) return;
        n.t = action;
        if (action === 'smooth') smoothNodeHandles(el, i);
    } else if (action === 'reverse') {
        c.nodes.reverse();
        c.nodes.forEach(n => {
            const ix = n.ix, iy = n.iy;
            n.ix = n.ox; n.iy = n.oy; n.ox = ix; n.oy = iy;
        });
        state.nodeSel = { id: el.id, i: c.nodes.length - 1 - i };
    } else if (action === 'fit') {
        fitCurveBox(el);
        return;
    }
    syncElement(el.id);
    updateCurveNodePanel(el);
    syncCurveFillControls(el);
    drawMeasure();
    commit();
    toast('路径已更新', 'success');
}
/** 同步曲线节点面板的状态 */
function updateCurveNodePanel(el) {
    const block = $('curveNodeBlock');
    if (!block) return;
    const isCurve = !!el && el.type === 'curve';
    block.style.display = isCurve ? 'block' : 'none';
    if (!isCurve) return;
    const c = el.curve, n = c.nodes.length, i = curveSelectedIndex(el);
    const info = $('curveNodeInfo');
    if (info) info.textContent = `${n} 节点 · ${c.closed ? '闭合' : '开放'} · 当前 #${i + 1}`;
    const closeBtn = $('btnCurveClose'), openBtn = $('btnCurveOpen');
    if (closeBtn) closeBtn.disabled = !!c.closed || n < 2;
    if (openBtn) openBtn.disabled = !c.closed;
    block.querySelectorAll('.text-btn[data-arg]').forEach(b => {
        const arg = b.dataset.arg;
        if (arg === 'del') b.disabled = n <= 2 || el.locked;
        else if (arg === 'smooth' || arg === 'cusp') {
            const cur = c.nodes[i];
            b.classList.toggle('active', !!cur && cur.t === arg);
        }
    });
    const hint = $('curveNodeHint');
    if (hint) hint.textContent = el.locked
        ? '元素已锁定，解锁后即可编辑节点'
        : '拖拽方块移动节点，拖拽圆形控制柄调整弧度（Alt 断开对称，Shift 15° 吸附）；双击线段加点，双击节点删点';
}

/* -------------------- 钢笔工具（贝塞尔路径绘制） -------------------- */
function penNodeAt(p) {
    return { x: round2(p.x), y: round2(p.y), ix: round2(p.x), iy: round2(p.y), ox: round2(p.x), oy: round2(p.y), t: 'smooth' };
}
function penPointFromEvent(e) {
    const w = clientToWorld(e.clientX, e.clientY);
    if (state.settings && state.settings.grid && !e.altKey) {
        const g = Math.max(1, state.settings.gridSize || 20);
        return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
    }
    return w;
}
/** 收起节点的出手柄（转为角点），使从它出发的下一段变成直线；入柄属于已画好的上一段，保持不变 */
function penCollapseOutHandle(pen, i) {
    const n = pen.nodes[i];
    if (!n) return false;
    if (Math.abs(n.ox - n.x) < 1e-6 && Math.abs(n.oy - n.y) < 1e-6) return false;
    n.ox = n.x; n.oy = n.y; n.t = 'cusp';
    return true;
}
function penPointerDown(e) {
    const world = penPointFromEvent(e);
    const pen = state.pen;
    if (!pen) {
        state.pen = { nodes: [penNodeAt(world)], cursor: world, closed: false,
            lastDown: { x: world.x, y: world.y, t: Date.now() } };
        state.interaction = { kind: 'pendrag', i: 0, sx: e.clientX, sy: e.clientY };
        renderPenDraft();
        return;
    }
    // 连点两下 = 结束当前路径
    if (pen.lastDown && Date.now() - pen.lastDown.t < 340 &&
        Math.hypot(world.x - pen.lastDown.x, world.y - pen.lastDown.y) * state.zoom < 7) {
        finishPen(false);
        return;
    }
    // 点回起点 = 闭合路径
    const first = pen.nodes[0];
    if (pen.nodes.length >= 2 && Math.hypot(world.x - first.x, world.y - first.y) * state.zoom <= 10) {
        finishPen(true);
        return;
    }
    const last = pen.nodes[pen.nodes.length - 1];
    // Alt + 点击刚放下的锚点 = 收起它的出手柄，之后下一段即为直线
    if (e.altKey && last && Math.hypot(world.x - last.x, world.y - last.y) * state.zoom <= 10) {
        if (penCollapseOutHandle(pen, pen.nodes.length - 1)) {
            state.interaction = null;
            renderPenDraft();
            toast('已收起出手柄：下一段为直线', 'success');
        }
        return;
    }
    // Alt + 落新点 = 顺带收起上一个节点的出手柄，让新生成的这一段是直线
    pen.nodes.push(penNodeAt(world));
    if (e.altKey) {
        if (penCollapseOutHandle(pen, pen.nodes.length - 2)) toast('已收起出手柄：新段为直线', 'success');
    }
    pen.lastDown = { x: world.x, y: world.y, t: Date.now() };
    state.interaction = { kind: 'pendrag', i: pen.nodes.length - 1, sx: e.clientX, sy: e.clientY };
    renderPenDraft();
}
function penDragMove(e) {
    const pen = state.pen;
    if (!pen) return;
    const it = state.interaction;
    // 4px 死区：单击时的手抖不应生成出手柄，否则下一段会意外变成曲线
    if (it && it.sx !== undefined && Math.hypot(e.clientX - it.sx, e.clientY - it.sy) < 4) return;
    const n = pen.nodes[it ? it.i : pen.nodes.length - 1];
    if (!n) return;
    let world = clientToWorld(e.clientX, e.clientY);
    let vx = world.x - n.x, vy = world.y - n.y;
    if (e.shiftKey) {
        const len = Math.hypot(vx, vy);
        const step = Math.PI / 12;
        const ang = Math.round(Math.atan2(vy, vx) / step) * step;
        vx = Math.cos(ang) * len; vy = Math.sin(ang) * len;
    }
    n.ox = round2(n.x + vx); n.oy = round2(n.y + vy);
    if (!e.altKey) { n.ix = round2(n.x - vx); n.iy = round2(n.y - vy); n.t = 'smooth'; }
    else { n.t = 'cusp'; }
    pen.cursor = world;
    renderPenDraft();
}
function cancelPen() {
    state.pen = null;
    state.interaction = null;
    renderPenDraft();
}
function finishPen(close, keepTool) {
    const pen = state.pen;
    state.pen = null;
    state.interaction = null;
    renderPenDraft();
    if (pen && pen.nodes.length >= 2) {
        const nodes = pen.nodes;
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        nodes.forEach(n => {
            [[n.x, n.y], [n.ix, n.iy], [n.ox, n.oy]].forEach(([x, y]) => {
                l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y);
            });
        });
        const pad = 4;
        const x = round2(l - pad), y = round2(t - pad);
        const w = Math.max(8, round2(r - l + pad * 2)), h = Math.max(8, round2(b - t + pad * 2));
        const el = buildElement('curve', x, y);
        el.w = w; el.h = h;
        const color = (state.settings.recentColors && state.settings.recentColors[0]) || '#1c2230';
        el.line = makeLine({ style: 'solid', width: 3, color });
        el.curve = makeCurve({
            closed: !!close,
            nodes: nodes.map(n => ({
                x: (n.x - x) / w, y: (n.y - y) / h,
                ix: (n.ix - x) / w, iy: (n.iy - y) / h,
                ox: (n.ox - x) / w, oy: (n.oy - y) / h,
                t: n.t
            }))
        });
        state.model.elements.push(el);
        renderAll();
        setSelection([el.id]);
        if (!keepTool) setTool('select');
        commit();
        toast(`已创建曲线 ${nodes.length} 个节点${close ? ' · 闭合路径，可用颜料桶 (B) 或检查器填充' : ''}`, 'success');
    } else if (!keepTool) {
        setTool('select');
    }
}
/** 草稿预览：路径 + 节点 + 控制柄 + 到指针的橡皮筋 */
function renderPenDraft() {
    const layer = $('penLayer');
    if (!layer) return;
    layer.textContent = '';
    const pen = state.pen;
    if (!pen || !pen.nodes.length) return;
    const z = state.zoom, p = state.pan;
    const X = v => round2(v * z + p.x), Y = v => round2(v * z + p.y);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const ns = pen.nodes;
    let d = `M ${X(ns[0].x)} ${Y(ns[0].y)}`;
    for (let i = 1; i < ns.length; i++) {
        d += ` C ${X(ns[i - 1].ox)} ${Y(ns[i - 1].oy)}, ${X(ns[i].ix)} ${Y(ns[i].iy)}, ${X(ns[i].x)} ${Y(ns[i].y)}`;
    }
    if (pen.closed && ns.length > 1) {
        const L = ns[ns.length - 1];
        d += ` C ${X(L.ox)} ${Y(L.oy)}, ${X(ns[0].ix)} ${Y(ns[0].iy)}, ${X(ns[0].x)} ${Y(ns[0].y)} Z`;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'pen-path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    // 橡皮筋：从最后一个节点到指针，按最后一个节点的出控制柄预览弧度
    const dragging = state.interaction && state.interaction.kind === 'pendrag';
    const last = ns[ns.length - 1];
    if (!dragging && pen.cursor && !pen.closed) {
        const rb = document.createElementNS(SVG_NS, 'path');
        rb.setAttribute('class', 'pen-rubber');
        rb.setAttribute('d', `M ${X(last.x)} ${Y(last.y)} C ${X(last.ox)} ${Y(last.oy)}, ${X(pen.cursor.x)} ${Y(pen.cursor.y)}, ${X(pen.cursor.x)} ${Y(pen.cursor.y)}`);
        svg.appendChild(rb);
    }
    // 控制柄与节点
    const tail = last;
    ['in', 'out'].forEach(k => {
        const has = k === 'in' ? curveNodeHasIn(tail) : curveNodeHasOut(tail);
        if (!has) return;
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('class', 'pen-tangent');
        ln.setAttribute('x1', X(tail.x)); ln.setAttribute('y1', Y(tail.y));
        ln.setAttribute('x2', X(k === 'in' ? tail.ix : tail.ox));
        ln.setAttribute('y2', Y(k === 'in' ? tail.iy : tail.oy));
        svg.appendChild(ln);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'pen-handle');
        dot.setAttribute('cx', X(k === 'in' ? tail.ix : tail.ox));
        dot.setAttribute('cy', Y(k === 'in' ? tail.iy : tail.oy));
        dot.setAttribute('r', 3.2);
        svg.appendChild(dot);
    });
    ns.forEach((n, i) => {
        const sq = document.createElementNS(SVG_NS, 'rect');
        sq.setAttribute('class', 'pen-node' + (i === 0 ? ' first' : ''));
        sq.setAttribute('x', X(n.x) - 3.5);
        sq.setAttribute('y', Y(n.y) - 3.5);
        sq.setAttribute('width', 7);
        sq.setAttribute('height', 7);
        sq.setAttribute('rx', 1.5);
        svg.appendChild(sq);
    });
    layer.appendChild(svg);
}

function createTextFromRect(a, b) {
    const dragged = Math.abs(b.x - a.x) > 8 || Math.abs(b.y - a.y) > 8;
    const el = buildElement('text', 0, 0);
    el.x = round2(Math.min(a.x, b.x));
    el.y = round2(Math.min(a.y, b.y));
    if (dragged) {
        el.w = round2(Math.max(40, Math.abs(b.x - a.x)));
        el.h = round2(Math.max(el.text.fontSize * el.text.lineHeight, Math.abs(b.y - a.y)));
        el.text.sizeMode = 'fixed';
    } else {
        el.w = 20;
        el.h = round2(el.text.fontSize * el.text.lineHeight);
        el.text.sizeMode = 'autoWH';
    }
    state.model.elements.push(el);
    renderAll();
    setSelection([el.id]);
    setTool('select');
    commit();
    startTextEdit(el);
}
function syncGeoInputs(el) {
    if (!el) return;
    $('geoX').value = Math.round(el.x);
    $('geoY').value = Math.round(el.y);
    $('geoW').value = Math.round(el.w);
    $('geoH').value = Math.round(el.type === 'line' ? lineHeightFor(el) : el.h);
    $('geoR').value = Math.round(el.rotation);
    syncPivotInputs(el);
}
function syncPivotInputs(el) {
    if (!el) return;
    $('pivotXInput').value = Math.round(el.pivotX * 100);
    $('pivotYInput').value = Math.round(el.pivotY * 100);
}
function syncLineStyleSeg(style) {
    document.querySelectorAll('#lineStyleSeg .line-style-btn').forEach(b => {
        const on = b.dataset.arg === style;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
}
function currentLineStyle() {
    const b = document.querySelector('#lineStyleSeg .line-style-btn.active');
    return b ? b.dataset.arg : 'solid';
}
function setLineStyle(style) {
    if (!LINE_STYLES.includes(style)) return;
    syncLineStyleSeg(style);
    updateLineStyle();
}
function syncWavyDashSeg(dash) {
    document.querySelectorAll('#wavyDashSeg .line-style-btn').forEach(b => {
        const on = b.dataset.arg === dash;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
    });
}
function currentWavyDash() {
    const b = document.querySelector('#wavyDashSeg .line-style-btn.active');
    return b ? b.dataset.arg : 'solid';
}
function setWavyDash(dash) {
    if (!['solid', 'dashed', 'dotted'].includes(dash)) return;
    syncWavyDashSeg(dash);
    updateLineStyle();
}

/* ==================== 14. 元素增删与基础操作 ==================== */
function addShape(type) {
    const proto = buildElement(type, 0, 0);
    const pos = canvasCenterFor(proto.w, proto.type === 'line' ? lineHeightFor(proto) : proto.h);
    proto.x = round2(pos.x); proto.y = round2(pos.y);
    state.model.elements.push(proto);
    renderAll();
    setSelection([proto.id]);
    commit();
}
function deleteSelected() {
    const removable = selectedEls().filter(e => !e.locked).map(e => e.id);
    const lockedCount = state.selection.length - removable.length;
    if (!removable.length) {
        if (lockedCount) toast('选中的元素已锁定，无法删除', 'error');
        return;
    }
    state.model.elements = state.model.elements.filter(e => !removable.includes(e.id));
    state.selection = [];
    renderAll(); updateUI();
    commit();
    if (lockedCount) toast(`已删除 ${removable.length} 个元素，${lockedCount} 个锁定元素被保留`, 'success');
}
function duplicateSelected() {
    const src = selectedEls();
    if (!src.length) return;
    const clones = src.map(e => {
        const c = deepCopy(e);
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false;
        return validateElement(c);
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
}
function copyToClipboard() {
    if (!state.selection.length) return;
    state.clipboard = selectedEls().map(deepCopy);
    toast(`已复制 ${state.clipboard.length} 个元素`, 'success');
}
function pasteFromClipboard() {
    if (!state.clipboard.length) return;
    const clones = state.clipboard.map(e => {
        const c = validateElement(deepCopy(e));
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false;
        return c;
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
}
function toggleLock() {
    const els = selectedEls(); if (!els.length) return;
    const allLocked = els.every(e => e.locked);
    els.forEach(e => { e.locked = !allLocked; syncElement(e.id); });
    updateUI(); commit();
}
function toggleExportVisibility() {
    const els = selectedEls(); if (!els.length) return;
    const visible = $('chkExportVisible').checked;
    els.forEach(e => { e.exportVisible = visible; syncElement(e.id); });
    commit();
}
function centerOnCanvas() {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    const box = selectionAABB();
    const dx = (state.model.canvas.w - box.w) / 2 - box.left;
    const dy = (state.model.canvas.h - box.h) / 2 - box.top;
    els.forEach(e => { e.x = round2(e.x + dx); e.y = round2(e.y + dy); syncElement(e.id); });
    if (els.length === 1) syncGeoInputs(els[0]);
    commit();
}
function updateGeo(type) {
    if (state.selection.length !== 1) return;
    const el = getEl(state.selection[0]);
    if (el.locked) { toast('元素已锁定，无法修改', 'error'); updatePropPanel(el); return; }
    const map = { x: 'geoX', y: 'geoY', w: 'geoW', h: 'geoH', r: 'geoR' };
    const value = finite($(map[type]).value, null);
    if (value === null) return;
    if (type === 'x') el.x = value;
    else if (type === 'y') el.y = value;
    else if (type === 'w') {
        el.w = Math.max(1, value);
        if (state.geoRatioLocked) { el.h = round2(Math.max(1, el.w / state.geoRatio)); $('geoH').value = Math.round(el.h); }
    } else if (type === 'h') {
        el.h = Math.max(1, value);
        if (state.geoRatioLocked) { el.w = round2(Math.max(1, el.h * state.geoRatio)); $('geoW').value = Math.round(el.w); }
    } else if (type === 'r') { el.rotation = value; }
    if (el.type === 'text' && (type === 'w' || type === 'h') && el.text.sizeMode !== 'fixed') {
        el.text.sizeMode = 'fixed';
        $('textSizeMode').value = 'fixed';
    }
    if (el.type === 'text') updateTextStats(el);
    syncElement(el.id);
    if (typeof drawMeasure === 'function') drawMeasure();
    scheduleCommit();
}
function updatePivotInput(axis) {
    if (state.selection.length !== 1) return;
    const el = getEl(state.selection[0]);
    if (!el || el.locked) { if (el) syncPivotInputs(el); return; }
    const v = finite($(axis === 'x' ? 'pivotXInput' : 'pivotYInput').value, 50);
    if (axis === 'x') setPivot(el, v / 100, el.pivotY, true);
    else setPivot(el, el.pivotX, v / 100, true);
    syncElement(el.id);
    syncGeoInputs(el);
    if (typeof drawMeasure === 'function') drawMeasure();
    scheduleCommit();
}
function resetPivot() {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    els.forEach(el => {
        setPivot(el, 0.5, 0.5, true);
        syncElement(el.id);
    });
    if (els.length === 1) syncGeoInputs(els[0]);
    if (typeof drawMeasure === 'function') drawMeasure();
    commit();
    toast('旋转中心已复位到元素正中', 'success');
}
function moveSelected(dx, dy) {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    els.forEach(e => { e.x = round2(e.x + dx); e.y = round2(e.y + dy); syncElement(e.id); });
    if (els.length === 1) syncGeoInputs(els[0]);
    drawMeasure();
    scheduleCommit(160);
}
function resizeCanvasSize(source) {
    const c = state.model.canvas;
    let w = finite($('canvasW').value, c.w), h = finite($('canvasH').value, c.h);
    w = clamp(w, 1, MAX_CANVAS_SIDE); h = clamp(h, 1, MAX_CANVAS_SIDE);
    if (state.canvasRatioLocked) {
        if (source === 'w') { h = Math.round(w / state.canvasRatio); $('canvasH').value = h; }
        else if (source === 'h') { w = Math.round(h * state.canvasRatio); $('canvasW').value = w; }
    }
    c.w = w; c.h = h;
    syncCanvasSize();
    scheduleCommit();
}

/* ==================== 15. 排列 / 图层（统一 AABB + z-index 归一） ==================== */
function alignElements(type) {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    // N7：相对画布基准时允许单选，并以整个画布作为对齐框
    const canvasBase = state.alignBase === 'canvas';
    if (!canvasBase && els.length < 2) return;
    let a, anchor = null;
    if (canvasBase) {
        a = { left: 0, top: 0, right: state.model.canvas.w, bottom: state.model.canvas.h,
              cx: state.model.canvas.w / 2, cy: state.model.canvas.h / 2,
              w: state.model.canvas.w, h: state.model.canvas.h };
    } else {
        anchor = getEl(state.selection[state.selection.length - 1]);
        if (!anchor) return;
        a = getAABB(anchor);
    }
    els.forEach(el => {
        if (el === anchor) return;
        const b = getAABB(el);
        if (type === 'left') el.x = round2(el.x + (a.left - b.left));
        else if (type === 'right') el.x = round2(el.x + (a.right - b.right));
        else if (type === 'center') el.x = round2(el.x + (a.cx - b.cx));
        else if (type === 'top') el.y = round2(el.y + (a.top - b.top));
        else if (type === 'bottom') el.y = round2(el.y + (a.bottom - b.bottom));
        else if (type === 'middle') el.y = round2(el.y + (a.cy - b.cy));
        syncElement(el.id);
    });
    commit();
}
function distributeElements(axis) {
    const els = selectedEls();
    if (els.length < 3) return;
    if (els.some(e => e.locked)) { toast('选中了锁定元素，无法分布', 'error'); return; }
    const items = els.map(el => ({ el, a: getAABB(el) }));
    const key = axis === 'h' ? 'left' : 'top';
    const sizeKey = axis === 'h' ? 'w' : 'h';
    items.sort((p, q) => p.a[key] - q.a[key]);
    const first = items[0], last = items[items.length - 1];
    const totalSize = items.reduce((s, i) => s + i.a[sizeKey], 0);
    const span = (axis === 'h' ? last.a.right - first.a.left : last.a.bottom - first.a.top);
    const gap = (span - totalSize) / (items.length - 1);
    let cursor = first.a[key];
    items.forEach(i => {
        const delta = cursor - i.a[key];
        if (axis === 'h') i.el.x = round2(i.el.x + delta);
        else i.el.y = round2(i.el.y + delta);
        syncElement(i.el.id);
        cursor += i.a[sizeKey] + gap;
    });
    commit();
}
function layerAction(action) {
    const ids = new Set(state.selection);
    if (!ids.size) return;
    const order = sortedElements();
    const picked = order.filter(e => ids.has(e.id));
    if (!picked.length) return;
    const rest = order.filter(e => !ids.has(e.id));
    const firstIdx = order.findIndex(e => ids.has(e.id));
    if (action === 'top') rest.push(...picked);
    else if (action === 'bottom') rest.unshift(...picked);
    else if (action === 'up') rest.splice(Math.min(firstIdx + 1, rest.length), 0, ...picked);
    else if (action === 'down') rest.splice(Math.max(firstIdx - 1, 0), 0, ...picked);
    normalizeZFromOrder(rest);
    renderAll(); applySelectionClasses(); commit();
}
function startRelLayer(type) {
    if (state.selection.length !== 1) return;
    state.layerPick = { type, id: state.selection[0] };
    $('btnRelUnder').disabled = true; $('btnRelAbove').disabled = true;
    $('relLayerMsg').style.display = 'block';
    document.body.style.cursor = 'crosshair';
}
function endRelLayer() {
    state.layerPick = null;
    $('btnRelUnder').disabled = false; $('btnRelAbove').disabled = false;
    $('relLayerMsg').style.display = 'none';
    document.body.style.cursor = 'default';
}
function handleLayerPick(targetId) {
    const pick = state.layerPick;
    if (!pick) return;
    if (targetId === pick.id) { toast('不能选择自己', 'error'); return; }
    const order = sortedElements().filter(e => e.id !== pick.id);
    const selected = getEl(pick.id);
    const idx = order.findIndex(e => e.id === targetId);
    if (idx < 0 || !selected) { endRelLayer(); return; }
    order.splice(pick.type === 'under' ? idx : idx + 1, 0, selected);
    normalizeZFromOrder(order);
    renderAll(); applySelectionClasses();
    endRelLayer(); commit();
}

/* ==================== 16. 样式更新（渐变 / 线条 / 透明度 / 圆角） ==================== */
function updateCanvasBg(source) {
    const c = state.model.canvas;
    const mode = $('bgType').value;
    if (mode === 'radial') $('bgAngleRow').style.display = 'none';
    else $('bgAngleRow').style.display = 'flex';
    $('bgPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
    if (source === 'slider') $('gradAngleInput').value = $('gradAngle').value;
    if (source === 'number') $('gradAngle').value = $('gradAngleInput').value;
    c.background = makeFill({
        mode,
        color: $('bgColorPicker').value,
        start: $('gradStart').value,
        end: $('gradEnd').value,
        angle: $('gradAngle').value,
        posX: $('gradPosX').value,
        posY: $('gradPosY').value
    });
    $('canvas').style.background = fillToCSS(c.background);
    scheduleCommit();
}
function toggleBgMode() {
    const mode = $('bgType').value;
    showOnly(mode);
    updateCanvasBg();
}
function updateElementBackground(source) {
    const els = selectedEls().filter(e => !e.locked && e.type !== 'text' && e.type !== 'line' && e.type !== 'curve');
    if (source === 'slider') $('elGradAngleInput').value = $('elGradAngle').value;
    if (source === 'number') $('elGradAngle').value = $('elGradAngleInput').value;
    const f = makeFill({
        mode: $('elBgType').value,
        color: $('elColorInput').value,
        start: $('elGradStart').value,
        end: $('elGradEnd').value,
        angle: $('elGradAngleInput').value,
        posX: $('elGradPosX').value,
        posY: $('elGradPosY').value,
        alpha: els.length ? els[0].fill.alpha : 1
    });
    els.forEach(e => { e.fill = Object.assign({}, f); syncElement(e.id); });
    scheduleCommit();
}
function toggleElBgMode() {
    const mode = $('elBgType').value;
    state.elBgMode = mode;
    $('elBgSolidControls').style.display = mode === 'solid' ? 'block' : 'none';
    $('elBgGradientControls').style.display = mode === 'solid' ? 'none' : 'block';
    $('elAngleRow').style.display = mode === 'radial' ? 'none' : 'flex';
    $('elPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
    updateElementBackground();
}
function updateElementColor() {
    const v = $('elColorInput').value;
    if (state.isTextEditing) { applyInlineStyle('color', v); return; }
    const els = selectedEls().filter(e => !e.locked);
    els.forEach(e => {
        if (e.type === 'text') {
            e.fill.color = v;
            e.text.runs.forEach(r => { r.color = ''; });
        } else if (e.type === 'line' || e.type === 'curve') {
            e.line.color = v;
        } else {
            e.fill.color = v;
        }
        syncElement(e.id);
    });
    scheduleCommit();
}
function updateLineStyle(source) {
    if (source === 'slider') $('lineWidthInput').value = $('lineWidthRange').value;
    if (source === 'number') $('lineWidthRange').value = $('lineWidthInput').value;
    if (source === 'wavySlider') $('wavyAmpInput').value = $('wavyAmpRange').value;
    if (source === 'wavyNumber') $('wavyAmpRange').value = $('wavyAmpInput').value;
    const style = currentLineStyle();
    $('wavyControlRow').style.display = style === 'wavy' ? 'flex' : 'none';
    $('wavyDashRow').style.display = style === 'wavy' ? 'flex' : 'none';
    const sample = selectedEls().find(e => !e.locked && (e.type === 'line' || e.type === 'curve'));
    const ln = makeLine({
        style, width: $('lineWidthInput').value,
        color: sample ? sample.line.color : $('elColorInput').value,
        wavyAmp: $('wavyAmpInput').value,
        dash: currentWavyDash()
    });
    selectedEls().filter(e => !e.locked && (e.type === 'line' || e.type === 'curve')).forEach(e => {
        const next = Object.assign({}, ln);
        if (e.type === 'curve' && next.style === 'wavy') next.style = 'solid';
        e.line = next;
        syncElement(e.id);
        if (e.type === 'line') $('geoH').value = Math.round(lineHeightFor(e));
    });
    drawMeasure();
    scheduleCommit();
}
function updateElementOpacity() {
    const v = clamp(finite($('opacityInput').value, 100), 0, 100);
    $('opacityVal').textContent = v;
    selectedEls().filter(e => !e.locked).forEach(e => { e.opacity = v / 100; syncElement(e.id); });
    scheduleCommit();
}
function updateElementRadius() {
    const v = clamp(finite($('borderRadiusInput').value, 0), 0, 10000);
    $('radiusVal').textContent = v;
    selectedEls().filter(e => !e.locked).forEach(e => { e.borderRadius = v; syncElement(e.id); });
    scheduleCommit();
}

/* ==================== 17. 富文本（runs 结构化，无 innerHTML / execCommand） ==================== */
function startTextEdit(el) {
    const d = nodeMap.get(el.id);
    if (!d) return;
    finishTextEdit();
    const tc = d.querySelector('.text-content');
    if (!tc) return;
    state.isTextEditing = true;
    state.editingId = el.id;
    d.classList.add('editing');
    tc.setAttribute('contenteditable', 'true');
    tc.addEventListener('paste', onTextPaste);
    tc.addEventListener('input', onTextInput);
    tc.onblur = () => finishTextEdit();
    tc.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(tc);
    sel.removeAllRanges(); sel.addRange(range);
}
function parseRuns(root) {
    const runs = [];
    const base = { bold: false, italic: false, underline: false, color: '' };
    function walk(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.nodeValue) runs.push(Object.assign({ text: node.nodeValue }, style));
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === 'BR') {
            // 末尾空段落里的孤立 br 是 contenteditable 的占位符，不算换行
            const p = node.parentNode;
            const placeholder = p && p !== root && p.childNodes.length === 1 && p === root.lastElementChild;
            if (!placeholder) runs.push(Object.assign({ text: '\n' }, style));
            return;
        }
        const s = Object.assign({}, style);
        const ds = node.dataset || {};
        if (ds.b === '1' || node.tagName === 'B' || node.tagName === 'STRONG') s.bold = true;
        if (ds.i === '1' || node.tagName === 'I' || node.tagName === 'EM') s.italic = true;
        if (ds.u === '1' || node.tagName === 'U') s.underline = true;
        if (HEX_RE.test(ds.color || '')) s.color = ds.color;
        // contenteditable 用 div/p 表示换行段落，需还原为 \n，否则导出与回读丢段落
        if (/^(DIV|P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(node.tagName) && runs.length && !runs[runs.length - 1].text.endsWith('\n')) {
            runs.push(Object.assign({ text: '\n' }, s));
        }
        Array.from(node.childNodes).forEach(c => walk(c, s));
    }
    Array.from(root.childNodes).forEach(c => walk(c, base));
    const merged = [];
    runs.forEach(r => {
        const last = merged[merged.length - 1];
        if (last && last.bold === r.bold && last.italic === r.italic && last.underline === r.underline && last.color === r.color) last.text += r.text;
        else merged.push(Object.assign({}, r));
    });
    return merged.length ? merged : [{ text: '文本', bold: false, italic: false, underline: false, color: '' }];
}
function finishTextEdit() {
    if (!state.isTextEditing) return;
    const id = state.editingId;
    const d = nodeMap.get(id);
    const el = getEl(id);
    state.isTextEditing = false;
    state.editingId = null;
    if (d && el) {
        const tc = d.querySelector('.text-content');
        if (tc) {
            tc.onblur = null;
            tc.removeEventListener('paste', onTextPaste);
            tc.removeEventListener('input', onTextInput);
            tc.removeAttribute('contenteditable');
            // 空文本框离开编辑即删除，避免留下不可见的空元素
            if (!tc.textContent.trim()) {
                state.model.elements = state.model.elements.filter(x => x.id !== id);
                state.selection = state.selection.filter(x => x !== id);
                renderAll(); updateUI(); commit();
                return;
            }
            el.text.runs = parseRuns(tc);
            applyAutoSize(el);
            renderRuns(tc, el);
        }
        d.classList.remove('editing');
        syncElement(el.id);
        updateTextStats(el);
        if (state.selection.length === 1) syncGeoInputs(el);
    }
    scheduleCommit(60);
}
function onTextInput() {
    const el = getEl(state.editingId);
    const d = nodeMap.get(state.editingId);
    if (!el || !d) return;
    const tc = d.querySelector('.text-content');
    if (!tc) return;
    el.text.runs = parseRuns(tc);
    applyAutoSize(el);
    syncNode(el, d);
    syncGeoInputs(el);
    updateTextStats(el);
    scheduleCommit(300);
}
function onTextPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    onTextInput();
}
function applyInlineStyle(prop, value) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { toast('请先选中要设置的文字', 'error'); return; }
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.dataset[prop] = String(value);
    if (prop === 'b') span.style.fontWeight = '700';
    else if (prop === 'i') span.style.fontStyle = 'italic';
    else if (prop === 'u') span.style.textDecoration = 'underline';
    else if (prop === 'color') span.style.color = value;
    try {
        range.surroundContents(span);
    } catch (err) {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
    }
    sel.removeAllRanges();
    onTextInput();
    scheduleCommit(60);
}
function updateTextStyle(prop) {
    if (state.isTextEditing) {
        if (prop === 'bold') applyInlineStyle('b', 1);
        else if (prop === 'italic') applyInlineStyle('i', 1);
        else if (prop === 'underline') applyInlineStyle('u', 1);
        return;
    }
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    if (!els.length) return;
    els.forEach(e => {
        const t = e.text;
        if (prop === 'font') {
            const raw = $('fontFamilyInput').value;
            const parts = raw.split('|');
            t.fontFamily = parts[0] || 'sans-serif';
            t.fontWeight = [100, 300, 400, 500, 700, 900].includes(Number(parts[1])) ? Number(parts[1]) : 400;
        } else if (prop === 'size') t.fontSize = clamp(finite($('fontSizeInput').value, t.fontSize), 1, 500);
        else if (prop === 'lineHeight') t.lineHeight = clamp(finite($('lineHeightInput').value, t.lineHeight), 0.3, 5);
        else if (prop === 'spacing') t.letterSpacing = clamp(finite($('letterSpacingInput').value, 0), -20, 100);
        else if (prop === 'weight') { const w = Number($('fontWeightInput').value); if ([100, 300, 400, 500, 700, 900].includes(w)) t.fontWeight = w; }
        else if (prop === 'bold') t.fontWeight = t.fontWeight >= 700 ? 400 : 700;
        else if (prop === 'italic') { const on = !t.runs.every(r => r.italic); t.runs.forEach(r => { r.italic = on; }); }
        else if (prop === 'underline') { const on = !t.runs.every(r => r.underline); t.runs.forEach(r => { r.underline = on; }); }
        applyAutoSize(e);
        syncElement(e.id);
        updateTextStats(e);
    });
    if (els.length === 1) updatePropPanel(els[0]);
    scheduleCommit();
}
function updateTextAlign(align) {
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    els.forEach(e => { e.text.align = align; syncElement(e.id); });
    if (els.length === 1) updatePropPanel(els[0]);
    scheduleCommit();
}
function updateTextSizeMode() {
    const mode = $('textSizeMode').value;
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    els.forEach(e => {
        e.text.sizeMode = mode;
        applyAutoSize(e);
        syncElement(e.id);
        updateTextStats(e);
    });
    if (els.length === 1) syncGeoInputs(els[0]);
    scheduleCommit();
}

/* ==================== 18. 布尔运算（离屏 canvas 生成 alpha 遮罩） ==================== */
function shapePath(ctx, el, w, h) {
    ctx.beginPath();
    const pts = POLYGON_POINTS[el.type];
    if (pts) {
        pts.forEach((p, i) => { const x = p[0] / 100 * w, y = p[1] / 100 * h; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.closePath();
    } else if (el.type === 'circle') {
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (ctx.roundRect && el.borderRadius > 0) {
        ctx.roundRect(0, 0, w, h, Math.min(el.borderRadius, w / 2, h / 2));
    } else ctx.rect(0, 0, w, h);
}
function drawMaskShape(ctx, item, op, originX, originY) {
    ctx.globalCompositeOperation = op;
    ctx.save();
    const h = item.el.type === 'line' ? lineHeightFor(item.el) : item.el.h;
    ctx.translate(item.el.x - originX + item.el.pivotX * item.el.w, item.el.y - originY + item.el.pivotY * h);
    ctx.rotate(item.el.rotation * Math.PI / 180);
    ctx.translate(-item.el.pivotX * item.el.w, -item.el.pivotY * h);
    shapePath(ctx, item.el, item.el.w, h);
    ctx.fillStyle = '#000';
    ctx.fill();
    if (item.el.type === 'text') {
        ctx.font = `${item.el.text.fontWeight} ${item.el.text.fontSize}px ${item.el.text.fontFamily}`;
        ctx.textBaseline = 'top';
        const text = item.el.text.runs.map(r => r.text).join('');
        ctx.fillText(text, 0, 0);
    }
    ctx.restore();
}
function performBoolean(op) {
    const els = selectedEls();
    if (els.length < 2) { toast('请至少选择两个元素进行布尔运算', 'error'); return; }
    if (els.some(e => e.locked)) { toast('选中了锁定元素，无法进行布尔运算', 'error'); return; }
    if (els.some(e => e.type === 'curve')) { toast('曲线是开放路径，暂不支持布尔运算', 'error'); return; }
    const items = els.map(el => ({ el, a: getAABB(el) })).sort((p, q) => p.el.zIndex - q.el.zIndex);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach(i => {
        minX = Math.min(minX, i.a.left); minY = Math.min(minY, i.a.top);
        maxX = Math.max(maxX, i.a.right); maxY = Math.max(maxY, i.a.bottom);
    });
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const ratio = clamp(Math.sqrt(4000000 / (w * h)), 1, 3);
    const mask = document.createElement('canvas');
    mask.width = Math.round(w * ratio); mask.height = Math.round(h * ratio);
    const ctx = mask.getContext('2d');
    ctx.scale(ratio, ratio);
    drawMaskShape(ctx, items[0], 'source-over', minX, minY);
    for (let i = 1; i < items.length; i++) {
        const comp = op === 'subtract' ? 'destination-out' : op === 'intersect' ? 'source-in' : 'source-over';
        drawMaskShape(ctx, items[i], comp, minX, minY);
    }
    const assetId = uid('mask');
    putAsset(assetId, mask.toDataURL('image/png'));
    const base = items[0].el;
    const result = buildElement('boolean', minX, minY);
    result.w = round2(w); result.h = round2(h);
    result.fill = deepCopy(base.fill);
    result.image = base.image ? deepCopy(base.image) : null;
    result.maskAssetId = assetId;
    result.zIndex = nextZIndex();
    const ids = new Set(els.map(e => e.id));
    state.model.elements = state.model.elements.filter(e => !ids.has(e.id));
    state.model.elements.push(result);
    state.selection = [result.id];
    renderAll(); updateUI(); commit();
    toast('布尔运算完成', 'success');
}

/* ==================== 19. 图片链路（统一 image 字段） ==================== */
function addImage() { $('imageInput').click(); }
async function handleImageUpload(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
        const dataURL = await readFileAsDataURL(file);
        const img = await loadImage(dataURL);
        const maxDim = 400;
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
            const k = maxDim / Math.max(w, h);
            w = Math.round(w * k); h = Math.round(h * k);
        }
        const assetId = uid('img');
        await putAsset(assetId, dataURL);
        const el = buildElement('image', 0, 0);
        el.w = w; el.h = h;
        el.image = { assetId, originalAssetId: assetId, crop: null };
        const pos = canvasCenterFor(w, h);
        el.x = round2(pos.x); el.y = round2(pos.y);
        state.model.elements.push(el);
        renderAll(); setSelection([el.id]); commit();
        toast('图片已插入，双击可二次裁剪', 'success');
    } catch (e) {
        toast('图片载入失败：' + e.message, 'error');
    }
}

/* ==================== 20. 自实现裁剪器（替代 CropperJS） ==================== */
function openCropModal(elId) {
    const el = getEl(elId);
    if (!el) return;
    const src = el.image ? state.assets[el.image.originalAssetId] : null;
    if (!src) { replaceImage(); return; }
    showCrop(src, el);
}
function replaceImage() {
    $('cropFileInput').click();
}
async function handleCropFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const targetId = cropState ? cropState.elId : (state.selection[0] || null);
    if (!targetId) { toast('请先选中一个元素', 'error'); return; }
    try {
        const dataURL = await readFileAsDataURL(file);
        await loadImage(dataURL);
        const assetId = uid('img');
        await putAsset(assetId, dataURL);
        const el = getEl(targetId);
        if (el) {
            el.image = { assetId, originalAssetId: assetId, crop: null };
            syncElement(el.id);
        }
        showCrop(dataURL, el || { id: targetId, w: 1, h: 1, type: 'rect', borderRadius: 0 });
    } catch (e) { toast('图片载入失败：' + e.message, 'error'); }
}
function showCrop(src, el) {
    $('cropShade').style.display = 'none';
    $('cropModal').style.display = 'flex';
    const img = $('cropImg');
    img.src = src;
    const frame = $('cropFrame');
    frame.classList.toggle('circle', el.type === 'circle');
    const setup = () => {
        const stage = $('cropStage');
        const iw = img.offsetWidth, ih = img.offsetHeight;
        if (!iw || !ih) return;
        const left = (stage.clientWidth - iw) / 2, top = (stage.clientHeight - ih) / 2;
        const ratio = el.w / Math.max(1, el.type === 'line' ? lineHeightFor(el) : el.h);
        let fw = iw * 0.9, fh = fw / ratio;
        if (fh > ih * 0.9) { fh = ih * 0.9; fw = fh * ratio; }
        const rect = { x: left + (iw - fw) / 2, y: top + (ih - fh) / 2, w: fw, h: fh };
        cropState = {
            elId: el.id, assetId: el.image ? el.image.originalAssetId : null,
            ratio, imgLeft: left, imgTop: top, imgW: iw, imgH: ih,
            naturalW: img.naturalWidth, naturalH: img.naturalHeight, rect
        };
        paintCropFrame();
    };
    if (img.complete && img.naturalWidth) setup(); else img.onload = setup;
}
function paintCropFrame() {
    if (!cropState) return;
    const r = cropState.rect;
    const f = $('cropFrame');
    f.style.left = r.x + 'px'; f.style.top = r.y + 'px';
    f.style.width = r.w + 'px'; f.style.height = r.h + 'px';
}
function clampCropRect() {
    const c = cropState, r = c.rect;
    r.w = clamp(r.w, 24, c.imgW); r.h = clamp(r.h, 24, c.imgH);
    r.x = clamp(r.x, c.imgLeft, c.imgLeft + c.imgW - r.w);
    r.y = clamp(r.y, c.imgTop, c.imgTop + c.imgH - r.h);
}
function initCropInteraction() {
    const frame = $('cropFrame');
    frame.addEventListener('pointerdown', e => {
        if (!cropState) return;
        e.preventDefault(); e.stopPropagation();
        const handle = e.target.dataset.h;
        const r = Object.assign({}, cropState.rect);
        state.interaction = {
            kind: 'crop', mode: handle ? 'resize' : 'move', dir: handle || null,
            startX: e.clientX, startY: e.clientY, rect: r
        };
        frame.setPointerCapture && frame.setPointerCapture(e.pointerId);
    });
    frame.addEventListener('pointermove', e => {
        const it = state.interaction;
        if (!it || it.kind !== 'crop' || !cropState) return;
        const dx = e.clientX - it.startX, dy = e.clientY - it.startY;
        const r = cropState.rect;
        if (it.mode === 'move') {
            r.x = it.rect.x + dx; r.y = it.rect.y + dy;
        } else {
            let { x, y, w, h } = it.rect;
            if (it.dir.includes('w')) { x += dx; w -= dx; }
            if (it.dir.includes('e')) { w += dx; }
            if (it.dir.includes('n')) { y += dy; h -= dy; }
            if (it.dir.includes('s')) { h += dy; }
            if (e.shiftKey || cropState.ratio) {
                h = Math.max(24, w / cropState.ratio);
                if (it.dir.includes('n')) y = it.rect.y + it.rect.h - h;
            }
            Object.assign(r, { x, y, w, h });
        }
        clampCropRect(); paintCropFrame();
    });
    const stop = () => { if (state.interaction && state.interaction.kind === 'crop') state.interaction = null; };
    frame.addEventListener('pointerup', stop);
    frame.addEventListener('pointercancel', stop);
}
function cropConfirm() {
    if (!cropState) { $('cropModal').style.display = 'none'; return; }
    const c = cropState;
    const sx = (c.rect.x - c.imgLeft) / c.imgW * c.naturalW;
    const sy = (c.rect.y - c.imgTop) / c.imgH * c.naturalH;
    const sw = c.rect.w / c.imgW * c.naturalW;
    const sh = c.rect.h / c.imgH * c.naturalH;
    const outW = Math.max(1, Math.round(sw)), outH = Math.max(1, Math.round(sh));
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage($('cropImg'), sx, sy, sw, sh, 0, 0, outW, outH);
    const dataURL = canvas.toDataURL('image/png');
    const assetId = uid('crop');
    putAsset(assetId, dataURL);
    const el = getEl(c.elId);
    if (el) {
        el.image = { assetId, originalAssetId: c.assetId || assetId, crop: { x: sx, y: sy, w: sw, h: sh } };
        syncElement(el.id);
    }
    $('cropModal').style.display = 'none';
    cropState = null;
    commit();
    toast('裁剪已应用，可再次双击继续编辑原图', 'success');
}
function closeModal(id) {
    $(id).style.display = 'none';
    if (id === 'cropModal') cropState = null;
}

/* ==================== 21. 项目文件（单 JSON，含内联资源） ==================== */
async function exportConfig() {
    const name = await appPrompt('请输入保存的项目名称：', '设计项目', { title: '保存项目' });
    if (!name) return;
    normalizeZ();
    // 仅打包仍被引用的资源，避免历史图片让项目文件持续膨胀
    const used = new Set();
    state.model.elements.forEach(e => {
        if (e.image) { used.add(e.image.assetId); used.add(e.image.originalAssetId); }
        if (e.maskAssetId) used.add(e.maskAssetId);
    });
    const assets = {};
    used.forEach(id => { if (state.assets[id]) assets[id] = state.assets[id]; });
    const payload = {
        version: VERSION,
        name: state.projectName || state.model.name || '未命名设计',
        canvas: state.model.canvas,
        elements: state.model.elements,
        guides: state.model.guides || [],
        assets
    };
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), safeName + '.canvas');
    toast('项目已保存（离线 JSON 格式）', 'success');
}
function importConfig() { $('imageInput').value = ''; pickFile('.canvas,.json').then(file => file && importProjectFile(file)); }
async function importProjectFile(file) {
    try {
        const text = await file.text();
        const parsed = validateProject(JSON.parse(text));
        const assets = parsed.assets || {};
        for (const [id, data] of Object.entries(assets)) await putAsset(id, data);
        state.model = { version: VERSION, name: parsed.name || file.name.replace(/\.[^.]+$/, ''), canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
        state.projectName = state.model.name;
        state.settings.projectName = state.projectName; saveSettings();
        state.selection = [];
        undoStack = []; historyIndex = -1;
        renderAll(); syncCanvasSize(); syncBackgroundControls(); updateUI();
        commit();
        toast('项目载入成功', 'success');
    } catch (e) {
        toast('无法打开文件：' + e.message, 'error');
    }
}
async function resetToDefault() {
    const ok = await appConfirm('确定要恢复默认设置吗？当前所有更改将丢失（建议先「保存项目」）。', { title: '恢复默认设置' });
    if (!ok) return;
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
    await idbClear();
    location.reload();
}

/* ==================== 22. Canvas 2D 导出渲染器（替代 html-to-image） ==================== */
function paintFill(ctx, fill, w, h) {
    if (fill.mode === 'solid') { ctx.fillStyle = fill.color; return; }
    const s = fill.start, e = fill.end;
    if (fill.mode === 'linear') {
        const rad = fill.angle * Math.PI / 180;
        const cx = w / 2, cy = h / 2;
        const len = (Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))) / 2;
        const dx = Math.sin(rad) * len, dy = -Math.cos(rad) * len;
        const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
        g.addColorStop(0, s); g.addColorStop(1, e); ctx.fillStyle = g; return;
    }
    if (fill.mode === 'radial') {
        const cx = w * fill.posX / 100, cy = h * fill.posY / 100;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
        g.addColorStop(0, s); g.addColorStop(1, e); ctx.fillStyle = g; return;
    }
    if (fill.mode === 'conic' && typeof ctx.createConicGradient === 'function') {
        const g = ctx.createConicGradient(fill.angle * Math.PI / 180, w * fill.posX / 100, h * fill.posY / 100);
        g.addColorStop(0, s); g.addColorStop(1, e); ctx.fillStyle = g; return;
    }
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, s); g.addColorStop(1, e); ctx.fillStyle = g;
}
function fontForRun(run, t) {
    return `${run.italic ? 'italic ' : ''}${run.bold ? 700 : t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
}
/* 排版原子：CJK 逐字可断行，西文按单词，空白独立成原子 */
const TEXT_ATOM_RE = /([\u2E80-\uFAFF\uFF01-\uFF60\u3001-\u303F])|([^\s\u2E80-\uFAFF\uFF01-\uFF60\u3001-\u303F]+)|(\s+)/g;
/** 贪心换行排版：编辑器自动尺寸与 PNG/SVG 导出共用同一套行模型 */
function layoutText(el, maxW, measure) {
    const lines = [[]];
    let cur = 0;
    const newline = forced => { if (forced) lines[lines.length - 1].forcedEnd = true; lines.push([]); cur = 0; };
    el.text.runs.forEach(run => {
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
function drawTextRuns(ctx, el) {
    const t = el.text;
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
        tokens.forEach((tok, i) => {
            const r = tok.run;
            ctx.font = fontForRun(r, t);
            ctx.fillStyle = r.color || el.fill.color;
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
function drawLineElement(ctx, el) {
    const ln = el.line;
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
function drawCurveElement(ctx, el) {
    const ln = el.line, c = el.curve, w = el.w, h = el.h;
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
    const seg = (a, b) => {
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
async function drawElementContent(c, el) {
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
        } catch (err) { console.warn('图片渲染失败', err.message); }
    } else {
        paintFill(c, el.fill, el.w, el.h);
        c.fillRect(0, 0, el.w, el.h);
    }
    c.restore();
}
async function drawExportElement(ctx, el, originX, originY) {
    const h = el.type === 'line' ? lineHeightFor(el) : el.h;
    ctx.save();
    ctx.globalAlpha = el.opacity;
    if (el.blendMode && el.blendMode !== 'normal' && EXPORT_BLEND[el.blendMode]) {
        ctx.globalCompositeOperation = EXPORT_BLEND[el.blendMode];
    }
    // N5：投影
    if (el.shadow && el.shadow.enabled) {
        ctx.shadowColor = hexToRgba(el.shadow.color, .72);
        ctx.shadowBlur = el.shadow.blur * (ctx.__exportScale || 1);
        ctx.shadowOffsetX = el.shadow.x * (ctx.__exportScale || 1);
        ctx.shadowOffsetY = el.shadow.y * (ctx.__exportScale || 1);
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
        await drawElementContent(oc, el);
        try {
            const maskImg = await loadImage(state.assets[el.maskAssetId]);
            oc.globalCompositeOperation = 'destination-in';
            oc.drawImage(maskImg, 0, 0, el.w, el.h);
            oc.globalCompositeOperation = 'source-over';
        } catch (err) { console.warn('遮罩渲染失败', err.message); }
        ctx.drawImage(off, 0, 0, el.w, el.h);
    } else {
        await drawElementContent(ctx, el);
    }
    // N5：描边（贴在形状外轮廓上，异形用 clipPath 多边形）
    if (el.stroke && el.stroke.width > 0 && el.type !== 'text' && el.type !== 'line') {
        ctx.save();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.strokeStyle = el.stroke.color;
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
/** opts: { transparent, elements, bounds:{x,y,w,h}, opaqueBackground } */
async function renderModelToCanvas(scale, opts) {
    const o = opts || {};
    const bounds = o.bounds || { x: 0, y: 0, w: state.model.canvas.w, h: state.model.canvas.h };
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bounds.w * scale));
    c.height = Math.max(1, Math.round(bounds.h * scale));
    const ctx = c.getContext('2d');
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
function exportBoundsFor(scope) {
    if (scope !== 'selection') return { x: 0, y: 0, w: state.model.canvas.w, h: state.model.canvas.h };
    const sel = selectedEls().filter(e => e.exportVisible && e.visible);
    if (!sel.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    sel.forEach(e => { const a = getAABB(e); l = Math.min(l, a.left); t = Math.min(t, a.top); r = Math.max(r, a.right); b = Math.max(b, a.bottom); });
    const pad = 8;
    return { x: Math.max(0, l - pad), y: Math.max(0, t - pad), w: Math.min(state.model.canvas.w, r + pad) - Math.max(0, l - pad), h: Math.min(state.model.canvas.h, b + pad) - Math.max(0, t - pad) };
}
function exportElementsFor(scope) {
    return scope === 'selection' ? selectedEls().filter(e => e.exportVisible && e.visible) : sortedElements();
}
function showExportModal() {
    $('exportW').value = Math.round(state.model.canvas.w);
    $('exportModal').style.display = 'flex';
    if (typeof updateExportSummary === 'function') updateExportSummary();
}
function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), mime, quality);
    });
}
async function doExport() {
    const exportW = Number($('exportW').value);
    if (!Number.isFinite(exportW) || !Number.isInteger(exportW) || exportW < 16 || exportW > 16000) {
        toast('导出宽度必须是 16–16000 之间的整数', 'error'); return;
    }
    const format = $('exportFormat').value;
    const scope = $('exportScope').value;
    const transparent = $('exportTransparent').checked;
    const quality = clamp(finite($('exportQuality').value, 92), 10, 100) / 100;
    const name = ($('exportName').value || 'design').trim().replace(/[\\/:*?"<>|]/g, '_');
    const btn = document.querySelector('[data-act="doExport"]');
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
        console.warn('导出失败：', e.message);
        toast('导出失败：' + e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ==================== 22.5 V12 扩展：界面 / 视图 / 吸附 / 样式 / 素材 ==================== */
const PRESET_COLORS = ['#4f6bff', '#12b886', '#f79009', '#e5484d', '#9b6bff', '#0ea5e9',
    '#1c2230', '#5a6379', '#8b94a8', '#ffffff', '#f4f6fb', '#e4e7f0',
    '#ffcccb', '#add8e6', '#ffe4a3', '#c8f0d8'];
const SHAPE_PRESETS = [
    { type: 'rect', label: '矩形', color: '#4f6bff', w: 200, h: 140, radius: 0 },
    { type: 'rect', label: '卡片', color: '#ffffff', w: 220, h: 150, radius: 14, stroke: '#e4e7f0' },
    { type: 'circle', label: '圆形', color: '#12b886', w: 140, h: 140 },
    { type: 'circle', label: '圆环', color: '#0ea5e9', w: 140, h: 140, stroke: '#0ea5e9' },
    { type: 'triangle', label: '三角', color: '#f79009', w: 150, h: 150 },
    { type: 'star', label: '星形', color: '#f7b731', w: 150, h: 150 },
    { type: 'arrow', label: '箭头', color: '#9b6bff', w: 200, h: 100 },
    { type: 'line', label: '分隔线', color: '#8b94a8', w: 280, h: 4 }
];
const TEXT_PRESETS = [
    { label: '大标题', size: 48, weight: 700, color: '#1c2230' },
    { label: '副标题', size: 28, weight: 500, color: '#5a6379' },
    { label: '正文', size: 18, weight: 400, color: '#1c2230' },
    { label: '强调蓝', size: 32, weight: 700, color: '#4f6bff' }
];
const SHORTCUTS = [
    ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y'], ['复制 / 粘贴', 'Ctrl+C / Ctrl+V'],
    ['创建副本', 'Ctrl+D'], ['全选', 'Ctrl+A'], ['保存项目', 'Ctrl+S'],
    ['组合 / 解组', 'Ctrl+G / Ctrl+Shift+G'], ['适应屏幕', 'Alt+Z'],
    ['显示网格', "Ctrl+'"],     ['选择 / 平移 / 文本 / 钢笔 / 颜料桶', 'V / H / T / P / B'], ['插入矩形', 'R'],
    ['钢笔：闭合路径', '点回起点'], ['钢笔：结束 / 取消', 'Enter / Esc'],
    ['钢笔：下一段拉直', 'Alt+点击锚点 / 落点'],
    ['颜料桶：连续上色 / 吸色', '按住拖动 / Alt+点击'],
    ['颜料桶：强制改描边', 'Shift + 点击'],
    ['曲线：双击线段 / 节点', '加点 / 删点'], ['节点对称吸附', 'Shift 拖拽控制柄'],
    ['方向键移动', '↑ ↓ ← →'], ['大步长移动', 'Shift + 方向键'],
    ['等比缩放 / 角度吸附', 'Shift + 拖拽'], ['临时平移', '空格 + 拖拽'],
    ['跳过吸附', 'Alt + 拖拽'], ['删除', 'Delete'], ['取消 / 取消选择', 'Esc'],
    ['快捷键说明', '?'], ['双击文本', '编辑内容'], ['双击图片', '裁剪'], ['双击旋转中心', '复位到中心'],
    ['编辑选中文字', 'Enter / F2'], ['结束文本编辑', 'Esc / Ctrl+Enter']
];

/* -------------------- 主题与视图设置 -------------------- */
function applyTheme() {
    const s = state.settings;
    document.body.dataset.theme = s.theme;
    document.body.dataset.contrast = s.contrast;
    setIcon($('btnTheme'), s.theme === 'dark' ? 'sun' : 'moon');
    if (typeof onViewChanged === 'function') onViewChanged();
}
function toggleTheme() {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(); applyTheme();
    toast(state.settings.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'success');
}
function setToggleButton(id, on) { const b = $(id); if (b) b.setAttribute('aria-pressed', String(!!on)); }
function applyViewSettings() {
    const s = state.settings;
    setToggleButton('btnSnap', s.snap); setToggleButton('btnGrid', s.grid);
    setToggleButton('btnRulers', s.rulers); setToggleButton('btnGuides', s.guides);
    setToggleButton('btnGuideLines', s.guideLines !== false);
    $('gridOverlay').classList.toggle('on', !!s.grid);
    [$('rulerH'), $('rulerV'), $('rulerCorner')].forEach(n => n.classList.toggle('hidden-ruler', !s.rulers));
    const flags = $('statusSnap'); if (flags) flags.classList.toggle('on', !!s.snap);
    const gf = $('statusGrid'); if (gf) gf.classList.toggle('on', !!s.grid);
    state.alignBase = s.alignBase || 'selection';
    if ($('alignBase')) $('alignBase').value = state.alignBase;
    if (typeof updateGrid === 'function') updateGrid();
    if (typeof onViewChanged === 'function') onViewChanged();
}
function toggleSetting(key, label) {
    state.settings[key] = !state.settings[key];
    saveSettings(); applyViewSettings();
    toast(label + (state.settings[key] ? '已开启' : '已关闭'), 'success');
}
/* -------------------- 颜料桶工具（矢量填色，不做像素漫水） -------------------- */
const BUCKET_FILL_DEFAULT = '#4f6bff', BUCKET_STROKE_DEFAULT = '#1c2230';
const bucketSlotLabel = s => s === 'stroke' ? '描边' : '填充';
function bucketColor(slot) {
    const s = state.settings;
    const v = s && (slot === 'stroke' ? s.bucketStrokeColor : s.bucketFillColor);
    return HEX_RE.test(v) ? v : (slot === 'stroke' ? BUCKET_STROKE_DEFAULT : BUCKET_FILL_DEFAULT);
}
function setBucketColor(slot, color) {
    if (!state.settings || !HEX_RE.test(color)) return;
    if (slot === 'stroke') state.settings.bucketStrokeColor = color;
    else state.settings.bucketFillColor = color;
    state.bucketSlot = slot;
    saveSettings();
    syncBucketSwatch();
}
/** 为指定色槽打开隐藏的原生取色器 */
function openBucketPicker(slot) {
    const input = $('bucketColorInput');
    if (!input) return;
    state.bucketSlot = slot || 'fill';
    input.value = bucketColor(state.bucketSlot);
    syncBucketSwatch();
    if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch (err) { /* 回退到 click */ }
    }
    input.click();
}
function syncBucketSwatch() {
    const fill = bucketColor('fill'), stroke = bucketColor('stroke');
    const fChip = $('bucketFillChip'), sChip = $('bucketStrokeChip');
    if (fChip) fChip.style.background = fill;
    if (sChip) sChip.style.background = stroke;
    const fSlot = $('bucketFillSlot'), sSlot = $('bucketStrokeSlot');
    if (fSlot) {
        fSlot.title = '填充色 ' + fill.toUpperCase() + '：点此选色';
        fSlot.classList.toggle('active', state.bucketSlot !== 'stroke');
    }
    if (sSlot) {
        sSlot.title = '描边色 ' + stroke.toUpperCase() + '：点此选色';
        sSlot.classList.toggle('active', state.bucketSlot === 'stroke');
    }
    const btn = $('railBucket');
    if (btn) btn.title = '颜料桶 (B)：填充 ' + fill.toUpperCase() + ' · 描边 ' + stroke.toUpperCase()
        + '；点内部改填充、点边缘改描边，Shift 强制描边，Alt+点击吸色，拖动连续上色';
}
function bucketHitElement(x, y, target) {
    let d = target && target.closest ? target.closest('.canvas-element') : null;
    // 尺寸标注、选框手柄等浮层可能盖在元素中心，逐层向下找真正的画布元素
    if (!d && typeof document.elementsFromPoint === 'function') {
        for (const n of document.elementsFromPoint(x, y)) {
            const c = n.closest && n.closest('.canvas-element');
            if (c) { d = c; break; }
        }
    }
    if (!d) {
        const node = document.elementFromPoint(x, y);
        if (node && node.closest) d = node.closest('.canvas-element');
    }
    return d ? getEl(d.dataset.id) : null;
}
/** 交互识别：点在描边带上改描边，点在内部改填充；无填充概念的元素一律按描边处理 */
function bucketDetectTarget(el, x, y, e) {
    if (!el) return 'fill';
    if (e && e.shiftKey) return 'stroke';
    if (el.type === 'line' || (el.type === 'curve' && !(el.curve && el.curve.closed))) return 'stroke';
    const loc = worldToLocalPoint(el, clientToWorld(x, y));
    const edgePx = 8 / (state.zoom || 1);   // 边缘命中带按屏幕像素换算到元素局部坐标
    if (el.type === 'curve') {
        const d = nodeMap.get(el.id);
        const path = d && d.querySelector('.curve-svg path');
        if (path && typeof path.isPointInStroke === 'function' && typeof DOMPoint === 'function') {
            const old = path.getAttribute('stroke-width');
            try {
                // 临时放大描边命中带，缩放后也能轻松点到细描边
                path.setAttribute('stroke-width', String(2 * edgePx + finite(el.line.width, 3)));
                const pt = new DOMPoint(loc.x, loc.y);
                if (path.isPointInStroke(pt)) return 'stroke';
                if (path.isPointInFill(pt)) return 'fill';
                return 'stroke';   // 路径之外视为描边带，便于重新启用已关闭的描边
            } catch (err) { /* 回退到内部判定 */ }
            finally {
                if (old !== null) path.setAttribute('stroke-width', old);
                else path.removeAttribute('stroke-width');
            }
        }
        return 'fill';
    }
    const sw = Math.max(edgePx, finite(el.stroke && el.stroke.width, 0) + edgePx);
    if (loc.x <= sw || loc.y <= sw || loc.x >= el.w - sw || loc.y >= el.h - sw) return 'stroke';
    return 'fill';
}
/** 按识别结果写入对应颜色：stroke 改描边，fill 改填充 */
function applyBucketColor(el, target, color) {
    if (!el || el.locked || el.visible === false || !HEX_RE.test(color)) return false;
    const stroke = target === 'stroke';
    if (stroke && (el.type === 'line' || el.type === 'curve')) {
        el.line.color = color;
        if (el.type === 'curve') el.curve.strokeOn = true;
    } else if (stroke && el.type === 'text') {
        el.fill.color = color;
        el.text.runs.forEach(r => { r.color = ''; });
    } else if (stroke) {
        el.stroke = makeStroke(Object.assign({}, el.stroke, {
            color, width: Math.max(1, finite(el.stroke && el.stroke.width, 0))
        }));
    } else if (el.type === 'line' || (el.type === 'curve' && !(el.curve && el.curve.closed))) {
        el.line.color = color;
    } else if (el.type === 'text') {
        el.fill.color = color;
        el.text.runs.forEach(r => { r.color = ''; });
    } else {
        el.fill.mode = 'solid';
        el.fill.color = color;
        if (el.type === 'curve') el.curve.filled = true;
    }
    syncElement(el.id);
    return true;
}
/* -------------------- 颜料桶悬停预览 -------------------- */
let bucketHoverEl = null;
function hideBucketHover() {
    const tip = $('bucketHover');
    if (tip) tip.classList.remove('on');
    const d = bucketHoverEl && nodeMap.get(bucketHoverEl);
    if (d) {
        delete d.dataset.bucketTarget;
        d.style.removeProperty('--bucket-hi');
        d.style.removeProperty('--bucket-hi-fade');
    }
    bucketHoverEl = null;
}
function updateBucketHover(e) {
    const tip = $('bucketHover');
    if (!tip) return;
    const el = bucketHitElement(e.clientX, e.clientY, e.target);
    if (!el || el.locked || el.visible === false) { hideBucketHover(); return; }
    const target = bucketDetectTarget(el, e.clientX, e.clientY, e);
    const color = bucketColor(target);
    if (bucketHoverEl !== el.id) hideBucketHover();
    const d = nodeMap.get(el.id);
    if (!d) { hideBucketHover(); return; }
    bucketHoverEl = el.id;
    d.dataset.bucketTarget = target;
    d.style.setProperty('--bucket-hi', color);
    if (target === 'stroke') d.style.removeProperty('--bucket-hi-fade');
    else d.style.setProperty('--bucket-hi-fade', hexToRgba(color, .22));
    const chip = $('bucketHoverChip'), text = $('bucketHoverText');
    if (chip) chip.style.background = color;
    if (text) text.textContent = bucketSlotLabel(target) + ' · ' + color.toUpperCase();
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
    tip.classList.add('on');
}
function setTool(name) {
    if (name !== 'pen' && state.pen) finishPen(false, true);
    if (name !== 'pen') renderPenDraft();
    state.tool = name;
    ['railSelect', 'railPan', 'railText', 'railPen', 'railBucket'].forEach(id => { const n = $(id); if (n) n.classList.remove('active'); });
    const railId = name === 'pan' ? 'railPan' : name === 'text' ? 'railText' : name === 'pen' ? 'railPen'
        : name === 'bucket' ? 'railBucket' : 'railSelect';
    const btn = $(railId);
    if (btn) btn.classList.add('active');
    $('viewport').classList.toggle('tool-pan', name === 'pan');
    $('viewport').classList.toggle('tool-text', name === 'text');
    $('viewport').classList.toggle('tool-pen', name === 'pen');
    $('viewport').classList.toggle('tool-bucket', name === 'bucket');
    syncBucketSwatch();
    if (name !== 'bucket') hideBucketHover();
    if (name === 'pen') {
        toast('钢笔：单击加角点，拖拽出曲线；Alt+点击锚点或 Alt+落新点可让下一段变直线；Enter 完成', 'success');
    } else if (name === 'bucket') {
        toast('颜料桶：填充 ' + bucketColor('fill').toUpperCase() + ' · 描边 ' + bucketColor('stroke').toUpperCase()
            + '；点内部改填充、点边缘改描边，Shift 强制描边，Alt+点击吸色', 'success');
    }
}
function toggleInspector() {
    state.settings.inspectorVisible = !state.settings.inspectorVisible;
    $('inspector').classList.toggle('collapsed', !state.settings.inspectorVisible);
    saveSettings();
    requestAnimationFrame(() => { if (typeof onViewChanged === 'function') onViewChanged(); });
}
function switchTab(name) {
    state.activeTab = name;
    state.settings.activeTab = name; saveSettings();
    document.querySelectorAll('.inspector-tabs .tab').forEach(t => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'layers' && typeof renderLayerList === 'function') renderLayerList();
    if (name === 'projects' && typeof renderProjectPanels === 'function') renderProjectPanels();
}
function toggleCard(id) { const c = $(id); if (c) c.classList.toggle('collapsed'); }
function syncInspectorFold() {
    const v = !!state.settings.inspectorFolded;
    $('inspector').classList.toggle('folded', v);
    const f = $('btnInspectorFold');
    if (f) {
        f.classList.toggle('folded', v);
        f.setAttribute('aria-expanded', String(!v));
        f.title = v ? '展开面板' : '收起面板';
    }
}
function setInspectorFolded(v) {
    state.settings.inspectorFolded = v;
    saveSettings();
    syncInspectorFold();
}
function closeAllMenus(except) {
    document.querySelectorAll('.menu.open').forEach(m => { if (m !== except) m.classList.remove('open'); });
}
function bindMenus() {
    document.querySelectorAll('.menu-trigger').forEach(t => {
        t.addEventListener('click', e => {
            e.stopPropagation();
            const m = t.closest('.menu'), open = m.classList.contains('open');
            closeAllMenus(); m.classList.toggle('open', !open);
        });
    });
    document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeAllMenus(); });
    document.querySelectorAll('.menu-pop').forEach(p => p.addEventListener('click', () => closeAllMenus()));
}

/* -------------------- 状态栏 / 视图变化 -------------------- */
function refreshStudioUI() {
    const n = state.model ? state.model.elements.length : 0;
    const s = state.selection.length;
    if ($('statusCount')) $('statusCount').textContent = n + ' 个元素';
    if ($('statusSelection')) $('statusSelection').textContent = s ? `已选中 ${s} 个` : (state.guideSel ? '已选中辅助线' : '未选中');
    if ($('statusProject')) $('statusProject').textContent = state.projectName || '未命名设计';
    if ($('projectName')) $('projectName').textContent = state.projectName || '未命名设计';
    if ($('layerCountBadge')) $('layerCountBadge').textContent = n;
    if ($('selTypeHint')) {
        const el = s === 1 ? getEl(state.selection[0]) : null;
        $('selTypeHint').textContent = el ? (TYPE_LABELS[el.type] || '') : '';
    }
    if ($('btnUngroup')) {
        const grouped = selectedEls().some(e => !!e.groupId);
        $('btnUngroup').disabled = !grouped;
    }
    if (state.activeTab === 'layers' && typeof renderLayerList === 'function') renderLayerList();
    if (typeof drawGuides === 'function') drawGuides();
    if (typeof drawMeasure === 'function') drawMeasure();
}
function refreshStudioPanels() {
    if (typeof renderLayerList === 'function') renderLayerList();
    if (typeof drawGuides === 'function') drawGuides();
    if (typeof drawMeasure === 'function') drawMeasure();
    refreshStudioUI();
}
function onViewChanged() {
    if (!state.settings) return;
    updateGrid();
    drawRulers();
    if (typeof drawGuides === 'function') drawGuides();
    drawMeasure();
    if ($('statusZoom')) $('statusZoom').textContent = Math.round(state.zoom * 100) + '%';
}
function updateGrid() {
    const g = $('gridOverlay');
    const size = Math.max(4, (state.settings.gridSize || 20) * state.zoom);
    g.style.backgroundSize = `${size}px ${size}px`;
    g.style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
}
function drawRulers() {
    if (!state.settings || !state.settings.rulers || !$('rulerHCanvas')) return;
    const vp = $('viewport');
    const dpr = window.devicePixelRatio || 1;
    const draw = (canvas, horizontal) => {
        const len = horizontal ? vp.clientWidth : vp.clientHeight;
        const thick = 20;
        canvas.width = Math.max(1, Math.round(len * dpr));
        canvas.height = Math.max(1, Math.round(thick * dpr));
        if (!horizontal) { canvas.width = Math.max(1, Math.round(thick * dpr)); canvas.height = Math.max(1, Math.round(len * dpr)); }
        canvas.style.width = horizontal ? len + 'px' : thick + 'px';
        canvas.style.height = horizontal ? thick + 'px' : len + 'px';
        const c = canvas.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const css = getComputedStyle(document.body);
        c.fillStyle = css.getPropertyValue('--bg-surface').trim() || '#fff';
        c.fillRect(0, 0, horizontal ? len : thick, horizontal ? thick : len);
        c.strokeStyle = css.getPropertyValue('--border-strong').trim() || '#ccc';
        c.fillStyle = css.getPropertyValue('--text-3').trim() || '#888';
        c.font = '9px sans-serif'; c.lineWidth = 1;
        const origin = horizontal ? state.pan.x : state.pan.y;
        const step = state.settings.gridSize * state.zoom;
        const unit = state.settings.gridSize;
        const first = Math.floor(-origin / step);
        const count = Math.ceil(len / step) + 1;
        for (let i = 0; i <= count; i++) {
            const idx = first + i;
            const pos = origin + idx * step;
            if (pos < -30 || pos > len + 5) continue;
            const major = idx % 5 === 0;
            c.beginPath();
            if (horizontal) { c.moveTo(Math.round(pos) + .5, thick); c.lineTo(Math.round(pos) + .5, thick - (major ? 9 : 5)); }
            else { c.moveTo(thick, Math.round(pos) + .5); c.lineTo(thick - (major ? 9 : 5), Math.round(pos) + .5); }
            c.stroke();
            if (major) {
                const label = String(idx * unit);
                if (horizontal) c.fillText(label, pos + 3, 9);
                else { c.save(); c.translate(9, pos - 3); c.rotate(-Math.PI / 2); c.fillText(label, 0, 0); c.restore(); }
            }
        }
    };
    draw($('rulerHCanvas'), true);
    draw($('rulerVCanvas'), false);
}

/* -------------------- N3 智能吸附、N7 尺寸标注 -------------------- */
function snapCandidates(ignoreIds) {
    const xs = [0, state.model.canvas.w / 2, state.model.canvas.w];
    const ys = [0, state.model.canvas.h / 2, state.model.canvas.h];
    state.model.elements.forEach(e => {
        if (ignoreIds.has(e.id) || !e.visible) return;
        const a = getAABB(e);
        xs.push(a.left, a.cx, a.right); ys.push(a.top, a.cy, a.bottom);
    });
    // 轴线辅助线参与吸附（旋转线不参与，避免斜向吸附干扰）
    (state.model.guides || []).forEach(g => {
        const axis = guideAxis(g);
        if (axis === 'v') xs.push(g.x);
        else if (axis === 'h') ys.push(g.y);
    });
    return { xs, ys };
}
function applyDragSnap(it, mx, my) {
    if (!state.settings || !state.settings.snap) return { mx, my, guides: [] };
    const ids = new Set(it.items.map(o => o.id));
    const { xs, ys } = snapCandidates(ids);
    const start = it.startBox || (it.startBox = selectionAABB());
    if (!start) return { mx, my, guides: [] };
    const cur = { left: start.left + mx, right: start.right + mx, cx: start.cx + mx,
                  top: start.top + my, bottom: start.bottom + my, cy: start.cy + my };
    const threshold = 6 / state.zoom;
    let bestX = null, bestY = null;
    [['left', 'xs'], ['cx', 'xs'], ['right', 'xs']].forEach(([key, arr]) => {
        (arr === 'xs' ? xs : []).forEach(v => {
            const d = v - cur[key];
            if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, v, vertical: true };
        });
    });
    [['top', 'ys'], ['cy', 'ys'], ['bottom', 'ys']].forEach(([key, arr]) => {
        (arr === 'ys' ? ys : []).forEach(v => {
            const d = v - cur[key];
            if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, v, vertical: false };
        });
    });
    const guides = [];
    if (bestX) { mx += bestX.d; guides.push({ vertical: true, at: bestX.v }); }
    if (bestY) { my += bestY.d; guides.push({ vertical: false, at: bestY.v }); }
    // 网格吸附：未命中元素/画布参考线时对齐到网格
    if (!bestX && !bestY && state.settings.grid) {
        const g = state.settings.gridSize;
        if (it.items.length === 1) {
            const el = getEl(it.items[0].id);
            if (el) {
                const nx = Math.round((el.x + mx) / g) * g, ny = Math.round((el.y + my) / g) * g;
                mx += nx - (el.x + mx); my += ny - (el.y + my);
            }
        }
    }
    return { mx, my, guides };
}
function drawSnapGuides(guides) {
    const layer = $('guidesLayer');
    layer.textContent = '';
    if (!guides || !guides.length) return;
    guides.forEach(g => {
        const d = document.createElement('div');
        d.className = 'snap-guide ' + (g.vertical ? 'v' : 'h');
        if (g.vertical) d.style.left = (g.at * state.zoom + state.pan.x) + 'px';
        else d.style.top = (g.at * state.zoom + state.pan.y) + 'px';
        layer.appendChild(d);
    });
}
function clearSnapGuides() { const l = $('guidesLayer'); if (l) l.textContent = ''; }
/* -------------------- 尺寸 / 边距标注（数值可点击编辑） -------------------- */
// 标注显示阈值（屏幕像素）：过远的测量线只会让画面变乱
const MEASURE_LIMIT = { gap: 300, align: 220, guide: 300, margin: 260 };
const GAP_ARROW = { left: '←', right: '→', top: '↑', bottom: '↓' };
function measureApplySize(axis, v) {
    v = Math.max(1, round2(v));
    if (state.selection.length === 1) {
        $(axis === 'w' ? 'geoW' : 'geoH').value = v;
        updateGeo(axis);
        return;
    }
    // 多选：以选区左上角为锚点等比缩放，与拖拽缩放手柄一致
    const box = selectionAABB();
    const els = selectedEls().filter(e => !e.locked);
    if (!box || !els.length) return;
    const s = v / Math.max(1, axis === 'w' ? box.w : box.h);
    els.forEach(el => {
        if (axis === 'w') { el.x = round2(box.left + (el.x - box.left) * s); el.w = round2(Math.max(1, el.w * s)); }
        else { el.y = round2(box.top + (el.y - box.top) * s); el.h = round2(Math.max(1, el.h * s)); }
        if (el.type === 'text' && el.text.sizeMode !== 'fixed') el.text.sizeMode = 'fixed';
        syncElement(el.id);
    });
    scheduleCommit();
}
function openMeasureEditor(span, value, apply, label) {
    if (span.querySelector('.measure-input')) return;
    const selKey = state.selection.join(',');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'measure-input';
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const fit = () => { input.style.width = Math.max(3, input.value.length + 1) + 'ch'; };
    fit();
    span.textContent = '';
    span.classList.add('editing');
    span.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    let lastApplied = null;
    const finish = applyIt => {
        if (done) return;
        done = true;
        const v = finite(input.value, null);
        input.remove();
        span.classList.remove('editing');
        // 选区在编辑期间变化时放弃应用，避免把数值改到别的对象上
        if (state.selection.join(',') === selKey) {
            if (applyIt && v !== null && (v !== value || lastApplied !== null)) { apply(v); commit(); }
            // Esc 取消：方向键已实时生效的改动回退到打开编辑前的数值
            else if (!applyIt && lastApplied !== null && lastApplied !== value) { apply(value); commit(); }
        }
        drawMeasure();
    };
    input.addEventListener('input', fit);
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault(); e.stopPropagation();
            const step = (state.moveStep || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const nv = round2(finite(input.value, value) + step);
            input.value = String(nv);
            fit();
            if (state.selection.join(',') === selKey) { lastApplied = nv; apply(nv); }
        }
    });
    input.addEventListener('blur', () => finish(true));
}
function measureNum(parent, value, apply, label, tip) {
    const s = document.createElement('span');
    s.className = 'measure-num';
    s.textContent = value;
    s.tabIndex = 0;
    s.setAttribute('role', 'spinbutton');
    s.setAttribute('aria-valuenow', String(value));
    s.setAttribute('aria-label', label);
    s.title = tip || ('点击编辑' + label + '（↑↓ 按步长微调，Shift 加速，Enter 确认，Esc 取消）');
    const open = () => openMeasureEditor(s, value, apply, label);
    s.addEventListener('click', e => { e.stopPropagation(); open(); });
    s.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
    });
    parent.appendChild(s);
    return s;
}
function measureText(parent, text) {
    const s = document.createElement('span');
    s.className = 'measure-sep';
    s.textContent = text;
    parent.appendChild(s);
    return s;
}
/* -------------------- 标注排版：屏幕坐标尺寸线 + 药丸标签批量避让 -------------------- */
/** 水平尺寸线（含两端刻度） */
function measureDimH(x1, x2, y, tick) {
    const t = tick || 4;
    return `M ${round2(x1)} ${round2(y - t)} V ${round2(y + t)} M ${round2(x1)} ${round2(y)} H ${round2(x2)} M ${round2(x2)} ${round2(y - t)} V ${round2(y + t)}`;
}
/** 垂直尺寸线（含两端刻度） */
function measureDimV(x, y1, y2, tick) {
    const t = tick || 4;
    return `M ${round2(x - t)} ${round2(y1)} H ${round2(x + t)} M ${round2(x)} ${round2(y1)} V ${round2(y2)} M ${round2(x - t)} ${round2(y2)} H ${round2(x + t)}`;
}
/** 任意方向尺寸线（旋转物件用），刻度垂直于线方向 */
function measureDimSeg(ax, ay, bx, by, tick) {
    const t = tick || 4;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    return `M ${round2(ax + nx * t)} ${round2(ay + ny * t)} L ${round2(ax - nx * t)} ${round2(ay - ny * t)}` +
        ` M ${round2(ax)} ${round2(ay)} L ${round2(bx)} ${round2(by)}` +
        ` M ${round2(bx + nx * t)} ${round2(by + ny * t)} L ${round2(bx - nx * t)} ${round2(by - ny * t)}`;
}
/** 视口内可用右边界：窄屏时检查器是覆盖画布的抽屉，标注需让位 */
function measureDrawerLimit() {
    const insp = $('inspector');
    if (!insp || insp.classList.contains('collapsed') || getComputedStyle(insp).position !== 'absolute') return null;
    const ir = insp.getBoundingClientRect(), vr = $('viewport').getBoundingClientRect();
    if (ir.left >= vr.right || ir.right <= vr.left) return null;
    return ir.left - vr.left - 16;
}
/**
 * 标签批量排版：先统一读尺寸（一次布局），再统一写位置
 * pending: [{ d, cx, cy, mode:'center'|'above' }]，seeds: 需要避让的屏幕矩形
 */
function layoutMeasureTags(pending, seeds) {
    if (!pending || !pending.length) return;
    const vp = $('viewport');
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const lim = measureDrawerLimit();
    const right = lim === null ? vw - 4 : clamp(lim, 140, vw - 4);
    const items = pending.slice();
    items.forEach(it => { it.w = it.d.offsetWidth || 46; it.h = it.d.offsetHeight || 19; });
    const placed = (seeds || []).map(s => ({ l: s.l, r: s.r, t: s.t, b: s.b }));
    const clash = r => placed.some(p => !(r.r + 3 < p.l || r.l - 3 > p.r || r.b + 3 < p.t || r.t - 3 > p.b));
    const CENTER = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const ABOVE = [[0, -1], [0, 0], [0, -2], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [0, 2], [-1, 1], [1, 1]];
    items.forEach(it => {
        const w = it.w, h = it.h;
        const order = it.mode === 'center' ? CENTER : ABOVE;
        let pick = null;
        for (const [dx, dy] of order) {
            const x = clamp(it.cx + dx * (w / 2 + 7), w / 2 + 4, Math.max(w / 2 + 4, right - w / 2));
            const y = clamp(it.cy + dy * (h + 5), h / 2 + 4, Math.max(h / 2 + 4, vh - h / 2 - 4));
            const r = { x, y, l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
            if (clash(r)) continue;
            pick = r;
            break;
        }
        if (!pick) {
            const x = clamp(it.cx, w / 2 + 4, Math.max(w / 2 + 4, right - w / 2));
            const y = clamp(it.cy, h / 2 + 4, Math.max(h / 2 + 4, vh - h / 2 - 4));
            pick = { x, y, l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
        }
        it.d.style.left = pick.x + 'px';
        it.d.style.top = pick.y + 'px';
        placed.push(pick);
    });
}
/* -------------------- 相邻物件间距（四向最近邻，玫红色标注） -------------------- */
const GAP_SIDE_NAME = { left: '左', right: '右', top: '上', bottom: '下' };
function neighborGapsFor(box, elements, excludeIds) {
    const best = {};
    elements.forEach(o => {
        if (excludeIds.includes(o.id) || o.visible === false) return;
        const a = getAABB(o);
        const oy = Math.min(box.bottom, a.bottom) - Math.max(box.top, a.top);
        const ox = Math.min(box.right, a.right) - Math.max(box.left, a.left);
        const put = (side, gap, line) => {
            const ag = Math.abs(gap), cur = best[side];
            // 按绝对值取最近邻；同距优先分离侧。负值表示两物件重叠的深度
            if (!cur || ag < Math.abs(cur.gap) || (ag === Math.abs(cur.gap) && gap > cur.gap)) {
                best[side] = Object.assign({ side, gap, otherId: o.id }, line);
            }
        };
        // 垂直方向有投影重叠才比较水平间距，反之亦然，避免斜对角误报；
        // 左右/上下按中心方位分配，因此重叠物件也会得到带符号的相对间距
        if (oy > 2) {
            const my = (Math.max(box.top, a.top) + Math.min(box.bottom, a.bottom)) / 2;
            if (a.cx < box.cx) put('left', box.left - a.right, { axis: 'h', x1: a.right, x2: box.left, y: my });
            else put('right', a.left - box.right, { axis: 'h', x1: box.right, x2: a.left, y: my });
        }
        if (ox > 2) {
            const mx = (Math.max(box.left, a.left) + Math.min(box.right, a.right)) / 2;
            if (a.cy < box.cy) put('top', box.top - a.bottom, { axis: 'v', x: mx, y1: a.bottom, y2: box.top });
            else put('bottom', a.top - box.bottom, { axis: 'v', x: mx, y1: box.bottom, y2: a.top });
        }
    });
    return ['left', 'right', 'top', 'bottom'].map(s => best[s]).filter(Boolean);
}
/* -------------------- 边缘对齐差（橙色标注，0=对齐，可编辑） -------------------- */
const ALIGN_EDGE_NAME = { top: '顶边', bottom: '底边', left: '左边', right: '右边' };
/** 与最近水平/垂直邻居的四边对齐差：不要求投影重叠，斜向邻居也能数值对齐 */
function alignmentMeasures(box, elements, excludeIds) {
    let h = null, v = null;
    elements.forEach(o => {
        if (excludeIds.includes(o.id) || o.visible === false) return;
        const a = getAABB(o);
        const dh = Math.abs(a.cx - box.cx), dv = Math.abs(a.cy - box.cy);
        if (!h || dh < h.d) h = { o, a, d: dh };
        if (!v || dv < v.d) v = { o, a, d: dv };
    });
    // 每个方向只保留差值更小的一条边，避免四个数字同时出现造成干扰
    const out = [];
    if (h && h.d > 1e-6) {
        const right = h.a.cx > box.cx;
        const mx = ((right ? box.right : h.a.right) + (right ? h.a.left : box.left)) / 2;
        const cand = [
            { otherId: h.o.id, edge: 'top', delta: round2(box.top - h.a.top), line: { axis: 'v', x: mx, y1: box.top, y2: h.a.top } },
            { otherId: h.o.id, edge: 'bottom', delta: round2(box.bottom - h.a.bottom), line: { axis: 'v', x: mx, y1: box.bottom, y2: h.a.bottom } }
        ];
        out.push(cand[Math.abs(cand[1].delta) < Math.abs(cand[0].delta) ? 1 : 0]);
    }
    if (v && v.d > 1e-6) {
        const below = v.a.cy > box.cy;
        const my = ((below ? box.bottom : v.a.bottom) + (below ? v.a.top : box.top)) / 2;
        const cand = [
            { otherId: v.o.id, edge: 'left', delta: round2(box.left - v.a.left), line: { axis: 'h', x1: box.left, x2: v.a.left, y: my } },
            { otherId: v.o.id, edge: 'right', delta: round2(box.right - v.a.right), line: { axis: 'h', x1: box.right, x2: v.a.right, y: my } }
        ];
        out.push(cand[Math.abs(cand[1].delta) < Math.abs(cand[0].delta) ? 1 : 0]);
    }
    return out;
}
/** 编辑对齐差：选区沿对应轴平移，使指定边缘与目标边缘相差 v（0=完全对齐） */
function applyAlignDelta(a, v) {
    const o = getEl(a.otherId);
    const b = selectionAABB();
    if (!o || !b) return;
    const aa = getAABB(o);
    const d = round2(round2(v) - (b[a.edge] - aa[a.edge]));
    if (a.edge === 'top' || a.edge === 'bottom') moveSelected(0, d);
    else moveSelected(d, 0);
}
function applyNeighborGap(g, v) {
    const o = getEl(g.otherId);
    const b = selectionAABB();
    if (!o || !b) return;
    const a = getAABB(o);
    if (g.side === 'left') moveSelected(round2(a.right + v - b.left), 0);
    else if (g.side === 'right') moveSelected(round2(a.left - v - b.right), 0);
    else if (g.side === 'top') moveSelected(0, round2(a.bottom + v - b.top));
    else moveSelected(0, round2(a.top - v - b.bottom));
}
/* -------------------- 标尺辅助线：几何 / 渲染 / 交互 / 双向测距 -------------------- */
function currentGuide() {
    return state.guideSel ? (state.model.guides || []).find(g => g.id === state.guideSel) || null : null;
}
/** 辅助线 = 过锚点 (x,y)、方向角 angle 的无限直线；n 为单位法向量，c 为法向偏移 */
function guideGeom(g) {
    const rad = g.angle * Math.PI / 180;
    const n = { x: -Math.sin(rad), y: Math.cos(rad) };
    return { n, c: n.x * g.x + n.y * g.y, dir: { x: Math.cos(rad), y: Math.sin(rad) } };
}
function guideAxis(g) {
    const m = ((g.angle % 180) + 180) % 180;
    if (Math.abs(m) < 1e-6) return 'h';
    if (Math.abs(m - 90) < 1e-6) return 'v';
    return null;
}
/** 包围盒到辅助线的垂直距离：分离时取最近角点，穿过时距离 0 并保留中心偏移符号 */
function boxGuideMeasure(box, g) {
    const { n, c } = guideGeom(g);
    const pts = [{ x: box.left, y: box.top }, { x: box.right, y: box.top },
        { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom }];
    let dmin = Infinity, dmax = -Infinity, pmin = pts[0], pmax = pts[0];
    pts.forEach(p => {
        const d = n.x * p.x + n.y * p.y - c;
        if (d < dmin) { dmin = d; pmin = p; }
        if (d > dmax) { dmax = d; pmax = p; }
    });
    if (dmin >= 0) return { dist: dmin, sign: 1, ext: dmin, from: pmin, to: { x: pmin.x - dmin * n.x, y: pmin.y - dmin * n.y }, n };
    if (dmax <= 0) return { dist: -dmax, sign: -1, ext: dmax, from: pmax, to: { x: pmax.x - dmax * n.x, y: pmax.y - dmax * n.y }, n };
    const center = { x: box.cx, y: box.cy };
    const sc = n.x * center.x + n.y * center.y - c;
    const sign = sc >= 0 ? 1 : -1;
    return { dist: 0, sign, ext: sign > 0 ? dmin : dmax, from: center, to: { x: center.x - sc * n.x, y: center.y - sc * n.y }, n };
}
function nearestGuidesToBox(box, limit) {
    if (!state.settings || state.settings.guideLines === false) return [];
    return (state.model.guides || []).map(g => ({ g, m: boxGuideMeasure(box, g) }))
        .sort((a, b) => a.m.dist - b.m.dist).slice(0, limit);
}
function nearestObjectsToGuide(g) {
    const sides = { 1: null, '-1': null };
    state.model.elements.forEach(o => {
        if (o.visible === false) return;
        const m = boxGuideMeasure(getAABB(o), g);
        const cur = sides[m.sign];
        if (!cur || m.dist < cur.m.dist) sides[m.sign] = { o, m };
    });
    return [sides[1], sides['-1']].filter(Boolean);
}
/** 编辑物件↔辅助线距离：沿法向平移选区，使最近边落到目标距离 */
function applyObjectGuideDistance(g, v) {
    const b = selectionAABB();
    if (!b) return;
    const m = boxGuideMeasure(b, g);
    const t = m.sign * Math.max(0, round2(v)) - m.ext;
    moveSelected(round2(m.n.x * t), round2(m.n.y * t));
}
/** 编辑辅助线↔物件距离：沿法向平移辅助线本身 */
function applyGuideDistance(g, v, otherId) {
    const o = getEl(otherId);
    if (!o) return;
    const m = boxGuideMeasure(getAABB(o), g);
    const t = m.ext - m.sign * Math.max(0, round2(v));
    g.x = round2(g.x + m.n.x * t);
    g.y = round2(g.y + m.n.y * t);
    drawGuides();
    drawMeasure();
    scheduleCommit(160);
}
function guideSegPath(m, g, zoom, pan) {
    const X = v => round2(v * zoom + pan.x), Y = v => round2(v * zoom + pan.y);
    const { dir } = guideGeom(g);
    const t = 4, dx = dir.x * t, dy = dir.y * t;
    const x1 = X(m.from.x), y1 = Y(m.from.y), x2 = X(m.to.x), y2 = Y(m.to.y);
    return `M ${round2(x1 - dx)} ${round2(y1 - dy)} L ${round2(x1 + dx)} ${round2(y1 + dy)} M ${x1} ${y1} L ${x2} ${y2} M ${round2(x2 - dx)} ${round2(y2 - dy)} L ${round2(x2 + dx)} ${round2(y2 + dy)}`;
}
const guideNodeMap = new Map();
function drawGuides() {
    const layer = $('guideLayer');
    if (!layer) return;
    const guides = state.settings && state.settings.guideLines === false ? [] : (state.model.guides || []);
    const vp = $('viewport');
    const L = vp.clientWidth + vp.clientHeight + 400;
    const seen = new Set();
    guides.forEach(g => {
        seen.add(g.id);
        let d = guideNodeMap.get(g.id);
        if (!d) {
            d = document.createElement('div');
            d.className = 'guide-line';
            d.dataset.id = g.id;
            layer.appendChild(d);
            guideNodeMap.set(g.id, d);
        }
        const ax = g.x * state.zoom + state.pan.x, ay = g.y * state.zoom + state.pan.y;
        d.style.width = L + 'px';
        d.style.left = (ax - L / 2) + 'px';
        d.style.top = (ay - 4) + 'px';
        d.style.transform = 'rotate(' + g.angle + 'deg)';
        const axis = guideAxis(g);
        d.style.cursor = axis === 'h' ? 'ns-resize' : axis === 'v' ? 'ew-resize' : 'move';
        d.classList.toggle('selected', state.guideSel === g.id);
        d.classList.toggle('deleting', !!(state.interaction && state.interaction.kind === 'guidemove' &&
            state.interaction.id === g.id && state.interaction.deleteHint));
        d.title = '辅助线：拖动移动，拖回标尺删除；双击设置角度';
    });
    guideNodeMap.forEach((d, id) => {
        if (!seen.has(id)) { d.remove(); guideNodeMap.delete(id); }
    });
    drawGuideCtrl();
}
/** 选中辅助线的浮动控制条：角度输入 + 删除按钮，贴在线的视口中心投影处 */
function drawGuideCtrl() {
    let ctrl = $('guideCtrl');
    const g = currentGuide();
    if (!g || (state.settings && state.settings.guideLines === false)) {
        if (ctrl) ctrl.remove();
        return;
    }
    if (!ctrl) {
        ctrl = document.createElement('div');
        ctrl.id = 'guideCtrl';
        ctrl.className = 'guide-ctrl';
        const lab = document.createElement('span'); lab.className = 'gc-label'; lab.textContent = '∠';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '1'; inp.className = 'gc-angle';
        inp.setAttribute('aria-label', '辅助线角度（度）');
        const deg = document.createElement('span'); deg.className = 'gc-label'; deg.textContent = '°';
        const del = document.createElement('button');
        del.className = 'gc-del'; del.title = '删除辅助线 (Delete)';
        del.appendChild(iconEl('trash'));
        ctrl.append(lab, inp, deg, del);
        inp.addEventListener('input', () => {
            const gd = currentGuide();
            const v = finite(inp.value, null);
            if (!gd || v === null) return;
            gd.angle = clamp(round2(v), -36000, 36000);
            drawGuides(); drawMeasure(); scheduleCommit(160);
        });
        inp.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') inp.blur();
        });
        del.addEventListener('click', e => { e.stopPropagation(); deleteGuide(state.guideSel); });
        ctrl.addEventListener('pointerdown', e => e.stopPropagation());
        ctrl.addEventListener('dblclick', e => e.stopPropagation());
        $('viewport').appendChild(ctrl);
    }
    const inp = ctrl.querySelector('.gc-angle');
    if (document.activeElement !== inp) inp.value = String(round2(g.angle));
    const vp = $('viewport');
    const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
    const { n } = guideGeom(g);
    const ax = g.x * state.zoom + state.pan.x, ay = g.y * state.zoom + state.pan.y;
    const s = n.x * (cx - ax) + n.y * (cy - ay);
    // 窄屏下检查器是覆盖画布的抽屉，浮控需留在其左侧可见区
    let rightLimit = vp.clientWidth - 80;
    const insp = $('inspector');
    if (insp && !insp.classList.contains('collapsed') && getComputedStyle(insp).position === 'absolute') {
        const ir = insp.getBoundingClientRect(), vr = vp.getBoundingClientRect();
        if (ir.left < vr.right && ir.right > vr.left) rightLimit = Math.min(rightLimit, ir.left - vr.left - 56);
    }
    ctrl.style.left = clamp(cx - s * n.x, 80, Math.max(80, rightLimit)) + 'px';
    ctrl.style.top = clamp(cy - s * n.y + 12, 8, vp.clientHeight - 36) + 'px';
}
function selectGuide(id) {
    state.guideSel = id;
    state.selection = [];
    applySelectionClasses();
    updateUI();
}
function deleteGuide(id, skipCommit) {
    const arr = state.model.guides || [];
    const i = arr.findIndex(g => g.id === id);
    if (i < 0) return;
    arr.splice(i, 1);
    if (state.guideSel === id) state.guideSel = null;
    drawGuides();
    updateUI();
    if (!skipCommit) commit();
}
function isOverRuler(clientX, clientY) {
    if (!state.settings.rulers) return false;
    return ['rulerH', 'rulerV'].some(id => {
        const r = $(id).getBoundingClientRect();
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
}
function drawMeasure() {
    const layer = $('measureLayer');
    if (!layer) return;
    if (layer.querySelector('.measure-input')) return;   // 编辑中不重绘，避免输入框被销毁
    layer.textContent = '';
    if (!state.settings || !state.settings.guides) return;
    const guideSel = currentGuide();
    if (guideSel) { drawGuideSelectionMeasure(layer, guideSel); return; }
    if (!state.selection.length) return;
    const box = selectionAABB();
    if (!box) return;
    const single = state.selection.length === 1 ? getEl(state.selection[0]) : null;
    const locked = !!(single && single.locked);
    const z = state.zoom || 1;
    const X = v => round2(v * z + state.pan.x), Y = v => round2(v * z + state.pan.y);
    const cw = state.model.canvas.w, ch = state.model.canvas.h;

    /* ---- 基础构件：尺寸线层（先建保证在标签之下）、药丸标签 ---- */
    const lineLayer = cls => {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'measure-lines' + (cls ? ' ' + cls : ''));
        svg.setAttribute('aria-hidden', 'true');
        layer.appendChild(svg);
        return d => {
            if (!d) return;
            const p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        };
    };
    const sizeLine = lineLayer('size-lines');
    const sizeExt = lineLayer('size-lines ext');
    const gapLine = lineLayer('');
    const alignLine = lineLayer('align-lines');
    const guideLine = lineLayer('guide-lines');
    const marginLine = lineLayer('margin-lines');

    const pending = [];
    const addTag = (cls, fill, cx, cy, opt) => {
        const d = document.createElement('div');
        d.className = 'measure-tag' + (cls ? ' ' + cls : '');
        d.style.left = cx + 'px';
        d.style.top = cy + 'px';
        fill(d);
        if (opt && opt.title) d.title = opt.title;
        layer.appendChild(d);
        pending.push({ d, cx, cy, mode: (opt && opt.mode) || 'above' });
        return d;
    };
    const tagKey = (d, k) => {
        const s = document.createElement('span');
        s.className = 'measure-key';
        s.textContent = k;
        d.appendChild(s);
    };
    // 只读（锁定）时输出纯文本，否则输出可点击编辑的数值
    const tagVal = (d, value, apply, label, title) => {
        if (locked) return measureText(d, String(Math.round(value)));
        return measureNum(d, Math.round(value), apply, label, title);
    };

    /* ---- 1. 自身尺寸：贴着物件自身边缘的 W / H 尺寸线（旋转后随物件倾斜） ---- */
    const sizeW = single ? single.w : box.w;
    const sizeH = single ? lineHeightFor(single) : box.h;
    const angle = single ? ((Math.round(single.rotation) % 360) + 360) % 360 : 0;
    const rotated = !!(single && angle !== 0);
    const rot = rotated ? rotatorWorld(single) : null;
    // 物件四角（屏幕坐标）：多选或未旋转时等价于 AABB
    const corner = (() => {
        if (!single) {
            return [{ x: X(box.left), y: Y(box.top) }, { x: X(box.right), y: Y(box.top) },
                { x: X(box.right), y: Y(box.bottom) }, { x: X(box.left), y: Y(box.bottom) }];
        }
        const a = single.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        const P = pivotWorld(single);
        const px = single.pivotX * single.w, py = single.pivotY * sizeH;
        return [[0, 0], [single.w, 0], [single.w, sizeH], [0, sizeH]].map(([lx, ly]) => {
            const dx = lx - px, dy = ly - py;
            return {
                x: X(P.x + dx * cos - dy * sin),
                y: Y(P.y + dx * sin + dy * cos)
            };
        });
    })();
    const rad = single ? single.rotation * Math.PI / 180 : 0;
    const upN = { x: Math.sin(rad), y: -Math.cos(rad) };      // 顶边外法线（屏幕方向）
    const leftN = { x: -Math.cos(rad), y: -Math.sin(rad) };   // 左边外法线
    const off = 18;
    const [cTL, cTR, cBR, cBL] = corner;
    // 尺寸线过分贴近视口边缘时翻到对侧，延伸线同步跟随
    const normal = (p, n, s) => ({ x: p.x + n.x * off * s, y: p.y + n.y * off * s });
    const vw = $('viewport').clientWidth;
    let wA0 = cTL, wB0 = cTR;
    let wA = normal(wA0, upN, 1), wB = normal(wB0, upN, 1);
    if (Math.min(wA.y, wB.y) < 12) {
        wA0 = cBL; wB0 = cBR;
        wA = normal(wA0, upN, -1); wB = normal(wB0, upN, -1);
    }
    let hA0 = cTL, hB0 = cBL;
    let hA = normal(hA0, leftN, 1), hB = normal(hB0, leftN, 1);
    if (Math.min(hA.x, hB.x) < 12 || Math.max(hA.x, hB.x) > vw - 12) {
        hA0 = cTR; hB0 = cBR;
        hA = normal(hA0, leftN, -1); hB = normal(hB0, leftN, -1);
    }
    sizeLine(measureDimSeg(wA.x, wA.y, wB.x, wB.y));
    // 延伸线：把尺寸线端点接回物件角点，旋转后也能看清对应哪条边
    sizeExt(`M ${round2(wA0.x)} ${round2(wA0.y)} L ${round2(wA.x)} ${round2(wA.y)} M ${round2(wB0.x)} ${round2(wB0.y)} L ${round2(wB.x)} ${round2(wB.y)}`);
    const tW = rotated ? 0.28 : 0.5;
    addTag('', d => {
        tagKey(d, 'W');
        tagVal(d, sizeW, v => measureApplySize('w', v), '宽度');
    }, round2(wA.x + (wB.x - wA.x) * tW), round2(wA.y + (wB.y - wA.y) * tW),
        { mode: 'center', title: '宽度：点击数值可直接修改（↑↓ 微调，Shift 加速）' });

    sizeLine(measureDimSeg(hA.x, hA.y, hB.x, hB.y));
    sizeExt(`M ${round2(hA0.x)} ${round2(hA0.y)} L ${round2(hA.x)} ${round2(hA.y)} M ${round2(hB0.x)} ${round2(hB0.y)} L ${round2(hB.x)} ${round2(hB.y)}`);
    addTag('', d => {
        tagKey(d, 'H');
        if (single && single.type === 'line') {
            const s = measureText(d, String(Math.round(sizeH)));
            s.title = '线条显示高度由粗细决定，请在「线条样式」中调整粗细';
        } else tagVal(d, sizeH, v => measureApplySize('h', v), '高度');
    }, round2((hA.x + hB.x) / 2), round2((hA.y + hB.y) / 2),
        { mode: 'center', title: '高度：点击数值可直接修改（↑↓ 微调，Shift 加速）' });

    if (rotated) {
        const rx = X(rot.x), ry = Y(rot.y);
        addTag('', d => {
            tagKey(d, '∠');
            if (locked) measureText(d, angle + '°');
            else {
                measureNum(d, angle, v => { $('geoR').value = v; updateGeo('r'); }, '旋转角度');
                measureText(d, '°');
            }
        }, rx, ry - 24, { mode: 'center', title: '旋转角度：点击数值可直接修改' });
    }
    /* ---- 2. 相邻物件间距（近处才标注，避免远处长线干扰） ---- */
    const gaps = neighborGapsFor(box, state.model.elements, state.selection)
        .filter(g => Math.abs(g.gap) * z <= MEASURE_LIMIT.gap)
        .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
    gaps.forEach(g => {
        gapLine(g.axis === 'h'
            ? measureDimH(X(g.x1), X(g.x2), Y(g.y))
            : measureDimV(X(g.x), Y(g.y1), Y(g.y2)));
        const ax = g.axis === 'h' ? (X(g.x1) + X(g.x2)) / 2 : X(g.x);
        const ay = g.axis === 'h' ? Y(g.y) : (Y(g.y1) + Y(g.y2)) / 2;
        const other = getEl(g.otherId);
        const nm = other ? other.name : '相邻物件';
        const title = `与「${nm}」的${GAP_SIDE_NAME[g.side]}侧间距` + (g.gap < 0 ? '（负值表示重叠）' : '') + '：点击数值可直接修改';
        addTag('gap', d => {
            tagKey(d, GAP_ARROW[g.side]);
            tagVal(d, g.gap, v => applyNeighborGap(g, v), title);
        }, round2(ax), round2(ay), { mode: 'above', title });
    });

    /* ---- 3. 边缘对齐差（0 时显示绿色“对齐”徽标） ---- */
    const aligns = alignmentMeasures(box, state.model.elements, state.selection)
        .filter(a => Math.abs(a.delta) * z <= MEASURE_LIMIT.align);
    aligns.forEach(a => {
        const lenPx = (a.line.axis === 'h' ? Math.abs(X(a.line.x2) - X(a.line.x1)) : Math.abs(Y(a.line.y2) - Y(a.line.y1)));
        const aligned = Math.abs(a.delta) < 0.5;
        if (!aligned && lenPx > 6) {
            alignLine(a.line.axis === 'h'
                ? measureDimH(X(a.line.x1), X(a.line.x2), Y(a.line.y), 3)
                : measureDimV(X(a.line.x), Y(a.line.y1), Y(a.line.y2), 3));
        }
        const ax = a.line.axis === 'h' ? (X(a.line.x1) + X(a.line.x2)) / 2 : X(a.line.x);
        const ay = a.line.axis === 'h' ? Y(a.line.y) : (Y(a.line.y1) + Y(a.line.y2)) / 2;
        const other = getEl(a.otherId);
        const title = `与「${other ? other.name : ''}」${ALIGN_EDGE_NAME[a.edge]}对齐差` +
            (aligned ? '（已对齐）' : '（0=对齐，负=偏上/偏左）：点击数值可直接修改');
        addTag('adist' + (aligned ? ' aligned' : ''), d => {
            if (aligned) { tagKey(d, '✓'); measureText(d, '对齐'); }
            else { tagKey(d, 'Δ'); tagVal(d, a.delta, v => applyAlignDelta(a, v), title); }
        }, round2(ax), round2(ay), { mode: 'above', title });
    });

    /* ---- 4. 与辅助线的垂直距离 ---- */
    nearestGuidesToBox(box, 2).filter(({ m }) => m.dist * z <= MEASURE_LIMIT.guide).forEach(({ g, m }) => {
        guideLine(guideSegPath(m, g, z, state.pan));
        const ax = (X(m.from.x) + X(m.to.x)) / 2, ay = (Y(m.from.y) + Y(m.to.y)) / 2;
        addTag('gdist', d => {
            tagKey(d, '↔');
            tagVal(d, m.dist, v => applyObjectGuideDistance(g, v), '与辅助线的垂直距离');
        }, round2(ax), round2(ay), { mode: 'above', title: '与辅助线的垂直距离：点击数值可直接修改' });
    });

    /* ---- 5. 画布边距（远距离用短引线，避免横穿整幅画布） ---- */
    if (single) {
        const moveBy = (dx, dy) => moveSelected(round2(dx), round2(dy));
        const spec = [
            { k: '左', v: box.left, dir: 'left', label: '左边距',
              apply: v => moveBy(v - selectionAABB().left, 0) },
            { k: '右', v: cw - box.right, dir: 'right', label: '右边距',
              apply: v => moveBy((cw - v) - selectionAABB().right, 0) },
            { k: '上', v: box.top, dir: 'top', label: '上边距',
              apply: v => moveBy(0, v - selectionAABB().top) },
            { k: '下', v: ch - box.bottom, dir: 'bottom', label: '下边距',
              apply: v => moveBy(0, (ch - v) - selectionAABB().bottom) }
        ].filter(m => m.v > 0.4);
        const nearest = spec.slice().sort((a, b) => a.v - b.v).slice(0, 2);
        spec.forEach(m => {
            const near = m.v * z <= MEASURE_LIMIT.margin;
            if (!near && nearest.indexOf(m) < 0) return;
            const len = near ? m.v : Math.min(56 / z, m.v * 0.85);
            let p1, p2;
            if (m.dir === 'left') { p1 = { x: box.left - len, y: box.cy }; p2 = { x: box.left, y: box.cy }; }
            else if (m.dir === 'right') { p1 = { x: box.right, y: box.cy }; p2 = { x: box.right + len, y: box.cy }; }
            else if (m.dir === 'top') { p1 = { x: box.cx, y: box.top - len }; p2 = { x: box.cx, y: box.top }; }
            else { p1 = { x: box.cx, y: box.bottom }; p2 = { x: box.cx, y: box.bottom + len }; }
            const x1 = X(p1.x), x2 = X(p2.x), y1 = Y(p1.y), y2 = Y(p2.y);
            if (m.dir === 'left' || m.dir === 'right') marginLine(measureDimH(x1, x2, y1, 3));
            else marginLine(measureDimV(x1, y1, y2, 3));
            addTag('margin', d => {
                tagKey(d, m.k);
                tagVal(d, m.v, m.apply, m.label);
            }, round2((x1 + x2) / 2), round2((y1 + y2) / 2),
                { mode: 'above', title: m.label + '（到画布边缘）：点击数值可直接修改' });
        });
    }

    // 统一排版：尺寸标签优先占位，其余标签依次避让
    const seeds = [];
    if (rotated && rot) {
        const rx = X(rot.x), ry = Y(rot.y);
        seeds.push({ l: rx - 9, r: rx + 9, t: ry - 9, b: ry + 9 });
    }
    layoutMeasureTags(pending, seeds);
}

/** 选中辅助线：显示法向两侧最近物件的距离，编辑时移动辅助线本身 */
function drawGuideSelectionMeasure(layer, g) {
    const near = nearestObjectsToGuide(g);
    if (!near.length) return;
    const z = state.zoom || 1;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'measure-lines guide-lines');
    svg.setAttribute('aria-hidden', 'true');
    near.forEach(({ m }) => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', guideSegPath(m, g, z, state.pan));
        svg.appendChild(p);
    });
    layer.appendChild(svg);
    const seeds = [];
    const ctrl = $('guideCtrl');
    if (ctrl) {
        const vr = $('viewport').getBoundingClientRect();
        const cr = ctrl.getBoundingClientRect();
        seeds.push({ l: cr.left - vr.left, r: cr.right - vr.left, t: cr.top - vr.top, b: cr.bottom - vr.top });
    }
    const pending = [];
    near.forEach(({ o, m }) => {
        const label = '辅助线与「' + o.name + '」的距离';
        const d = document.createElement('div');
        d.className = 'measure-tag gdist';
        const k = document.createElement('span');
        k.className = 'measure-key';
        k.textContent = '↔';
        d.appendChild(k);
        measureNum(d, Math.round(m.dist), v => applyGuideDistance(g, v, o.id), label);
        d.title = label + '：点击数值可直接修改';
        layer.appendChild(d);
        pending.push({
            d,
            cx: ((m.from.x + m.to.x) / 2) * z + state.pan.x,
            cy: ((m.from.y + m.to.y) / 2) * z + state.pan.y,
            mode: 'above'
        });
    });
    layoutMeasureTags(pending, seeds);
}

/* -------------------- N5 描边 / 阴影 / 混合模式 -------------------- */
function syncStyleControls() {
    const el = selectedEls()[0];
    if (!el) return;
    const st = el.stroke || makeStroke(null), sh = el.shadow || makeShadow(null);
    $('strokeColor').value = st.color; $('strokeWidth').value = st.width;
    $('strokeWidthVal').textContent = st.width; $('strokeStyle').value = st.style;
    $('blendMode').value = el.blendMode || 'normal';
    $('shadowEnabled').checked = !!sh.enabled; $('shadowColor').value = sh.color;
    $('shadowX').value = sh.x; $('shadowXVal').textContent = sh.x;
    $('shadowY').value = sh.y; $('shadowYVal').textContent = sh.y;
    $('shadowBlur').value = sh.blur; $('shadowBlurVal').textContent = sh.blur;
    $('elAlphaInput').value = Math.round((el.fill.alpha === undefined ? 1 : el.fill.alpha) * 100);
    $('elAlphaVal').textContent = $('elAlphaInput').value + '%';
    $('elColorHex').value = el.fill.color.toUpperCase();
}
function applyStyleChange() {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    const st = makeStroke({ color: $('strokeColor').value, width: $('strokeWidth').value, style: $('strokeStyle').value });
    const sh = makeShadow({ enabled: $('shadowEnabled').checked, color: $('shadowColor').value,
        x: $('shadowX').value, y: $('shadowY').value, blur: $('shadowBlur').value });
    const blend = $('blendMode').value;
    $('strokeWidthVal').textContent = st.width;
    $('shadowXVal').textContent = sh.x; $('shadowYVal').textContent = sh.y; $('shadowBlurVal').textContent = sh.blur;
    els.forEach(e => {
        e.stroke = Object.assign({}, st); e.shadow = Object.assign({}, sh); e.blendMode = blend;
        syncElement(e.id);
    });
    scheduleCommit();
}
function applyFillAlpha() {
    const v = clamp(finite($('elAlphaInput').value, 100), 0, 100) / 100;
    $('elAlphaVal').textContent = Math.round(v * 100) + '%';
    selectedEls().filter(e => !e.locked && e.type !== 'line' && e.type !== 'curve').forEach(e => {
        e.fill.alpha = v; if (e.type !== 'text') syncElement(e.id);
    });
    scheduleCommit();
}

/* -------------------- N6 颜色与素材 -------------------- */
function renderSwatches() {
    const recent = $('recentColors'), preset = $('presetColors');
    if (!recent || !preset || !state.settings) return;
    recent.textContent = ''; preset.textContent = '';
    const make = (color, host) => {
        const b = document.createElement('button');
        b.className = 'swatch'; b.style.background = color;
        b.title = color; b.dataset.color = color; b.setAttribute('aria-label', '使用颜色 ' + color);
        b.addEventListener('click', () => applySwatch(color));
        host.appendChild(b);
    };
    const rec = state.settings.recentColors.length ? state.settings.recentColors : PRESET_COLORS.slice(0, 8);
    rec.forEach(c => make(c, recent));
    PRESET_COLORS.concat(state.settings.palette).forEach(c => make(c, preset));
    syncBucketSwatch();
}
function applySwatch(color) {
    if (!HEX_RE.test(color)) return;
    useColor(color);
    // 颜料桶模式下色板只设定当前激活色槽的颜色，不改动选中元素或画布背景
    if (state.tool === 'bucket') {
        const slot = state.bucketSlot || 'fill';
        setBucketColor(slot, color);
        toast('已设为' + bucketSlotLabel(slot) + '色 ' + color.toUpperCase(), 'success');
        return;
    }
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) {
        $('bgColorPicker').value = color;
        $('bgColorHex').value = color.toUpperCase();
        updateCanvasBg();
        toast('已应用到画布背景', 'success');
        return;
    }
    els.forEach(e => {
        if (e.type === 'line' || e.type === 'curve') e.line.color = color;
        else { e.fill.color = color; if (e.type === 'text') e.text.runs.forEach(r => { r.color = ''; }); }
        syncElement(e.id);
    });
    $('elColorInput').value = color; $('elColorHex').value = color.toUpperCase();
    scheduleCommit();
    toast('已应用到 ' + els.length + ' 个元素', 'success');
}
function addSwatch() {
    const c = $('customSwatch').value;
    if (!HEX_RE.test(c)) return;
    if (!state.settings.palette.includes(c.toUpperCase())) state.settings.palette.push(c.toUpperCase());
    saveSettings(); renderSwatches(); toast('已加入色板', 'success');
}
async function eyedropper() {
    if (typeof window.EyeDropper !== 'function') {
        toast('当前浏览器不支持屏幕吸管，请直接在色板中选取颜色', 'error'); return;
    }
    try {
        const result = await new window.EyeDropper().open();
        if (result && HEX_RE.test(result.sRGBHex)) applySwatch(result.sRGBHex);
    } catch (e) { /* 用户取消 */ }
}
function applyHexInput(id, targetId, onApply) {
    const input = $(id);
    input.addEventListener('change', () => {
        let v = input.value.trim();
        if (!v.startsWith('#')) v = '#' + v;
        if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v.slice(1).split('').map(ch => ch + ch).join('');
        if (!HEX_RE.test(v)) { toast('请输入有效的 6 位十六进制颜色', 'error'); input.value = $(targetId).value.toUpperCase(); return; }
        v = v.toUpperCase(); input.value = v; $(targetId).value = v;
        onApply(v);
    });
}
function insertPresetShape(p) {
    const el = buildElement(p.type, 0, 0);
    const pos = canvasCenterFor(p.w, p.h);
    el.x = round2(pos.x); el.y = round2(pos.y);
    el.w = p.w; el.h = p.h;
    el.fill = makeFill({ mode: 'solid', color: p.color });
    el.borderRadius = p.radius || 0;
    if (p.stroke) el.stroke = makeStroke({ width: 2, color: p.stroke });
    if (p.type === 'line' || p.type === 'curve') el.line = makeLine({ width: 3, color: p.color });
    state.model.elements.push(el);
    renderAll(); setSelection([el.id]); commit(); useColor(p.color);
    toast('已插入 ' + p.label, 'success');
}
function insertPresetText(p) {
    const el = buildElement('text', 0, 0);
    const pos = canvasCenterFor(300, Math.max(40, p.size * 1.6));
    el.x = round2(pos.x); el.y = round2(pos.y);
    el.w = 300; el.h = Math.max(40, p.size * 1.6);
    el.text = makeText({ fontSize: p.size, fontWeight: p.weight, runs: [{ text: p.label }] });
    el.fill = makeFill({ mode: 'solid', color: p.color });
    state.model.elements.push(el);
    renderAll(); setSelection([el.id]); commit(); useColor(p.color);
    startTextEdit(el);
}
function renderAssetPresets() {
    const sg = $('shapePresets'), tg = $('textPresets');
    if (!sg || !tg) return;
    sg.textContent = ''; tg.textContent = '';
    SHAPE_PRESETS.forEach((p, i) => {
        const b = document.createElement('button');
        b.className = 'asset-item'; b.title = '插入' + p.label;
        b.appendChild(iconEl(TYPE_ICONS[p.type]));
        const span = document.createElement('span'); span.textContent = p.label;
        b.appendChild(span);
        b.addEventListener('click', () => insertPresetShape(p));
        sg.appendChild(b);
    });
    TEXT_PRESETS.forEach(p => {
        const b = document.createElement('button');
        b.className = 'text-preset';
        const t = document.createElement('span');
        t.textContent = p.label; t.style.fontSize = Math.min(p.size, 22) + 'px';
        t.style.fontWeight = String(p.weight); t.style.color = p.color;
        const lab = document.createElement('span'); lab.className = 'text-preset-label'; lab.textContent = p.size + 'px';
        b.appendChild(t); b.appendChild(lab);
        b.addEventListener('click', () => insertPresetText(p));
        tg.appendChild(b);
    });
}

/* ==================== 23. 动作分发（data-act 事件委托） ==================== */
const ACTIONS = {
    undo: () => undo(),
    redo: () => redo(),
    zoom: arg => adjustZoom(Number(arg)),
    resetView: () => resetView(),
    fitToScreen: () => fitToScreen(),
    toggleCanvasLock: () => toggleCanvasLock(),
    align: arg => alignElements(arg),
    distribute: arg => distributeElements(arg),
    boolean: arg => performBoolean(arg),
    addShape: arg => addShape(arg),
    addImage: () => addImage(),
    toggleLock: () => toggleLock(),
    toggleSelectionLock: () => toggleSelectionLock(),
    duplicateSelected: () => duplicateSelected(),
    centerOnCanvas: () => centerOnCanvas(),
    deleteSelected: () => deleteSelected(),
    textStyle: arg => updateTextStyle(arg),
    textAlign: arg => updateTextAlign(arg),
    layer: arg => layerAction(arg),
    relLayer: arg => startRelLayer(arg),
    exportConfig: () => exportConfig(),
    importConfig: () => importConfig(),
    showExportModal: () => showExportModal(),
    doExport: () => doExport(),
    resetToDefault: () => resetToDefault(),
    closeModal: arg => closeModal(arg),
    cropConfirm: () => cropConfirm(),
    replaceImage: () => replaceImage(),
    dialogOk: () => dialogOk(),
    dialogCancel: () => dialogCancel(),
    // ---- V12 新增动作 ----
    toggleTheme: () => toggleTheme(),
    toggleGrid: () => toggleSetting('grid', '网格'),
    toggleRulers: () => toggleSetting('rulers', '标尺'),
    toggleGuideLines: () => { toggleSetting('guideLines', '辅助线'); drawGuides(); drawMeasure(); },
    toggleSnap: () => toggleSetting('snap', '智能吸附'),
    toggleGuides: () => toggleSetting('guides', '尺寸标注'),
    toggleInspector: () => toggleInspector(),
    setTool: arg => setTool(arg),
    groupSelected: () => groupSelected(),
    ungroupSelected: () => ungroupSelected(),
    collapseAllGroups: () => collapseAllGroups(),
    renameSelected: () => renameSelected(),
    selectAll: () => setSelection(expandGroupIds(state.model.elements.map(e => e.id))),
    copyClipboard: () => copyToClipboardSystem(),
    pasteClipboard: () => pasteFromClipboardSystem(),
    newProject: () => newProject(),
    createVersion: () => createVersion(),
    showShortcuts: () => showShortcuts(),
    showAbout: () => showAbout(),
    runSelfTest: () => runSelfTest(),
    eyedropper: () => eyedropper(),
    addSwatch: () => addSwatch(),
    toggleCard: arg => toggleCard(arg),
    setLineStyle: arg => setLineStyle(arg),
    setWavyDash: arg => setWavyDash(arg),
    curveOp: arg => curveOp(arg),
    resetPivot: () => resetPivot()
};

/* -------------------- N1 图层面板 -------------------- */
function layerIcon(el) { return iconEl(el.groupId ? 'group' : (TYPE_ICONS[el.type] || 'square')); }
function renderLayerList() {
    const host = $('layerList');
    if (!host || !state.model) return;
    const q = ($('layerSearch').value || '').trim().toLowerCase();
    host.textContent = '';
    const list = sortedElements().slice().reverse();
    const filtered = list.filter(e => !q || (e.name || '').toLowerCase().includes(q) || (TYPE_LABELS[e.type] || '').includes(q));
    $('layerCountBadge').textContent = state.model.elements.length;
    if (!filtered.length) {
        const d = document.createElement('div'); d.className = 'layer-empty';
        d.textContent = q ? '没有匹配的图层' : '画布上还没有元素';
        host.appendChild(d); return;
    }
    const sel = new Set(state.selection);
    filtered.forEach(el => {
        const row = document.createElement('div');
        row.className = 'layer-row' + (sel.has(el.id) ? ' selected' : '') + (el.visible ? '' : ' hidden-layer');
        row.dataset.id = el.id; row.draggable = true;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(sel.has(el.id)));
        row.tabIndex = 0;
        if (el.groupId) {
            const ind = document.createElement('div'); ind.className = 'group-indent'; row.appendChild(ind);
        }
        const thumb = document.createElement('div'); thumb.className = 'layer-thumb';
        thumb.appendChild(layerIcon(el)); row.appendChild(thumb);
        const meta = document.createElement('div'); meta.className = 'layer-meta';
        const nm = document.createElement('div'); nm.className = 'layer-name'; nm.textContent = el.name || TYPE_LABELS[el.type];
        const sub = document.createElement('div'); sub.className = 'layer-sub';
        sub.textContent = `${TYPE_LABELS[el.type] || el.type} · ${Math.round(el.w)}×${Math.round(el.h)}` + (el.groupId ? ' · 组内' : '');
        meta.appendChild(nm); meta.appendChild(sub); row.appendChild(meta);
        const act = document.createElement('div'); act.className = 'layer-actions';
        const mk = (icon, title, fn, danger) => {
            const b = document.createElement('button'); b.className = 'layer-mini' + (danger ? ' danger' : '');
            b.title = title; b.setAttribute('aria-label', title); b.appendChild(iconEl(icon));
            b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
            act.appendChild(b); return b;
        };
        mk(el.visible ? 'eye' : 'eye-off', el.visible ? '隐藏图层' : '显示图层', () => toggleLayerVisible(el.id));
        mk(el.locked ? 'lock' : 'unlock', el.locked ? '解锁图层' : '锁定图层', () => toggleLayerLock(el.id));
        mk('tag', '重命名', () => renameLayer(el.id));
        mk('trash', '删除图层', () => deleteLayer(el.id), true);
        row.appendChild(act);
        row.addEventListener('click', e => {
            const ids = e.ctrlKey || e.metaKey ? state.selection.slice() : [];
            const i = ids.indexOf(el.id);
            if (i >= 0) ids.splice(i, 1); else ids.push(el.id);
            setSelection(expandGroupIds(ids));
            setInspectorFolded(false);
            switchTab('layers');
        });
        row.addEventListener('dblclick', () => renameLayer(el.id));
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
            else if (e.key === 'Delete') { e.preventDefault(); deleteLayer(el.id); }
        });
        row.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', el.id);
            e.dataTransfer.effectAllowed = 'move';
            row.style.opacity = '.5';
        });
        row.addEventListener('dragend', () => { row.style.opacity = ''; });
        row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
            e.preventDefault(); row.classList.remove('drag-over');
            const srcId = e.dataTransfer.getData('text/plain');
            if (srcId && srcId !== el.id) reorderLayer(srcId, el.id);
        });
        host.appendChild(row);
    });
}
function reorderLayer(srcId, targetId) {
    const order = sortedElements();
    const from = order.findIndex(e => e.id === srcId);
    if (from < 0) return;
    const [moved] = order.splice(from, 1);
    const to = order.findIndex(e => e.id === targetId);
    order.splice(to < 0 ? order.length : to, 0, moved);
    normalizeZFromOrder(order);
    renderAll(); applySelectionClasses(); commit();
    toast('图层顺序已调整', 'success');
}
function toggleLayerVisible(id) {
    const el = getEl(id); if (!el) return;
    el.visible = !el.visible; syncElement(id); renderLayerList(); commit();
}
function toggleLayerLock(id) {
    const el = getEl(id); if (!el) return;
    el.locked = !el.locked; syncElement(id); renderLayerList(); updateUI(); commit();
}
async function renameLayer(id) {
    const el = getEl(id); if (!el) return;
    const name = await appPrompt('输入图层名称：', el.name || TYPE_LABELS[el.type], { title: '重命名图层' });
    if (!name) return;
    el.name = name.trim().slice(0, 80) || el.name;
    renderLayerList(); commit(); toast('已重命名', 'success');
}
function renameSelected() {
    if (state.selection.length !== 1) { toast('请先选中一个图层', 'error'); return; }
    renameLayer(state.selection[0]);
}
function deleteLayer(id) {
    const el = getEl(id); if (!el) return;
    if (el.locked) { toast('图层已锁定，无法删除', 'error'); return; }
    state.model.elements = state.model.elements.filter(e => e.id !== id);
    state.selection = state.selection.filter(x => x !== id);
    renderAll(); updateUI(); commit();
}

/* -------------------- N2 组合 / 解组 -------------------- */
function expandGroupIds(ids) {
    const out = new Set(ids);
    const groups = new Set(ids.map(getEl).filter(Boolean).map(e => e.groupId).filter(Boolean));
    if (!groups.size) return ids.slice();
    state.model.elements.forEach(e => { if (groups.has(e.groupId)) out.add(e.id); });
    return Array.from(out);
}
function groupSelected() {
    const els = selectedEls();
    if (els.length < 2) { toast('请至少选中两个元素再组合', 'error'); return; }
    const gid = uid('grp');
    els.forEach(e => { e.groupId = gid; syncElement(e.id); });
    renderAll(); applySelectionClasses(); commit();
    toast(`已将 ${els.length} 个元素组合`, 'success');
}
function ungroupSelected() {
    const els = selectedEls().filter(e => !!e.groupId);
    if (!els.length) { toast('选中的元素不在组合中', 'error'); return; }
    els.forEach(e => { e.groupId = null; syncElement(e.id); });
    renderAll(); applySelectionClasses(); commit();
    toast(`已解组 ${els.length} 个元素`, 'success');
}
function collapseAllGroups() {
    const ids = expandGroupIds(state.selection.length ? state.selection : state.model.elements.map(e => e.id));
    setSelection(ids); setInspectorFolded(false); switchTab('layers');
    toast('已展开全部组合', 'success');
}

/* -------------------- N4 SVG / PDF / 批量导出 -------------------- */
function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fillDefs(id, f) {
    if (f.mode === 'solid') return { def: '', ref: hexToRgba(f.color, finite(f.alpha, 1)) };
    const a = finite(f.alpha, 1), s = hexToRgba(f.start, a), e = hexToRgba(f.end, a);
    if (f.mode === 'linear') {
        const rad = f.angle * Math.PI / 180, dx = Math.sin(rad) * 50, dy = -Math.cos(rad) * 50;
        return { def: `<linearGradient id="${id}" x1="${50 - dx}%" y1="${50 - dy}%" x2="${50 + dx}%" y2="${50 + dy}%"><stop offset="0" stop-color="${s}"/><stop offset="1" stop-color="${e}"/></linearGradient>`, ref: `url(#${id})` };
    }
    if (f.mode === 'radial') return { def: `<radialGradient id="${id}" cx="${f.posX}%" cy="${f.posY}%" r="75%"><stop offset="0" stop-color="${s}"/><stop offset="1" stop-color="${e}"/></radialGradient>`, ref: `url(#${id})` };
    return { def: `<linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0" stop-color="${s}"/><stop offset="1" stop-color="${e}"/></linearGradient>`, ref: `url(#${id})` };
}
function shapeSVG(el, ref) {
    const st = el.stroke && el.stroke.width > 0
        ? ` stroke="${el.stroke.color}" stroke-width="${el.stroke.width}"${el.stroke.style === 'dashed' ? ' stroke-dasharray="8 5"' : el.stroke.style === 'dotted' ? ' stroke-dasharray="2 4"' : ''}` : '';
    if (el.type === 'circle') return `<ellipse cx="${el.w / 2}" cy="${el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" fill="${ref}"${st}/>`;
    if (POLYGON_POINTS[el.type]) {
        const pts = POLYGON_POINTS[el.type].map(([x, y]) => `${x * el.w / 100},${y * el.h / 100}`).join(' ');
        return `<polygon points="${pts}" fill="${ref}"${st}/>`;
    }
    return `<rect x="0" y="0" width="${el.w}" height="${el.h}" rx="${el.type === 'circle' ? el.w / 2 : el.borderRadius}" fill="${ref}"${st}/>`;
}
function buildSVG(opts) {
    const b = opts.bounds, els = opts.elements;
    const defs = [], masks = [];
    const body = [];
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
        const transform = `translate(${tx + px} ${ty + py}) rotate(${el.rotation}) translate(${-px} ${-py})`;
        const opacity = ` opacity="${el.opacity}"`;
        const blend = el.blendMode && el.blendMode !== 'normal' ? ` style="mix-blend-mode:${el.blendMode}"` : '';
        const shadow = el.shadow && el.shadow.enabled
            ? `<filter id="sh${i}"><feDropShadow dx="${el.shadow.x}" dy="${el.shadow.y}" stdDeviation="${el.shadow.blur / 3}" flood-color="${el.shadow.color}" flood-opacity="0.72"/></filter>` : '';
        if (shadow) defs.push(shadow);
        const filter = shadow ? ` filter="url(#sh${i})"` : '';
        let inner = '';
        if (el.type === 'text') {
            const t = el.text;
            const ctx = textMeasureCtx();
            const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, t, run, text));
            const lh = t.fontSize * t.lineHeight;
            const spans = [];
            lines.forEach((tokens, li) => {
                const total = tokens.reduce((a, tok) => a + tok.w, 0);
                const gaps = tokens.length - 1;
                const justify = t.align === 'justify' && li < lines.length - 1 && !lines[li].forcedEnd && gaps > 0;
                const extra = justify ? (el.w - total) / gaps : 0;
                let x = t.align === 'center' ? (el.w - total) / 2 : t.align === 'right' ? el.w - total : 0;
                const y = round2(li * lh);
                tokens.forEach(tok => {
                    const r = tok.run;
                    const attrs = ` x="${round2(x)}" y="${y}"`;
                    const weight = r.bold ? 700 : t.fontWeight;
                    const style = r.italic ? ' font-style="italic"' : '';
                    const deco = r.underline ? ' text-decoration="underline"' : '';
                    const fill = r.color ? ` fill="${r.color}"` : '';
                    spans.push(`<tspan${attrs} font-weight="${weight}"${style}${deco}${fill}>${xmlEscape(tok.text)}</tspan>`);
                    x += tok.w + extra;
                });
            });
            inner = `<text font-family="${xmlEscape(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}" letter-spacing="${t.letterSpacing}" fill="${hexToRgba(el.fill.color, finite(el.fill.alpha, 1))}" dominant-baseline="text-before-edge">${spans.join('')}</text>`;
        } else if (el.type === 'line') {
            const ln = el.line, y = h / 2;
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
            const ln = el.line;
            const dash = ln.style === 'dashed' ? ` stroke-dasharray="${ln.width * 3} ${ln.width * 2}"`
                : ln.style === 'dotted' ? ` stroke-dasharray="0.1 ${ln.width * 1.8}"` : '';
            const fd = curveFillOn(el) ? fillDefs('g' + i, el.fill) : null;
            if (fd && fd.def) defs.push(fd.def);
            inner = `<path d="${curvePathD(el.curve, el.w, el.h)}" fill="${fd ? fd.ref : 'none'}" stroke="${ln.color}" stroke-width="${curveStrokeOn(el) ? ln.width : 0}" stroke-linecap="round"${dash}/>`;
        } else if (el.image && state.assets[el.image.assetId]) {
            inner = `<image x="0" y="0" width="${el.w}" height="${el.h}" preserveAspectRatio="none" href="${state.assets[el.image.assetId]}"/>`;
        } else {
            const f = fillDefs('g' + i, el.fill);
            defs.push(f.def);
            inner = shapeSVG(el, f.ref);
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
function buildPDF(jpegDataURL, w, h) {
    const base64 = String(jpegDataURL).split(',')[1] || '';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const enc = new TextEncoder();
    const chunks = [];
    const objOffsets = [0, 0, 0, 0, 0, 0];
    let length = 0;
    const push = (data) => {
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
async function batchExport(name, format, transparent, quality) {
    const list = sortedElements().filter(e => e.exportVisible && e.visible);
    if (!list.length) { toast('画布上没有可导出的元素', 'error'); return; }
    toast(`开始批量导出 ${list.length} 个图层…`, 'success');
    for (let i = 0; i < list.length; i++) {
        const el = list[i];
        const a = getAABB(el);
        const bounds = { x: Math.max(0, a.left - 4), y: Math.max(0, a.top - 4), w: a.w + 8, h: a.h + 8 };
        try {
            if (format === 'svg') {
                const svg = buildSVG({ bounds, elements: [el], transparent: true });
                downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}_${i + 1}_${el.name || el.type}.svg`);
            } else {
                const c = await renderModelToCanvas(2, { transparent: transparent && format !== 'jpeg' && format !== 'pdf',
                    opaqueBackground: (format === 'jpeg' || format === 'pdf') ? '#ffffff' : null, bounds, elements: [el] });
                const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
                let blob = await canvasToBlob(c, mime, quality);
                if (mime === 'image/webp' && blob.type !== 'image/webp') blob = await canvasToBlob(c, 'image/png');
                downloadBlob(blob, `${name}_${i + 1}_${el.name || el.type}.${format === 'jpeg' ? 'jpg' : format}`);
            }
        } catch (err) { console.warn('批量导出单项失败', err.message); }
        await new Promise(r => setTimeout(r, 260));
    }
    toast(`批量导出完成，共 ${list.length} 个文件`, 'success');
    $('exportModal').style.display = 'none';
}
function updateExportSummary() {
    const s = $('exportSummary'), hint = $('exportHint');
    if (!s) return;
    const fmt = $('exportFormat').value, scope = $('exportScope').value;
    const b = exportBoundsFor(scope);
    const fmtLabel = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', svg: 'SVG', pdf: 'PDF' }[fmt] || fmt;
    const scopeLabel = { canvas: '整个画布', selection: '仅选中元素', batch: '按图层批量' }[scope];
    s.textContent = b ? `将导出 ${fmtLabel} · ${scopeLabel} · 内容尺寸 ${Math.round(b.w)}×${Math.round(b.h)}` : '请先选中要导出的元素';
    if (hint) hint.textContent = scope === 'batch' ? '批量导出会依次下载多个文件，请允许浏览器多文件下载' : '';
    const qRow = $('exportQualityRow');
    if (qRow) qRow.style.display = (fmt === 'jpeg' || fmt === 'webp' || fmt === 'pdf') ? 'flex' : 'none';
    $('exportTransparent').disabled = (fmt === 'jpeg' || fmt === 'pdf');
    if (fmt === 'svg') { $('exportW').disabled = true; s.textContent += '（矢量，宽度固定为内容尺寸）'; }
    else $('exportW').disabled = false;
}

/* -------------------- N8 多项目与版本快照 -------------------- */
let projectSaveTimer = null;
function queueProjectSave() {
    clearTimeout(projectSaveTimer);
    projectSaveTimer = setTimeout(() => persistCurrentProject(), 700);
}
async function persistCurrentProject() {
    if (!state.projectId || !state.model) return;
    const ok = await storePut(DB_PROJECTS, {
        id: state.projectId, name: state.projectName, updated: Date.now(), data: snapshotJSON()
    });
    if (!ok) toast('项目列表保存失败，请用「保存项目」导出文件备份', 'error');
}
async function ensureProjectId() {
    if (state.projectId) return;
    const items = await storeAll(DB_PROJECTS);
    if (items.length) {
        items.sort((a, b) => b.updated - a.updated);
        state.projectId = items[0].id; state.projectName = items[0].name;
    } else {
        state.projectId = uid('prj');
        state.projectName = state.model && state.model.name ? state.model.name : '未命名设计';
    }
    state.settings.projectId = state.projectId;
    state.settings.projectName = state.projectName;
    saveSettings(); await persistCurrentProject();
}
async function renderProjectPanels() {
    await ensureProjectId();
    renderProjectList(); renderVersionList();
}
function renderProjectList() {
    const host = $('projectList'); if (!host) return;
    storeAll(DB_PROJECTS).then(items => {
        host.textContent = '';
        items.sort((a, b) => b.updated - a.updated);
        if (!items.length) {
            const d = document.createElement('div'); d.className = 'list-empty'; d.textContent = '暂无其他项目'; host.appendChild(d); return;
        }
        items.forEach(p => {
            const row = document.createElement('div');
            row.className = 'project-row' + (p.id === state.projectId ? ' current' : '');
            const ic = document.createElement('div'); ic.className = 'project-icon'; ic.appendChild(iconEl('folder'));
            const meta = document.createElement('div'); meta.className = 'project-meta';
            const t = document.createElement('div'); t.className = 'project-title'; t.textContent = p.name;
            const sub = document.createElement('div'); sub.className = 'project-sub';
            sub.textContent = new Date(p.updated).toLocaleString('zh-CN');
            meta.appendChild(t); meta.appendChild(sub);
            row.appendChild(ic); row.appendChild(meta);
            if (p.id !== state.projectId) {
                const open = document.createElement('button'); open.className = 'mini-btn'; open.textContent = '打开';
                open.addEventListener('click', () => switchProject(p.id)); row.appendChild(open);
            } else {
                const cur = document.createElement('span'); cur.className = 'mini-btn'; cur.textContent = '当前'; row.appendChild(cur);
            }
            const ren = document.createElement('button'); ren.className = 'mini-btn'; ren.title = '重命名'; ren.textContent = '改名';
            ren.addEventListener('click', () => renameProject(p.id, p.name)); row.appendChild(ren);
            const del = document.createElement('button'); del.className = 'mini-btn danger'; del.title = '删除'; del.textContent = '删';
            del.addEventListener('click', () => deleteProject(p.id, p.name)); row.appendChild(del);
            host.appendChild(row);
        });
    });
}
function renderVersionList() {
    const host = $('versionList'); if (!host) return;
    storeAll(DB_VERSIONS).then(items => {
        host.textContent = '';
        const mine = items.filter(v => v.projectId === state.projectId).sort((a, b) => b.created - a.created);
        if (!mine.length) {
            const d = document.createElement('div'); d.className = 'list-empty'; d.textContent = '还没有版本快照'; host.appendChild(d); return;
        }
        mine.forEach(v => {
            const row = document.createElement('div'); row.className = 'version-row';
            const ic = document.createElement('div'); ic.className = 'version-icon'; ic.appendChild(iconEl('snapshot'));
            const meta = document.createElement('div'); meta.className = 'version-meta';
            const t = document.createElement('div'); t.className = 'version-title'; t.textContent = v.name;
            const sub = document.createElement('div'); sub.className = 'version-sub';
            sub.textContent = new Date(v.created).toLocaleString('zh-CN');
            meta.appendChild(t); meta.appendChild(sub);
            row.appendChild(ic); row.appendChild(meta);
            const rest = document.createElement('button'); rest.className = 'mini-btn'; rest.textContent = '恢复';
            rest.addEventListener('click', () => restoreVersion(v.id, v.name)); row.appendChild(rest);
            const del = document.createElement('button'); del.className = 'mini-btn danger'; del.textContent = '删';
            del.addEventListener('click', () => deleteVersion(v.id)); row.appendChild(del);
            host.appendChild(row);
        });
    });
}
async function newProject() {
    const name = await appPrompt('新项目名称：', '未命名设计', { title: '新建项目' });
    if (!name) return;
    await persistCurrentProject();
    state.projectId = uid('prj'); state.projectName = name.trim() || '未命名设计';
    state.settings.projectId = state.projectId; state.settings.projectName = state.projectName; saveSettings();
    state.model = defaultModel(); state.model.name = state.projectName;
    state.selection = []; undoStack = [snapshotJSON()]; historyIndex = 0;
    renderAll(); syncCanvasSize(); syncBackgroundControls(); resetView(); updateUI(); saveAuto(undoStack[0]);
    await persistCurrentProject(); renderProjectPanels();
    toast('已新建项目：' + state.projectName, 'success');
}
async function switchProject(id) {
    const ok = await appConfirm('切换项目会载入该项目的画布，当前未导出的更改会自动保存。继续吗？', { title: '切换项目' });
    if (!ok) return;
    await persistCurrentProject();
    const items = await storeAll(DB_PROJECTS);
    const p = items.find(x => x.id === id);
    if (!p) { toast('项目不存在', 'error'); return; }
    state.projectId = p.id; state.projectName = p.name;
    state.settings.projectId = p.id; state.settings.projectName = p.name; saveSettings();
    applySnapshot(p.data, true);
    undoStack = [snapshotJSON()]; historyIndex = 0; saveAuto(undoStack[0]);
    renderProjectPanels(); toast('已切换到：' + p.name, 'success');
}
async function renameProject(id, oldName) {
    const name = await appPrompt('项目名称：', oldName, { title: '重命名项目' });
    if (!name) return;
    const items = await storeAll(DB_PROJECTS);
    const p = items.find(x => x.id === id); if (!p) return;
    p.name = name.trim() || p.name; p.updated = Date.now();
    await storePut(DB_PROJECTS, p);
    if (id === state.projectId) {
        state.projectName = p.name; state.model.name = p.name;
        state.settings.projectName = p.name; saveSettings(); refreshStudioUI();
    }
    renderProjectList(); toast('已重命名', 'success');
}
async function deleteProject(id, name) {
    if (id === state.projectId) { toast('不能删除当前项目，请先切换到其他项目', 'error'); return; }
    const ok = await appConfirm(`确定删除项目「${name}」吗？此操作不可撤销。`, { title: '删除项目' });
    if (!ok) return;
    await storeDelete(DB_PROJECTS, id);
    const versions = await storeAll(DB_VERSIONS);
    for (const v of versions.filter(v => v.projectId === id)) await storeDelete(DB_VERSIONS, v.id);
    renderProjectList(); toast('项目已删除', 'success');
}
async function createVersion() {
    await ensureProjectId();
    const name = await appPrompt('版本名称：', '版本 ' + new Date().toLocaleString('zh-CN'), { title: '创建版本快照' });
    if (!name) return;
    const ok = await storePut(DB_VERSIONS, {
        id: uid('ver'), projectId: state.projectId, name: name.trim() || '版本快照',
        created: Date.now(), data: snapshotJSON()
    });
    if (!ok) { toast('版本保存失败，请检查浏览器存储权限', 'error'); return; }
    renderVersionList(); toast('版本快照已创建', 'success');
}
async function restoreVersion(id, name) {
    const ok = await appConfirm(`确定恢复到「${name}」吗？当前画布内容会被替换（可用撤销前的自动保存备份）。`, { title: '恢复版本' });
    if (!ok) return;
    const items = await storeAll(DB_VERSIONS);
    const v = items.find(x => x.id === id); if (!v) { toast('版本不存在', 'error'); return; }
    applySnapshot(v.data, true);
    undoStack = [snapshotJSON()]; historyIndex = 0; saveAuto(undoStack[0]);
    toast('已恢复版本：' + name, 'success');
}
async function deleteVersion(id) {
    const ok = await appConfirm('确定删除这个版本快照吗？', { title: '删除版本' });
    if (!ok) return;
    await storeDelete(DB_VERSIONS, id); renderVersionList(); toast('版本已删除', 'success');
}

function bindDelegates() {
    document.addEventListener('click', e => {
        const node = e.target.closest('[data-act]');
        if (!node) return;
        const fn = ACTIONS[node.dataset.act];
        if (!fn) return;
        if (node.disabled) return;
        e.preventDefault();
        fn(node.dataset.arg, node, e);
    });
    // 防失焦：颜色输入与 B/I/U/对齐按钮在按下时不抢焦点
    document.addEventListener('mousedown', e => {
        if (e.target.closest('[data-keepfocus]')) e.preventDefault();
    });

    const handlers = {
        canvasW: () => resizeCanvasSize('w'),
        canvasH: () => resizeCanvasSize('h'),
        moveStep: () => { state.moveStep = clamp(finite($('moveStep').value, 1), 1, 1000); },
        geoX: () => updateGeo('x'),
        geoY: () => updateGeo('y'),
        geoW: () => updateGeo('w'),
        geoH: () => updateGeo('h'),
        geoR: () => updateGeo('r'),
        pivotXInput: () => updatePivotInput('x'),
        pivotYInput: () => updatePivotInput('y'),
        chkExportVisible: () => toggleExportVisibility(),
        elBgType: () => toggleElBgMode(),
        elColorInput: () => updateElementColor(),
        elGradStart: () => updateElementBackground(),
        elGradEnd: () => updateElementBackground(),
        elGradAngle: () => updateElementBackground('slider'),
        elGradAngleInput: () => updateElementBackground('number'),
        elGradPosX: () => updateElementBackground(),
        elGradPosY: () => updateElementBackground(),
        opacityInput: () => updateElementOpacity(),
        borderRadiusInput: () => updateElementRadius(),
        lineWidthRange: () => updateLineStyle('slider'),
        lineWidthInput: () => updateLineStyle('number'),
        wavyAmpRange: () => updateLineStyle('wavySlider'),
        wavyAmpInput: () => updateLineStyle('wavyNumber'),
        fontFamilyInput: () => updateTextStyle('font'),
        fontWeightInput: () => updateTextStyle('weight'),
        textSizeMode: () => updateTextSizeMode(),
        fontSizeInput: () => updateTextStyle('size'),
        lineHeightInput: () => updateTextStyle('lineHeight'),
        letterSpacingInput: () => updateTextStyle('spacing'),
        // V12 新增控件
        strokeColor: () => applyStyleChange(),
        strokeWidth: () => applyStyleChange(),
        strokeStyle: () => applyStyleChange(),
        blendMode: () => applyStyleChange(),
        shadowEnabled: () => applyStyleChange(),
        shadowColor: () => applyStyleChange(),
        shadowX: () => applyStyleChange(),
        shadowY: () => applyStyleChange(),
        shadowBlur: () => applyStyleChange(),
        elAlphaInput: () => applyFillAlpha(),
        curveFillEnabled: () => updateCurveFill(),
        curveFillMode: () => updateCurveFill(),
        curveFillColor: () => updateCurveFill(),
        curveFillGradStart: () => updateCurveFill(),
        curveFillGradEnd: () => updateCurveFill(),
        curveFillAngle: () => updateCurveFill(),
        curveFillAlpha: () => updateCurveFill(),
        curveStrokeEnabled: () => updateCurveStroke(),
        curveStrokeColor: () => updateCurveStroke(),
        exportFormat: () => updateExportSummary(),
        exportScope: () => updateExportSummary(),
        exportQuality: () => { $('exportQualityVal').textContent = $('exportQuality').value; updateExportSummary(); },
        exportTransparent: () => updateExportSummary(),
        exportW: () => updateExportSummary(),
        alignBase: () => { state.alignBase = $('alignBase').value; state.settings.alignBase = state.alignBase; saveSettings(); },
        bgType: () => toggleBgMode(),
        bgColorPicker: () => updateCanvasBg(),
        gradStart: () => updateCanvasBg(),
        gradEnd: () => updateCanvasBg(),
        gradAngle: () => updateCanvasBg('slider'),
        gradAngleInput: () => updateCanvasBg('number'),
        gradPosX: () => updateCanvasBg(),
        gradPosY: () => updateCanvasBg()
    };
    // 按控件类型分配：select/checkbox 只走 change，其余只走 input，避免双触发
    const dispatch = (e, allow) => {
        const t = e.target;
        if (!t || !t.id) return;
        const isChoice = t.tagName === 'SELECT' || t.type === 'checkbox';
        if (isChoice !== allow) return;
        const fn = handlers[t.id];
        if (fn) fn();
    };
    document.addEventListener('input', e => dispatch(e, false));
    document.addEventListener('change', e => dispatch(e, true));

    [['bucketFillSlot', 'fill'], ['bucketStrokeSlot', 'stroke']].forEach(([id, slot]) => {
        const n = $(id);
        if (n) n.addEventListener('click', e => { e.stopPropagation(); openBucketPicker(slot); });
    });
    const bucketColor = $('bucketColorInput');
    if (bucketColor) bucketColor.addEventListener('change', () => setBucketColor(state.bucketSlot || 'fill', bucketColor.value));
    document.addEventListener('mouseleave', () => { if (state.tool === 'bucket') hideBucketHover(); });

    $('imageInput').addEventListener('change', e => handleImageUpload(e.target));
    $('cropFileInput').addEventListener('change', e => handleCropFile(e.target));
    $('appDialogInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); dialogOk(); }
    });
    ['cropModal', 'exportModal', 'appDialog', 'shortcutsModal', 'selftestModal', 'aboutModal'].forEach(id => {
        $(id).addEventListener('pointerdown', e => {
            if (e.target.id === id) {
                if (id === 'appDialog') dialogCancel();
                else closeModal(id);
            }
        });
    });

    // 标签页切换（折叠卡片由 ACTIONS.toggleCard 统一处理，避免双重触发）
    document.querySelectorAll('.inspector-tabs .tab').forEach(t => {
        t.addEventListener('click', () => {
            const name = t.dataset.tab;
            // 点击当前标签：收起/展开面板；点击其他标签：展开并切换
            if (state.activeTab === name) { setInspectorFolded(!state.settings.inspectorFolded); return; }
            setInspectorFolded(false);
            switchTab(name);
        });
    });
    $('btnInspectorFold').addEventListener('click', () => setInspectorFolded(!state.settings.inspectorFolded));
    // 图层搜索
    $('layerSearch').addEventListener('input', () => renderLayerList());
    // 颜色十六进制输入
    applyHexInput('elColorHex', 'elColorInput', () => {
        updateElementColor(); useColor($('elColorInput').value);
    });
    applyHexInput('bgColorHex', 'bgColorPicker', () => updateCanvasBg());
    $('bgColorPicker').addEventListener('input', () => { $('bgColorHex').value = $('bgColorPicker').value.toUpperCase(); });
    $('elColorInput').addEventListener('input', () => { $('elColorHex').value = $('elColorInput').value.toUpperCase(); });
    // 自定义色板与工具
    $('projectChip').addEventListener('click', () => { setInspectorFolded(false); switchTab('projects'); });
    $('statusCoord').addEventListener('click', () => { /* 占位以便键盘可达 */ });
    // 视口坐标跟踪
    $('viewport').addEventListener('pointermove', e => {
        if (isInputActive()) return;
        const w = clientToWorld(e.clientX, e.clientY);
        $('statusCoord').textContent = `X ${Math.round(w.x)} · Y ${Math.round(w.y)}`;
    });
    // 导出摘要随选择变化
    document.addEventListener('click', e => {
        if (e.target.closest('[data-act="showExportModal"]') && typeof updateExportSummary === 'function') updateExportSummary();
    });
    // 菜单触发器（阻止冒泡，避免被全局 click 关闭）
    bindMenus();
}

/* -------------------- N9 系统剪贴板与拖放导入 -------------------- */
function serialFromElements(els) {
    return JSON.stringify({ kind: 'canvas-studio-elements', version: VERSION, elements: els });
}
function elementsFromSerial(text) {
    try {
        const o = JSON.parse(text);
        if (!o || o.kind !== 'canvas-studio-elements' || !Array.isArray(o.elements)) return null;
        const seen = new Set();
        return o.elements.slice(0, 200).map(e => validateElement(e)).map(e => {
            if (seen.has(e.id)) e.id = uid('el'); seen.add(e.id); return e;
        });
    } catch (err) { return null; }
}
async function copyToClipboardSystem() {
    if (!state.selection.length) return;
    state.clipboard = selectedEls().map(deepCopy);
    const text = serialFromElements(state.clipboard);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            toast(`已复制 ${state.clipboard.length} 个元素（可跨项目粘贴）`, 'success');
        } else toast(`已复制 ${state.clipboard.length} 个元素（应用内剪贴板）`, 'success');
    } catch (e) { toast(`已复制 ${state.clipboard.length} 个元素（应用内剪贴板）`, 'success'); }
}
async function pasteFromClipboardSystem() {
    let parsed = null;
    try {
        if (navigator.clipboard && navigator.clipboard.readText) {
            const text = await navigator.clipboard.readText();
            parsed = elementsFromSerial(text);
        }
    } catch (e) { /* 权限受限，回退应用内剪贴板 */ }
    const src = parsed || state.clipboard;
    if (!src || !src.length) { toast('剪贴板中没有可粘贴的元素', 'error'); return; }
    const clones = src.map(e => {
        const c = validateElement(deepCopy(e));
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false; return c;
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
    toast(`已粘贴 ${clones.length} 个元素`, 'success');
}
async function insertImageFileAt(file, clientX, clientY) {
    if (!file || !/^image\//.test(file.type)) return false;
    try {
        const dataURL = await readFileAsDataURL(file);
        const img = await loadImage(dataURL);
        const max = 400;
        let w = img.width, h = img.height;
        if (w > max || h > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
        const assetId = uid('asset');
        await putAsset(assetId, dataURL);
        const el = buildElement('image', 0, 0);
        el.w = w; el.h = h;
        el.image = makeImage({ assetId, originalAssetId: assetId });
        el.name = file.name.slice(0, 60);
        const world = clientX === undefined ? canvasCenterFor(w, h) : clientToWorld(clientX, clientY);
        el.x = round2(world.x - (clientX === undefined ? w / 2 : 0));
        el.y = round2(world.y - (clientX === undefined ? h / 2 : 0));
        state.model.elements.push(el);
        renderAll(); setSelection([el.id]); commit();
        toast('图片已导入，双击可裁剪', 'success');
        return true;
    } catch (err) { toast('图片导入失败：' + err.message, 'error'); return false; }
}
function insertTextAt(text, clientX, clientY) {
    const el = buildElement('text', 0, 0);
    el.text = makeText({ runs: [{ text: String(text).slice(0, 2000) }] });
    const pos = clientX === undefined ? canvasCenterFor(el.w, 60) : clientToWorld(clientX, clientY);
    el.x = round2(pos.x); el.y = round2(pos.y);
    state.model.elements.push(el);
    renderAll(); setSelection([el.id]); commit();
}
function bindDropImport() {
    const vp = $('viewport');
    ['dragenter', 'dragover'].forEach(t => vp.addEventListener(t, e => {
        e.preventDefault(); e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        vp.classList.add('drag-over');
    }));
    vp.addEventListener('dragleave', e => {
        if (!vp.contains(e.relatedTarget)) vp.classList.remove('drag-over');
    });
    vp.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation();
        vp.classList.remove('drag-over');
        const dt = e.dataTransfer; if (!dt) return;
        const files = Array.from(dt.files || []);
        if (files.length) {
            for (const f of files) {
                if (/^image\//.test(f.type)) { await insertImageFileAt(f, e.clientX, e.clientY); continue; }
                if (/\.(canvas|json)$/i.test(f.name) || f.type === 'application/json') { await importProjectFile(f); continue; }
                if (/^text\//.test(f.type) || /\.txt$/i.test(f.name)) {
                    insertTextAt(await f.text(), e.clientX, e.clientY); continue;
                }
                toast('不支持的文件类型：' + f.name, 'error');
            }
            return;
        }
        const text = dt.getData('text/plain');
        if (text) {
            const els = elementsFromSerial(text);
            if (els) { state.clipboard = els; await pasteFromClipboardSystem(); }
            else insertTextAt(text, e.clientX, e.clientY);
        }
    });
}

/* -------------------- N10 触屏与可访问性 -------------------- */
function bindTouch() {
    const vp = $('viewport');
    vp.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        state.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.touchPoints.size === 2) {
            const [a, b] = Array.from(state.touchPoints.values());
            state.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom,
                cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, panX: state.pan.x, panY: state.pan.y };
            state.interaction = null;   // 取消单指拖拽，避免抖动
        }
    });
    vp.addEventListener('pointermove', e => {
        if (e.pointerType !== 'touch' || !state.touchPoints.has(e.pointerId)) return;
        state.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.touchPoints.size === 2 && state.pinch) {
            const [a, b] = Array.from(state.touchPoints.values());
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
            const z = clamp(state.pinch.zoom * (dist / Math.max(1, state.pinch.dist)), MIN_ZOOM, MAX_ZOOM);
            state.pan.x = state.pinch.panX + (cx - state.pinch.cx);
            state.pan.y = state.pinch.panY + (cy - state.pinch.cy);
            state.zoom = z; syncTransform();
        }
    });
    const end = e => {
        state.touchPoints.delete(e.pointerId);
        if (state.touchPoints.size < 2) state.pinch = null;
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
}
function bindAccessibility() {
    document.querySelectorAll('.icon-btn, .action-btn, .rail-btn, .toggle-btn, .tab').forEach(b => {
        if (!b.getAttribute('aria-label') && !b.getAttribute('title') && b.textContent.trim() === '') {
            b.setAttribute('aria-label', b.dataset.act || '按钮');
        }
    });
    $('viewport').setAttribute('aria-label', '设计画布');
    $('layerList').setAttribute('aria-multiselectable', 'true');
    const saved = $('statusSaved');
    if (saved) { saved.setAttribute('role', 'status'); saved.setAttribute('aria-live', 'polite'); }
}

/* -------------------- N11 内置自检 -------------------- */
function runSelfTest() {
    const results = [];
    const check = (name, fn) => {
        try { const detail = fn(); results.push({ name, ok: true, detail: detail || '通过' }); }
        catch (e) { results.push({ name, ok: false, detail: e.message }); }
    };
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
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
        const d = curvePathD(el.curve, el.w, el.h);
        assert(d.startsWith('M ') && d.includes(' C '), '路径数据异常');
        const v = validateElement(el);
        assert(v.type === 'curve' && v.curve.nodes.length === el.curve.nodes.length && v.line, '校验往返丢失曲线');
        // 旧版单段四点曲线存档（v3）自动迁移为两节点路径
        const legacy = validateElement({
            id: 'el_legacy', type: 'curve', x: 0, y: 0, w: 100, h: 100,
            curve: { x1: 0, y1: 1, cx1: 0.3, cy1: 0, cx2: 0.7, cy2: 1, x2: 1, y2: 0 },
            line: { width: 2 }
        });
        assert(legacy.curve.nodes.length === 2 && legacy.curve.nodes[0].ox === 0.3, '旧版曲线未迁移');
        // De Casteljau 分割：插入节点后形状不变（分割点落在曲线上）
        const pts = curveSegPts(legacy.curve.nodes, 0, 1, legacy.w, legacy.h);
        const sp = splitCubic(pts, 0.5);
        const expect = cubicAt(pts[0], pts[1], pts[2], pts[3], 0.5);
        assert(Math.abs(sp.mid.x - expect.x) < 0.001 && Math.abs(sp.mid.y - expect.y) < 0.001, '节点分割点偏离曲线');
        return el.curve.nodes.length + ' 节点 · 兼容旧版·可闭合';
    });
    check('闭合曲线填充', () => {
        const el = buildElement('curve', 0, 0);
        el.curve.closed = true;
        assert(!curveFillOn(el), '旧存档默认应保持只描边');
        el.curve.filled = true;
        el.fill = makeFill({ mode: 'solid', color: '#ff0000' });
        assert(curveFillOn(el), '填充启用标记未生效');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.toLowerCase().includes('fill="#ff0000"'), 'SVG 导出缺少曲线填充');
        const open = buildElement('curve', 0, 0);
        open.curve.filled = true;
        assert(!curveFillOn(open), '开放路径不应填充');
        return '闭合可填充 · 开放只描边 · 旧存档兼容';
    });
    check('颜料桶双色槽与曲线描边', () => {
        const el = buildElement('curve', 0, 0);
        assert(el.curve.strokeOn !== false, '旧存档默认应显示描边');
        el.curve.strokeOn = false;
        assert(!curveStrokeOn(el), '描边开关未生效');
        const svg = buildSVG({ bounds: { x: 0, y: 0, w: el.w, h: el.h }, elements: [el], transparent: true });
        assert(svg.includes('stroke-width="0"'), 'SVG 导出未遵循描边开关');
        assert(HEX_RE.test(bucketColor('fill')) && HEX_RE.test(bucketColor('stroke')), '双色槽取值异常');
        return '填充 / 描边双色 · 描边开关 · 导出一致';
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
        const lines = layoutText(el, el.w, (run, text) => canvasTextWidth(ctx, el.text, run, text));
        assert(lines.length > 1, '长文本未换行');
        el.text.sizeMode = 'autoH';
        applyAutoSize(el);
        assert(el.h >= lines.length * el.text.fontSize * el.text.lineHeight - 1, '自动高度未随内容增长');
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
        const svg = buildSVG({ bounds: exportBoundsFor('canvas'), elements: sortedElements(), transparent: false });
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
        assert(typeof c.getContext('2d').createLinearGradient === 'function', '2D 上下文异常');
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
        assert(el, '没有可编辑的元素');
        const prevSel = state.selection.slice();
        const prevGuides = state.settings.guides;
        const x0 = el.x, w0 = el.w;
        try {
            state.settings.guides = true;
            setSelection([el.id]);
            drawMeasure();
            const nums = document.querySelectorAll('#measureLayer .measure-num');
            assert(nums.length >= 3, '可编辑数值数量不足');
            nums[0].click();
            const input = document.querySelector('#measureLayer .measure-input');
            assert(input, '点击数值未打开输入框');
            input.value = String(w0 + 123);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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
        const mk = (id, x, y) => ({ id, type: 'rect', x, y, w: 100, h: 100, rotation: 0, pivotX: 0.5, pivotY: 0.5, visible: true });
        const box = { left: 200, top: 200, right: 300, bottom: 300, cx: 250, cy: 250 };
        const els = [mk('L', 50, 200), mk('R', 350, 220), mk('R2', 500, 220), mk('T', 220, 60), mk('B', 240, 380),
            mk('D', 900, 900), Object.assign(mk('H', 350, 200), { visible: false })];
        const by = {};
        neighborGapsFor(box, els, []).forEach(g => { by[g.side] = g; });
        assert(by.left && by.left.gap === 50 && by.left.otherId === 'L', '左间距错误');
        assert(by.right && by.right.gap === 50 && by.right.otherId === 'R', '右间距应取最近邻');
        assert(by.top && by.top.gap === 40 && by.top.otherId === 'T', '上间距错误');
        assert(by.bottom && by.bottom.gap === 80 && by.bottom.otherId === 'B', '下间距错误');
        assert(Object.values(by).every(g => g.otherId !== 'D'), '斜对角不应产生间距');
        const ov = {};
        neighborGapsFor(box, [mk('O', 250, 220)], []).forEach(g => { ov[g.side] = g; });
        assert(ov.right && ov.right.gap === -50 && ov.bottom && ov.bottom.gap === -80, '重叠物件应显示负间距');
        const tie = {};
        neighborGapsFor(box, [mk('O', 250, 220), mk('R', 350, 220)], []).forEach(g => { tie[g.side] = g; });
        assert(tie.right && tie.right.otherId === 'R', '同绝对距离时优先分离侧');
        const ex = neighborGapsFor(box, els, ['L', 'R', 'T', 'B']);
        assert(ex.length === 1 && ex[0].side === 'right' && ex[0].otherId === 'R2' && ex[0].gap === 200, '排除选区后应取次近邻');
        const hiddenOnly = neighborGapsFor(box, [Object.assign(mk('H', 350, 200), { visible: false })], []);
        assert(hiddenOnly.length === 0, '隐藏物件不应参与间距');
        return '四向最近邻 · 重叠负值 · 排除/隐藏/斜对角跳过';
    });
    check('边缘对齐差', () => {
        const mk = (id, x, y, w, h) => ({ id, type: 'rect', x, y, w, h, rotation: 0, pivotX: 0.5, pivotY: 0.5, visible: true });
        const box = { left: 100, top: 300, right: 200, bottom: 304, cx: 150, cy: 302 };
        const al = alignmentMeasures(box, [mk('S', 400, 430, 200, 200)], []);
        const by = {};
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
        const box = { left: 200, top: 200, right: 300, bottom: 300, cx: 250, cy: 250 };
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
        catch (e) { dup = true; }
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
function makeSelfLine(style) {
    return { type: 'line', w: 100, h: 4, line: makeLine({ style, width: 4, wavyAmp: 5 }) };
}

/* -------------------- 快捷键帮助 / 关于 -------------------- */
function renderShortcuts() {
    const host = $('shortcutGrid'); if (!host) return;
    host.textContent = '';
    SHORTCUTS.forEach(([label, key]) => {
        const row = document.createElement('div'); row.className = 'shortcut-row';
        const l = document.createElement('span'); l.textContent = label;
        const k = document.createElement('kbd'); k.textContent = key;
        row.appendChild(l); row.appendChild(k); host.appendChild(row);
    });
}
function showShortcuts() { renderShortcuts(); $('shortcutsModal').style.display = 'flex'; }
function showAbout() { $('aboutModal').style.display = 'flex'; }

/* ==================== 24. 全局快捷键 ==================== */
function isInputActive() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}
function bindHotkeys() {
    document.addEventListener('keydown', e => {
        if (dialogState) {
            if (e.key === 'Escape') { e.preventDefault(); dialogCancel(); }
            return;
        }
        const ctrl = e.ctrlKey || e.metaKey;
        const typing = isInputActive();

        // 编辑态一律让浏览器原生处理，避免文本内撤销误重建画布 / 丢字
        if (typing) {
            if (ctrl && e.key === 'Enter') {
                e.preventDefault();
                if (state.isTextEditing) finishTextEdit();
                else if (document.activeElement) document.activeElement.blur();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (state.isTextEditing) finishTextEdit();
                else if ($('exportModal').style.display === 'flex') closeModal('exportModal');
                else if (document.activeElement) document.activeElement.blur();
            }
            return;
        }
        if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
        if (ctrl && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
        if (e.altKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) { e.preventDefault(); fitToScreen(); return; }
        if (ctrl && e.code === 'KeyC') { e.preventDefault(); copyToClipboardSystem(); return; }
        if (ctrl && e.code === 'KeyV') { e.preventDefault(); pasteFromClipboardSystem(); return; }
        if (ctrl && e.code === 'KeyA') { e.preventDefault(); setSelection(expandGroupIds(state.model.elements.map(x => x.id))); return; }
        if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicateSelected(); return; }
        if (ctrl && e.code === 'KeyS') { e.preventDefault(); exportConfig(); return; }
        if (ctrl && e.code === 'KeyG') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); return; }
        if (ctrl && e.code === 'Quote') { e.preventDefault(); toggleSetting('grid', '网格'); return; }
        if (ctrl && e.altKey && e.code === 'KeyN') { e.preventDefault(); newProject(); return; }
        if (!ctrl && !e.altKey && e.key === '?') { e.preventDefault(); showShortcuts(); return; }
        if (!ctrl && !e.altKey && (e.key === 'v' || e.key === 'V')) { setTool('select'); return; }
        if (!ctrl && !e.altKey && (e.key === 'h' || e.key === 'H')) { setTool('pan'); return; }
        if (!ctrl && !e.altKey && (e.key === 't' || e.key === 'T')) { setTool('text'); return; }
        if (!ctrl && !e.altKey && (e.key === 'p' || e.key === 'P')) { setTool(state.tool === 'pen' ? 'select' : 'pen'); return; }
        if (!ctrl && !e.altKey && (e.key === 'b' || e.key === 'B')) { setTool('bucket'); return; }
        if (!ctrl && !e.altKey && (e.key === 'r' || e.key === 'R')) { addShape('rect'); return; }
        if (state.pen) {
            if (e.key === 'Enter') { e.preventDefault(); finishPen(false); return; }
            if (e.key === 'Escape') { e.preventDefault(); cancelPen(); return; }
            if (e.key === 'Backspace') {
                e.preventDefault();
                if (state.pen.nodes.length > 1) state.pen.nodes.pop();
                else cancelPen();
                renderPenDraft();
                return;
            }
        }
        if (!ctrl && !e.altKey && (e.key === 'Enter' || e.key === 'F2')) {
            const els = selectedEls();
            if (els.length === 1 && els[0].type === 'text' && !els[0].locked) { e.preventDefault(); startTextEdit(els[0]); }
            return;
        }

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
            if (state.guideSel) {
                const g = currentGuide();
                if (!g) return;
                e.preventDefault();
                const step = state.moveStep * (e.shiftKey ? 10 : 1);
                const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
                const dy = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
                const { n } = guideGeom(g);
                const d = n.x * dx + n.y * dy;   // 只沿法向移动才会改变距离
                g.x = round2(g.x + n.x * d);
                g.y = round2(g.y + n.y * d);
                drawGuides(); drawMeasure(); scheduleCommit(160);
                return;
            }
            if (!state.selection.length) return;
            e.preventDefault();
            const step = state.moveStep * (e.shiftKey ? 10 : 1);
            moveSelected(e.code === 'ArrowUp' ? 0 : e.code === 'ArrowDown' ? 0 : e.code === 'ArrowLeft' ? -step : step,
                e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0);
            return;
        }
        if (e.code === 'Space' && !state.spaceDown) {
            e.preventDefault(); state.spaceDown = true;
            $('viewport').classList.add('panning'); return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (state.guideSel) deleteGuide(state.guideSel);
            else deleteSelected();
            return;
        }
        if (e.key === 'Escape') {
            const openModal = ['shortcutsModal', 'selftestModal', 'aboutModal', 'exportModal', 'cropModal']
                .find(id => $(id) && $(id).style.display === 'flex');
            if (openModal) closeModal(openModal);
            else if (state.layerPick) endRelLayer();
            else if (state.interaction && state.interaction.kind === 'crop') state.interaction = null;
            else deselectAll();
        }
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space') {
            state.spaceDown = false;
            $('viewport').classList.remove('panning');
        }
    });
}

/* ==================== 25. 启动 ==================== */
async function boot() {
    state.settings = loadSettings();
    await openDB();
    const hadLegacy = !!localStorage.getItem(LEGACY_KEY);
    const loaded = await loadAuto();
    if (loaded) {
        undoStack = [snapshotJSON()];
        historyIndex = 0;
        if (hadLegacy) toast('检测到旧版本存档：本次使用全新数据格式，旧存档未加载', 'error');
    } else {
        state.model = defaultModel();
        undoStack = [snapshotJSON()];
        historyIndex = 0;
        saveAuto(undoStack[0]);
        if (hadLegacy) {
            try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
            toast('已启用全新数据格式，旧版本存档不兼容并已清理', 'error');
        }
    }
    state.projectId = state.settings.projectId;
    state.projectName = state.settings.projectName || state.model.name || '未命名设计';
    state.model.name = state.projectName;
    state.activeTab = state.settings.activeTab || 'design';
    syncCanvasSize();
    syncBackgroundControls();
    applyTheme();
    applyViewSettings();
    renderAll();
    fitToScreen();   // 首次打开自动适应屏幕，避免大画布被裁切
    updateUI();
    updateUndoRedoButtons();
    updateGeoLockButton();
    initCanvasInteraction();
    initCropInteraction();
    bindDelegates();
    bindHotkeys();
    bindDropImport();
    bindTouch();
    bindAccessibility();
    setTool('select');
    renderSwatches();
    renderAssetPresets();
    renderShortcuts();
    renderLayerList();
    switchTab(state.activeTab);
    $('inspector').classList.toggle('collapsed', !state.settings.inspectorVisible);
    syncInspectorFold();
    window.addEventListener('resize', () => syncTransform());
    // 检查器收起/展开改变工作区尺寸（不触发 window.resize），用 ResizeObserver 同步标尺与标注
    if (typeof ResizeObserver !== 'undefined') {
        let roQueued = false;
        new ResizeObserver(() => {
            if (roQueued) return;
            roQueued = true;
            requestAnimationFrame(() => { roQueued = false; syncTransform(); });
        }).observe($('viewport'));
    }
    window.addEventListener('beforeunload', () => { clearTimeout(projectSaveTimer); persistCurrentProject(); });
    setTimeout(() => { renderProjectPanels(); }, 300);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();

