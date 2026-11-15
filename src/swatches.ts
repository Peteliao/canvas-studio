import { HEX_RE, PRESET_COLORS, SHAPE_PRESETS, SHADOW_PRESETS, TEXT_PRESETS, TYPE_ICONS } from './constants';
import type { ShapePreset, TextPreset } from './constants';
import { state } from './state';
import { $, clamp, finite, iconEl, round2, toast } from './utils';
import { buildElement, makeFill, makeLine, makeShadow, makeStroke, makeText, selectedEls } from './model';
import { renderAll, syncElement } from './render';
import { commit, scheduleCommit } from './history';
import { canvasCenterFor } from './view';
import { setSelection } from './selection';
import { saveSettings } from './db';
import { bucketSlotLabel, setBucketColor, syncBucketSwatch } from './bucket';
import { updateCanvasBg } from './styles';
import { startTextEdit } from './richtext';
import type { BlendMode, ShadowType } from './types';

interface EyeDropperResult { sRGBHex: string; }
declare global {
    interface Window { EyeDropper?: new () => { open(): Promise<EyeDropperResult> }; }
}

export function useColor(color: string): void {
    if (!HEX_RE.test(color)) return;
    const list = state.settings.recentColors.filter(c => c.toLowerCase() !== color.toLowerCase());
    list.unshift(color.toUpperCase());
    state.settings.recentColors = list.slice(0, 16);
    saveSettings();
    renderSwatches();
    syncBucketSwatch();
}

/* -------------------- N5 描边 / 阴影 / 混合模式 -------------------- */
export function syncStyleControls(): void {
    const el = selectedEls()[0];
    if (!el) return;
    const st = el.stroke || makeStroke(null), sh = el.shadow || makeShadow(null);
    $<HTMLInputElement>('strokeColor').value = st.color; $<HTMLInputElement>('strokeWidth').value = String(st.width);
    $('strokeWidthVal').textContent = String(st.width); $<HTMLSelectElement>('strokeStyle').value = st.style;
    $<HTMLSelectElement>('blendMode').value = el.blendMode || 'normal';
    $<HTMLInputElement>('shadowEnabled').checked = !!sh.enabled; $<HTMLInputElement>('shadowColor').value = sh.color;
    $<HTMLSelectElement>('shadowType').value = sh.type;
    $<HTMLInputElement>('shadowX').value = String(sh.x); $('shadowXVal').textContent = String(sh.x);
    $<HTMLInputElement>('shadowY').value = String(sh.y); $('shadowYVal').textContent = String(sh.y);
    $<HTMLInputElement>('shadowBlur').value = String(sh.blur); $('shadowBlurVal').textContent = String(sh.blur);
    $<HTMLInputElement>('shadowOpacity').value = String(Math.round(sh.opacity * 100)); $('shadowOpacityVal').textContent = Math.round(sh.opacity * 100) + '%';
    syncShadowPolar(sh.x, sh.y);
    syncShadowOffsetRows(sh.type);
    $<HTMLInputElement>('elAlphaInput').value = String(Math.round((el.fill.alpha === undefined ? 1 : el.fill.alpha) * 100));
    $('elAlphaVal').textContent = $<HTMLInputElement>('elAlphaInput').value + '%';
    $<HTMLInputElement>('elColorHex').value = el.fill.color.toUpperCase();
}

export function applyStyleChange(): void {
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) return;
    const st = makeStroke({ color: $<HTMLInputElement>('strokeColor').value, width: $<HTMLInputElement>('strokeWidth').value, style: $<HTMLSelectElement>('strokeStyle').value });
    const sh = makeShadow({ enabled: $<HTMLInputElement>('shadowEnabled').checked, type: $<HTMLSelectElement>('shadowType').value,
        color: $<HTMLInputElement>('shadowColor').value, x: $<HTMLInputElement>('shadowX').value, y: $<HTMLInputElement>('shadowY').value,
        blur: $<HTMLInputElement>('shadowBlur').value, opacity: Number($<HTMLInputElement>('shadowOpacity').value) / 100 });
    const blend = $<HTMLSelectElement>('blendMode').value as BlendMode;
    $('strokeWidthVal').textContent = String(st.width);
    $('shadowXVal').textContent = String(sh.x); $('shadowYVal').textContent = String(sh.y); $('shadowBlurVal').textContent = String(sh.blur);
    $('shadowOpacityVal').textContent = Math.round(sh.opacity * 100) + '%';
    syncShadowOffsetRows(sh.type);
    els.forEach(e => {
        e.stroke = Object.assign({}, st); e.shadow = Object.assign({}, sh); e.blendMode = blend;
        syncElement(e.id);
    });
    scheduleCommit();
}

function syncShadowPolar(x: number, y: number): void {
    const dist = Math.min(140, Math.round(Math.hypot(x, y)));
    let ang = Math.round(Math.atan2(y, x) * 180 / Math.PI);
    if (ang < 0) ang += 360;
    $<HTMLInputElement>('shadowAngle').value = String(ang); $('shadowAngleVal').textContent = ang + '°';
    $<HTMLInputElement>('shadowDistance').value = String(dist); $('shadowDistanceVal').textContent = String(dist);
}
function syncShadowOffsetRows(type: ShadowType): void {
    $('shadowOffsetRows').style.display = type === 'glow' ? 'none' : '';
}
/** 角度/距离（极坐标）→ X/Y，再走统一样式应用 */
export function applyShadowPolar(): void {
    const ang = Number($<HTMLInputElement>('shadowAngle').value) * Math.PI / 180;
    const dist = Number($<HTMLInputElement>('shadowDistance').value);
    const x = clamp(Math.round(dist * Math.cos(ang)), -100, 100), y = clamp(Math.round(dist * Math.sin(ang)), -100, 100);
    $<HTMLInputElement>('shadowX').value = String(x); $('shadowXVal').textContent = String(x);
    $<HTMLInputElement>('shadowY').value = String(y); $('shadowYVal').textContent = String(y);
    $('shadowAngleVal').textContent = $<HTMLInputElement>('shadowAngle').value + '°';
    $('shadowDistanceVal').textContent = $<HTMLInputElement>('shadowDistance').value;
    applyStyleChange();
}
/** 直接拖 X/Y 后同步角度/距离显示 */
export function applyShadowXY(): void {
    applyStyleChange();
    syncShadowPolar(Number($<HTMLInputElement>('shadowX').value), Number($<HTMLInputElement>('shadowY').value));
}
/** 一键投影预设：应用到选中物件并刷新面板 */
export function applyShadowPreset(key: string): void {
    const preset = SHADOW_PRESETS[key];
    if (!preset) return;
    const els = selectedEls().filter(e => !e.locked);
    if (!els.length) { toast('请先选中要应用投影的物件', 'error'); return; }
    const sh = makeShadow({ ...preset, enabled: true });
    els.forEach(e => { e.shadow = Object.assign({}, sh); syncElement(e.id); });
    scheduleCommit();
    syncStyleControls();
    toast('已应用投影预设', 'success');
}

export function applyFillAlpha(): void {
    const v = clamp(finite($<HTMLInputElement>('elAlphaInput').value, 100), 0, 100) / 100;
    $('elAlphaVal').textContent = Math.round(v * 100) + '%';
    selectedEls().filter(e => !e.locked && e.type !== 'line' && e.type !== 'curve').forEach(e => {
        e.fill.alpha = v; if (e.type !== 'text') syncElement(e.id);
    });
    scheduleCommit();
}

/* -------------------- N6 颜色与素材 -------------------- */
export function renderSwatches(): void {
    const recent = $('recentColors'), preset = $('presetColors');
    recent.textContent = ''; preset.textContent = '';
    const make = (color: string, host: HTMLElement) => {
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

export function applySwatch(color: string): void {
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
        $<HTMLInputElement>('bgColorPicker').value = color;
        $<HTMLInputElement>('bgColorHex').value = color.toUpperCase();
        updateCanvasBg();
        toast('已应用到画布背景', 'success');
        return;
    }
    els.forEach(e => {
        if (e.type === 'line' || e.type === 'curve') e.line!.color = color;
        else { e.fill.enabled = true; e.fill.color = color; if (e.type === 'text') e.text!.runs.forEach(r => { r.color = ''; }); }
        syncElement(e.id);
    });
    $<HTMLInputElement>('elColorInput').value = color; $<HTMLInputElement>('elColorHex').value = color.toUpperCase();
    scheduleCommit();
    toast('已应用到 ' + els.length + ' 个元素', 'success');
}

export function addSwatch(): void {
    const c = $<HTMLInputElement>('customSwatch').value;
    if (!HEX_RE.test(c)) return;
    if (!state.settings.palette.includes(c.toUpperCase())) state.settings.palette.push(c.toUpperCase());
    saveSettings(); renderSwatches(); toast('已加入色板', 'success');
}

export async function eyedropper(): Promise<void> {
    const ED = window.EyeDropper;
    if (typeof ED !== 'function') {
        toast('当前浏览器不支持屏幕吸管，请直接在色板中选取颜色', 'error'); return;
    }
    try {
        const result = await new ED().open();
        if (result && HEX_RE.test(result.sRGBHex)) applySwatch(result.sRGBHex);
    } catch { /* 用户取消 */ }
}

export function applyHexInput(id: string, targetId: string, onApply: (v: string) => void): void {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
        let v = input.value.trim();
        if (!v.startsWith('#')) v = '#' + v;
        if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v.slice(1).split('').map(ch => ch + ch).join('');
        if (!HEX_RE.test(v)) { toast('请输入有效的 6 位十六进制颜色', 'error'); input.value = $<HTMLInputElement>(targetId).value.toUpperCase(); return; }
        v = v.toUpperCase(); input.value = v; $<HTMLInputElement>(targetId).value = v;
        onApply(v);
    });
}

export function insertPresetShape(p: ShapePreset): void {
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

export function insertPresetText(p: TextPreset): void {
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

export function renderAssetPresets(): void {
    const sg = $('shapePresets'), tg = $('textPresets');
    sg.textContent = ''; tg.textContent = '';
    SHAPE_PRESETS.forEach(p => {
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