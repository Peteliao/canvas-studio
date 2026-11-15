import { state } from './state';
import { $, clamp, finite } from './utils';
import { makeFill, makeLine, selectedEls } from './model';
import { fillToCSS, lineHeightFor } from './style';
import { syncElement } from './render';
import { scheduleCommit } from './history';
import { showOnly } from './panel';
import { currentLineStyle, currentWavyDash } from './interaction';
import { applyInlineStyle } from './richtext';
import { drawMeasure } from './measure';
import type { FillMode } from './types';

export function updateCanvasBg(source?: string): void {
    const c = state.model.canvas;
    const mode = $<HTMLSelectElement>('bgType').value as FillMode;
    if (mode === 'radial') $('bgAngleRow').style.display = 'none';
    else $('bgAngleRow').style.display = 'flex';
    $('bgPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
    if (source === 'slider') $<HTMLInputElement>('gradAngleInput').value = $<HTMLInputElement>('gradAngle').value;
    if (source === 'number') $<HTMLInputElement>('gradAngle').value = $<HTMLInputElement>('gradAngleInput').value;
    c.background = makeFill({
        mode,
        color: $<HTMLInputElement>('bgColorPicker').value,
        start: $<HTMLInputElement>('gradStart').value,
        end: $<HTMLInputElement>('gradEnd').value,
        angle: $<HTMLInputElement>('gradAngle').value,
        posX: $<HTMLInputElement>('gradPosX').value,
        posY: $<HTMLInputElement>('gradPosY').value
    });
    $('canvas').style.background = fillToCSS(c.background);
    scheduleCommit();
}

export function toggleBgMode(): void {
    const mode = $<HTMLSelectElement>('bgType').value as FillMode;
    showOnly(mode);
    updateCanvasBg();
}

export function updateElementBackground(source?: string): void {
    const els = selectedEls().filter(e => !e.locked && e.type !== 'text' && e.type !== 'line' && e.type !== 'curve');
    if (source === 'slider') $<HTMLInputElement>('elGradAngleInput').value = $<HTMLInputElement>('elGradAngle').value;
    if (source === 'number') $<HTMLInputElement>('elGradAngle').value = $<HTMLInputElement>('elGradAngleInput').value;
    const f = makeFill({
        mode: $<HTMLSelectElement>('elBgType').value,
        color: $<HTMLInputElement>('elColorInput').value,
        start: $<HTMLInputElement>('elGradStart').value,
        end: $<HTMLInputElement>('elGradEnd').value,
        angle: $<HTMLInputElement>('elGradAngleInput').value,
        posX: $<HTMLInputElement>('elGradPosX').value,
        posY: $<HTMLInputElement>('elGradPosY').value,
        alpha: els.length ? els[0].fill.alpha : 1
    });
    els.forEach(e => { e.fill = Object.assign({}, f); syncElement(e.id); });
    scheduleCommit();
}

export function toggleElBgMode(): void {
    const mode = $<HTMLSelectElement>('elBgType').value as FillMode;
    state.elBgMode = mode;
    $('elBgSolidControls').style.display = mode === 'solid' ? 'block' : 'none';
    $('elBgGradientControls').style.display = mode === 'solid' ? 'none' : 'block';
    $('elAngleRow').style.display = mode === 'radial' ? 'none' : 'flex';
    $('elPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
    updateElementBackground();
}

export function updateElementColor(): void {
    const v = $<HTMLInputElement>('elColorInput').value;
    if (state.isTextEditing) { applyInlineStyle('color', v); return; }
    const els = selectedEls().filter(e => !e.locked);
    els.forEach(e => {
        if (e.type === 'text') {
            e.fill.enabled = true;
            e.fill.color = v;
            e.text!.runs.forEach(r => { r.color = ''; });
        } else if (e.type === 'line' || e.type === 'curve') {
            e.line!.color = v;
        } else {
            e.fill.enabled = true;
            e.fill.color = v;
        }
        syncElement(e.id);
    });
    scheduleCommit();
}

export function updateLineStyle(source?: string): void {
    if (source === 'slider') $<HTMLInputElement>('lineWidthInput').value = $<HTMLInputElement>('lineWidthRange').value;
    if (source === 'number') $<HTMLInputElement>('lineWidthRange').value = $<HTMLInputElement>('lineWidthInput').value;
    if (source === 'wavySlider') $<HTMLInputElement>('wavyAmpInput').value = $<HTMLInputElement>('wavyAmpRange').value;
    if (source === 'wavyNumber') $<HTMLInputElement>('wavyAmpRange').value = $<HTMLInputElement>('wavyAmpInput').value;
    const style = currentLineStyle();
    $('wavyControlRow').style.display = style === 'wavy' ? 'flex' : 'none';
    $('wavyDashRow').style.display = style === 'wavy' ? 'flex' : 'none';
    const sample = selectedEls().find(e => !e.locked && (e.type === 'line' || e.type === 'curve'));
    const ln = makeLine({
        style, width: $<HTMLInputElement>('lineWidthInput').value,
        color: sample ? sample.line!.color : $<HTMLInputElement>('elColorInput').value,
        wavyAmp: $<HTMLInputElement>('wavyAmpInput').value,
        dash: currentWavyDash()
    });
    selectedEls().filter(e => !e.locked && (e.type === 'line' || e.type === 'curve')).forEach(e => {
        const next = Object.assign({}, ln);
        if (e.type === 'curve' && next.style === 'wavy') next.style = 'solid';
        e.line = next;
        syncElement(e.id);
        if (e.type === 'line') $<HTMLInputElement>('geoH').value = String(Math.round(lineHeightFor(e)));
    });
    drawMeasure();
    scheduleCommit();
}

export function updateElementOpacity(): void {
    const v = clamp(finite($<HTMLInputElement>('opacityInput').value, 100), 0, 100);
    $('opacityVal').textContent = String(v);
    selectedEls().filter(e => !e.locked).forEach(e => { e.opacity = v / 100; syncElement(e.id); });
    scheduleCommit();
}

export function updateElementRadius(): void {
    const v = clamp(finite($<HTMLInputElement>('borderRadiusInput').value, 0), 0, 10000);
    $('radiusVal').textContent = String(v);
    selectedEls().filter(e => !e.locked).forEach(e => { e.borderRadius = v; syncElement(e.id); });
    scheduleCommit();
}