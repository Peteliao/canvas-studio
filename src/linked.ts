/* 关联副本：同类型物件的样式 / 尺寸同步 */
import { TYPE_LABELS } from './constants';
import { state } from './state';
import { $opt, deepCopy, round2, toast, uid } from './utils';
import { selectedEls } from './model';
import { applyAutoSize, syncElement } from './render';
import type { CanvasElement, TextRun } from './types';

/** 上次提交时的样式签名；元素对象被撤销替换后自然失效 */
let snapshots = new WeakMap<CanvasElement, string>();

interface TextStylePayload {
    runs: Array<Pick<TextRun, 'bold' | 'italic' | 'underline' | 'color'>>;
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    lineHeight: number;
    letterSpacing: number;
    paraSpacing: number;
    indent: number;
    align: string;
    sizeMode: string;
}

/** 不含内容、位置、旋转、枢轴、图层元数据；文本尺寸只取稳定的部分 */
function signature(el: CanvasElement): string {
    const t = el.text;
    const text: TextStylePayload | null = t ? {
        runs: t.runs.map(r => ({ bold: r.bold, italic: r.italic, underline: r.underline, color: r.color })),
        fontSize: t.fontSize,
        fontFamily: t.fontFamily,
        fontWeight: t.fontWeight,
        lineHeight: t.lineHeight,
        letterSpacing: t.letterSpacing,
        paraSpacing: t.paraSpacing,
        indent: t.indent,
        align: t.align,
        sizeMode: t.sizeMode
    } : null;
    return JSON.stringify({
        type: el.type,
        w: el.type === 'text' && (!text || text.sizeMode === 'autoWH') ? null : round2(el.w),
        h: el.type === 'text' && text?.sizeMode !== 'fixed' ? null : round2(el.h),
        fill: el.fill,
        stroke: el.stroke,
        line: el.line,
        shadow: el.shadow,
        opacity: el.opacity,
        borderRadius: el.borderRadius,
        shapeParams: el.shapeParams,
        blendMode: el.blendMode,
        effectTint: el.effectTint,
        text,
        curve: el.curve ? { filled: el.curve.filled, strokeOn: el.curve.strokeOn } : null
    });
}

function applyLinkedStyle(target: CanvasElement, src: CanvasElement): void {
    target.w = src.w;
    target.h = src.h;
    target.fill = deepCopy(src.fill);
    target.stroke = deepCopy(src.stroke);
    target.line = src.line ? deepCopy(src.line) : null;
    target.shadow = deepCopy(src.shadow);
    target.opacity = src.opacity;
    target.borderRadius = src.borderRadius;
    target.shapeParams = deepCopy(src.shapeParams);
    target.blendMode = src.blendMode;
    target.effectTint = src.effectTint;
    if (target.curve && src.curve) {
        target.curve.filled = src.curve.filled;
        target.curve.strokeOn = src.curve.strokeOn;
    }
    if (target.text && src.text) {
        const s = src.text, t = target.text;
        t.fontSize = s.fontSize;
        t.fontFamily = s.fontFamily;
        t.fontWeight = s.fontWeight;
        t.lineHeight = s.lineHeight;
        t.letterSpacing = s.letterSpacing;
        t.paraSpacing = s.paraSpacing;
        t.indent = s.indent;
        t.align = s.align;
        t.sizeMode = s.sizeMode;
        const last = s.runs[s.runs.length - 1];
        t.runs.forEach((r, i) => {
            const from = s.runs[Math.min(i, s.runs.length - 1)] || last;
            if (!from) return;
            r.bold = from.bold; r.italic = from.italic; r.underline = from.underline; r.color = from.color;
        });
        applyAutoSize(target);
    }
}

function record(list: CanvasElement[]): void {
    list.forEach(e => snapshots.set(e, signature(e)));
}

/** 链接建立、载入存档或撤销后调用，避免首次提交把旧差异当成新修改 */
export function resetLinkSnapshots(): void {
    snapshots = new WeakMap();
    record(state.model.elements.filter(e => !!e.linkId));
}

function pickSource(dirty: CanvasElement[]): CanvasElement {
    for (let i = state.selection.length - 1; i >= 0; i--) {
        const hit = dirty.find(e => e.id === state.selection[i]);
        if (hit) return hit;
    }
    return dirty[dirty.length - 1];
}

/** 在 commit 生成快照前同步关联成员，返回是否有属性被传播 */
export function syncLinkedOnCommit(): boolean {
    const groups = new Map<string, CanvasElement[]>();
    state.model.elements.forEach(e => {
        if (!e.linkId) return;
        const arr = groups.get(e.linkId);
        if (arr) arr.push(e);
        else groups.set(e.linkId, [e]);
    });
    let propagated = false;
    groups.forEach(list => {
        if (list.length < 2) {
            list.forEach(e => { e.linkId = null; syncElement(e.id); });
            return;
        }
        const dirty = list.filter(e => snapshots.has(e) && snapshots.get(e) !== signature(e));
        if (!dirty.length) { record(list); return; }
        const src = pickSource(dirty);
        list.forEach(target => {
            if (target === src) return;
            applyLinkedStyle(target, src);
            syncElement(target.id);
            propagated = true;
        });
        record(list);
    });
    return propagated;
}

/** 选中物件的关联兼容性：至少两个、未锁定、同一元素类型 */
export function linkCompatibility(): { ok: boolean; reason: string } {
    const els = selectedEls();
    if (els.length < 2) return { ok: false, reason: '请至少选中两个物件再建立关联副本' };
    if (els.some(e => e.locked)) return { ok: false, reason: '锁定物件无法建立关联副本，请先解锁' };
    const types = Array.from(new Set(els.map(e => e.type)));
    if (types.length > 1) {
        const names = types.map(t => TYPE_LABELS[t] || t).join(' / ');
        return { ok: false, reason: `无法关联不同基础类型的物件（${names}）：关联需要填充、描边、尺寸等属性结构一致，请选择同一种物件` };
    }
    return { ok: true, reason: '' };
}

export function linkSelected(): void {
    const compat = linkCompatibility();
    if (!compat.ok) { toast(compat.reason, 'error'); return; }
    const els = selectedEls().filter(e => !e.locked);
    const lid = uid('lnk');
    els.forEach(e => { e.linkId = lid; });
    record(els);
    els.forEach(e => syncElement(e.id));
    resetLinkSnapshots();
    toast(`已将 ${els.length} 个${TYPE_LABELS[els[0].type] || '物件'}设为关联副本：修改任一物件的填充、描边、尺寸等会同步到其余成员`, 'success');
}

export function unlinkSelected(): void {
    const els = selectedEls().filter(e => !!e.linkId);
    if (!els.length) { toast('选中的物件没有关联副本', 'error'); return; }
    const touched = new Set<string>();
    els.forEach(e => { e.linkId = null; touched.add(e.id); });
    // 关联组只剩一个成员时自动解散，避免出现「只有自己的关联」
    const counts = new Map<string, CanvasElement[]>();
    state.model.elements.forEach(e => {
        if (!e.linkId) return;
        const arr = counts.get(e.linkId);
        if (arr) arr.push(e);
        else counts.set(e.linkId, [e]);
    });
    counts.forEach(list => {
        if (list.length < 2) list.forEach(e => { e.linkId = null; touched.add(e.id); });
    });
    touched.forEach(id => syncElement(id));
    resetLinkSnapshots();
    const remaining = state.model.elements.filter(e => !!e.linkId).length;
    toast(remaining
        ? `已解除 ${touched.size} 个物件的关联同步；其余 ${remaining} 个成员仍保持原有链接`
        : `已解除 ${touched.size} 个物件的关联同步；关联组已全部解散`, 'success');
}

/** 顶栏按钮状态：允许点击后给出具体原因，因此不做 disabled，仅做弱化提示 */
export function syncLinkTools(): void {
    const link = $opt<HTMLButtonElement>('btnLinkSelected');
    const unlink = $opt<HTMLButtonElement>('btnUnlinkSelected');
    if (!link || !unlink) return;
    const compat = linkCompatibility();
    link.title = compat.ok
        ? '关联副本：填充、描边、粗细、尺寸、圆角、阴影等同步修改'
        : compat.reason;
    link.classList.toggle('unavailable', !compat.ok);
    const hasLink = selectedEls().some(e => !!e.linkId);
    unlink.classList.toggle('active', hasLink);
    unlink.title = hasLink ? '断开所选物件的关联同步' : '所选物件未建立关联';
}
