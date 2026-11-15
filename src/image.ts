import { state } from './state';
import { $, loadImage, readFileAsDataURL, round2, toast, uid } from './utils';
import { buildElement } from './model';
import { renderAll } from './render';
import { commit } from './history';
import { canvasCenterFor } from './view';
import { setSelection } from './selection';
import { putAsset } from './db';

export function addImage(): void { $<HTMLInputElement>('imageInput').click(); }

export async function handleImageUpload(input: HTMLInputElement): Promise<void> {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
        const dataURL = await readFileAsDataURL(file);
        const img = await loadImage(dataURL);
        const maxDim = 400;
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
            const k = maxDim / Math.max(w, h);
            w = Math.round(w * k); h = Math.round(h * k);
        }
        const assetId = uid('img');
        await putAsset(assetId, dataURL);
        const el = buildElement('image', 0, 0);
        el.w = w; el.h = h;
        el.image = { assetId, originalAssetId: assetId, crop: null };
        const pos = canvasCenterFor(w, h);
        el.x = round2(pos.x); el.y = round2(pos.y);
        state.model.elements.push(el);
        renderAll(); setSelection([el.id]); commit();
        toast('图片已插入，双击可二次裁剪', 'success');
    } catch (e) {
        toast('图片载入失败：' + (e as Error).message, 'error');
    }
}