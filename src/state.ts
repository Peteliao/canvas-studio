import type { AppState } from './types';
import { defaultModel } from './model';
import { loadSettings } from './db';

export const state: AppState = {
    model: defaultModel(),
    assets: {},
    selection: [],
    guideSel: null,
    zoom: 1,
    pan: { x: 0, y: 0 },
    clipboard: [],
    elBgMode: 'solid',
    geoRatioLocked: false,
    geoRatio: 1,
    canvasRatioLocked: false,
    canvasRatio: 1,
    moveStep: 1,
    isTextEditing: false,
    editingId: null,
    layerPick: null,
    spaceDown: false,
    interaction: null,
    boxCache: null,
    hiddenAssetsDirty: new Set(),
    tool: 'select',
    bucketSlot: 'fill',
    nodeSel: null,
    pen: null,
    settings: loadSettings(),
    projectId: null,
    projectName: '未命名设计',
    activeTab: 'design',
    alignBase: 'selection',
    snapLines: [],
    touchPoints: new Map(),
    pinch: null,
    clipboardSerial: ''
};

export const nodeMap = new Map<string, HTMLDivElement>();   // element id -> DOM node
export const imageCache = new Map<string, HTMLImageElement>();    // dataURL -> HTMLImageElement