import { LEGACY_KEY, STORAGE_KEY, VERSION } from './constants';
import { state } from './state';
import { $, appConfirm, appPrompt, downloadBlob, pickFile, toast, uid } from './utils';
import { normalizeZ, snapshotJSON, validateProject } from './model';
import { applySnapshot, resetHistoryWithSave } from './history';
import { idbClear, putAsset, saveSettings } from './db';
import { ensureProjectId, persistCurrentProject, renderProjectPanels } from './projects';
import { remapProjectAssets } from './project-binding';
import type { Settings } from './types';

export async function exportConfig(): Promise<void> {
    const name = await appPrompt('请输入保存的项目名称：', '设计项目', { title: '保存项目' });
    if (!name) return;
    normalizeZ();
    // 仅打包仍被引用的资源，避免历史图片让项目文件持续膨胀
    const used = new Set<string>();
    const collectAssets = (elements: typeof state.model.elements): void => elements.forEach(e => {
        if (e.image) { used.add(e.image.assetId); used.add(e.image.originalAssetId); }
        if (e.maskAssetId) used.add(e.maskAssetId);
    });
    collectAssets(state.model.elements);
    state.model.components?.forEach(component => collectAssets(component.elements));
    const assets: Record<string, string> = {};
    used.forEach(id => { if (state.assets[id]) assets[id] = state.assets[id]; });
    const payload = {
        version: VERSION,
        name: state.projectName || state.model.name || '未命名设计',
        canvas: state.model.canvas,
        elements: state.model.elements,
        guides: state.model.guides || [],
        components: state.model.components,
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
        const imported = remapProjectAssets(parsed, () => uid('img'));
        imported.name = imported.name || file.name.replace(/\.[^.]+$/, '') || '未命名设计';
        await ensureProjectId();
        const sourceProjectId = state.projectId;
        const sourceSnapshot = snapshotJSON();
        if (!await persistCurrentProject()) return;
        for (const [id, data] of Object.entries(imported.assets || {})) {
            if (!await putAsset(id, data)) {
                toast('项目资源保存失败，已停止导入；请检查浏览器存储权限后重试', 'error');
                return;
            }
        }
        if (state.projectId !== sourceProjectId || snapshotJSON() !== sourceSnapshot) {
            toast('导入已取消：项目在载入期间发生变化，请重新导入', 'error');
            return;
        }
        const projectId = uid('prj');
        const settings: Settings = { ...state.settings, projectId, projectName: imported.name };
        if (!saveSettings(settings)) { toast('项目归属设置保存失败，已停止导入', 'error'); return; }
        state.projectId = projectId;
        state.projectName = imported.name;
        state.settings = settings;
        if (!applySnapshot(JSON.stringify({ ...imported, assets: undefined }))) return;
        resetHistoryWithSave();
        const saved = await persistCurrentProject();
        await renderProjectPanels();
        if (saved) toast('项目载入成功', 'success');
        else toast('项目已载入，但项目列表保存失败，请立即导出文件备份', 'error');
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