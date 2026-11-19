/* 启动入口 */
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-serif-sc';
import { LEGACY_KEY } from './constants';
import { state } from './state';
import { $, toast } from './utils';
import { openDB, loadSettings } from './db';
import { defaultModel } from './model';
import { loadAuto, resetHistory, resetHistoryWithSave, updateUndoRedoButtons } from './history';
import { renderAll, syncCanvasSize, syncTransform } from './render';
import { syncBackgroundControls, updateUI, updateCurveGradientStops } from './panel';
import { applyTheme, applyViewSettings } from './theme';
import { fitToScreen } from './view';
import { updateGeoLockButton } from './selection';
import { initCanvasInteraction } from './interaction';
import { initCropInteraction } from './cropper';
import { bindDelegates, bindTouch, bindAccessibility, renderShortcuts } from './actions';
import { bindHotkeys } from './shortcuts';
import { bindDropImport } from './clipboard';
import { setTool, switchTab, syncInspectorFold } from './tools';
import { renderSwatches, renderAssetPresets, applyStrokeGradientStops } from './swatches';
import { renderLayerList } from './layerlist';
import { renderProjectPanels, flushProjectSave } from './projects';
import { initRail } from './rail';
import { initGradientEditors } from './gradeditor';
import { updateElementGradientStops } from './styles';

async function boot(): Promise<void> {
    state.settings = loadSettings();
    await openDB();
    const hadLegacy = !!localStorage.getItem(LEGACY_KEY);
    const loaded = await loadAuto();
    if (loaded) {
        resetHistory();
        if (hadLegacy) toast('检测到旧版本存档：本次使用全新数据格式，旧存档未加载', 'error');
    } else {
        state.model = defaultModel();
        resetHistoryWithSave();
        if (hadLegacy) {
            try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
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
    initGradientEditors({ fill: updateElementGradientStops, curve: updateCurveGradientStops, stroke: applyStrokeGradientStops });
    updateUI();
    updateUndoRedoButtons();
    updateGeoLockButton();
    initCanvasInteraction();
    initCropInteraction();
    bindDelegates();
    initRail();
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
    window.addEventListener('beforeunload', () => flushProjectSave());
    setTimeout(() => { void renderProjectPanels(); }, 300);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); });
else void boot();