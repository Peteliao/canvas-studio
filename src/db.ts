/* IndexedDB：资源、项目与版本快照存储 */
import { DB_NAME, DB_STORE, DB_PROJECTS, DB_VERSIONS, SETTINGS_KEY, HEX_RE } from './constants';
import type { Settings } from './types';
import { state, imageCache } from './state';

let db: IDBDatabase | null = null;
export let dbAvailable = false;

export function openDB(): Promise<boolean> {
    return new Promise(resolve => {
        if (!window.indexedDB) { resolve(false); return; }
        let req: IDBOpenDBRequest;
        try { req = indexedDB.open(DB_NAME, 2); }
        catch { resolve(false); return; }
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
            if (!d.objectStoreNames.contains(DB_PROJECTS)) d.createObjectStore(DB_PROJECTS, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(DB_VERSIONS)) d.createObjectStore(DB_VERSIONS, { keyPath: 'id' });
        };
        req.onsuccess = () => { db = req.result; dbAvailable = true; resolve(true); };
        req.onerror = () => { dbAvailable = false; resolve(false); };
        req.onblocked = () => { dbAvailable = false; resolve(false); };
    });
}
export function idbPut(id: string, value: string): Promise<boolean> {
    return new Promise(resolve => {
        if (!db) { resolve(false); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(value, id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch { resolve(false); }
    });
}
export function idbGet(id: string): Promise<string | null> {
    return new Promise(resolve => {
        if (!db) { resolve(null); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readonly');
            const r = tx.objectStore(DB_STORE).get(id);
            r.onsuccess = () => resolve((r.result as string) || null);
            r.onerror = () => resolve(null);
        } catch { resolve(null); }
    });
}
export function idbAll(): Promise<Record<string, string>> {
    return new Promise(resolve => {
        if (!db) { resolve({}); return; }
        const out: Record<string, string> = {};
        try {
            const tx = db.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            tx.oncomplete = () => {
                keysReq.result.forEach((k, i) => { out[String(k)] = valsReq.result[i] as string; });
                resolve(out);
            };
            tx.onerror = () => resolve({});
        } catch { resolve({}); }
    });
}
export function idbClear(): Promise<boolean> {
    return new Promise(resolve => {
        if (!db) { resolve(false); return; }
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        } catch { resolve(false); }
    });
}
export async function putAsset(id: string, dataURL: string): Promise<boolean> {
    state.assets[id] = dataURL;
    imageCache.delete(dataURL);
    const ok = await idbPut(id, dataURL);
    if (!ok) state.hiddenAssetsDirty.add(id);
    return ok;
}
/** 通用 object store 操作：项目列表与版本快照 */
export function storeAll<T>(name: string): Promise<T[]> {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve([]); return; }
        try {
            const r = db.transaction(name, 'readonly').objectStore(name).getAll();
            r.onsuccess = () => resolve((r.result as T[]) || []);
            r.onerror = () => resolve([]);
        } catch { resolve([]); }
    });
}
export function storePut(name: string, value: unknown): Promise<boolean> {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve(false); return; }
        try {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).put(value);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch { resolve(false); }
    });
}
export function storeDelete(name: string, key: string): Promise<boolean> {
    return new Promise(resolve => {
        if (!db || !db.objectStoreNames.contains(name)) { resolve(false); return; }
        try {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        } catch { resolve(false); }
    });
}
export function saveSettings(): boolean {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); return true; }
    catch { return false; }
}
export function loadSettings(): Settings {
    const s: Settings = {
        theme: 'light', contrast: 'normal', snap: true, grid: false, rulers: true,
        guides: true, guideLines: true, gridSize: 20, alignBase: 'selection', inspectorVisible: true, inspectorFolded: false,
        measureSize: true, measureCanvas: true, measureGap: true, measureAlign: true, measureGuide: true,
        activeTab: 'design', recentColors: [], palette: [], projectId: null, projectName: '未命名设计',
        bucketFillColor: '#4f6bff', bucketStrokeColor: '#1c2230'
    };
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return s;
        const o = JSON.parse(raw) as Record<string, unknown>;
        if (o && typeof o === 'object') {
            (Object.keys(s) as (keyof Settings)[]).forEach(k => {
                const v = o[k];
                if (v !== undefined && typeof v === typeof s[k]) (s as unknown as Record<string, unknown>)[k] = v;
            });
            if (Array.isArray(o.recentColors)) s.recentColors = (o.recentColors as unknown[]).filter((c): c is string => typeof c === 'string' && HEX_RE.test(c)).slice(0, 16);
            if (Array.isArray(o.palette)) s.palette = (o.palette as unknown[]).filter((c): c is string => typeof c === 'string' && HEX_RE.test(c)).slice(0, 32);
        }
    } catch { /* 使用默认设置 */ }
    if (s.bucketFillColor !== 'none' && !HEX_RE.test(s.bucketFillColor)) s.bucketFillColor = '#4f6bff';
    if (s.bucketStrokeColor !== 'none' && !HEX_RE.test(s.bucketStrokeColor)) s.bucketStrokeColor = '#1c2230';
    return s;
}