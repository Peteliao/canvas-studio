/* 左侧工具架分组：Photoshop 式一级图标 + 二级弹出菜单 */
import { SHAPE_MENU_BASIC, TYPE_LABELS, VECTOR_SHAPE_TYPES } from './constants';
import type { ElementType, ToolName } from './types';
import { $opt, elementIconEl, iconEl } from './utils';

let shapeBtn: HTMLButtonElement | null = null;
let lineBtn: HTMLButtonElement | null = null;
let shapeIcon: HTMLElement | null = null;
let lineIcon: HTMLElement | null = null;
let lineLabel: HTMLElement | null = null;
let shapeMenu: HTMLElement | null = null;
let lineMenu: HTMLElement | null = null;

function setGlyph(slot: HTMLElement | null, node: SVGElement): void {
    if (!slot) return;
    slot.textContent = '';
    slot.appendChild(node);
}

function setShapeGlyph(type: ElementType): void {
    setGlyph(shapeIcon, elementIconEl(type));
    const label = shapeBtn && shapeBtn.lastElementChild;
    if (label) label.textContent = TYPE_LABELS[type] || '形状';
}

function setLineGlyph(name: 'arrow' | 'line' | 'pen'): void {
    setGlyph(lineIcon, iconEl(name));
    if (lineLabel) lineLabel.textContent = name === 'arrow' ? '箭头' : name === 'pen' ? '钢笔' : '线条';
}

function closeMenus(): void {
    [shapeMenu, lineMenu].forEach(m => { if (m) m.hidden = true; });
    [shapeBtn, lineBtn].forEach(b => {
        if (!b) return;
        b.classList.remove('menu-open');
        b.setAttribute('aria-expanded', 'false');
    });
}

function positionMenu(menu: HTMLElement, btn: HTMLElement): void {
    const r = btn.getBoundingClientRect();
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = r.right + 8;
    let top = r.top;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
}

function openMenu(menu: HTMLElement | null, btn: HTMLButtonElement | null): void {
    if (!menu || !btn) return;
    const willOpen = menu.hidden;
    closeMenus();
    if (!willOpen) return;
    menu.hidden = false;
    btn.classList.add('menu-open');
    btn.setAttribute('aria-expanded', 'true');
    positionMenu(menu, btn);
}

function makeItem(act: string, arg: string, icon: SVGElement, label: string, hint?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rail-menu-item';
    b.dataset.act = act;
    b.dataset.arg = arg;
    b.setAttribute('role', 'menuitem');
    b.title = label + (hint ? ' ' + hint : '');
    b.appendChild(icon);
    const span = document.createElement('span');
    span.textContent = label;
    b.appendChild(span);
    if (hint) {
        const k = document.createElement('kbd');
        k.textContent = hint;
        b.appendChild(k);
    }
    return b;
}

function buildShapeMenu(host: HTMLElement): void {
    const order: ElementType[] = [...SHAPE_MENU_BASIC, ...VECTOR_SHAPE_TYPES];
    order.forEach(type => {
        const item = makeItem('addShape', type, elementIconEl(type), TYPE_LABELS[type] || type);
        item.addEventListener('click', () => { setShapeGlyph(type); closeMenus(); });
        host.appendChild(item);
    });
    host.style.gridTemplateColumns = 'repeat(4, 60px)';
}

function buildLineMenu(host: HTMLElement): void {
    const items: { act: string; arg: 'arrow' | 'line' | 'pen'; label: string; hint: string }[] = [
        { act: 'addShape', arg: 'arrow', label: '箭头', hint: '' },
        { act: 'addShape', arg: 'line', label: '线条', hint: '' },
        { act: 'setTool', arg: 'pen', label: '钢笔', hint: 'P' }
    ];
    items.forEach(it => {
        const item = makeItem(it.act, it.arg, iconEl(it.arg), it.label, it.hint || undefined);
        item.addEventListener('click', () => { setLineGlyph(it.arg); closeMenus(); });
        host.appendChild(item);
    });
    host.style.gridTemplateColumns = 'repeat(3, 64px)';
}

/** 工具切换时同步线条组图标（钢笔在组内） */
export function syncRailGroupForTool(name: ToolName): void {
    if (name === 'pen') setLineGlyph('pen');
}

export function closeRailMenus(): void { closeMenus(); }

export function initRail(): void {
    shapeBtn = $opt<HTMLButtonElement>('railShapeBtn');
    lineBtn = $opt<HTMLButtonElement>('railLineBtn');
    shapeIcon = $opt('railShapeIcon');
    lineIcon = $opt('railLineIcon');
    lineLabel = $opt('railLineLabel');
    shapeMenu = $opt('railShapeMenu');
    lineMenu = $opt('railLineMenu');
    if (!shapeBtn || !lineBtn || !shapeMenu || !lineMenu) return;
    buildShapeMenu(shapeMenu);
    buildLineMenu(lineMenu);
    setGlyph(shapeIcon, iconEl('square'));
    setGlyph(lineIcon, iconEl('line'));

    shapeBtn.addEventListener('click', e => { e.stopPropagation(); openMenu(shapeMenu, shapeBtn); });
    lineBtn.addEventListener('click', e => { e.stopPropagation(); openMenu(lineMenu, lineBtn); });

    document.addEventListener('click', e => {
        const t = e.target as Node;
        if (shapeMenu!.contains(t) || lineMenu!.contains(t) || shapeBtn!.contains(t) || lineBtn!.contains(t)) return;
        closeMenus();
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!shapeMenu!.hidden || !lineMenu!.hidden) { closeMenus(); e.stopPropagation(); }
    }, true);
    document.addEventListener('scroll', closeMenus, true);
    window.addEventListener('resize', closeMenus);
}
