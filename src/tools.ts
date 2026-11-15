import { TYPE_LABELS } from './constants';
import { state } from './state';
import { $, $opt, toast } from './utils';
import { getEl, selectedEls } from './model';
import { saveSettings } from './db';
import { finishPen, renderPenDraft } from './interaction';
import { bucketColorLabel, hideBucketHover, syncBucketSwatch } from './bucket';
import { updateGrid, drawRulers } from './grid';
import { drawGuides } from './guides';
import { drawMeasure } from './measure';
import { renderLayerList } from './layerlist';
import { renderProjectPanels } from './projects';
import type { TabName, ToolName } from './types';

export function setTool(name: ToolName): void {
    if (name !== 'pen' && state.pen) finishPen(false, true);
    if (name !== 'pen') renderPenDraft();
    state.tool = name;
    ['railSelect', 'railPan', 'railText', 'railPen', 'railBucket'].forEach(id => { const n = $opt(id); if (n) n.classList.remove('active'); });
    const railId = name === 'pan' ? 'railPan' : name === 'text' ? 'railText' : name === 'pen' ? 'railPen'
        : name === 'bucket' ? 'railBucket' : 'railSelect';
    const btn = $opt(railId);
    if (btn) btn.classList.add('active');
    $('viewport').classList.toggle('tool-pan', name === 'pan');
    $('viewport').classList.toggle('tool-text', name === 'text');
    $('viewport').classList.toggle('tool-pen', name === 'pen');
    $('viewport').classList.toggle('tool-bucket', name === 'bucket');
    syncBucketSwatch();
    if (name !== 'bucket') hideBucketHover();
    if (name === 'pen') {
        toast('钢笔：单击加角点，拖拽出曲线；Alt+点击锚点或 Alt+落新点可让下一段变直线；Enter 完成', 'success');
    } else if (name === 'bucket') {
        toast('颜料桶：填充 ' + bucketColorLabel('fill') + ' · 描边 ' + bucketColorLabel('stroke')
            + '；点内部改填充、点边缘改描边，Shift 强制描边，Alt+点击吸色', 'success');
    }
}

export function toggleInspector(): void {
    state.settings.inspectorVisible = !state.settings.inspectorVisible;
    $('inspector').classList.toggle('collapsed', !state.settings.inspectorVisible);
    saveSettings();
    requestAnimationFrame(() => onViewChanged());
}

export function switchTab(name: TabName): void {
    state.activeTab = name;
    state.settings.activeTab = name; saveSettings();
    document.querySelectorAll<HTMLElement>('.inspector-tabs .tab').forEach(t => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'layers') renderLayerList();
    if (name === 'projects') renderProjectPanels();
}

export function toggleCard(id: string): void { const c = $opt(id); if (c) c.classList.toggle('collapsed'); }

export function syncInspectorFold(): void {
    const v = !!state.settings.inspectorFolded;
    $('inspector').classList.toggle('folded', v);
    const f = $opt('btnInspectorFold');
    if (f) {
        f.classList.toggle('folded', v);
        f.setAttribute('aria-expanded', String(!v));
        f.title = v ? '展开面板' : '收起面板';
    }
}

export function setInspectorFolded(v: boolean): void {
    state.settings.inspectorFolded = v;
    saveSettings();
    syncInspectorFold();
}

export function closeAllMenus(except?: Element | null): void {
    document.querySelectorAll('.menu.open').forEach(m => { if (m !== except) m.classList.remove('open'); });
}

export function bindMenus(): void {
    document.querySelectorAll<HTMLElement>('.menu-trigger').forEach(t => {
        t.addEventListener('click', e => {
            e.stopPropagation();
            const m = t.closest('.menu')!;
            const open = m.classList.contains('open');
            closeAllMenus(); m.classList.toggle('open', !open);
        });
    });
    document.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.menu')) closeAllMenus(); });
    document.querySelectorAll('.menu-pop').forEach(p => p.addEventListener('click', () => closeAllMenus()));
}

/* -------------------- 状态栏 / 视图变化 -------------------- */
export function refreshStudioUI(): void {
    const n = state.model.elements.length;
    const s = state.selection.length;
    const count = $opt('statusCount'); if (count) count.textContent = n + ' 个元素';
    const selStatus = $opt('statusSelection'); if (selStatus) selStatus.textContent = s ? `已选中 ${s} 个` : (state.guideSel ? '已选中辅助线' : '未选中');
    const proj = $opt('statusProject'); if (proj) proj.textContent = state.projectName || '未命名设计';
    const projName = $opt('projectName'); if (projName) projName.textContent = state.projectName || '未命名设计';
    const badge = $opt('layerCountBadge'); if (badge) badge.textContent = String(n);
    const hint = $opt('selTypeHint');
    if (hint) {
        const el = s === 1 ? getEl(state.selection[0]) : null;
        hint.textContent = el ? (TYPE_LABELS[el.type] || '') : '';
    }
    const ungroup = $opt<HTMLButtonElement>('btnUngroup');
    if (ungroup) {
        const grouped = selectedEls().some(e => !!e.groupId);
        ungroup.disabled = !grouped;
    }
    if (state.activeTab === 'layers') renderLayerList();
    drawGuides();
    drawMeasure();
}

export function refreshStudioPanels(): void {
    renderLayerList();
    drawGuides();
    drawMeasure();
    refreshStudioUI();
}

export function onViewChanged(): void {
    updateGrid();
    drawRulers();
    drawGuides();
    drawMeasure();
    const zoom = $opt('statusZoom'); if (zoom) zoom.textContent = Math.round(state.zoom * 100) + '%';
}