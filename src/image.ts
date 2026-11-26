import { state } from './state';
import type { CanvasElement } from './types';
import { $, round2, toast, uid } from './utils';
import { decodeImageFile, type DecodedImage, type DecodedPsdLayer } from './imageimport';
import { buildElement } from './model';
import { renderAll } from './render';
import { commit } from './history';
import { canvasCenterFor } from './view';
import { setSelection } from './selection';
import { putAsset } from './db';
import { clientToWorld } from './interaction';

export function addImage(): void { $<HTMLInputElement>('imageInput').click(); }

export async function handleImageUpload(input: HTMLInputElement): Promise<void> {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const projectId = state.projectId;
    try {
        const decoded = await decodeImageFile(file);
        if (projectId !== state.projectId) { toast('项目已切换，已取消图片导入', 'error'); return; }
        await insertDecodedImage(file.name, decoded);
    } catch (e) {
        toast('图片载入失败：' + (e as Error).message, 'error');
    }
}

export async function insertDecodedImage(fileName: string, decoded: DecodedImage, clientX?: number, clientY?: number): Promise<boolean> {
    const projectId = state.projectId;
    const layers = decoded.layers?.length ? decoded.layers : null;
    const maxDim = layers ? 800 : 400;
    const scale = Math.min(1, maxDim / Math.max(1, decoded.width, decoded.height));
    const width = Math.max(1, round2(decoded.width * scale));
    const height = Math.max(1, round2(decoded.height * scale));
    const world = clientX === undefined ? canvasCenterFor(width, height) : clientToWorld(clientX, clientY!);
    const originX = world.x;
    const originY = world.y;
    const assetIds = new Map<string, string>();
    const resources: { key: string; dataURL: string | null }[] = layers
        ? layers.map(layer => ({ key: layer.key, dataURL: layer.dataURL }))
        : [{ key: 'composite', dataURL: decoded.dataURL }];
    for (const resource of resources) {
        if (!resource.dataURL) throw new Error('图片数据为空');
        const assetId = uid('img');
        if (!await putAsset(assetId, resource.dataURL)) {
            toast('图片资源保存失败，请检查浏览器存储权限后重试', 'error');
            return false;
        }
        assetIds.set(resource.key, assetId);
        if (projectId !== state.projectId) { toast('项目已切换，已取消图片导入', 'error'); return false; }
    }
    const elements: CanvasElement[] = [];
    const groupIds = new Map<string, string>();
    const addLayer = (layer: DecodedPsdLayer): void => {
        const el = buildElement('image', round2(originX + layer.left * scale), round2(originY + layer.top * scale));
        el.w = Math.max(1, round2(layer.width * scale));
        el.h = Math.max(1, round2(layer.height * scale));
        const assetId = assetIds.get(layer.key)!;
        el.image = { assetId, originalAssetId: assetId, crop: null };
        el.name = layer.name.slice(0, 80);
        el.visible = layer.visible;
        el.opacity = layer.opacity;
        el.blendMode = layer.blendMode;
        if (layer.groupKey) {
            let groupId = groupIds.get(layer.groupKey);
            if (!groupId) { groupId = uid('grp'); groupIds.set(layer.groupKey, groupId); }
            el.groupId = groupId;
        }
        elements.push(el);
    };
    if (layers) layers.slice().reverse().forEach(addLayer);
    else {
        const el = buildElement('image', round2(originX), round2(originY));
        el.w = width; el.h = height;
        const assetId = assetIds.get('composite')!;
        el.image = { assetId, originalAssetId: assetId, crop: null };
        el.name = fileName.slice(0, 60);
        elements.push(el);
    }
    state.model.elements.push(...elements);
    renderAll(); setSelection(elements.map(el => el.id)); commit();
    if (layers) {
        const groups = decoded.groupCount ? ` · ${decoded.groupCount} 个组` : '';
        toast(`PSD 已导入 ${elements.length} 个图层${groups}`, 'success');
    } else if (decoded.notice) toast(`${decoded.notice}；已插入合成图`, 'success');
    else toast('图片已插入，双击可二次裁剪', 'success');
    return true;
}
