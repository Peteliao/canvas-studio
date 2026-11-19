/* 视图 / 缩放（鼠标锚点） */
import { MIN_ZOOM, MAX_ZOOM } from './constants';
import { state } from './state';
import { $, clamp } from './utils';
import { syncTransform } from './render';

export function viewportRect(): DOMRect { return $('viewport').getBoundingClientRect(); }
export function setZoom(next: number, clientX?: number, clientY?: number): void {
    const vr = viewportRect();
    const ax = (clientX === undefined ? vr.left + vr.width / 2 : clientX) - vr.left;
    const ay = (clientY === undefined ? vr.top + vr.height / 2 : clientY) - vr.top;
    const old = state.zoom;
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const worldX = (ax - state.pan.x) / old;
    const worldY = (ay - state.pan.y) / old;
    state.zoom = z;
    state.pan.x = ax - worldX * z;
    state.pan.y = ay - worldY * z;
    syncTransform();
}
export function adjustZoom(delta: number, clientX?: number, clientY?: number): void { setZoom(state.zoom + delta, clientX, clientY); }
export function resetView(): void {
    const vr = viewportRect();
    state.zoom = 1;
    state.pan.x = (vr.width - state.model.canvas.w) / 2;
    state.pan.y = (vr.height - state.model.canvas.h) / 2;
    syncTransform();
}
export function fitToScreen(): void {
    const vr = viewportRect();
    const pad = 40;
    const cw = state.model.canvas.w, ch = state.model.canvas.h;
    const z = clamp(Math.min((vr.width - pad) / cw, (vr.height - pad) / ch), MIN_ZOOM, 5);
    state.zoom = z;
    state.pan.x = (vr.width - cw * z) / 2;
    state.pan.y = (vr.height - ch * z) / 2;
    syncTransform();
}
export function canvasCenterFor(w: number, h: number): { x: number; y: number } {
    const vr = viewportRect();
    const worldX = (vr.width / 2 - state.pan.x) / state.zoom;
    const worldY = (vr.height / 2 - state.pan.y) / state.zoom;
    return { x: worldX - w / 2, y: worldY - h / 2 };
}

/* -------------------- 缩放/平移后的「适应屏幕」浮钮 -------------------- */
let fitFloatTimer = 0, fitFloatHideTimer = 0, fitFloatBound = false;
export function hideFitFloat(immediate = false): void {
    clearTimeout(fitFloatTimer); clearTimeout(fitFloatHideTimer);
    const btn = $('fitFloatBtn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.remove('show');
    if (immediate) btn.hidden = true;
    else fitFloatHideTimer = window.setTimeout(() => { btn.hidden = true; }, 200);
}
/** 在指针附近显示「适应屏幕」浮钮，数秒未点击自动消失 */
export function showFitFloat(clientX?: number, clientY?: number): void {
    const btn = $('fitFloatBtn') as HTMLButtonElement | null;
    if (!btn) return;
    bindFitFloat();
    const vr = viewportRect();
    const ax = clientX === undefined ? vr.left + vr.width / 2 : clientX;
    const ay = clientY === undefined ? vr.top + vr.height / 2 : clientY;
    if (btn.hidden) {
        btn.hidden = false;
        btn.classList.remove('show');
        void btn.offsetWidth;
        requestAnimationFrame(() => btn.classList.add('show'));
    }
    const w = btn.offsetWidth || 110, h = btn.offsetHeight || 34;
    const x = clamp(ax + 18, vr.left + 8, Math.max(vr.left + 8, vr.right - w - 8));
    const y = clamp(ay + 20, vr.top + 8, Math.max(vr.top + 8, vr.bottom - h - 8));
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    clearTimeout(fitFloatTimer); clearTimeout(fitFloatHideTimer);
    fitFloatTimer = window.setTimeout(() => hideFitFloat(), 3600);
}
function bindFitFloat(): void {
    if (fitFloatBound) return;
    fitFloatBound = true;
    const btn = $('fitFloatBtn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        hideFitFloat(true);
        fitToScreen();
    });
}