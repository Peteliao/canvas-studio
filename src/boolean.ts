import { POLYGON_POINTS } from './constants';
import { state } from './state';
import { clamp, deepCopy, round2, toast, uid } from './utils';
import { buildElement, nextZIndex, selectedEls } from './model';
import { lineHeightFor } from './style';
import { renderAll } from './render';
import { commit } from './history';
import { getAABB } from './geometry';
import { updateUI } from './panel';
import { putAsset } from './db';
import type { AABB, CanvasElement } from './types';

export function shapePath(ctx: CanvasRenderingContext2D, el: CanvasElement, w: number, h: number): void {
    ctx.beginPath();
    const pts = POLYGON_POINTS[el.type];
    if (pts) {
        pts.forEach((p, i) => { const x = p[0] / 100 * w, y = p[1] / 100 * h; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.closePath();
    } else if (el.type === 'circle') {
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (ctx.roundRect && el.borderRadius > 0) {
        ctx.roundRect(0, 0, w, h, Math.min(el.borderRadius, w / 2, h / 2));
    } else ctx.rect(0, 0, w, h);
}

function drawMaskShape(ctx: CanvasRenderingContext2D, item: { el: CanvasElement; a: AABB }, op: GlobalCompositeOperation, originX: number, originY: number): void {
    ctx.globalCompositeOperation = op;
    ctx.save();
    const h = item.el.type === 'line' ? lineHeightFor(item.el) : item.el.h;
    ctx.translate(item.el.x - originX + item.el.pivotX * item.el.w, item.el.y - originY + item.el.pivotY * h);
    ctx.rotate(item.el.rotation * Math.PI / 180);
    ctx.translate(-item.el.pivotX * item.el.w, -item.el.pivotY * h);
    shapePath(ctx, item.el, item.el.w, h);
    ctx.fillStyle = '#000';
    ctx.fill();
    if (item.el.type === 'text') {
        ctx.font = `${item.el.text!.fontWeight} ${item.el.text!.fontSize}px ${item.el.text!.fontFamily}`;
        ctx.textBaseline = 'top';
        const text = item.el.text!.runs.map(r => r.text).join('');
        ctx.fillText(text, 0, 0);
    }
    ctx.restore();
}

export function performBoolean(op: string): void {
    const els = selectedEls();
    if (els.length < 2) { toast('请至少选择两个元素进行布尔运算', 'error'); return; }
    if (els.some(e => e.locked)) { toast('选中了锁定元素，无法进行布尔运算', 'error'); return; }
    if (els.some(e => e.type === 'curve')) { toast('曲线是开放路径，暂不支持布尔运算', 'error'); return; }
    const items = els.map(el => ({ el, a: getAABB(el) })).sort((p, q) => p.el.zIndex - q.el.zIndex);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach(i => {
        minX = Math.min(minX, i.a.left); minY = Math.min(minY, i.a.top);
        maxX = Math.max(maxX, i.a.right); maxY = Math.max(maxY, i.a.bottom);
    });
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const ratio = clamp(Math.sqrt(4000000 / (w * h)), 1, 3);
    const mask = document.createElement('canvas');
    mask.width = Math.round(w * ratio); mask.height = Math.round(h * ratio);
    const ctx = mask.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.scale(ratio, ratio);
    drawMaskShape(ctx, items[0], 'source-over', minX, minY);
    for (let i = 1; i < items.length; i++) {
        const comp: GlobalCompositeOperation = op === 'subtract' ? 'destination-out' : op === 'intersect' ? 'source-in' : 'source-over';
        drawMaskShape(ctx, items[i], comp, minX, minY);
    }
    const assetId = uid('mask');
    putAsset(assetId, mask.toDataURL('image/png'));
    const base = items[0].el;
    const result = buildElement('boolean', minX, minY);
    result.w = round2(w); result.h = round2(h);
    result.fill = deepCopy(base.fill);
    result.image = base.image ? deepCopy(base.image) : null;
    result.maskAssetId = assetId;
    result.zIndex = nextZIndex();
    const ids = new Set(els.map(e => e.id));
    state.model.elements = state.model.elements.filter(e => !ids.has(e.id));
    state.model.elements.push(result);
    state.selection = [result.id];
    renderAll(); updateUI(); commit();
    toast('布尔运算完成', 'success');
}