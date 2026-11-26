import type { BlendMode as PsdBlendMode, Layer, LayerMaskData, Psd } from 'ag-psd';
import type { BlendMode } from './types';

const PSD_RE = /\.(psd|psb)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;
const MAX_PSD_BYTES = 200 * 1024 * 1024;
const MAX_PSD_PIXELS = 40_000_000;
const MAX_PSD_LAYERS = 500;
const MAX_PSD_LAYER_PIXELS = 16_000_000;
const MAX_IMPORT_SIDE = 4096;

export interface DecodedPsdLayer {
    key: string;
    name: string;
    left: number;
    top: number;
    width: number;
    height: number;
    dataURL: string;
    visible: boolean;
    opacity: number;
    blendMode: BlendMode;
    groupKey: string | null;
}

export interface DecodedImage {
    dataURL: string | null;
    width: number;
    height: number;
    layers?: DecodedPsdLayer[];
    groupCount?: number;
    notice?: string;
}

export interface PsdLayerDescriptor {
    source: Layer;
    key: string;
    name: string;
    left: number;
    top: number;
    width: number;
    height: number;
    visible: boolean;
    opacity: number;
    groupKey: string | null;
}

export interface PsdLayerFlattenResult {
    layers: PsdLayerDescriptor[];
    groupCount: number;
    truncated: boolean;
}

type AgPsd = typeof import('ag-psd');

export function isImageFile(file: File): boolean {
    return /^image\//.test(file.type) || IMAGE_RE.test(file.name) || PSD_RE.test(file.name);
}

export function isPsdFile(file: File): boolean {
    return PSD_RE.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}

export async function decodeImageFile(file: File): Promise<DecodedImage> {
    if (isPsdFile(file)) return decodePsdFile(file);
    const { readFileAsDataURL, loadImage } = await import('./utils');
    const dataURL = await readFileAsDataURL(file);
    const img = await loadImage(dataURL);
    return { dataURL, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}

function finite(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function layerName(layer: Layer): string {
    return String(layer.name || '图层').trim().slice(0, 80) || '图层';
}

export function flattenPsdLayers(children: readonly Layer[], limit = MAX_PSD_LAYERS): PsdLayerFlattenResult {
    const layers: PsdLayerDescriptor[] = [];
    let groupCount = 0, leafCount = 0, truncated = false;
    const walk = (
        items: readonly Layer[],
        path: string,
        names: readonly string[],
        parentVisible: boolean,
        parentOpacity: number,
        parentGroup: string | null
    ): void => {
        if (names.length > 32) { truncated = true; return; }
        items.forEach((source, index) => {
            const key = path ? `${path}.${index}` : String(index);
            const visible = parentVisible && !source.hidden;
            const opacity = parentOpacity * Math.max(0, Math.min(1, finite(source.opacity, 1)));
            if (source.children) {
                groupCount++;
                const name = layerName(source);
                walk(source.children, key, [...names, name], visible, opacity, `g:${key}`);
                return;
            }
            leafCount++;
            if (leafCount > limit) { truncated = true; return; }
            const left = finite(source.left, 0), top = finite(source.top, 0);
            const width = finite(source.right, left) - left;
            const height = finite(source.bottom, top) - top;
            if (width <= 0 || height <= 0) return;
            layers.push({
                source, key: `l:${key}`, name: [...names, layerName(source)].join(' / ').slice(0, 120),
                left, top, width, height, visible, opacity, groupKey: parentGroup
            });
        });
    };
    walk(children, '', [], true, 1, null);
    return { layers, groupCount, truncated };
}

const PSD_BLEND_MODES: Record<string, BlendMode> = {
    normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
    darken: 'darken', lighten: 'lighten', difference: 'difference'
};

export function psdBlendMode(mode: PsdBlendMode | string | undefined): BlendMode {
    return PSD_BLEND_MODES[mode || ''] || 'normal';
}

function validateDocumentSize(psd: Psd): { width: number; height: number } {
    const width = Math.max(0, Math.round(finite(psd.width, 0)));
    const height = Math.max(0, Math.round(finite(psd.height, 0)));
    if (!width || !height) throw new Error('PSD 画布尺寸无效');
    if (width * height > MAX_PSD_PIXELS) {
        throw new Error(`PSD 尺寸 ${width}×${height} 超过 ${MAX_PSD_PIXELS / 1_000_000} 百万像素限制`);
    }
    return { width, height };
}

function canvasToPng(canvas: HTMLCanvasElement): string {
    const scale = Math.min(
        1,
        MAX_IMPORT_SIDE / Math.max(1, canvas.width, canvas.height),
        Math.sqrt(MAX_PSD_LAYER_PIXELS / Math.max(1, canvas.width * canvas.height))
    );
    let out = canvas;
    if (scale < 1) {
        out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(canvas.width * scale));
        out.height = Math.max(1, Math.round(canvas.height * scale));
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, out.width, out.height);
    }
    return out.toDataURL('image/png');
}

function applyLayerMasks(layer: Layer, canvas: HTMLCanvasElement, ag: AgPsd): HTMLCanvasElement {
    const masks = [layer.realMask, layer.mask].filter((mask): mask is LayerMaskData => !!mask && !mask.disabled);
    if (!masks.length) return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('无法创建蒙版画布');
    ctx.drawImage(canvas, 0, 0);
    for (const mask of masks) {
        const maskCanvas = mask === layer.realMask ? ag.getLayerRealMaskCanvas(layer) : ag.getLayerMaskCanvas(layer);
        if (!maskCanvas || !maskCanvas.width || !maskCanvas.height) throw new Error('蒙版像素不可用');
        const x = mask.positionRelativeToLayer ? 0 : finite(mask.left, finite(layer.left, 0)) - finite(layer.left, 0);
        const y = mask.positionRelativeToLayer ? 0 : finite(mask.top, finite(layer.top, 0)) - finite(layer.top, 0);
        const density = mask === layer.realMask ? mask.vectorMaskDensity : mask.userMaskDensity;
        const feather = mask === layer.realMask ? mask.vectorMaskFeather : mask.userMaskFeather;
        ctx.globalCompositeOperation = 'destination-in';
        ctx.globalAlpha = Math.max(0, Math.min(1, finite(density, 100) / 100));
        ctx.filter = feather && feather > 0 ? `blur(${Math.min(64, feather)}px)` : 'none';
        ctx.drawImage(maskCanvas, x, y);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    return out;
}

async function decodePsdLayers(descriptors: readonly PsdLayerDescriptor[], ag: AgPsd): Promise<DecodedPsdLayer[]> {
    const layers: DecodedPsdLayer[] = [];
    for (const descriptor of descriptors) {
        try {
            let canvas = ag.getLayerCanvas(descriptor.source);
            if (!canvas && !descriptor.visible) {
                delete descriptor.source.canvas;
                delete descriptor.source.imageData;
                delete descriptor.source.rawData;
                continue;
            }
            if (!canvas || !canvas.width || !canvas.height) throw new Error('图层像素为空');
            canvas = applyLayerMasks(descriptor.source, canvas, ag);
            const dataURL = canvasToPng(canvas);
            layers.push({
                key: descriptor.key, name: descriptor.name, left: descriptor.left, top: descriptor.top,
                width: descriptor.width, height: descriptor.height, dataURL, visible: descriptor.visible,
                opacity: descriptor.opacity, blendMode: psdBlendMode(descriptor.source.blendMode), groupKey: descriptor.groupKey
            });
        } catch (e) {
            throw new Error(`图层「${descriptor.name}」解码失败：${(e as Error).message}`);
        } finally {
            delete descriptor.source.canvas;
            delete descriptor.source.imageData;
            delete descriptor.source.rawData;
        }
    }
    return layers;
}

async function decodeCompositeFallback(ag: AgPsd, buffer: ArrayBuffer, psd: Psd | undefined, notice: string): Promise<DecodedImage> {
    let canvas: HTMLCanvasElement | undefined;
    if (psd) {
        try { canvas = ag.getCompositeCanvas(psd); } catch { /* 使用下方轻量重读 */ }
    }
    if (!canvas) {
        try {
            psd = ag.readPsd(buffer, {
                useRawData: true, skipLayerImageData: true, skipThumbnail: true,
                skipLinkedFilesData: true, throwForMissingFeatures: false
            });
            canvas = ag.getCompositeCanvas(psd);
        } catch (e) {
            throw new Error('PSD 解析失败：' + (e as Error).message);
        }
    }
    if (!psd) throw new Error('PSD 解析失败');
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('PSD 图层解码失败，且没有可用的合成图（请先在 Photoshop 中存储为“最大兼容”）');
    }
    const scale = Math.min(1, MAX_IMPORT_SIDE / Math.max(canvas.width, canvas.height));
    let out = canvas;
    if (scale < 1) {
        out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(canvas.width * scale));
        out.height = Math.max(1, Math.round(canvas.height * scale));
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, out.width, out.height);
    }
    return { dataURL: out.toDataURL('image/png'), width: out.width, height: out.height, notice: notice.slice(0, 180) };
}

async function decodePsdFile(file: File): Promise<DecodedImage> {
    if (file.size > MAX_PSD_BYTES) throw new Error('PSD 文件过大（上限 200 MB）');
    let ag: AgPsd;
    try { ag = await import('ag-psd'); }
    catch { throw new Error('PSD 解码模块加载失败，请检查网络后重试'); }
    const buffer = await file.arrayBuffer();
    let psd: Psd;
    try {
        psd = ag.readPsd(buffer, {
            useRawData: true, skipThumbnail: true, skipLinkedFilesData: true,
            throwForMissingFeatures: false, totalMemoryLimit: 768 * 1024 * 1024
        });
    } catch (e) {
        return decodeCompositeFallback(ag, buffer, undefined, `PSD 图层读取失败：${(e as Error).message}`);
    }
    const { width, height } = validateDocumentSize(psd);
    const flattened = flattenPsdLayers(psd.children || []);
    if (flattened.truncated) {
        return decodeCompositeFallback(ag, buffer, psd, `PSD 图层过多或层级过深，已回退为合成图`);
    }
    if (!flattened.layers.length) {
        return decodeCompositeFallback(ag, buffer, psd, 'PSD 中没有可导入的图层，已回退为合成图');
    }
    try {
        const layers = await decodePsdLayers(flattened.layers, ag);
        if (!layers.length) throw new Error('没有可用的图层像素');
        return { dataURL: null, width, height, layers, groupCount: flattened.groupCount };
    } catch (e) {
        return decodeCompositeFallback(ag, buffer, psd, `PSD 分层导入失败，已回退为合成图：${(e as Error).message}`);
    }
}
