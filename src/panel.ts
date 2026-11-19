/* 面板回填：属性检查器与画布设置 */
import type { CanvasElement, Fill, FillMode } from './types';
import { state } from './state';
import { $, clamp, finite, setIcon } from './utils';
import { getEl, selectedEls, makeFill } from './model';
import { lineHeightFor } from './style';
import { syncElement, updateTextStats } from './render';
import { scheduleCommit } from './history';
import { syncPivotInputs, syncLineStyleSeg, syncWavyDashSeg, updateCurveNodePanel } from './interaction';
import { refreshStudioUI } from './tools';
import { syncStyleControls } from './swatches';
import { syncPaintStrokeWidth } from './railstroke';
import { syncShapeParamPanel } from './shapepanel';

export function showOnly(mode: FillMode): void {
    $('bgSolidControls').style.display = mode === 'solid' ? 'flex' : 'none';
    $('bgGradientControls').style.display = mode === 'solid' ? 'none' : 'block';
    $('bgAngleRow').style.display = mode === 'radial' ? 'none' : 'flex';
    $('bgPosRow').style.display = (mode === 'radial' || mode === 'conic') ? 'flex' : 'none';
}
export function syncBackgroundControls(): void {
    const f = state.model.canvas.background;
    $<HTMLSelectElement>('bgType').value = f.mode;
    $<HTMLInputElement>('bgColorPicker').value = f.color;
    $<HTMLInputElement>('bgColorHex').value = f.color.toUpperCase();
    $<HTMLInputElement>('gradStart').value = f.start;
    $<HTMLInputElement>('gradEnd').value = f.end;
    $<HTMLInputElement>('gradAngle').value = String(f.angle);
    $<HTMLInputElement>('gradAngleInput').value = String(f.angle);
    $<HTMLInputElement>('gradPosX').value = String(f.posX);
    $<HTMLInputElement>('gradPosY').value = String(f.posY);
    showOnly(f.mode);
    const btn = $('btnCanvasLock');
    state.canvasRatioLocked = !!state.model.canvas.lockedRatio;
    state.canvasRatio = state.model.canvas.w / state.model.canvas.h;
    btn.classList.toggle('active', state.canvasRatioLocked);
    setIcon(btn, state.canvasRatioLocked ? 'link' : 'unlink');
}
export function syncElBackgroundControls(f: Fill): void {
    $<HTMLSelectElement>('elBgType').value = f.mode;
    $<HTMLInputElement>('elColorInput').value = f.color;
    $<HTMLInputElement>('elColorHex').value = f.color.toUpperCase();
    $<HTMLInputElement>('elAlphaInput').value = String(Math.round(clamp(finite(f.alpha, 1), 0, 1) * 100));
    $('elAlphaVal').textContent = $<HTMLInputElement>('elAlphaInput').value + '%';
    $<HTMLInputElement>('elGradStart').value = f.start;
    $<HTMLInputElement>('elGradEnd').value = f.end;
    $<HTMLInputElement>('elGradAngle').value = String(f.angle);
    $<HTMLInputElement>('elGradAngleInput').value = String(f.angle);
    $<HTMLInputElement>('elGradPosX').value = String(f.posX);
    $<HTMLInputElement>('elGradPosY').value = String(f.posY);
    state.elBgMode = f.mode;
    $('elBgSolidControls').style.display = f.mode === 'solid' ? 'block' : 'none';
    $('elBgGradientControls').style.display = f.mode === 'solid' ? 'none' : 'block';
    $('elAngleRow').style.display = f.mode === 'radial' ? 'none' : 'flex';
    $('elPosRow').style.display = (f.mode === 'radial' || f.mode === 'conic') ? 'flex' : 'none';
}
/* -------------------- 曲线填充面板（仅闭合路径） -------------------- */
export function syncCurveFillControls(el: CanvasElement | null): void {
    const isCurve = !!(el && el.type === 'curve');
    $('shapeFillControls').style.display = isCurve ? 'none' : 'block';
    $('curveFillControls').style.display = isCurve ? 'block' : 'none';
    if (!isCurve || !el) return;
    const f = el.fill, c = el.curve!;
    $<HTMLInputElement>('curveFillEnabled').checked = !!c.filled;
    $<HTMLInputElement>('curveFillEnabled').disabled = !c.closed || !!el.locked;
    $<HTMLSelectElement>('curveFillMode').value = f.mode;
    $<HTMLInputElement>('curveFillColor').value = f.color;
    $('curveFillHex').textContent = f.color.toUpperCase();
    $<HTMLInputElement>('curveFillGradStart').value = f.start;
    $<HTMLInputElement>('curveFillGradEnd').value = f.end;
    $<HTMLInputElement>('curveFillAngle').value = String(f.angle);
    $('curveFillAngleVal').textContent = Math.round(f.angle) + '°';
    $<HTMLInputElement>('curveFillAlpha').value = String(Math.round(f.alpha * 100));
    $('curveFillAlphaVal').textContent = Math.round(f.alpha * 100) + '%';
    $<HTMLInputElement>('curveStrokeEnabled').checked = c.strokeOn !== false;
    $<HTMLInputElement>('curveStrokeColor').value = el.line!.color;
    $('curveStrokeHex').textContent = el.line!.color.toUpperCase();
    const grad = f.mode !== 'solid';
    $('curveFillSolidRow').style.display = grad ? 'none' : 'flex';
    $('curveFillGradControls').style.display = grad ? 'block' : 'none';
}
export function updateCurveFill(): void {
    const el = selectedEls().find(e => e.type === 'curve' && !e.locked);
    if (!el) return;
    const f = makeFill({
        mode: $<HTMLSelectElement>('curveFillMode').value,
        color: $<HTMLInputElement>('curveFillColor').value,
        start: $<HTMLInputElement>('curveFillGradStart').value,
        end: $<HTMLInputElement>('curveFillGradEnd').value,
        angle: $<HTMLInputElement>('curveFillAngle').value,
        alpha: Number($<HTMLInputElement>('curveFillAlpha').value) / 100
    });
    el.fill = f;
    el.curve!.filled = $<HTMLInputElement>('curveFillEnabled').checked && el.curve!.closed;
    $('curveFillHex').textContent = f.color.toUpperCase();
    $('curveFillAngleVal').textContent = Math.round(f.angle) + '°';
    $('curveFillAlphaVal').textContent = Math.round(Number($<HTMLInputElement>('curveFillAlpha').value)) + '%';
    const grad = f.mode !== 'solid';
    $('curveFillSolidRow').style.display = grad ? 'none' : 'flex';
    $('curveFillGradControls').style.display = grad ? 'block' : 'none';
    syncElement(el.id);
    scheduleCommit();
}
export function updateCurveStroke(): void {
    const el = selectedEls().find(e => e.type === 'curve' && !e.locked);
    if (!el) return;
    el.curve!.strokeOn = $<HTMLInputElement>('curveStrokeEnabled').checked;
    el.line!.color = $<HTMLInputElement>('curveStrokeColor').value;
    $('curveStrokeHex').textContent = el.line!.color.toUpperCase();
    syncElement(el.id);
    scheduleCommit();
}
export function updatePropPanel(el: CanvasElement | null): void {
    if (!el) return;
    $<HTMLInputElement>('geoX').value = String(Math.round(el.x));
    $<HTMLInputElement>('geoY').value = String(Math.round(el.y));
    $<HTMLInputElement>('geoW').value = String(Math.round(el.w));
    $<HTMLInputElement>('geoH').value = String(Math.round(el.type === 'line' ? lineHeightFor(el) : el.h));
    $<HTMLInputElement>('geoR').value = String(Math.round(el.rotation));
    syncPivotInputs(el);
    $<HTMLInputElement>('chkExportVisible').checked = el.exportVisible;
    $<HTMLInputElement>('opacityInput').value = String(Math.round(el.opacity * 100));
    $('opacityVal').textContent = String(Math.round(el.opacity * 100));
    $<HTMLInputElement>('borderRadiusInput').value = String(Math.round(el.borderRadius));
    $('radiusVal').textContent = String(Math.round(el.borderRadius));
    syncElBackgroundControls(el.fill);

    const isLine = el.type === 'line', isCurve = el.type === 'curve', isText = el.type === 'text';
    $('appearanceBlock').style.display = 'block';
    syncCurveFillControls(el);
    $<HTMLSelectElement>('elBgType').disabled = isLine || isCurve || isText;
    $('lineSpecific').style.display = (isLine || isCurve) ? 'block' : 'none';
    $('textSpecific').style.display = isText ? 'block' : 'none';
    // 线条/曲线的描边由专属面板控制，禁用通用描边控件避免“无效控件”
    ['strokeColor', 'strokeWidth', 'strokeStyle'].forEach(id => { $<HTMLInputElement>(id).disabled = isLine || isCurve; });

    if (isLine || isCurve) {
        const ln = el.line!;
        $('linePanelTitle').textContent = isCurve ? '曲线样式' : '线条样式';
        $('lineStyleSeg').classList.toggle('no-wavy', isCurve);
        syncLineStyleSeg(ln.style);
        $<HTMLInputElement>('lineWidthRange').value = String(ln.width);
        $<HTMLInputElement>('lineWidthInput').value = String(ln.width);
        $<HTMLInputElement>('wavyAmpRange').value = String(ln.wavyAmp);
        $<HTMLInputElement>('wavyAmpInput').value = String(ln.wavyAmp);
        $('wavyControlRow').style.display = ln.style === 'wavy' ? 'flex' : 'none';
        $('wavyDashRow').style.display = ln.style === 'wavy' ? 'flex' : 'none';
        syncWavyDashSeg(ln.dash);
        $<HTMLInputElement>('elColorInput').value = ln.color;
        $<HTMLInputElement>('elColorHex').value = ln.color.toUpperCase();
    }
    updateCurveNodePanel(isCurve ? el : null);
    if (isText) {
        const t = el.text!;
        $<HTMLInputElement>('fontSizeInput').value = String(t.fontSize);
        $<HTMLInputElement>('lineHeightInput').value = String(t.lineHeight);
        $<HTMLInputElement>('letterSpacingInput').value = String(t.letterSpacing);
        const match = `${t.fontFamily}|${t.fontWeight}`;
        const sel = $<HTMLSelectElement>('fontFamilyInput');
        const matchOpt = Array.from(sel.options).find(o => o.value === match || o.value === `${t.fontFamily}|400`);
        if (matchOpt) sel.value = matchOpt.value;
        else sel.selectedIndex = 0;
        $('btnBold').classList.toggle('active', t.fontWeight >= 700);
        $('btnItalic').classList.toggle('active', t.runs.some(r => r.italic));
        $('btnUnderline').classList.toggle('active', t.runs.some(r => r.underline));
        (['left', 'center', 'right', 'justify'] as const).forEach(a => $('btnAlign' + a[0].toUpperCase() + a.slice(1)).classList.toggle('active', t.align === a));
        $<HTMLSelectElement>('textSizeMode').value = t.sizeMode || 'fixed';
        $<HTMLSelectElement>('fontWeightInput').value = String(t.fontWeight);
        updateTextStats(el);
    }
    syncShapeParamPanel(el);
}
export function updateUI(): void {
    const n = state.selection.length;
    $('selectionPanel').style.display = n > 0 ? 'block' : 'none';
    $('emptyHint').style.display = n > 0 ? 'none' : 'block';
    const ehTitle = $('emptyHint').querySelector<HTMLElement>('.empty-title');
    const ehDesc = $('emptyHint').querySelector<HTMLElement>('.empty-desc');
    if (ehTitle && ehDesc) {
        if (n === 0 && state.guideSel) {
            ehTitle.textContent = '辅助线已选中';
            ehDesc.textContent = '拖动移动 · 拖回标尺或 Delete 删除 · 双击或浮控输入角度旋转';
        } else {
            ehTitle.textContent = '未选中元素';
            ehDesc.textContent = '从左侧工具架插入元素，或点击画布上的元素开始编辑';
        }
    }
    $('alignTools').style.display = n > 0 ? 'flex' : 'none';
    $('distributeTools').style.display = n >= 3 ? 'flex' : 'none';
    $('booleanTools').style.display = n > 1 ? 'flex' : 'none';
    $('groupTools').style.display = n > 0 ? 'flex' : 'none';
    $('selCountBadge').textContent = String(n);
    refreshStudioUI();
    syncPaintStrokeWidth();
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
        $<HTMLSelectElement>('elBgType').disabled = false;
        syncShapeParamPanel(null);
    }
    syncStyleControls();
}