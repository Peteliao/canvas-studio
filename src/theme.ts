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

export function applyViewSettings(): void {
    const s = state.settings;
    setToggleButton('btnSnap', s.snap); setToggleButton('btnGrid', s.grid);
    setToggleButton('btnRulers', s.rulers); setToggleButton('btnGuides', s.guides);
    setToggleButton('btnGuideLines', s.guideLines !== false);
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