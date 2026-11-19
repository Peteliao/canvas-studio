/* 历史、自动保存与载入 */
import { STORAGE_KEY, VERSION, MAX_HISTORY } from './constants';
import { state } from './state';
import { $, toast } from './utils';
import { validateProject, snapshotJSON, normalizeZ } from './model';
import { dbAvailable, idbPut, idbAll } from './db';
import { renderAll, syncCanvasSize } from './render';
import { syncBackgroundControls, updateUI } from './panel';
import { queueProjectSave } from './projects';
import { resetLinkSnapshots, syncLinkedOnCommit } from './linked';

let undoStack: string[] = [];
let historyIndex = -1;
let isApplyingHistory = false;
let commitTimer: number | undefined;

export function updateUndoRedoButtons(): void {
    $('btnUndo').style.opacity = historyIndex > 0 ? '1' : '0.35';
    $('btnRedo').style.opacity = historyIndex < undoStack.length - 1 ? '1' : '0.35';
}
export function saveAuto(json: string): boolean {
    try {
        localStorage.setItem(STORAGE_KEY, json);
        return true;
    } catch {
        toast('本地存储空间不足，请立即用「保存项目」导出 .canvas 文件，以免内容丢失', 'error');
        return false;
    }
}
/** 连续滑块/输入只提交一次历史，避免 50 步被瞬间耗尽 */
export function scheduleCommit(delay?: number): void {
    clearTimeout(commitTimer);
    commitTimer = window.setTimeout(() => { commitTimer = undefined; commit(); }, delay === undefined ? 220 : delay);
}
/** 是否有等待中的防抖提交（悬停试穿前先结算，避免快照混入未提交状态） */
export function hasPendingCommit(): boolean {
    return commitTimer !== undefined;
}
export function commit(): void {
    clearTimeout(commitTimer);
    commitTimer = undefined;
    if (isApplyingHistory) return;
    // 关联副本：先按上次签名把变化成员的样式 / 尺寸传播给同组，再生成历史
    syncLinkedOnCommit();
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
    void flushAssets();
    queueProjectSave();
    const dot = $('saveDot'); if (dot) dot.classList.remove('dirty');
}
export async function flushAssets(): Promise<void> {
    if (!dbAvailable || !state.hiddenAssetsDirty.size) return;
    const ids = Array.from(state.hiddenAssetsDirty);
    state.hiddenAssetsDirty.clear();
    for (const id of ids) {
        if (state.assets[id]) await idbPut(id, state.assets[id]);
    }
}
export function applySnapshot(json: string): boolean {
    let parsed;
    try { parsed = validateProject(JSON.parse(json)); }
    catch (e) { toast('数据载入失败：' + (e as Error).message, 'error'); return false; }
    state.isTextEditing = false;
    state.editingId = null;
    state.interaction = null;
    state.model = { version: VERSION, name: parsed.name || state.projectName, canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
    state.guideSel = null;
    if (parsed.assets) Object.assign(state.assets, parsed.assets);
    state.selection = [];
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = undefined; }
    resetLinkSnapshots();
    renderAll();
    syncCanvasSize();
    syncBackgroundControls();
    updateUI();
    return true;
}
export function undo(): void {
    if (historyIndex <= 0) return;
    isApplyingHistory = true;
    historyIndex--;
    applySnapshot(undoStack[historyIndex]);
    saveAuto(undoStack[historyIndex]);
    isApplyingHistory = false;
    updateUndoRedoButtons();
}
export function redo(): void {
    if (historyIndex >= undoStack.length - 1) return;
    isApplyingHistory = true;
    historyIndex++;
    applySnapshot(undoStack[historyIndex]);
    saveAuto(undoStack[historyIndex]);
    isApplyingHistory = false;
    updateUndoRedoButtons();
}
export async function loadAuto(): Promise<boolean> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
        const parsed = validateProject(JSON.parse(raw));
        const stored = await idbAll();
        state.assets = Object.assign({}, stored, parsed.assets || {});
        state.model = { version: VERSION, name: parsed.name || state.projectName || '未命名设计', canvas: parsed.canvas, elements: parsed.elements, guides: parsed.guides || [] };
        undoStack = [snapshotJSON()];
        historyIndex = 0;
        resetLinkSnapshots();
        return true;
    } catch (e) {
        console.warn('自动保存数据不可用：', (e as Error).message);
        toast('本地存档无法读取（' + (e as Error).message + '），已载入空白画布；原数据未被覆盖', 'error');
        return false;
    }
}
/** 载入完成后重置历史栈（boot 使用） */
export function resetHistory(): void {
    undoStack = [snapshotJSON()];
    historyIndex = 0;
    resetLinkSnapshots();
}
/** 新建/切换项目、恢复版本后重置历史栈并立即自动保存 */
export function resetHistoryWithSave(): void {
    resetHistory();
    saveAuto(undoStack[0]);
}