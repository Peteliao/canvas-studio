/* 动作分发（data-act 事件委托）、全局绑定、导出摘要、触屏与可访问性 */
import { SHORTCUTS, MIN_ZOOM, MAX_ZOOM, HEX_RE } from './constants';
import type { ElementType, TextAlign, ToolName, TabName, BucketSlot } from './types';
import { state } from './state';
import { $, $opt, clamp, finite, toast, dialogOk, dialogCancel, downloadBlob } from './utils';
import { sortedElements } from './model';
import { getAABB } from './geometry';
import { undo, redo, commit } from './history';
import { linkSelected, unlinkSelected } from './linked';
import { adjustZoom, resetView, fitToScreen } from './view';
import { setSelection, toggleSelectionLock, toggleCanvasLock } from './selection';
import { alignElements, distributeElements, layerAction, startRelLayer } from './layers';
import { performBoolean } from './boolean';
import { addShape, toggleLock, duplicateSelected, centerOnCanvas, deleteSelected, resetPivot, resizeCanvasSize, updateGeo, updatePivotInput, toggleExportVisibility } from './elements';
import { updateTextStyle, updateTextAlign, updateTextSizeMode } from './richtext';
import { exportConfig, importConfig, resetToDefault } from './project';
import { showExportModal, doExport, exportBoundsFor, renderModelToCanvas, canvasToBlob } from './exporter';
import { buildSVG, buildPDF } from './vector-export';
import { exportInkPadding, padExportBounds, rasterExportScale } from './export-bounds';
import { closeModal, cropConfirm, replaceImage, handleCropFile } from './cropper';
import { toggleTheme, toggleSetting, toggleMeasureType } from './theme';
import type { MeasureKind } from './theme';
import { drawGuides } from './guides';
import { drawMeasure } from './measure';
import { setTool, toggleInspector, toggleCard, switchTab, setInspectorFolded, bindMenus } from './tools';
import { groupSelected, ungroupSelected, collapseAllGroups, renameSelected, renderLayerList, expandGroupIds } from './layerlist';
import { copyToClipboardSystem, pasteFromClipboardSystem } from './clipboard';
import { newProject, createVersion } from './projects';
import { runSelfTest } from './selftest';
import { eyedropper, addSwatch, applyHexInput, useColor, applyStyleChange, applyFillAlpha, applyShadowPolar, applyShadowXY, applyShadowPreset, applyStrokePaintMode, applyStrokeGradientGeometry, setStrokeAlign } from './swatches';
import { setLineStyle, setWavyDash, curveOp, clientToWorld, endInteraction } from './interaction';
import { pinchViewport } from './touch';
import { updateElementColor, updateCanvasBg, toggleElBgMode, updateElementBackground, updateElementOpacity, updateElementRadius, updateLineStyle, toggleBgMode } from './styles';
import { updateCurveFill, updateCurveStroke, updateUI } from './panel';
import { openBucketPicker, hideBucketHover, bucketEditsSelection, commitBucketPicker, previewBucketPicker, bindPaintPopoverControls, setBucketColor, bucketSlotLabel } from './bucket';
import { bindStrokeAlignPreview } from './railstroke';
import { toggleBoundaryGuide } from './alignguide';
import { addImage, handleImageUpload } from './image';
import { saveSettings } from './db';
import { syncTransform } from './render';
import { bindShapeParamControls } from './shapepanel';
import { isInputActive } from './shortcuts';

type ActionFn = (arg?: string, node?: HTMLElement, e?: Event) => void;

async function pickScreenColor(): Promise<void> {
    const ED = window.EyeDropper;
    if (typeof ED !== 'function') {
        toast('当前浏览器不支持屏幕吸管，请使用检查器中的取色器或色板', 'error');
        return;
    }
    try {
        const result = await new ED().open();
        if (!result || !HEX_RE.test(result.sRGBHex)) return;
        const slot = state.bucketSlot || 'fill';
        useColor(result.sRGBHex);
        setBucketColor(slot, result.sRGBHex);
        setTool('bucket');
        toast(`已吸取 ${result.sRGBHex.toUpperCase()}，颜料桶当前涂${bucketSlotLabel(slot)}色`, 'success');
    } catch { /* 用户取消 */ }
}

export const ACTIONS: Record<string, ActionFn> = {
    undo: () => undo(),
    redo: () => redo(),
    zoom: arg => adjustZoom(Number(arg)),
    resetView: () => resetView(),
    fitToScreen: () => fitToScreen(),
    toggleCanvasLock: () => toggleCanvasLock(),
    align: arg => alignElements(arg!),
    distribute: arg => distributeElements(arg as 'h' | 'v'),
    boolean: arg => performBoolean(arg!),
    addShape: arg => addShape(arg as ElementType),
    addImage: () => addImage(),
    toggleLock: () => toggleLock(),
    toggleSelectionLock: () => toggleSelectionLock(),
    duplicateSelected: () => duplicateSelected(),
    centerOnCanvas: () => centerOnCanvas(),
    deleteSelected: () => deleteSelected(),
    textStyle: arg => updateTextStyle(arg!),
    textAlign: arg => updateTextAlign(arg as TextAlign),
    shadowPreset: arg => applyShadowPreset(arg || ''),
    strokeAlign: arg => setStrokeAlign(arg || 'center'),
    toggleBoundaryGuide: () => toggleBoundaryGuide(),
    layer: arg => layerAction(arg!),
    relLayer: arg => startRelLayer(arg as 'under' | 'above'),
    exportConfig: () => { void exportConfig(); },
    importConfig: () => importConfig(),
    showExportModal: () => showExportModal(),
    doExport: () => { void doExport(); },
    resetToDefault: () => { void resetToDefault(); },
    closeModal: arg => closeModal(arg!),
    cropConfirm: () => cropConfirm(),
    replaceImage: () => replaceImage(),
    dialogOk: () => dialogOk(),
    dialogCancel: () => dialogCancel(),
    // ---- V12 新增动作 ----
    toggleTheme: () => toggleTheme(),
    toggleGrid: () => toggleSetting('grid', '网格'),
    toggleRulers: () => toggleSetting('rulers', '标尺'),
    toggleGuideLines: () => { toggleSetting('guideLines', '辅助线'); drawGuides(); drawMeasure(); },
    toggleSnap: () => toggleSetting('snap', '智能捕捉'),
    toggleGuides: () => toggleSetting('guides', '尺寸标注'),
    toggleMeasure: arg => toggleMeasureType((arg || 'size') as MeasureKind),
    toggleInspector: () => toggleInspector(),
    setTool: arg => setTool(arg as ToolName),
    groupSelected: () => groupSelected(),
    ungroupSelected: () => ungroupSelected(),
    linkSelected: () => { linkSelected(); updateUI(); commit(); },
    unlinkSelected: () => { unlinkSelected(); updateUI(); commit(); },
    collapseAllGroups: () => collapseAllGroups(),
    renameSelected: () => { void renameSelected(); },
    selectAll: () => setSelection(expandGroupIds(state.model.elements.map(e => e.id))),
    copyClipboard: () => { void copyToClipboardSystem(); },
    pasteClipboard: () => { void pasteFromClipboardSystem(); },
    newProject: () => { void newProject(); },
    createVersion: () => { void createVersion(); },
    showShortcuts: () => showShortcuts(),
    showAbout: () => showAbout(),
    runSelfTest: () => runSelfTest(),
    eyedropper: () => { void eyedropper(); },
    pickScreenColor: () => { void pickScreenColor(); },
    addSwatch: () => addSwatch(),
    toggleCard: arg => toggleCard(arg!),
    setLineStyle: arg => setLineStyle(arg!),
    setWavyDash: arg => setWavyDash(arg!),
    curveOp: arg => curveOp(arg!),
    resetPivot: () => resetPivot()
};

export async function batchExport(name: string, format: string, transparent: boolean, quality: number): Promise<void> {
    const list = sortedElements().filter(e => e.exportVisible && e.visible);
    if (!list.length) { toast('画布上没有可导出的元素', 'error'); return; }
    toast(`开始批量导出 ${list.length} 个图层…`, 'success');
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
        const el = list[i];
        try {
            const bounds = padExportBounds(getAABB(el), exportInkPadding(el));
            if (format === 'svg') {
                const svg = buildSVG({ bounds, elements: [el], transparent });
                downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}_${i + 1}_${el.name || el.type}.svg`);
            } else {
                const c = await renderModelToCanvas(rasterExportScale(bounds), { transparent: transparent && format !== 'jpeg' && format !== 'pdf',
                    opaqueBackground: (format === 'jpeg' || format === 'pdf') ? '#ffffff' : null, bounds, elements: [el] });
                if (format === 'pdf') {
                    const pdf = buildPDF(c.toDataURL('image/jpeg', quality), c.width, c.height);
                    downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `${name}_${i + 1}_${el.name || el.type}.pdf`);
                } else {
                    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
                    let blob = await canvasToBlob(c, mime, quality);
                    let extension = format === 'jpeg' ? 'jpg' : format;
                    if (mime === 'image/webp' && blob.type !== 'image/webp') {
                        blob = await canvasToBlob(c, 'image/png');
                        extension = 'png';
                    }
                    downloadBlob(blob, `${name}_${i + 1}_${el.name || el.type}.${extension}`);
                }
            }
        } catch (err) {
            failed++;
            console.warn('批量导出单项失败', (err as Error).message);
        }
        await new Promise(r => setTimeout(r, 260));
    }
    if (failed) toast(`批量导出结束：成功 ${list.length - failed} 个，失败 ${failed} 个`, 'error');
    else {
        toast(`批量导出完成，共 ${list.length} 个文件`, 'success');
        $('exportModal').style.display = 'none';
    }
}
export function updateExportSummary(): void {
    const s = $('exportSummary'), hint = $opt('exportHint');
    const fmt = $<HTMLSelectElement>('exportFormat').value, scope = $<HTMLSelectElement>('exportScope').value;
    const b = exportBoundsFor(scope);
    const fmtLabel = ({ png: 'PNG', jpeg: 'JPEG', webp: 'WebP', svg: 'SVG', pdf: 'PDF' } as Record<string, string>)[fmt] || fmt;
    const scopeLabel = ({ canvas: '整个画布', selection: '仅选中元素', batch: '按图层批量' } as Record<string, string>)[scope];
    s.textContent = b ? `将导出 ${fmtLabel} · ${scopeLabel} · 内容尺寸 ${Math.round(b.w)}×${Math.round(b.h)}` : '请先选中要导出的元素';
    if (hint) hint.textContent = scope === 'batch' ? '批量导出会依次下载多个文件，请允许浏览器多文件下载' : '';
    const qRow = $opt('exportQualityRow');
    if (qRow) qRow.style.display = (fmt === 'jpeg' || fmt === 'webp' || fmt === 'pdf') ? 'flex' : 'none';
    $<HTMLInputElement>('exportTransparent').disabled = (fmt === 'jpeg' || fmt === 'pdf');
    if (fmt === 'svg') { $<HTMLInputElement>('exportW').disabled = true; s.textContent += '（矢量，宽度固定为内容尺寸）'; }
    else $<HTMLInputElement>('exportW').disabled = false;
}

export function bindDelegates(): void {
    document.addEventListener('click', e => {
        const node = (e.target as Element).closest<HTMLElement>('[data-act]');
        if (!node) return;
        const fn = ACTIONS[node.dataset.act || ''];
        if (!fn) return;
        if ((node as HTMLButtonElement).disabled) return;
        e.preventDefault();
        fn(node.dataset.arg, node, e);
    });
    // 防失焦：颜色输入与 B/I/U/对齐按钮在按下时不抢焦点
    document.addEventListener('mousedown', e => {
        if ((e.target as Element).closest('[data-keepfocus]')) e.preventDefault();
    });

    const handlers: Record<string, () => void> = {
        canvasW: () => resizeCanvasSize('w'),
        canvasH: () => resizeCanvasSize('h'),
        moveStep: () => { state.moveStep = clamp(finite($<HTMLInputElement>('moveStep').value, 1), 1, 1000); },
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
        paraSpacingInput: () => updateTextStyle('paraSpacing'),
        textIndentInput: () => updateTextStyle('indent'),
        // V12 新增控件
        strokeColor: () => applyStyleChange(),
        strokeWidth: () => applyStyleChange(),
        strokeStyle: () => applyStyleChange(),
        strokePaintMode: () => applyStrokePaintMode(),
        strokeGradAngle: () => applyStrokeGradientGeometry('slider'),
        strokeGradAngleNum: () => applyStrokeGradientGeometry('number'),
        strokeGradPosX: () => applyStrokeGradientGeometry('pos'),
        strokeGradPosY: () => applyStrokeGradientGeometry('pos'),
        blendMode: () => applyStyleChange(),
        shadowEnabled: () => applyStyleChange(),
        shadowType: () => applyStyleChange(),
        shadowColor: () => applyStyleChange(),
        shadowX: () => applyShadowXY(),
        shadowY: () => applyShadowXY(),
        shadowAngle: () => applyShadowPolar(),
        shadowDistance: () => applyShadowPolar(),
        shadowBlur: () => applyStyleChange(),
        shadowOpacity: () => applyStyleChange(),
        elAlphaInput: () => applyFillAlpha(),
        curveFillEnabled: () => updateCurveFill(),
        curveFillMode: () => updateCurveFill(),
        curveFillColor: () => updateCurveFill(),
        curveFillAngle: () => updateCurveFill(),
        curveFillAlpha: () => updateCurveFill(),
        curveStrokeEnabled: () => updateCurveStroke(),
        curveStrokeColor: () => updateCurveStroke(),
        curveStrokePaintMode: () => updateCurveStroke(),
        curveStrokeGradAngle: () => {
            $<HTMLInputElement>('curveStrokeGradAngleNum').value = $<HTMLInputElement>('curveStrokeGradAngle').value;
            updateCurveStroke();
        },
        curveStrokeGradAngleNum: () => {
            $<HTMLInputElement>('curveStrokeGradAngle').value = $<HTMLInputElement>('curveStrokeGradAngleNum').value;
            updateCurveStroke();
        },
        curveStrokeGradPosX: () => updateCurveStroke(),
        curveStrokeGradPosY: () => updateCurveStroke(),
        exportFormat: () => updateExportSummary(),
        exportScope: () => updateExportSummary(),
        exportQuality: () => { $('exportQualityVal').textContent = $<HTMLInputElement>('exportQuality').value; updateExportSummary(); },
        exportTransparent: () => updateExportSummary(),
        exportW: () => updateExportSummary(),
        alignBase: () => { state.alignBase = $<HTMLSelectElement>('alignBase').value as 'selection' | 'canvas'; state.settings.alignBase = state.alignBase; saveSettings(); },
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
    const dispatch = (e: Event, allow: boolean): void => {
        const t = e.target as HTMLInputElement | null;
        if (!t || !t.id) return;
        const isChoice = t.tagName === 'SELECT' || t.type === 'checkbox';
        if (isChoice !== allow) return;
        const fn = handlers[t.id];
        if (fn) fn();
    };
    document.addEventListener('input', e => dispatch(e, false));
    document.addEventListener('change', e => dispatch(e, true));

    ([['bucketFillSlot', 'fill'], ['bucketStrokeSlot', 'stroke']] as [string, BucketSlot][]).forEach(([id, slot]) => {
        const n = $opt(id);
        if (n) n.addEventListener('click', e => { e.stopPropagation(); openBucketPicker(slot, bucketEditsSelection(), n); });
    });
    const bucketColorInput = $opt<HTMLInputElement>('bucketColorInput');
    if (bucketColorInput) {
        // 拖动取色器时实时预览；确认（change）后才写入撤销历史并提示
        bucketColorInput.addEventListener('input', () => previewBucketPicker(bucketColorInput.value));
        bucketColorInput.addEventListener('change', () => commitBucketPicker(bucketColorInput.value));
    }
    bindPaintPopoverControls();
    bindStrokeAlignPreview();
    document.addEventListener('mouseleave', () => { if (state.tool === 'bucket') hideBucketHover(); });

    $('imageInput').addEventListener('change', e => { void handleImageUpload(e.target as HTMLInputElement); });
    $('cropFileInput').addEventListener('change', e => { void handleCropFile(e.target as HTMLInputElement); });
    $('appDialogInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); dialogOk(); }
    });
    ['cropModal', 'exportModal', 'appDialog', 'shortcutsModal', 'selftestModal', 'aboutModal'].forEach(id => {
        $(id).addEventListener('pointerdown', e => {
            if ((e.target as Element).id === id) {
                if (id === 'appDialog') dialogCancel();
                else closeModal(id);
            }
        });
    });

    // 标签页切换（折叠卡片由 ACTIONS.toggleCard 统一处理，避免双重触发）
    document.querySelectorAll<HTMLElement>('.inspector-tabs .tab').forEach(t => {
        t.addEventListener('click', () => {
            const name = t.dataset.tab;
            // 点击当前标签：收起/展开面板；点击其他标签：展开并切换
            if (state.activeTab === name) { setInspectorFolded(!state.settings.inspectorFolded); return; }
            setInspectorFolded(false);
            switchTab(name as TabName);
        });
    });
    $('btnInspectorFold').addEventListener('click', () => setInspectorFolded(!state.settings.inspectorFolded));
    // 图层搜索
    $('layerSearch').addEventListener('input', () => renderLayerList());
    // 颜色十六进制输入
    applyHexInput('elColorHex', 'elColorInput', () => updateElementColor(), v => useColor(v));
    applyHexInput('bgColorHex', 'bgColorPicker', () => updateCanvasBg());
    $('bgColorPicker').addEventListener('input', () => { $<HTMLInputElement>('bgColorHex').value = $<HTMLInputElement>('bgColorPicker').value.toUpperCase(); });
    $('elColorInput').addEventListener('input', () => { $<HTMLInputElement>('elColorHex').value = $<HTMLInputElement>('elColorInput').value.toUpperCase(); });
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
        if ((e.target as Element).closest('[data-act="showExportModal"]')) updateExportSummary();
    });
    // 菜单触发器（阻止冒泡，避免被全局 click 关闭）
    bindMenus();
    bindShapeParamControls();
}

/* -------------------- 触屏与可访问性 -------------------- */
export function bindTouch(): void {
    const vp = $('viewport');
    vp.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        state.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.touchPoints.size >= 2) {
            if (!state.pinch && state.touchPoints.size === 2) {
                const [a, b] = Array.from(state.touchPoints.values());
                state.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom,
                    cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, panX: state.pan.x, panY: state.pan.y };
            }
            const it = state.interaction;
            if (it && (it.kind === 'textcreate' || it.kind === 'box')) {
                $('selectionBox').style.display = 'none';
                state.boxCache = null;
                state.interaction = null;
            } else if (it && it.kind !== 'crop') endInteraction();
            vp.classList.remove('panning');
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    });
    vp.addEventListener('pointermove', e => {
        if (e.pointerType !== 'touch' || !state.touchPoints.has(e.pointerId)) return;
        state.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.touchPoints.size >= 2 && state.pinch) {
            const [a, b] = Array.from(state.touchPoints.values());
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
            const next = pinchViewport(state.pinch, dist, cx, cy, MIN_ZOOM, MAX_ZOOM);
            state.pan.x = next.panX; state.pan.y = next.panY;
            state.zoom = next.zoom; syncTransform();
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    });
    const end = (e: PointerEvent): void => {
        const wasPinching = !!state.pinch;
        state.touchPoints.delete(e.pointerId);
        if (state.touchPoints.size < 2) state.pinch = null;
        if (wasPinching) e.stopImmediatePropagation();
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
}
export function bindAccessibility(): void {
    document.querySelectorAll<HTMLElement>('.icon-btn, .action-btn, .rail-btn, .toggle-btn, .tab').forEach(b => {
        if (!b.getAttribute('aria-label') && !b.getAttribute('title') && (b.textContent || '').trim() === '') {
            b.setAttribute('aria-label', b.dataset.act || '按钮');
        }
    });
    $('viewport').setAttribute('aria-label', '设计画布');
    $('layerList').setAttribute('aria-multiselectable', 'true');
    const saved = $opt('statusSaved');
    if (saved) { saved.setAttribute('role', 'status'); saved.setAttribute('aria-live', 'polite'); }
}

/* -------------------- 快捷键帮助 / 关于 -------------------- */
export function renderShortcuts(): void {
    const host = $('shortcutGrid');
    host.textContent = '';
    SHORTCUTS.forEach(([label, key]) => {
        const row = document.createElement('div'); row.className = 'shortcut-row';
        const l = document.createElement('span'); l.textContent = label;
        const k = document.createElement('kbd'); k.textContent = key;
        row.appendChild(l); row.appendChild(k); host.appendChild(row);
    });
}
export function showShortcuts(): void { renderShortcuts(); $('shortcutsModal').style.display = 'flex'; }
export function showAbout(): void { $('aboutModal').style.display = 'flex'; }