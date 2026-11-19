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

export const VECTOR_SHAPE_TYPES: ElementType[] = ['hexagon', 'pentagon', 'diamond', 'trapezoid', 'parallelogram', 'cross',
    'semicircle', 'heart', 'cloud', 'moon', 'speech', 'drop'];
export const TYPES: ElementType[] = ['rect', 'circle', 'triangle', 'star', 'arrow', 'line', 'curve', 'text', 'image', 'boolean',
    ...VECTOR_SHAPE_TYPES];
export const FILL_MODES: FillMode[] = ['solid', 'linear', 'radial', 'conic'];
export const LINE_STYLES: LineStyle[] = ['solid', 'dashed', 'dotted', 'wavy'];
export const TEXT_ALIGNS: TextAlign[] = ['left', 'center', 'right', 'justify'];
export const STROKE_STYLES: StrokeStyle[] = ['solid', 'dashed', 'dotted'];
export const SHADOW_TYPES: ShadowType[] = ['drop', 'glow'];
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'];
export const TYPE_LABELS: Record<ElementType | 'group', string> = { rect: '矩形', circle: '圆形', triangle: '三角形', star: '五角星', arrow: '箭头', line: '线条', curve: '曲线', text: '文本', image: '图片', boolean: '布尔图形', group: '组合',
    hexagon: '六边形', pentagon: '五边形', diamond: '菱形', trapezoid: '梯形', parallelogram: '平行四边形', cross: '十字',
    semicircle: '半圆', heart: '心形', cloud: '云朵', moon: '月牙', speech: '对话气泡', drop: '水滴' };
// 多边形形状的图标由 POLYGON_POINTS 实时生成，其余类型使用 SVG 符号
export const TYPE_ICONS: Partial<Record<ElementType, string>> = { rect: 'square', circle: 'circle', triangle: 'triangle', star: 'star', arrow: 'arrow', line: 'line', curve: 'curve', text: 'font', image: 'image', boolean: 'union' };
export const EXPORT_BLEND: Record<string, GlobalCompositeOperation> = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference' };
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

export const POLYGON_POINTS: Record<string, [number, number][]> = {
    triangle: [[50, 0], [0, 100], [100, 100]],
    star: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]],
    arrow: [[0, 20], [60, 20], [60, 0], [100, 50], [60, 100], [60, 80], [0, 80]],
    hexagon: [[50, 0], [93.3, 25], [93.3, 75], [50, 100], [6.7, 75], [6.7, 25]],
    pentagon: [[50, 0], [100, 36], [81, 100], [19, 100], [0, 36]],
    diamond: [[50, 0], [100, 50], [50, 100], [0, 50]],
    trapezoid: [[22, 0], [78, 0], [100, 100], [0, 100]],
    parallelogram: [[25, 0], [100, 0], [75, 100], [0, 100]],
    cross: [[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]],
    semicircle: [[0, 100], [0.4, 86.9], [1.7, 74.1], [3.8, 61.7], [6.7, 50], [10.3, 39.1], [14.6, 29.3], [19.6, 20.7], [25, 13.4], [30.9, 7.6], [37.1, 3.4], [43.5, 0.9], [50, 0], [56.5, 0.9], [62.9, 3.4], [69.1, 7.6], [75, 13.4], [80.4, 20.7], [85.4, 29.3], [89.7, 39.1], [93.3, 50], [96.2, 61.7], [98.3, 74.1], [99.6, 86.9], [100, 100]],
    heart: [[50, 27.4], [50.1, 26.3], [50.8, 23.4], [52.7, 19.3], [56, 14.6], [60.8, 10.4], [67, 7.6], [74, 6.6], [81.2, 7.9], [87.9, 11.3], [93.3, 16.6], [96.8, 23.1], [98, 30.4], [96.8, 37.9], [93.3, 45.2], [87.9, 52.2], [81.2, 58.9], [74, 65.2], [67, 71.2], [60.8, 76.9], [56, 82.2], [52.7, 86.7], [50.8, 90.3], [50.1, 92.6], [50, 93.4], [49.9, 92.6], [49.2, 90.3], [47.3, 86.7], [44, 82.2], [39.2, 76.9], [33, 71.2], [26, 65.2], [18.8, 58.9], [12.1, 52.2], [6.7, 45.2], [3.2, 37.9], [2, 30.4], [3.2, 23.1], [6.7, 16.6], [12.1, 11.3], [18.8, 7.9], [26, 6.6], [33, 7.6], [39.2, 10.4], [44, 14.6], [47.3, 19.3], [49.2, 23.4], [49.9, 26.3], [50, 27.4]],
    cloud: [[19.3, 94.2], [14.9, 93.7], [11.1, 92.2], [7.9, 89.7], [5.3, 86.6], [3.5, 82.8], [2.4, 78.6], [2, 74], [2.5, 69.2], [3.8, 64.3], [6, 59.5], [3.9, 53.8], [2.9, 48.3], [3, 43.1], [3.9, 38.4], [5.7, 34.2], [8.2, 30.9], [11.4, 28.4], [15.1, 27], [19.2, 26.8], [23.7, 27.9], [25.5, 20.1], [28.3, 13.6], [31.7, 8.5], [35.6, 4.8], [39.8, 2.7], [44.1, 2], [48.5, 2.9], [52.5, 5.4], [56.2, 9.5], [59.2, 15.3], [62.8, 10.4], [66.7, 7.2], [70.7, 5.6], [74.8, 5.4], [78.6, 6.6], [82, 9.2], [84.9, 12.9], [86.9, 17.9], [88.1, 24], [88, 31.1], [91.6, 33.7], [94.4, 37.5], [96.4, 42.3], [97.6, 47.8], [98, 53.6], [97.6, 59.5], [96.4, 65.2], [94.4, 70.5], [91.6, 75], [88, 78.5], [88.2, 83], [87.6, 87.1], [86.3, 90.6], [84.4, 93.6], [81.9, 95.8], [79.1, 97.3], [75.9, 98], [72.6, 97.8], [69.2, 96.5], [65.8, 94.2], [19.3, 94.2]],
    moon: [[98, 6.2], [88.9, 3.9], [79.4, 2.5], [69.8, 2], [60.1, 2.5], [50.7, 4], [41.6, 6.4], [33.1, 9.7], [25.4, 13.8], [18.5, 18.6], [12.7, 24.1], [8.1, 30.1], [4.7, 36.5], [2.7, 43.2], [2, 50], [2.7, 56.8], [4.7, 63.5], [8.1, 69.9], [12.7, 75.9], [18.5, 81.4], [25.4, 86.2], [33.1, 90.3], [41.6, 93.6], [50.7, 96], [60.1, 97.5], [69.8, 98], [79.4, 97.5], [88.9, 96.1], [98, 93.8], [91.5, 93.1], [85.2, 91.9], [79, 90.3], [73.2, 88.2], [67.7, 85.7], [62.5, 82.8], [57.9, 79.5], [53.7, 76], [50.2, 72.1], [47.2, 68], [44.8, 63.7], [43.1, 59.2], [42.1, 54.6], [41.7, 50], [42.1, 45.4], [43.1, 40.8], [44.8, 36.3], [47.2, 32], [50.2, 27.9], [53.7, 24], [57.9, 20.5], [62.5, 17.2], [67.7, 14.3], [73.2, 11.8], [79, 9.7], [85.2, 8.1], [91.5, 6.9], [98, 6.2]],
    speech: [[16.6, 2], [25, 2], [33.3, 2], [41.7, 2], [50, 2], [58.3, 2], [66.7, 2], [75, 2], [83.4, 2], [86.8, 2.2], [89.8, 2.9], [92.3, 4], [94.3, 5.6], [95.9, 7.6], [97.1, 10.1], [97.8, 13.1], [98, 16.5], [98, 24.4], [98, 32.3], [98, 40.2], [98, 48.1], [98, 56], [98, 63.9], [97.8, 67.3], [97.1, 70.3], [95.9, 72.7], [94.3, 74.8], [92.3, 76.4], [89.8, 77.5], [86.8, 78.2], [83.4, 78.4], [75.6, 78.4], [67.7, 78.4], [59.9, 78.4], [52.1, 78.4], [47.2, 84.9], [42.3, 91.5], [37.5, 98], [35.4, 88.2], [33.3, 78.4], [25, 78.4], [16.6, 78.4], [13.2, 78.2], [10.2, 77.5], [7.7, 76.4], [5.7, 74.8], [4.1, 72.7], [2.9, 70.3], [2.2, 67.3], [2, 63.9], [2, 56], [2, 48.1], [2, 40.2], [2, 32.3], [2, 24.4], [2, 16.5], [2.2, 13.1], [2.9, 10.1], [4.1, 7.6], [5.7, 5.6], [7.7, 4], [10.2, 2.9], [13.2, 2.2], [16.6, 2]],
    drop: [[50, 2], [53.8, 6.8], [57.6, 11.5], [61.5, 16.1], [65.5, 20.5], [69.4, 25], [73.3, 29.3], [77.2, 33.7], [81, 37.9], [84.6, 42.2], [88, 46.4], [91.1, 50.7], [93.6, 54.9], [95.6, 59.1], [97, 63.2], [97.8, 67.3], [98, 71.2], [97.6, 75.1], [96.5, 78.8], [94.8, 82.4], [92.5, 85.8], [89.5, 88.9], [86.1, 91.5], [82.3, 93.7], [78.2, 95.4], [73.8, 96.7], [69.1, 97.5], [64.4, 98], [59.6, 98], [54.8, 97.7], [50, 96.9], [45.2, 97.7], [40.4, 98], [35.6, 98], [30.9, 97.5], [26.2, 96.7], [21.8, 95.4], [17.7, 93.7], [13.9, 91.5], [10.5, 88.9], [7.5, 85.8], [5.2, 82.4], [3.5, 78.8], [2.4, 75.1], [2, 71.2], [2.2, 67.3], [3, 63.2], [4.4, 59.1], [6.4, 54.9], [8.9, 50.7], [12, 46.4], [15.4, 42.2], [19, 37.9], [22.8, 33.7], [26.7, 29.3], [30.6, 25], [34.5, 20.5], [38.5, 16.1], [42.4, 11.5], [46.2, 6.8], [50, 2]]
};
/** 由 POLYGON_POINTS 派生 clip-path，保证渲染与几何数据始终一致 */
export const CLIP_PATHS: Record<string, string> = Object.fromEntries(
    Object.entries(POLYGON_POINTS).map(([type, pts]) => [type, `polygon(${pts.map(([x, y]) => `${x}% ${y}%`).join(', ')})`])
);
export const STROKE_SVG_TYPES: ElementType[] = ['rect', 'circle', 'image', ...(Object.keys(POLYGON_POINTS) as ElementType[])];

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
export const VECTOR_SHAPE_PRESETS: ShapePreset[] = VECTOR_SHAPE_TYPES.map(type => ({
    type,
    label: TYPE_LABELS[type],
    color: ({
        hexagon: '#0ea5e9', pentagon: '#9b6bff', diamond: '#12b886', trapezoid: '#f79009',
        parallelogram: '#4f6bff', cross: '#e5484d', semicircle: '#0ea5e9', heart: '#e5484d',
        cloud: '#add8e6', moon: '#ffe4a3', speech: '#9b6bff', drop: '#0ea5e9'
    } as Record<string, string>)[type] || '#4f6bff',
    w: ({ trapezoid: 180, parallelogram: 190, cross: 140, semicircle: 180, heart: 160, cloud: 210, moon: 140, speech: 170 } as Record<string, number>)[type] || 150,
    h: ({ trapezoid: 120, parallelogram: 120, cross: 140, semicircle: 90, heart: 150, cloud: 140, moon: 140, speech: 150 } as Record<string, number>)[type] || 150,
    stroke: type === 'moon' ? '#e8c56b' : type === 'cloud' ? '#c9d9ec' : undefined
}));
/** 左侧形状二级菜单中的基础形状 */
export const SHAPE_MENU_BASIC: ElementType[] = ['rect', 'circle', 'triangle', 'star'];

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