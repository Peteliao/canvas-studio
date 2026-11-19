import { HEX_RE } from './constants';
import { state, nodeMap } from './state';
import { $, clamp, finite, toast } from './utils';
import { getEl, selectedEls } from './model';
import { applyAutoSize, renderAll, renderRuns, syncElement, syncNode, updateTextStats } from './render';
import { commit, scheduleCommit } from './history';
import { updatePropPanel, updateUI } from './panel';
import { syncGeoInputs } from './interaction';
import type { CanvasElement, FontWeight, TextAlign, TextRun, TextSizeMode } from './types';

const WEIGHTS: readonly number[] = [100, 300, 400, 500, 700, 900];

export function startTextEdit(el: CanvasElement): void {
    const d = nodeMap.get(el.id);
    if (!d) return;
    finishTextEdit();
    const tc = d.querySelector<HTMLElement>('.text-content');
    if (!tc) return;
    state.isTextEditing = true;
    state.editingId = el.id;
    d.classList.add('editing');
    tc.setAttribute('contenteditable', 'true');
    tc.addEventListener('paste', onTextPaste);
    tc.addEventListener('input', onTextInput);
    tc.onblur = () => finishTextEdit();
    tc.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(tc);
    sel.removeAllRanges(); sel.addRange(range);
}

export function parseRuns(root: HTMLElement): TextRun[] {
    const runs: TextRun[] = [];
    const base = { bold: false, italic: false, underline: false, color: '' };
    function walk(node: Node, style: typeof base): void {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.nodeValue) runs.push(Object.assign({ text: node.nodeValue }, style));
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const eln = node as HTMLElement;
        if (eln.tagName === 'BR') {
            // 末尾空段落里的孤立 br 是 contenteditable 的占位符，不算换行
            const p = eln.parentNode;
            const placeholder = p && p !== root && p.childNodes.length === 1 && p === root.lastElementChild;
            if (!placeholder) runs.push(Object.assign({ text: '\n' }, style));
            return;
        }
        const s = Object.assign({}, style);
        const ds = eln.dataset;
        if (ds.b === '1' || eln.tagName === 'B' || eln.tagName === 'STRONG') s.bold = true;
        if (ds.i === '1' || eln.tagName === 'I' || eln.tagName === 'EM') s.italic = true;
        if (ds.u === '1' || eln.tagName === 'U') s.underline = true;
        if (ds.color && HEX_RE.test(ds.color)) s.color = ds.color;
        // contenteditable 用 div/p 表示换行段落，需还原为 \n，否则导出与回读丢段落
        if (/^(DIV|P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(eln.tagName) && runs.length && !runs[runs.length - 1].text.endsWith('\n')) {
            runs.push(Object.assign({ text: '\n' }, s));
        }
        Array.from(eln.childNodes).forEach(c => walk(c, s));
    }
    Array.from(root.childNodes).forEach(c => walk(c, base));
    const merged: TextRun[] = [];
    runs.forEach(r => {
        const last = merged[merged.length - 1];
        if (last && last.bold === r.bold && last.italic === r.italic && last.underline === r.underline && last.color === r.color) last.text += r.text;
        else merged.push(Object.assign({}, r));
    });
    return merged.length ? merged : [{ text: '文本', bold: false, italic: false, underline: false, color: '' }];
}

export function finishTextEdit(): void {
    if (!state.isTextEditing) return;
    const id = state.editingId;
    const d = id ? nodeMap.get(id) : undefined;
    const el = id ? getEl(id) : null;
    state.isTextEditing = false;
    state.editingId = null;
    if (d && el && id) {
        const tc = d.querySelector<HTMLElement>('.text-content');
        if (tc) {
            tc.onblur = null;
            tc.removeEventListener('paste', onTextPaste);
            tc.removeEventListener('input', onTextInput);
            tc.removeAttribute('contenteditable');
            // 空文本框离开编辑即删除，避免留下不可见的空元素
            if (!(tc.textContent || '').trim()) {
                state.model.elements = state.model.elements.filter(x => x.id !== id);
                state.selection = state.selection.filter(x => x !== id);
                renderAll(); updateUI(); commit();
                return;
            }
            el.text!.runs = parseRuns(tc);
            applyAutoSize(el);
            renderRuns(tc, el);
        }
        d.classList.remove('editing');
        syncElement(el.id);
        updateTextStats(el);
        if (state.selection.length === 1) syncGeoInputs(el);
    }
    scheduleCommit(60);
}

export function onTextInput(): void {
    const el = state.editingId ? getEl(state.editingId) : null;
    const d = state.editingId ? nodeMap.get(state.editingId) : undefined;
    if (!el || !d) return;
    const tc = d.querySelector<HTMLElement>('.text-content');
    if (!tc) return;
    el.text!.runs = parseRuns(tc);
    applyAutoSize(el);
    syncNode(el, d);
    syncGeoInputs(el);
    updateTextStats(el);
    scheduleCommit(300);
}

export function onTextPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    onTextInput();
}

export function applyInlineStyle(prop: string, value: string | number): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { toast('请先选中要设置的文字', 'error'); return; }
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.dataset[prop] = String(value);
    if (prop === 'b') span.style.fontWeight = '700';
    else if (prop === 'i') span.style.fontStyle = 'italic';
    else if (prop === 'u') span.style.textDecoration = 'underline';
    else if (prop === 'color') span.style.color = String(value);
    try {
        range.surroundContents(span);
    } catch {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
    }
    sel.removeAllRanges();
    onTextInput();
    scheduleCommit(60);
}

export function updateTextStyle(prop: string): void {
    if (state.isTextEditing) {
        if (prop === 'bold') applyInlineStyle('b', 1);
        else if (prop === 'italic') applyInlineStyle('i', 1);
        else if (prop === 'underline') applyInlineStyle('u', 1);
        return;
    }
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    if (!els.length) return;
    els.forEach(e => {
        const t = e.text!;
        if (prop === 'font') {
            const raw = $<HTMLSelectElement>('fontFamilyInput').value;
            const parts = raw.split('|');
            t.fontFamily = parts[0] || 'sans-serif';
            const w = Number(parts[1]);
            t.fontWeight = WEIGHTS.includes(w) ? w as FontWeight : 400;
        } else if (prop === 'size') t.fontSize = clamp(finite($<HTMLInputElement>('fontSizeInput').value, t.fontSize), 1, 500);
        else if (prop === 'lineHeight') t.lineHeight = clamp(finite($<HTMLInputElement>('lineHeightInput').value, t.lineHeight), 0.3, 5);
        else if (prop === 'spacing') t.letterSpacing = clamp(finite($<HTMLInputElement>('letterSpacingInput').value, 0), -20, 100);
        else if (prop === 'paraSpacing') t.paraSpacing = clamp(finite($<HTMLInputElement>('paraSpacingInput').value, t.paraSpacing), 0, 300);
        else if (prop === 'indent') t.indent = clamp(finite($<HTMLInputElement>('textIndentInput').value, t.indent), 0, 600);
        else if (prop === 'weight') { const w = Number($<HTMLSelectElement>('fontWeightInput').value); if (WEIGHTS.includes(w)) t.fontWeight = w as FontWeight; }
        else if (prop === 'bold') t.fontWeight = t.fontWeight >= 700 ? 400 : 700;
        else if (prop === 'italic') { const on = !t.runs.every(r => r.italic); t.runs.forEach(r => { r.italic = on; }); }
        else if (prop === 'underline') { const on = !t.runs.every(r => r.underline); t.runs.forEach(r => { r.underline = on; }); }
        applyAutoSize(e);
        syncElement(e.id);
        updateTextStats(e);
    });
    if (els.length === 1) updatePropPanel(els[0]);
    scheduleCommit();
}

export function updateTextAlign(align: TextAlign): void {
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    els.forEach(e => { e.text!.align = align; syncElement(e.id); });
    if (els.length === 1) updatePropPanel(els[0]);
    scheduleCommit();
}

export function updateTextSizeMode(): void {
    const mode = $<HTMLSelectElement>('textSizeMode').value as TextSizeMode;
    const els = selectedEls().filter(e => !e.locked && e.type === 'text');
    els.forEach(e => {
        e.text!.sizeMode = mode;
        applyAutoSize(e);
        syncElement(e.id);
        updateTextStats(e);
    });
    if (els.length === 1) syncGeoInputs(els[0]);
    scheduleCommit();
}