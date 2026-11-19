import { state } from './state';
import { $, $opt, setIcon, toast } from './utils';
import { saveSettings } from './db';
import { updateGrid } from './grid';
import { onViewChanged } from './tools';

export function applyTheme(): void {
    const s = state.settings;
    document.body.dataset.theme = s.theme;
    document.body.dataset.contrast = s.contrast;
    setIcon($('btnTheme'), s.theme === 'dark' ? 'sun' : 'moon');
    onViewChanged();
}

export function toggleTheme(): void {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(); applyTheme();
    toast(state.settings.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'success');
}

export function setToggleButton(id: string, on: boolean): void {
    const b = $opt(id); if (b) b.setAttribute('aria-pressed', String(!!on));
}

/* -------------------- 标注类型开关 -------------------- */
export type MeasureKind = 'size' | 'canvas' | 'gap' | 'align' | 'guide';
type MeasureKey = 'measureSize' | 'measureCanvas' | 'measureGap' | 'measureAlign' | 'measureGuide';
const MEASURE_META: Record<MeasureKind, { key: MeasureKey; chip: string; label: string; hot: string }> = {
    size: { key: 'measureSize', chip: 'statusMeasureSize', label: '尺寸', hot: '1' },
    canvas: { key: 'measureCanvas', chip: 'statusMeasureCanvas', label: '边距', hot: '2' },
    gap: { key: 'measureGap', chip: 'statusMeasureGap', label: '间距', hot: '3' },
    align: { key: 'measureAlign', chip: 'statusMeasureAlign', label: '对齐', hot: '4' },
    guide: { key: 'measureGuide', chip: 'statusMeasureGuide', label: '辅助线', hot: '5' }
};

export function toggleMeasureType(kind: MeasureKind): void {
    const meta = MEASURE_META[kind];
    if (state.settings.guides) {
        state.settings[meta.key] = !state.settings[meta.key];
    } else {
        // 总标注关闭时，第一次按键先打开总开关并显示该类型
        state.settings.guides = true;
        state.settings[meta.key] = true;
    }
    saveSettings(); applyViewSettings();
    toast(meta.label + '标注已' + (state.settings[meta.key] ? '显示' : '隐藏') + '（' + meta.hot + '）', 'success');
}

export function applyViewSettings(): void {
    const s = state.settings;
    setToggleButton('btnSnap', s.snap); setToggleButton('btnGrid', s.grid);
    setToggleButton('btnRulers', s.rulers); setToggleButton('btnGuides', s.guides);
    setToggleButton('btnGuideLines', s.guideLines !== false);
    (Object.keys(MEASURE_META) as MeasureKind[]).forEach(k => {
        const meta = MEASURE_META[k];
        const b = $opt(meta.chip);
        if (b) {
            b.classList.toggle('on', s[meta.key] !== false);
            b.setAttribute('aria-pressed', String(s[meta.key] !== false));
        }
    });
    $('gridOverlay').classList.toggle('on', !!s.grid);
    [$('rulerH'), $('rulerV'), $('rulerCorner')].forEach(n => n.classList.toggle('hidden-ruler', !s.rulers));
    const flags = $opt('statusSnap'); if (flags) flags.classList.toggle('on', !!s.snap);
    const gf = $opt('statusGrid'); if (gf) gf.classList.toggle('on', !!s.grid);
    state.alignBase = s.alignBase || 'selection';
    const ab = $opt<HTMLSelectElement>('alignBase'); if (ab) ab.value = state.alignBase;
    updateGrid();
    onViewChanged();
}

export function toggleSetting(key: 'snap' | 'grid' | 'rulers' | 'guides' | 'guideLines', label: string): void {
    state.settings[key] = !state.settings[key];
    saveSettings(); applyViewSettings();
    toast(label + (state.settings[key] ? '已开启' : '已关闭'), 'success');
}