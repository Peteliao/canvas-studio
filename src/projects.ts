/* 多项目与版本快照（IndexedDB） */
import { DB_PROJECTS, DB_VERSIONS } from './constants';
import { state } from './state';
import { $, uid, iconEl, toast, appPrompt, appConfirm } from './utils';
import { storeAll, storePut, storeDelete, saveSettings } from './db';
import { defaultModel, snapshotJSON } from './model';
import { applySnapshot, resetHistoryWithSave } from './history';
import { renderAll, syncCanvasSize } from './render';
import { syncBackgroundControls, updateUI } from './panel';
import { resetView } from './view';
import { refreshStudioUI } from './tools';

interface ProjectRecord { id: string; name: string; updated: number; data: string; }
interface VersionRecord { id: string; projectId: string; name: string; created: number; data: string; }

let projectSaveTimer: number | undefined;

export function queueProjectSave(): void {
    clearTimeout(projectSaveTimer);
    projectSaveTimer = window.setTimeout(() => { void persistCurrentProject(); }, 700);
}
/** 页面卸载前取消排队中的延迟保存并立即落盘 */
export function flushProjectSave(): void {
    clearTimeout(projectSaveTimer);
    void persistCurrentProject();
}
export async function persistCurrentProject(): Promise<void> {
    if (!state.projectId || !state.model) return;
    const ok = await storePut(DB_PROJECTS, {
        id: state.projectId, name: state.projectName, updated: Date.now(), data: snapshotJSON()
    });
    if (!ok) toast('项目列表保存失败，请用「保存项目」导出文件备份', 'error');
}
export async function ensureProjectId(): Promise<void> {
    if (state.projectId) return;
    const items = await storeAll<ProjectRecord>(DB_PROJECTS);
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
export async function renderProjectPanels(): Promise<void> {
    await ensureProjectId();
    renderProjectList(); renderVersionList();
}
function renderProjectList(): void {
    const host = $('projectList');
    void storeAll<ProjectRecord>(DB_PROJECTS).then(items => {
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
                open.addEventListener('click', () => { void switchProject(p.id); }); row.appendChild(open);
            } else {
                const cur = document.createElement('span'); cur.className = 'mini-btn'; cur.textContent = '当前'; row.appendChild(cur);
            }
            const ren = document.createElement('button'); ren.className = 'mini-btn'; ren.title = '重命名'; ren.textContent = '改名';
            ren.addEventListener('click', () => { void renameProject(p.id, p.name); }); row.appendChild(ren);
            const del = document.createElement('button'); del.className = 'mini-btn danger'; del.title = '删除'; del.textContent = '删';
            del.addEventListener('click', () => { void deleteProject(p.id, p.name); }); row.appendChild(del);
            host.appendChild(row);
        });
    });
}
function renderVersionList(): void {
    const host = $('versionList');
    void storeAll<VersionRecord>(DB_VERSIONS).then(items => {
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
            rest.addEventListener('click', () => { void restoreVersion(v.id, v.name); }); row.appendChild(rest);
            const del = document.createElement('button'); del.className = 'mini-btn danger'; del.textContent = '删';
            del.addEventListener('click', () => { void deleteVersion(v.id); }); row.appendChild(del);
            host.appendChild(row);
        });
    });
}
export async function newProject(): Promise<void> {
    const name = await appPrompt('新项目名称：', '未命名设计', { title: '新建项目' });
    if (!name) return;
    await persistCurrentProject();
    state.projectId = uid('prj'); state.projectName = name.trim() || '未命名设计';
    state.settings.projectId = state.projectId; state.settings.projectName = state.projectName; saveSettings();
    state.model = defaultModel(); state.model.name = state.projectName;
    state.selection = [];
    renderAll(); syncCanvasSize(); syncBackgroundControls(); resetView(); updateUI();
    resetHistoryWithSave();
    await persistCurrentProject(); await renderProjectPanels();
    toast('已新建项目：' + state.projectName, 'success');
}
export async function switchProject(id: string): Promise<void> {
    const ok = await appConfirm('切换项目会载入该项目的画布，当前未导出的更改会自动保存。继续吗？', { title: '切换项目' });
    if (!ok) return;
    await persistCurrentProject();
    const items = await storeAll<ProjectRecord>(DB_PROJECTS);
    const p = items.find(x => x.id === id);
    if (!p) { toast('项目不存在', 'error'); return; }
    state.projectId = p.id; state.projectName = p.name;
    state.settings.projectId = p.id; state.settings.projectName = p.name; saveSettings();
    applySnapshot(p.data);
    resetHistoryWithSave();
    await renderProjectPanels(); toast('已切换到：' + p.name, 'success');
}
export async function renameProject(id: string, oldName: string): Promise<void> {
    const name = await appPrompt('项目名称：', oldName, { title: '重命名项目' });
    if (!name) return;
    const items = await storeAll<ProjectRecord>(DB_PROJECTS);
    const p = items.find(x => x.id === id); if (!p) return;
    p.name = name.trim() || p.name; p.updated = Date.now();
    await storePut(DB_PROJECTS, p);
    if (id === state.projectId) {
        state.projectName = p.name; state.model.name = p.name;
        state.settings.projectName = p.name; saveSettings(); refreshStudioUI();
    }
    renderProjectList(); toast('已重命名', 'success');
}
export async function deleteProject(id: string, name: string): Promise<void> {
    if (id === state.projectId) { toast('不能删除当前项目，请先切换到其他项目', 'error'); return; }
    const ok = await appConfirm(`确定删除项目「${name}」吗？此操作不可撤销。`, { title: '删除项目' });
    if (!ok) return;
    await storeDelete(DB_PROJECTS, id);
    const versions = await storeAll<VersionRecord>(DB_VERSIONS);
    for (const v of versions.filter(v => v.projectId === id)) await storeDelete(DB_VERSIONS, v.id);
    renderProjectList(); toast('项目已删除', 'success');
}
export async function createVersion(): Promise<void> {
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
export async function restoreVersion(id: string, name: string): Promise<void> {
    const ok = await appConfirm(`确定恢复到「${name}」吗？当前画布内容会被替换（可用撤销前的自动保存备份）。`, { title: '恢复版本' });
    if (!ok) return;
    const items = await storeAll<VersionRecord>(DB_VERSIONS);
    const v = items.find(x => x.id === id); if (!v) { toast('版本不存在', 'error'); return; }
    applySnapshot(v.data);
    resetHistoryWithSave();
    toast('已恢复版本：' + name, 'success');
}
export async function deleteVersion(id: string): Promise<void> {
    const ok = await appConfirm('确定删除这个版本快照吗？', { title: '删除版本' });
    if (!ok) return;
    await storeDelete(DB_VERSIONS, id); renderVersionList(); toast('版本已删除', 'success');
}