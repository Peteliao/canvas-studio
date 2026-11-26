import type { ComponentDefinition } from './types';
import { state } from './state';
import { $opt, appConfirm, appPrompt, iconEl, toast, uid } from './utils';
import { selectedEls } from './model';
import { componentBounds, createComponentDefinition, detachComponentElements, instantiateComponent } from './component-core';

function componentRows(): ComponentDefinition[] {
    return state.model.components || [];
}

export function renderComponentLibrary(): void {
    const host = $opt('componentList');
    if (!host) return;
    host.textContent = '';
    const selection = selectedEls();
    const disabled = !selection.length || selection.some(el => !!el.componentId);
    document.querySelectorAll<HTMLButtonElement>('#btnCreateComponent, #btnCreateComponentPanel').forEach(button => { button.disabled = disabled; });
    const components = componentRows();
    const countBadge = $opt('componentCountBadge');
    if (countBadge) countBadge.textContent = String(components.length);
    if (!components.length) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = '选中画布元素后创建组件，之后可重复插入并同步主组件修改';
        host.appendChild(empty);
        return;
    }
    components.forEach(component => {
        const row = document.createElement('div');
        row.className = 'component-row';
        const icon = document.createElement('div');
        icon.className = 'component-icon';
        icon.appendChild(iconEl('group'));
        row.appendChild(icon);
        const meta = document.createElement('div');
        meta.className = 'component-meta';
        const title = document.createElement('div');
        title.className = 'component-title';
        title.textContent = component.name;
        const sub = document.createElement('div');
        sub.className = 'component-sub';
        sub.textContent = `${component.elements.length} 个元素 · ${component.elements.filter(el => el.image).length} 张图片`;
        meta.append(title, sub);
        row.appendChild(meta);
        const actions = document.createElement('div');
        actions.className = 'component-actions';
        const button = (label: string, titleText: string, fn: () => void, danger = false): void => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mini-btn' + (danger ? ' danger' : '');
            b.textContent = label;
            b.title = titleText;
            b.setAttribute('aria-label', titleText);
            b.addEventListener('click', () => { void fn(); });
            actions.appendChild(b);
        };
        button('插入', '插入组件实例', () => { void insertComponent(component.id); });
        button('主件', '定位并选中主组件', () => { void locateComponentMaster(component.id); });
        button('命名', '重命名组件', () => { void renameComponent(component.id); });
        button('删除', '删除组件并脱离全部实例', () => { void deleteComponent(component.id); }, true);
        row.appendChild(actions);
        host.appendChild(row);
    });
}

async function finishEditing(): Promise<void> {
    if (state.isTextEditing) {
        const { finishTextEdit } = await import('./richtext');
        finishTextEdit();
    }
}

async function refreshAfterChange(message: string): Promise<void> {
    const [{ renderAll }, { commit }] = await Promise.all([import('./render'), import('./history')]);
    renderAll();
    commit();
    renderComponentLibrary();
    toast(message, 'success');
}

export async function createComponentFromSelection(): Promise<void> {
    await finishEditing();
    const elements = selectedEls().slice().sort((a, b) => a.zIndex - b.zIndex);
    if (!elements.length) { toast('请先选中要创建组件的元素', 'error'); return; }
    if (elements.length > 200) { toast('单个组件最多包含 200 个元素，请减少选区', 'error'); return; }
    if (componentRows().length >= 100) { toast('组件数量已达上限（100 个），请先删除不需要的组件', 'error'); return; }
    if (elements.some(el => !!el.componentId)) { toast('请先脱离现有组件或主组件后再创建', 'error'); return; }
    const name = await appPrompt('组件名称：', elements.length === 1 ? elements[0].name : `组件 ${componentRows().length + 1}`, { title: '创建组件' });
    if (!name?.trim()) return;
    const definition = createComponentDefinition(elements, uid('cmp'), name);
    state.model.components = [...componentRows(), definition];
    elements.forEach(el => {
        el.componentId = definition.id;
        el.componentInstanceId = null;
        el.componentSourceId = el.id;
        el.linkId = null;
    });
    await refreshAfterChange(`已创建组件：${definition.name}`);
}

export async function insertComponent(componentId: string): Promise<void> {
    const definition = componentRows().find(component => component.id === componentId);
    if (!definition) { toast('组件不存在', 'error'); return; }
    const bounds = componentBounds(definition.elements);
    const scale = Math.min(1, 600 / Math.max(bounds.w, bounds.h));
    const { canvasCenterFor } = await import('./view');
    const center = canvasCenterFor(bounds.w * scale, bounds.h * scale);
    const instanceId = uid('cmp');
    const groupId = uid('grp');
    const elements = instantiateComponent(definition, instanceId, groupId, center.x, center.y, scale, scale, () => uid('el'));
    state.model.elements.push(...elements);
    const [{ renderAll }, { setSelection }, { commit }] = await Promise.all([
        import('./render'), import('./selection'), import('./history')
    ]);
    renderAll();
    setSelection(elements.map(el => el.id));
    commit();
    renderComponentLibrary();
    toast(`已插入组件实例：${definition.name}`, 'success');
}

export async function locateComponentMaster(componentId: string): Promise<void> {
    const masters = state.model.elements.filter(el => el.componentId === componentId && !el.componentInstanceId);
    if (!masters.length) { toast('这个组件没有可定位的主组件', 'error'); return; }
    const [{ setSelection }, { viewportRect }, { syncTransform }] = await Promise.all([
        import('./selection'), import('./view'), import('./render')
    ]);
    setSelection(masters.map(el => el.id));
    const bounds = componentBounds(masters);
    const viewport = viewportRect();
    state.pan.x = viewport.width / 2 - (bounds.x + bounds.w / 2) * state.zoom;
    state.pan.y = viewport.height / 2 - (bounds.y + bounds.h / 2) * state.zoom;
    syncTransform();
    toast(`已选中并定位主组件：${componentRows().find(c => c.id === componentId)?.name || '组件'}`, 'success');
}

export async function renameComponent(componentId: string): Promise<void> {
    const component = componentRows().find(item => item.id === componentId);
    if (!component) return;
    const name = await appPrompt('组件名称：', component.name, { title: '重命名组件' });
    if (!name?.trim()) return;
    component.name = name.trim().slice(0, 80);
    const sourceNames = new Map(component.elements.map(el => [el.id, el.name]));
    state.model.elements.forEach(el => {
        if (el.componentId !== component.id || !el.componentInstanceId) return;
        el.name = `${component.name} · ${sourceNames.get(el.componentSourceId || '') || '元素'}`.slice(0, 80);
    });
    await refreshAfterChange('组件已重命名，实例名称已同步');
}

export async function deleteComponent(componentId: string): Promise<void> {
    const component = componentRows().find(item => item.id === componentId);
    if (!component) return;
    const ok = await appConfirm(`删除「${component.name}」？画布上的主组件和实例会保留并脱离关联。`, { title: '删除组件' });
    if (!ok) return;
    state.model.components = componentRows().filter(item => item.id !== componentId);
    detachComponentElements(state.model.elements.filter(el => el.componentId === componentId));
    await refreshAfterChange('组件已删除，相关元素已脱离');
}

export async function detachSelectedComponents(): Promise<void> {
    const elements = selectedEls().filter(el => !!el.componentId);
    if (!elements.length) { toast('所选元素不是组件主件或实例', 'error'); return; }
    detachComponentElements(elements);
    await refreshAfterChange(`已脱离 ${elements.length} 个组件元素`);
}
