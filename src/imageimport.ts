/* 图片解码：普通位图直读，PSD/PSB 取合成图并转为 PNG */
import { readFileAsDataURL, loadImage } from './utils';

const PSD_RE = /\.(psd|psb)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;
const MAX_PSD_BYTES = 200 * 1024 * 1024;
const MAX_PSD_PIXELS = 40_000_000;
const MAX_IMPORT_SIDE = 4096;

export interface DecodedImage {
    dataURL: string;
    width: number;
    height: number;
}

export function isImageFile(file: File): boolean {
    return /^image\//.test(file.type) || IMAGE_RE.test(file.name) || PSD_RE.test(file.name);
}

export function isPsdFile(file: File): boolean {
    return PSD_RE.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}

export async function decodeImageFile(file: File): Promise<DecodedImage> {
    if (isPsdFile(file)) return decodePsdFile(file);
    const dataURL = await readFileAsDataURL(file);
    const img = await loadImage(dataURL);
    return { dataURL, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}

async function decodePsdFile(file: File): Promise<DecodedImage> {
    if (file.size > MAX_PSD_BYTES) throw new Error('PSD 文件过大（上限 200 MB）');
    let readPsd: typeof import('ag-psd').readPsd;
    let getCompositeCanvas: typeof import('ag-psd').getCompositeCanvas;
    try {
        ({ readPsd, getCompositeCanvas } = await import('ag-psd'));
    } catch {
        throw new Error('PSD 解码模块加载失败，请检查网络后重试');
    }
    const buffer = await file.arrayBuffer();
    let psd: import('ag-psd').Psd;
    try {
        psd = readPsd(buffer, {
            useRawData: true, skipLayerImageData: true, skipThumbnail: true,
            skipLinkedFilesData: true, throwForMissingFeatures: false
        });
    } catch (e) {
        throw new Error('PSD 解析失败：' + (e as Error).message);
    }
    const width = Math.max(0, Math.round(psd.width || 0));
    const height = Math.max(0, Math.round(psd.height || 0));
    if (!width || !height) throw new Error('PSD 画布尺寸无效');
    if (width * height > MAX_PSD_PIXELS) {
        throw new Error(`PSD 尺寸 ${width}×${height} 超过 ${MAX_PSD_PIXELS / 1_000_000} 百万像素限制`);
    }
    let canvas: HTMLCanvasElement | undefined;
    try {
        canvas = getCompositeCanvas(psd);
    } catch (e) {
        throw new Error('PSD 合成图解码失败：' + (e as Error).message);
    }
    if (!canvas || !canvas.width || !canvas.height) throw new Error('PSD 中没有可用的合成图（请先在 Photoshop 中存储为“最大兼容”）');
    const scale = Math.min(1, MAX_IMPORT_SIDE / Math.max(canvas.width, canvas.height));
    let out = canvas;
    if (scale < 1) {
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, w, h);
    }
    return { dataURL: out.toDataURL('image/png'), width: out.width, height: out.height };
}
