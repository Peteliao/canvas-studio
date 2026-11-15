import { LEGACY_KEY, STORAGE_KEY, VERSION } from './constants';
import { state } from './state';
import { $, appConfirm, appPrompt, downloadBlob, pickFile, toast } from './utils';
import { normalizeZ, validateProject } from './model';
import { renderAll, syncCanvasSize } from './render';
import { commit, resetHistory } from './history';
import { syncBackgroundControls, updateUI } from './panel';
import { idbClear, putAsset, saveSettings } from './db';

export async function exportConfig(): Promise<void> {
    const name = await appPrompt('请输入保存的项目名称：', '设计项目', { title: '保存项目' });
    if (!name) return;
    normalizeZ();
    // 仅打包仍被引用的资源，避免历史图片让项目文件持续膨胀
    const used = new Set<string>();
    state.model.elements.forEach(e => {
        if (e.image) { used.add(e.image.assetId); used.add(e.image.originalAssetId); }
        if (e.maskAssetId) used.add(e.maskAssetId);
    });
    const assets: Record<string, string> = {};
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

export function importConfig(): void {
    $<HTMLInputElement>('imageInput').value = '';
    pickFile('.canvas,.json').then(file => file && importProjectFile(file));
}

export async function importProjectFile(file: File): Promise<void> {
    try {
        const text = await file.text();
        const parsed = validateProject(JSON.parse(text));
        const assets = parsed.assets || {};
        for (const [id, data] of Object.entries(assets)) await putAsset(id, data);
        state.model = { version: VERSION, name: parsed.name || file.name.replace(/\.[^.]+$/, ''), canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
        state.projectName = state.model.name;
        state.settings.projectName = state.projectName; saveSettings();
        state.selection = [];
        resetHistory();
        renderAll(); syncCanvasSize(); syncBackgroundControls(); updateUI();
        commit();
        toast('项目载入成功', 'success');
    } catch (e) {
        toast('无法打开文件：' + (e as Error).message, 'error');
    }
}

export async function resetToDefault(): Promise<void> {
    const ok = await appConfirm('确定要恢复默认设置吗？当前所有更改将丢失（建议先「保存项目」）。', { title: '恢复默认设置' });
    if (!ok) return;
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    await idbClear();
    location.reload();
}