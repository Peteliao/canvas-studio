import { TYPE_ICONS, TYPE_LABELS } from './constants';
import { state } from './state';
import { $, appPrompt, iconEl, toast, uid } from './utils';
import { getEl, selectedEls, sortedElements } from './model';
import { applySelectionClasses, renderAll, syncElement } from './render';
import { commit } from './history';
import { normalizeZFromOrder } from './geometry';
import { setSelection } from './selection';
import { updateUI } from './panel';
import { setInspectorFolded, switchTab } from './tools';
import type { CanvasElement } from './types';

function layerIcon(el: CanvasElement): SVGSVGElement { return iconEl(el.groupId ? 'group' : (TYPE_ICONS[el.type] || 'square')); }

export function renderLayerList(): void {
    const host = $('layerList');
    const q = ($<HTMLInputElement>('layerSearch').value || '').trim().toLowerCase();
    host.textContent = '';
    const list = sortedElements().slice().reverse();
    const filtered = list.filter(e => !q || (e.name || '').toLowerCase().includes(q) || (TYPE_LABELS[e.type] || '').includes(q));
    $('layerCountBadge').textContent = String(state.model.elements.length);
    if (!filtered.length) {
        const d = document.createElement('div'); d.className = 'layer-empty';
        d.textContent = q ? '没有匹配的图层' : '画布上还没有元素';
        host.appendChild(d); return;
    }
    const sel = new Set(state.selection);
    filtered.forEach(el => {
        const row = document.createElement('div');
        row.className = 'layer-row' + (sel.has(el.id) ? ' selected' : '') + (el.visible ? '' : ' hidden-layer');
        row.dataset.id = el.id; row.draggable = true;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(sel.has(el.id)));
        row.tabIndex = 0;
        if (el.groupId) {
            const ind = document.createElement('div'); ind.className = 'group-indent'; row.appendChild(ind);
        }
        const thumb = document.createElement('div'); thumb.className = 'layer-thumb';
        thumb.appendChild(layerIcon(el)); row.appendChild(thumb);
        const meta = document.createElement('div'); meta.className = 'layer-meta';
        const nm = document.createElement('div'); nm.className = 'layer-name'; nm.textContent = el.name || TYPE_LABELS[el.type];
        const sub = document.createElement('div'); sub.className = 'layer-sub';
        sub.textContent = `${TYPE_LABELS[el.type] || el.type} · ${Math.round(el.w)}×${Math.round(el.h)}` + (el.groupId ? ' · 组内' : '');
        meta.appendChild(nm); meta.appendChild(sub); row.appendChild(meta);
        const act = document.createElement('div'); act.className = 'layer-actions';
        const mk = (icon: string, title: string, fn: () => void, danger?: boolean) => {
            const b = document.createElement('button'); b.className = 'layer-mini' + (danger ? ' danger' : '');
            b.title = title; b.setAttribute('aria-label', title); b.appendChild(iconEl(icon));
            b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
            act.appendChild(b); return b;
        };
        mk(el.visible ? 'eye' : 'eye-off', el.visible ? '隐藏图层' : '显示图层', () => toggleLayerVisible(el.id));
        mk(el.locked ? 'lock' : 'unlock', el.locked ? '解锁图层' : '锁定图层', () => toggleLayerLock(el.id));
        mk('tag', '重命名', () => renameLayer(el.id));
        mk('trash', '删除图层', () => deleteLayer(el.id), true);
        row.appendChild(act);
        row.addEventListener('click', e => {
            const ids = e.ctrlKey || e.metaKey ? state.selection.slice() : [];
            const i = ids.indexOf(el.id);
            if (i >= 0) ids.splice(i, 1); else ids.push(el.id);
            setSelection(expandGroupIds(ids));
            setInspectorFolded(false);
            switchTab('layers');
        });
        row.addEventListener('dblclick', () => renameLayer(el.id));
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
            else if (e.key === 'Delete') { e.preventDefault(); deleteLayer(el.id); }
        });
        row.addEventListener('dragstart', e => {
            e.dataTransfer!.setData('text/plain', el.id);
            e.dataTransfer!.effectAllowed = 'move';
            row.style.opacity = '.5';
        });
        row.addEventListener('dragend', () => { row.style.opacity = ''; });
        row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
            e.preventDefault(); row.classList.remove('drag-over');
            const srcId = e.dataTransfer!.getData('text/plain');
            if (srcId && srcId !== el.id) reorderLayer(srcId, el.id);
        });
        host.appendChild(row);
    });
}

function reorderLayer(srcId: string, targetId: string): void {
    const order = sortedElements();
    const from = order.findIndex(e => e.id === srcId);
    if (from < 0) return;
    const [moved] = order.splice(from, 1);
    const to = order.findIndex(e => e.id === targetId);
    order.splice(to < 0 ? order.length : to, 0, moved);
    normalizeZFromOrder(order);
    renderAll(); applySelectionClasses(); commit();
    toast('图层顺序已调整', 'success');
}

function toggleLayerVisible(id: string): void {
    const el = getEl(id); if (!el) return;
    el.visible = !el.visible; syncElement(id); renderLayerList(); commit();
}

function toggleLayerLock(id: string): void {
    const el = getEl(id); if (!el) return;
    el.locked = !el.locked; syncElement(id); renderLayerList(); updateUI(); commit();
}

async function renameLayer(id: string): Promise<void> {
    const el = getEl(id); if (!el) return;
    const name = await appPrompt('输入图层名称：', el.name || TYPE_LABELS[el.type], { title: '重命名图层' });
    if (!name) return;
    el.name = name.trim().slice(0, 80) || el.name;
    renderLayerList(); commit(); toast('已重命名', 'success');
}

export function renameSelected(): void {
    if (state.selection.length !== 1) { toast('请先选中一个图层', 'error'); return; }
    renameLayer(state.selection[0]);
}

function deleteLayer(id: string): void {
    const el = getEl(id); if (!el) return;
    if (el.locked) { toast('图层已锁定，无法删除', 'error'); return; }
    state.model.elements = state.model.elements.filter(e => e.id !== id);
    state.selection = state.selection.filter(x => x !== id);
    renderAll(); updateUI(); commit();
}

/* -------------------- N2 组合 / 解组 -------------------- */
export function expandGroupIds(ids: string[]): string[] {
    const out = new Set(ids);
    const groups = new Set(ids.map(getEl).filter((e): e is CanvasElement => !!e).map(e => e.groupId).filter((g): g is string => !!g));
    if (!groups.size) return ids.slice();
    state.model.elements.forEach(e => { if (e.groupId && groups.has(e.groupId)) out.add(e.id); });
    return Array.from(out);
}

export function groupSelected(): void {
    const els = selectedEls();
    if (els.length < 2) { toast('请至少选中两个元素再组合', 'error'); return; }
    const gid = uid('grp');
    els.forEach(e => { e.groupId = gid; syncElement(e.id); });
    renderAll(); applySelectionClasses(); commit();
    toast(`已将 ${els.length} 个元素组合`, 'success');
}

export function ungroupSelected(): void {
    const els = selectedEls().filter(e => !!e.groupId);
    if (!els.length) { toast('选中的元素不在组合中', 'error'); return; }
    els.forEach(e => { e.groupId = null; syncElement(e.id); });
    renderAll(); applySelectionClasses(); commit();
    toast(`已解组 ${els.length} 个元素`, 'success');
}

export function collapseAllGroups(): void {
    const ids = expandGroupIds(state.selection.length ? state.selection : state.model.elements.map(e => e.id));
    setSelection(ids); setInspectorFolded(false); switchTab('layers');
    toast('已展开全部组合', 'success');
}