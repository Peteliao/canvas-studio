/* 透明特效图案库：内置水珠 / 流体 / 波浪等海报装饰，插入即带渐变与透明度，可一键换色 */
import { CLIP_PATHS } from './constants';
import type { BlendMode, ElementType, FillMode } from './types';
import { state } from './state';
import { round2, toast } from './utils';
import { buildElement, makeFill, makeShadow, makeStroke } from './model';
import { effectTintColors, fillToCSS, mixHex } from './style';
import { renderAll } from './render';
import { setSelection } from './selection';
import { commit } from './history';
import { canvasCenterFor } from './view';
import { useColor } from './swatches';

export interface EffectPreset {
    key: string;
    label: string;
    desc: string;
    type: ElementType;
    w: number;
    h: number;
    color: string;
    /** 高光混白比例 0–1；换色时按同一比例重算渐变 */
    light: number;
    mode: FillMode;
    angle: number;
    posX: number;
    posY: number;
    alpha: number;
    rotation?: number;
    strokeWidth?: number;
    glow?: { blur: number; opacity: number };
    blend?: BlendMode;
    gloss?: boolean;
    shapeParams?: Record<string, number>;
}

export const EFFECT_PRESETS: EffectPreset[] = [
    { key: 'drop', label: '水珠', desc: '玻璃感水珠，径向高光', type: 'drop', w: 140, h: 160, color: '#54c7ff', light: 0.62,
        mode: 'radial', angle: 90, posX: 35, posY: 24, alpha: 0.88, glow: { blur: 18, opacity: 0.32 }, gloss: true,
        shapeParams: { tip: 112 } },
    { key: 'blob', label: '流体', desc: '有机流体色块，可调波瓣', type: 'blob', w: 220, h: 200, color: '#7a6cf8', light: 0.5,
        mode: 'linear', angle: 125, posX: 50, posY: 50, alpha: 0.85, gloss: true },
    { key: 'wave', label: '波浪', desc: '液态波浪色带', type: 'wave', w: 280, h: 120, color: '#18a8e8', light: 0.45,
        mode: 'linear', angle: 100, posX: 50, posY: 50, alpha: 0.75 },
    { key: 'splash', label: '水花', desc: '飞溅水花，径向高光', type: 'splash', w: 200, h: 200, color: '#38bdf8', light: 0.55,
        mode: 'radial', angle: 90, posX: 38, posY: 30, alpha: 0.82, gloss: true },
    { key: 'bubble', label: '气泡', desc: '玻璃气泡，带浅色描边', type: 'circle', w: 150, h: 150, color: '#8fd8ff', light: 0.78,
        mode: 'radial', angle: 90, posX: 34, posY: 28, alpha: 0.42, strokeWidth: 2, gloss: true },
    { key: 'glow', label: '柔光', desc: '柔光光晕，可叠在文字后', type: 'circle', w: 190, h: 190, color: '#ff9ed2', light: 0.55,
        mode: 'radial', angle: 90, posX: 50, posY: 50, alpha: 0.5, glow: { blur: 26, opacity: 0.45 } },
    { key: 'ribbon', label: '彩带', desc: '倾斜液态彩带', type: 'wave', w: 300, h: 96, color: '#f472b6', light: 0.42,
        mode: 'linear', angle: 105, posX: 50, posY: 50, alpha: 0.7, rotation: -12, shapeParams: { amp: 18, thick: 38 } },
    { key: 'aurora', label: '极光', desc: '柔焦极光光斑', type: 'blob', w: 260, h: 170, color: '#34d399', light: 0.5,
        mode: 'radial', angle: 90, posX: 42, posY: 36, alpha: 0.55, rotation: 14, glow: { blur: 30, opacity: 0.38 },
        shapeParams: { lobes: 4, depth: 18 } }
];

export function insertEffectPreset(p: EffectPreset): void {
    const el = buildElement(p.type, 0, 0);
    const pos = canvasCenterFor(p.w, p.h);
    el.x = round2(pos.x);
    el.y = round2(pos.y);
    el.w = p.w;
    el.h = p.h;
    el.name = '特效 · ' + p.label + ' ' + (state.model.elements.length + 1);
    if (p.shapeParams) el.shapeParams = Object.assign({}, p.shapeParams);
    const colors = effectTintColors(p.color, p.light);
    el.fill = makeFill({
        enabled: true, mode: p.mode, color: p.color, start: colors.start, end: colors.end,
        angle: p.angle, posX: p.posX, posY: p.posY, alpha: p.alpha
    });
    el.effectTint = p.light;
    el.rotation = p.rotation || 0;
    if (p.blend) el.blendMode = p.blend;
    if (p.strokeWidth) el.stroke = makeStroke({ width: p.strokeWidth, color: mixHex(p.color, '#ffffff', 0.8), style: 'solid' });
    if (p.glow) {
        el.shadow = makeShadow({
            enabled: true, type: 'glow', color: mixHex(p.color, '#ffffff', 0.55),
            x: 0, y: 0, blur: p.glow.blur, opacity: p.glow.opacity
        });
    }
    state.model.elements.push(el);
    renderAll();
    setSelection([el.id]);
    commit();
    useColor(p.color);
    toast('已插入「特效 · ' + p.label + '」：选中后点色板或填充面板即可换色', 'success');
}

/** 菜单缩略图：与画布一致的 CSS 渐变 + 透明 + 轮廓裁剪 */
export function effectThumbEl(p: EffectPreset): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'effect-thumb-wrap' + (p.gloss ? ' gloss' : '');
    const chip = document.createElement('span');
    chip.className = 'effect-thumb';
    const colors = effectTintColors(p.color, p.light);
    chip.style.background = fillToCSS(makeFill({
        mode: p.mode, color: p.color, start: colors.start, end: colors.end,
        angle: p.angle, posX: p.posX, posY: p.posY, alpha: p.alpha
    }));
    if (p.type === 'circle') chip.style.borderRadius = '50%';
    else if (CLIP_PATHS[p.type]) chip.style.clipPath = CLIP_PATHS[p.type];
    wrap.appendChild(chip);
    return wrap;
}
