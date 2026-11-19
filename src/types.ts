/* 核心数据类型：结构化模型（唯一数据源） */

export type ElementType = 'rect' | 'circle' | 'triangle' | 'star' | 'arrow' | 'line' | 'curve' | 'text' | 'image' | 'boolean'
    | 'hexagon' | 'pentagon' | 'diamond' | 'trapezoid' | 'parallelogram' | 'cross'
    | 'semicircle' | 'heart' | 'cloud' | 'moon' | 'speech' | 'drop';
export type FillMode = 'solid' | 'linear' | 'radial' | 'conic';
export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'wavy';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type ShadowType = 'drop' | 'glow';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type TextSizeMode = 'fixed' | 'autoH' | 'autoWH';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'difference';
export type CurveNodeType = 'smooth' | 'cusp';
export type FontWeight = 100 | 300 | 400 | 500 | 700 | 900;
export type ToolName = 'select' | 'pan' | 'text' | 'pen' | 'bucket';
export type TabName = 'design' | 'layers' | 'assets' | 'projects';
export type BucketSlot = 'fill' | 'stroke';
export type HandleSide = 'in' | 'out';

export interface Point { x: number; y: number; }
export interface Box { left: number; top: number; right: number; bottom: number; w: number; h: number; }
export interface AABB extends Box { cx: number; cy: number; }

export interface Fill {
    enabled: boolean;
    mode: FillMode;
    color: string;
    start: string;
    end: string;
    angle: number;
    posX: number;
    posY: number;
    alpha: number;
}
export interface Stroke { color: string; width: number; style: StrokeStyle; }
export interface Shadow { enabled: boolean; type: ShadowType; color: string; x: number; y: number; blur: number; opacity: number; }
export interface TextRun { text: string; bold: boolean; italic: boolean; underline: boolean; color: string; }
export interface TextStyle {
    runs: TextRun[];
    fontSize: number;
    fontFamily: string;
    fontWeight: FontWeight;
    lineHeight: number;
    letterSpacing: number;
    align: TextAlign;
    sizeMode: TextSizeMode;
}
export interface LineSpec {
    style: LineStyle;
    width: number;
    color: string;
    wavyAmp: number;
    dash: StrokeStyle;
}
/** 贝塞尔节点：锚点 + 入/出控制柄（元素宽高的比例坐标） */
export interface CurveNode {
    x: number; y: number;
    ix: number; iy: number;
    ox: number; oy: number;
    t: CurveNodeType;
}
export interface Curve { nodes: CurveNode[]; closed: boolean; filled: boolean; strokeOn: boolean; }
export interface CropRect { x: number; y: number; w: number; h: number; }
export interface ImageRef { assetId: string; originalAssetId: string; crop: CropRect | null; }

/** 导出排版：行模型（编辑器自动尺寸与 PNG/SVG 导出共用） */
export interface TextToken { run: TextRun; text: string; w: number; }
export type TextLine = TextToken[] & { forcedEnd?: boolean };

export interface CanvasElement {
    id: string;
    type: ElementType;
    x: number; y: number; w: number; h: number;
    rotation: number;
    pivotX: number; pivotY: number;
    zIndex: number;
    locked: boolean;
    exportVisible: boolean;
    opacity: number;
    borderRadius: number;
    shapeParams: Record<string, number>;
    fill: Fill;
    text: TextStyle | null;
    line: LineSpec | null;
    curve: Curve | null;
    image: ImageRef | null;
    maskAssetId: string | null;
    name: string;
    visible: boolean;
    groupId: string | null;
    stroke: Stroke;
    shadow: Shadow;
    blendMode: BlendMode;
}

export interface Guide { id: string; angle: number; x: number; y: number; }
export interface CanvasConfig { w: number; h: number; background: Fill; lockedRatio: boolean; }
export interface Model {
    version: number;
    name: string;
    canvas: CanvasConfig;
    elements: CanvasElement[];
    guides: Guide[];
    assets?: Record<string, string>;
}

export interface Settings {
    theme: 'light' | 'dark';
    contrast: string;
    snap: boolean;
    grid: boolean;
    rulers: boolean;
    guides: boolean;
    guideLines: boolean;
    measureSize: boolean;
    measureCanvas: boolean;
    measureGap: boolean;
    measureAlign: boolean;
    measureGuide: boolean;
    gridSize: number;
    alignBase: 'selection' | 'canvas';
    inspectorVisible: boolean;
    inspectorFolded: boolean;
    activeTab: TabName;
    recentColors: string[];
    palette: string[];
    projectId: string | null;
    projectName: string;
    bucketFillColor: string;
    bucketStrokeColor: string;
}

/* -------------------- 交互状态 -------------------- */
export interface DragItem { id: string; x: number; y: number; }
export interface ResizeItem { id: string; x: number; y: number; w: number; h: number; }
export interface RotateItem extends ResizeItem { rotation: number; pivotX: number; pivotY: number; }
export interface SnapLine { vertical: boolean; at: number; }

export type Interaction =
    | { kind: 'pan'; lastX: number; lastY: number }
    | { kind: 'drag'; startX: number; startY: number; items: DragItem[]; startBox?: AABB | null }
    | { kind: 'resize'; dir: string; startX: number; startY: number; box: AABB; items: ResizeItem[] }
    | { kind: 'rotate'; box: AABB; center: Point; single: boolean; startAngle: number; items: RotateItem[] }
    | { kind: 'pivot'; id: string; w: number; h: number; x: number; y: number; fx: number; fy: number; rotation: number }
    | { kind: 'box'; start: Point; current: Point; additive: boolean; subtractive: boolean; initial: string[] }
    | { kind: 'textcreate'; start: Point; current: Point }
    | { kind: 'guidemove'; id: string; start: Point; ox: number; oy: number; deleteHint: boolean }
    | { kind: 'bucketpaint'; painted: Set<string> }
    | { kind: 'pendrag'; i: number; sx: number; sy: number }
    | { kind: 'cnode'; id: string; i: number; start: Point; ox: number; oy: number }
    | { kind: 'cctrl'; id: string; i: number; h: HandleSide }
    | { kind: 'crop'; mode: 'move' | 'resize'; dir: string | null; startX: number; startY: number; rect: CropRect };

/** 钢笔草稿：节点为世界坐标 */
export interface PenDraft {
    nodes: CurveNode[];
    cursor: Point;
    closed: boolean;
    lastDown: { x: number; y: number; t: number } | null;
}

export interface CropState {
    elId: string;
    assetId: string | null;
    ratio: number;
    imgLeft: number; imgTop: number; imgW: number; imgH: number;
    naturalW: number; naturalH: number;
    rect: CropRect;
}

export interface PinchState { dist: number; zoom: number; cx: number; cy: number; panX: number; panY: number; }

export interface AppState {
    model: Model;
    assets: Record<string, string>;
    selection: string[];
    guideSel: string | null;
    zoom: number;
    pan: Point;
    clipboard: CanvasElement[];
    elBgMode: FillMode;
    geoRatioLocked: boolean;
    geoRatio: number;
    canvasRatioLocked: boolean;
    canvasRatio: number;
    moveStep: number;
    isTextEditing: boolean;
    editingId: string | null;
    layerPick: { type: 'under' | 'above'; id: string } | null;
    spaceDown: boolean;
    interaction: Interaction | null;
    boxCache: { id: string; a: AABB }[] | null;
    hiddenAssetsDirty: Set<string>;
    tool: ToolName;
    bucketSlot: BucketSlot;
    nodeSel: { id: string; i: number } | null;
    pen: PenDraft | null;
    settings: Settings;
    projectId: string | null;
    projectName: string;
    activeTab: TabName;
    alignBase: 'selection' | 'canvas';
    snapLines: SnapLine[];
    touchPoints: Map<number, Point>;
    pinch: PinchState | null;
    clipboardSerial: string;
    guideTipShown?: boolean;
}

/* 渲染层在 DOM 节点上挂载的临时状态 */
declare global {
    interface HTMLElement {
        _peekTimer?: number;
        _hidePeekLater?: () => void;
    }
    interface CanvasRenderingContext2D {
        __exportScale?: number;
    }
}