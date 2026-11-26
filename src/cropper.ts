import { state } from './state';
import { $, clamp, loadImage, readFileAsDataURL, toast, uid } from './utils';
import { getEl } from './model';
import { lineHeightFor } from './style';
import { syncElement } from './render';
import { commit } from './history';
import { putAsset } from './db';
import type { CanvasElement, CropState, ImageRef } from './types';

let cropState: CropState | null = null;
let cropConfirming = false;
let cropSession = 0;

export function openCropModal(elId: string): void {
    const el = getEl(elId);
    if (!el) return;
    const src = el.image ? state.assets[el.image.originalAssetId] : null;
    if (!src) { replaceImage(); return; }
    showCrop(src, el);
}

export function replaceImage(): void {
    $<HTMLInputElement>('cropFileInput').click();
}

export async function handleCropFile(input: HTMLInputElement): Promise<void> {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const session = cropSession, projectId = state.projectId;
    const targetId = cropState ? cropState.elId : (state.selection[0] || null);
    if (!targetId) { toast('请先选中一个元素', 'error'); return; }
    try {
        const dataURL = await readFileAsDataURL(file);
        await loadImage(dataURL);
        const el = getEl(targetId);
        if (!el || el.type !== 'image') { toast('请先选中一张图片', 'error'); return; }
        const assetId = uid('img');
        if (!await putAsset(assetId, dataURL)) { toast('图片资源保存失败，请检查浏览器存储权限后重试', 'error'); return; }
        if (session !== cropSession || projectId !== state.projectId) return;
        const pendingImage: ImageRef = { assetId, originalAssetId: assetId, crop: null };
        showCrop(dataURL, el, pendingImage);
    } catch (e) { toast('图片载入失败：' + (e as Error).message, 'error'); }
}

function showCrop(src: string, el: CanvasElement, pendingImage: ImageRef | null = null): void {
    const session = ++cropSession;
    $('cropShade').style.display = 'none';
    $('cropModal').style.display = 'flex';
    const img = $<HTMLImageElement>('cropImg');
    const frame = $('cropFrame');
    frame.classList.toggle('circle', el.type === 'circle');
    const setup = () => {
        if (session !== cropSession || $('cropModal').style.display !== 'flex') return;
        const stage = $('cropStage');
        const iw = img.offsetWidth, ih = img.offsetHeight;
        if (!iw || !ih) return;
        const left = (stage.clientWidth - iw) / 2, top = (stage.clientHeight - ih) / 2;
        const ratio = el.w / Math.max(1, el.type === 'line' ? lineHeightFor(el) : el.h);
        let fw = iw * 0.9, fh = fw / ratio;
        if (fh > ih * 0.9) { fh = ih * 0.9; fw = fh * ratio; }
        const rect = { x: left + (iw - fw) / 2, y: top + (ih - fh) / 2, w: fw, h: fh };
        cropState = {
            elId: el.id, assetId: pendingImage?.assetId || (el.image ? el.image.originalAssetId : null),
            ratio, imgLeft: left, imgTop: top, imgW: iw, imgH: ih,
            naturalW: img.naturalWidth, naturalH: img.naturalHeight, rect, pendingImage
        };
        paintCropFrame();
    };
    img.onload = setup;
    img.src = src;
    if (img.complete && img.naturalWidth) setup();
}

function paintCropFrame(): void {
    if (!cropState) return;
    const r = cropState.rect;
    const f = $('cropFrame');
    f.style.left = r.x + 'px'; f.style.top = r.y + 'px';
    f.style.width = r.w + 'px'; f.style.height = r.h + 'px';
}

function clampCropRect(): void {
    if (!cropState) return;
    const c = cropState, r = c.rect;
    r.w = clamp(r.w, 24, c.imgW); r.h = clamp(r.h, 24, c.imgH);
    r.x = clamp(r.x, c.imgLeft, c.imgLeft + c.imgW - r.w);
    r.y = clamp(r.y, c.imgTop, c.imgTop + c.imgH - r.h);
}

export function initCropInteraction(): void {
    const frame = $('cropFrame');
    frame.addEventListener('pointerdown', e => {
        if (!cropState) return;
        e.preventDefault(); e.stopPropagation();
        const handle = (e.target as HTMLElement).dataset.h;
        const r = Object.assign({}, cropState.rect);
        state.interaction = {
            kind: 'crop', mode: handle ? 'resize' : 'move', dir: handle || null,
            startX: e.clientX, startY: e.clientY, rect: r
        };
        frame.setPointerCapture(e.pointerId);
    });
    frame.addEventListener('pointermove', e => {
        const it = state.interaction;
        if (!it || it.kind !== 'crop' || !cropState) return;
        const dx = e.clientX - it.startX, dy = e.clientY - it.startY;
        const r = cropState.rect;
        if (it.mode === 'move') {
            r.x = it.rect.x + dx; r.y = it.rect.y + dy;
        } else {
            let { x, y, w, h } = it.rect;
            const dir = it.dir || '';
            if (dir.includes('w')) { x += dx; w -= dx; }
            if (dir.includes('e')) { w += dx; }
            if (dir.includes('n')) { y += dy; h -= dy; }
            if (dir.includes('s')) { h += dy; }
            if (!e.shiftKey && cropState.ratio) {
                h = Math.max(24, w / cropState.ratio);
                if (dir.includes('n')) y = it.rect.y + it.rect.h - h;
            }
            Object.assign(r, { x, y, w, h });
        }
        clampCropRect(); paintCropFrame();
    });
    const stop = () => { if (state.interaction && state.interaction.kind === 'crop') state.interaction = null; };
    frame.addEventListener('pointerup', stop);
    frame.addEventListener('pointercancel', stop);
}

export async function cropConfirm(): Promise<void> {
    if (!cropState) { closeModal('cropModal'); return; }
    if (cropConfirming) return;
    cropConfirming = true;
    const session = cropSession, projectId = state.projectId;
    try {
        const c = cropState;
        const sx = (c.rect.x - c.imgLeft) / c.imgW * c.naturalW;
        const sy = (c.rect.y - c.imgTop) / c.imgH * c.naturalH;
        const sw = c.rect.w / c.imgW * c.naturalW;
        const sh = c.rect.h / c.imgH * c.naturalH;
        const outW = Math.max(1, Math.round(sw)), outH = Math.max(1, Math.round(sh));
        const canvas = document.createElement('canvas');
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        ctx.drawImage($<HTMLImageElement>('cropImg'), sx, sy, sw, sh, 0, 0, outW, outH);
        const dataURL = canvas.toDataURL('image/png');
        const assetId = uid('crop');
        if (!await putAsset(assetId, dataURL)) { toast('裁剪资源保存失败，请检查浏览器存储权限后重试', 'error'); return; }
        if (session !== cropSession || projectId !== state.projectId || cropState !== c || $('cropModal').style.display !== 'flex') return;
        const el = getEl(c.elId);
        if (!el) { toast('图片元素已不存在', 'error'); return; }
        const originalAssetId = c.pendingImage?.assetId || c.assetId || assetId;
        el.image = { assetId, originalAssetId, crop: { x: sx, y: sy, w: sw, h: sh } };
        syncElement(el.id);
        closeModal('cropModal');
        commit();
        toast('裁剪已应用，可再次双击继续编辑原图', 'success');
    } catch (e) {
        toast('裁剪失败：' + (e as Error).message, 'error');
    } finally {
        cropConfirming = false;
    }
}

export function closeModal(id: string): void {
    $(id).style.display = 'none';
    if (id === 'cropModal') {
        cropSession++;
        cropState = null;
        $<HTMLImageElement>('cropImg').onload = null;
        if (state.interaction?.kind === 'crop') state.interaction = null;
    }
}