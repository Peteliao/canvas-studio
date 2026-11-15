import type { BlendMode, CurveNodeType, ElementType, FillMode, FontWeight, LineStyle, Shadow, ShadowType, StrokeStyle, TextAlign } from './types';

export const VERSION = 4;
export const COMPAT_VERSIONS = [2, 3, 4];   // v2 旧格式 / v3 单段曲线 / v4 多节点贝塞尔
export const STORAGE_KEY = 'canvas_autosave_v2';
export const LEGACY_KEY = 'canvas_autosave_v1';
export const SETTINGS_KEY = 'canvas_studio_settings_v3';
export const DB_NAME = 'CanvasAssetsDB';
export const DB_STORE = 'assets';
export const DB_PROJECTS = 'projects';
export const DB_VERSIONS = 'versions';
export const MAX_HISTORY = 50;
export const MAX_EXPORT_PIXELS = 16 * 1000 * 1000;
export const MAX_CANVAS_SIDE = 20000;
export const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
export const SVG_NS = 'http://www.w3.org/2000/svg';

export const TYPES: ElementType[] = ['rect', 'circle', 'triangle', 'star', 'arrow', 'line', 'curve', 'text', 'image', 'boolean'];
export const FILL_MODES: FillMode[] = ['solid', 'linear', 'radial', 'conic'];
export const LINE_STYLES: LineStyle[] = ['solid', 'dashed', 'dotted', 'wavy'];
export const TEXT_ALIGNS: TextAlign[] = ['left', 'center', 'right', 'justify'];
export const STROKE_STYLES: StrokeStyle[] = ['solid', 'dashed', 'dotted'];
export const SHADOW_TYPES: ShadowType[] = ['drop', 'glow'];
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'];
export const TYPE_LABELS: Record<ElementType | 'group', string> = { rect: '矩形', circle: '圆形', triangle: '三角形', star: '五角星', arrow: '箭头', line: '线条', curve: '曲线', text: '文本', image: '图片', boolean: '布尔图形', group: '组合' };
export const TYPE_ICONS: Record<ElementType, string> = { rect: 'square', circle: 'circle', triangle: 'triangle', star: 'star', arrow: 'arrow', line: 'line', curve: 'curve', text: 'font', image: 'image', boolean: 'union' };
// 这些类型的描边用 SVG 轮廓叠加渲染，虚线/点线在画布上即时可见（boolean 沿用 drop-shadow 以贴合遮罩）
export const STROKE_SVG_TYPES: ElementType[] = ['rect', 'circle', 'triangle', 'star', 'arrow', 'image'];
export const EXPORT_BLEND: Record<string, GlobalCompositeOperation> = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference' };
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

export const CLIP_PATHS: Record<string, string> = {
    triangle: 'polygon(50% 0%, 0% 100%, 100% 100%)',
    star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
    arrow: 'polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)'
};
export const POLYGON_POINTS: Record<string, [number, number][]> = {
    triangle: [[50, 0], [0, 100], [100, 100]],
    star: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]],
    arrow: [[0, 20], [60, 20], [60, 0], [100, 50], [60, 100], [60, 80], [0, 80]]
};

export const MAX_CURVE_NODES = 200;
export const CURVE_NODE_TYPES: CurveNodeType[] = ['smooth', 'cusp'];

export const PRESET_COLORS = ['#4f6bff', '#12b886', '#f79009', '#e5484d', '#9b6bff', '#0ea5e9',
    '#1c2230', '#5a6379', '#8b94a8', '#ffffff', '#f4f6fb', '#e4e7f0',
    '#ffcccb', '#add8e6', '#ffe4a3', '#c8f0d8'];

export interface ShapePreset { type: ElementType; label: string; color: string; w: number; h: number; radius?: number; stroke?: string; }
export const SHAPE_PRESETS: ShapePreset[] = [
    { type: 'rect', label: '矩形', color: '#4f6bff', w: 200, h: 140, radius: 0 },
    { type: 'rect', label: '卡片', color: '#ffffff', w: 220, h: 150, radius: 14, stroke: '#e4e7f0' },
    { type: 'circle', label: '圆形', color: '#12b886', w: 140, h: 140 },
    { type: 'circle', label: '圆环', color: '#0ea5e9', w: 140, h: 140, stroke: '#0ea5e9' },
    { type: 'triangle', label: '三角', color: '#f79009', w: 150, h: 150 },
    { type: 'star', label: '星形', color: '#f7b731', w: 150, h: 150 },
    { type: 'arrow', label: '箭头', color: '#9b6bff', w: 200, h: 100 },
    { type: 'line', label: '分隔线', color: '#8b94a8', w: 280, h: 4 }
];

export interface TextPreset { label: string; size: number; weight: FontWeight; color: string; }
export const TEXT_PRESETS: TextPreset[] = [
    { label: '大标题', size: 48, weight: 700, color: '#1c2230' },
    { label: '副标题', size: 28, weight: 500, color: '#5a6379' },
    { label: '正文', size: 18, weight: 400, color: '#1c2230' },
    { label: '强调蓝', size: 32, weight: 700, color: '#4f6bff' }
];

// 投影一键预设（enabled 由应用时置 true）；glow 为零偏移发光
export const SHADOW_PRESETS: Record<string, Omit<Shadow, 'enabled'>> = {
    soft: { type: 'drop', color: '#000000', x: 0, y: 12, blur: 24, opacity: 0.35 },
    hard: { type: 'drop', color: '#000000', x: 6, y: 6, blur: 0, opacity: 0.55 },
    long: { type: 'drop', color: '#000000', x: -28, y: 28, blur: 6, opacity: 0.4 },
    neon: { type: 'glow', color: '#3b82f6', x: 0, y: 0, blur: 22, opacity: 0.9 }
};

export const SHORTCUTS: [string, string][] = [
    ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y'], ['复制 / 粘贴', 'Ctrl+C / Ctrl+V'],
    ['创建副本', 'Ctrl+D'], ['全选', 'Ctrl+A'], ['保存项目', 'Ctrl+S'],
    ['组合 / 解组', 'Ctrl+G / Ctrl+Shift+G'], ['适应屏幕', 'Alt+Z'],
    ['显示网格', "Ctrl+'"],     ['选择 / 平移 / 文本 / 钢笔 / 颜料桶', 'V / H / T / P / B'], ['插入矩形', 'R'],
    ['钢笔：闭合路径', '点回起点'], ['钢笔：结束 / 取消', 'Enter / Esc'],
    ['钢笔：下一段拉直', 'Alt+点击锚点 / 落点'],
    ['颜料桶：连续上色 / 吸色', '按住拖动 / Alt+点击'],
    ['颜料桶：强制改描边', 'Shift + 点击'],
    ['曲线：双击线段 / 节点', '加点 / 删点'], ['节点对称吸附', 'Shift 拖拽控制柄'],
    ['方向键移动', '↑ ↓ ← →'], ['大步长移动', 'Shift + 方向键'],
    ['等比缩放 / 角度吸附', 'Shift + 拖拽'], ['临时平移', '空格 + 拖拽'],
    ['跳过吸附', 'Alt + 拖拽'], ['删除', 'Delete'], ['取消 / 取消选择', 'Esc'],
    ['快捷键说明', '?'], ['双击文本', '编辑内容'], ['双击图片', '裁剪'], ['双击旋转中心', '复位到中心'],
    ['编辑选中文字', 'Enter / F2'], ['结束文本编辑', 'Esc / Ctrl+Enter']
];