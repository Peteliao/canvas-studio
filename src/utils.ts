/* 基础工具：DOM 查询、数值、对话框、文件与图片加载 */
import { SVG_NS, HEX_RE } from './constants';
import { imageCache } from './state';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error('缺少 DOM 节点: #' + id);
    return el as T;
}
export function $opt<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export function finite(v: unknown, d: number): number {
    if (v === '' || v === null || v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}
export const uid = (prefix: string): string => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const deepCopy = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
export const validColor = (v: unknown, d: string): string => (typeof v === 'string' && HEX_RE.test(v) ? v : d);

export function iconEl(name: string, cls?: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
    svg.appendChild(use);
    return svg;
}
export function setIcon(button: HTMLElement | null, name: string): void {
    if (!button) return;
    button.textContent = '';
    button.appendChild(iconEl(name));
}

let toastTimer: number | undefined;
export function toast(message: string, kind?: string): void {
    const t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.className = 'toast'; }, 3600);
}

type DialogState =
    | { mode: 'confirm'; resolve: (v: boolean | null) => void }
    | { mode: 'prompt'; resolve: (v: string | null) => void };
let dialogState: DialogState | null = null;

export function appConfirm(text: string, options?: { title?: string }): Promise<boolean | null> {
    return new Promise(resolve => {
        dialogState = { mode: 'confirm', resolve };
        $('appDialogTitle').textContent = (options && options.title) || '请确认';
        $('appDialogText').textContent = text;
        $('appDialogInput').style.display = 'none';
        $('appDialog').style.display = 'flex';
        $('dialogOk').focus();
    });
}
export function appPrompt(text: string, defaultValue?: string, options?: { title?: string }): Promise<string | null> {
    return new Promise(resolve => {
        dialogState = { mode: 'prompt', resolve };
        $('appDialogTitle').textContent = (options && options.title) || '请输入';
        $('appDialogText').textContent = text;
        const input = $<HTMLInputElement>('appDialogInput');
        input.style.display = 'block';
        input.value = defaultValue || '';
        $('appDialog').style.display = 'flex';
        input.focus(); input.select();
    });
}
export function dialogOk(): void {
    if (!dialogState) return;
    const s = dialogState; dialogState = null;
    $('appDialog').style.display = 'none';
    if (s.mode === 'prompt') s.resolve($<HTMLInputElement>('appDialogInput').value.trim() || null);
    else s.resolve(true);
}
export function dialogCancel(): void {
    if (!dialogState) return;
    const s = dialogState; dialogState = null;
    $('appDialog').style.display = 'none';
    s.resolve(null);
}
export function isDialogOpen(): boolean { return !!dialogState; }

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error('文件读取失败'));
        r.readAsDataURL(file);
    });
}
export function pickFile(accept?: string): Promise<File | null> {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = accept || '';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => { resolve(input.files && input.files[0] || null); input.remove(); }, { once: true });
        input.click();
    });
}
export function loadImage(src: string): Promise<HTMLImageElement> {
    const cached = imageCache.get(src);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { imageCache.set(src, img); resolve(img); };
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
    });
}