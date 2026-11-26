/* 系统剪贴板与拖放导入 */
import { VERSION } from './constants';
import type { CanvasElement } from './types';
import { state } from './state';
import { $, toast, uid, deepCopy, round2 } from './utils';
import { decodeImageFile, isImageFile } from './imageimport';
import { insertDecodedImage } from './image';
import { validateElement, selectedEls, nextZIndex, buildElement, makeText } from './model';
import { renderAll } from './render';
import { setSelection } from './selection';
import { commit } from './history';
import { clientToWorld } from './interaction';
import { canvasCenterFor } from './view';
import { importProjectFile } from './project';

function serialFromElements(els: CanvasElement[]): string {
    return JSON.stringify({ kind: 'canvas-studio-elements', version: VERSION, elements: els });
}
function elementsFromSerial(text: string): CanvasElement[] | null {
    try {
        const o = JSON.parse(text) as { kind?: string; elements?: unknown[] } | null;
        if (!o || o.kind !== 'canvas-studio-elements' || !Array.isArray(o.elements)) return null;
        const seen = new Set<string>();
        return o.elements.slice(0, 200).map(e => validateElement(e)).map(e => {
            if (seen.has(e.id)) e.id = uid('el'); seen.add(e.id); return e;
        });
    } catch { return null; }
}
export async function copyToClipboardSystem(): Promise<void> {
    if (!state.selection.length) return;
    state.clipboard = selectedEls().map(deepCopy);
    const text = serialFromElements(state.clipboard);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            toast(`已复制 ${state.clipboard.length} 个元素（可跨项目粘贴）`, 'success');
        } else toast(`已复制 ${state.clipboard.length} 个元素（应用内剪贴板）`, 'success');
    } catch { toast(`已复制 ${state.clipboard.length} 个元素（应用内剪贴板）`, 'success'); }
}
export async function pasteFromClipboardSystem(): Promise<void> {
    let parsed: CanvasElement[] | null = null;
    try {
        if (navigator.clipboard && navigator.clipboard.readText) {
            const text = await navigator.clipboard.readText();
            parsed = elementsFromSerial(text);
        }
    } catch { /* 权限受限，回退应用内剪贴板 */ }
    const src = parsed || state.clipboard;
    if (!src || !src.length) { toast('剪贴板中没有可粘贴的元素', 'error'); return; }
    const clones = src.map(e => {
        const c = validateElement(deepCopy(e));
        c.id = uid('el'); c.x = round2(c.x + 20); c.y = round2(c.y + 20);
        c.zIndex = nextZIndex(); c.locked = false;
        c.groupId = null; c.linkId = null;
        c.componentId = null; c.componentInstanceId = null; c.componentSourceId = null; return c;
    });
    state.model.elements.push(...clones);
    renderAll(); setSelection(clones.map(c => c.id)); commit();
    toast(`已粘贴 ${clones.length} 个元素`, 'success');
}
async function insertImageFileAt(file: File, clientX?: number, clientY?: number): Promise<boolean> {
    if (!file || !isImageFile(file)) return false;
    const projectId = state.projectId;
    try {
        const decoded = await decodeImageFile(file);
        if (projectId !== state.projectId) { toast('项目已切换，已取消图片导入', 'error'); return false; }
        return await insertDecodedImage(file.name, decoded, clientX, clientY);
    } catch (err) { toast('图片导入失败：' + (err as Error).message, 'error'); return false; }
}
function insertTextAt(text: string, clientX?: number, clientY?: number): void {
    const el = buildElement('text', 0, 0);
    el.text = makeText({ runs: [{ text: String(text).slice(0, 2000) }] });
    const pos = clientX === undefined ? canvasCenterFor(el.w, 60) : clientToWorld(clientX, clientY!);
    el.x = round2(pos.x); el.y = round2(pos.y);
    state.model.elements.push(el);
    renderAll(); setSelection([el.id]); commit();
}
export function bindDropImport(): void {
    const vp = $('viewport');
    (['dragenter', 'dragover'] as const).forEach(t => vp.addEventListener(t, e => {
        e.preventDefault(); e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        vp.classList.add('drag-over');
    }));
    vp.addEventListener('dragleave', e => {
        if (!vp.contains(e.relatedTarget as Node | null)) vp.classList.remove('drag-over');
    });
    vp.addEventListener('drop', e => {
        void (async () => {
            e.preventDefault(); e.stopPropagation();
            vp.classList.remove('drag-over');
            const dt = e.dataTransfer; if (!dt) return;
            const files = Array.from(dt.files || []);
            if (files.length) {
                for (const f of files) {
                    if (isImageFile(f)) { await insertImageFileAt(f, e.clientX, e.clientY); continue; }
                    if (/\.(canvas|json)$/i.test(f.name) || f.type === 'application/json') { await importProjectFile(f); continue; }
                    if (/^text\//.test(f.type) || /\.txt$/i.test(f.name)) {
                        insertTextAt(await f.text(), e.clientX, e.clientY); continue;
                    }
                    toast('不支持的文件类型：' + f.name, 'error');
                }
                return;
            }
            const text = dt.getData('text/plain');
            if (text) {
                const els = elementsFromSerial(text);
                if (els) { state.clipboard = els; await pasteFromClipboardSystem(); }
                else insertTextAt(text, e.clientX, e.clientY);
            }
        })();
    });
}