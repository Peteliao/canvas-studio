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