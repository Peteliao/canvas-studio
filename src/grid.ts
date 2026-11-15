import { state } from './state';
import { $, $opt } from './utils';

export function updateGrid(): void {
    const g = $('gridOverlay');
    const size = Math.max(4, (state.settings.gridSize || 20) * state.zoom);
    g.style.backgroundSize = `${size}px ${size}px`;
    g.style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
}

export function drawRulers(): void {
    if (!state.settings.rulers || !$opt('rulerHCanvas')) return;
    const vp = $('viewport');
    const dpr = window.devicePixelRatio || 1;
    const draw = (canvas: HTMLCanvasElement, horizontal: boolean) => {
        const len = horizontal ? vp.clientWidth : vp.clientHeight;
        const thick = 20;
        canvas.width = Math.max(1, Math.round(len * dpr));
        canvas.height = Math.max(1, Math.round(thick * dpr));
        if (!horizontal) { canvas.width = Math.max(1, Math.round(thick * dpr)); canvas.height = Math.max(1, Math.round(len * dpr)); }
        canvas.style.width = horizontal ? len + 'px' : thick + 'px';
        canvas.style.height = horizontal ? thick + 'px' : len + 'px';
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const css = getComputedStyle(document.body);
        c.fillStyle = css.getPropertyValue('--bg-surface').trim() || '#fff';
        c.fillRect(0, 0, horizontal ? len : thick, horizontal ? thick : len);
        c.strokeStyle = css.getPropertyValue('--border-strong').trim() || '#ccc';
        c.fillStyle = css.getPropertyValue('--text-3').trim() || '#888';
        c.font = '9px sans-serif'; c.lineWidth = 1;
        const origin = horizontal ? state.pan.x : state.pan.y;
        const step = state.settings.gridSize * state.zoom;
        const unit = state.settings.gridSize;
        const first = Math.floor(-origin / step);
        const count = Math.ceil(len / step) + 1;
        for (let i = 0; i <= count; i++) {
            const idx = first + i;
            const pos = origin + idx * step;
            if (pos < -30 || pos > len + 5) continue;
            const major = idx % 5 === 0;
            c.beginPath();
            if (horizontal) { c.moveTo(Math.round(pos) + .5, thick); c.lineTo(Math.round(pos) + .5, thick - (major ? 9 : 5)); }
            else { c.moveTo(thick, Math.round(pos) + .5); c.lineTo(thick - (major ? 9 : 5), Math.round(pos) + .5); }
            c.stroke();
            if (major) {
                const label = String(idx * unit);
                if (horizontal) c.fillText(label, pos + 3, 9);
                else { c.save(); c.translate(9, pos - 3); c.rotate(-Math.PI / 2); c.fillText(label, 0, 0); c.restore(); }
            }
        }
    };
    draw($<HTMLCanvasElement>('rulerHCanvas'), true);
    draw($<HTMLCanvasElement>('rulerVCanvas'), false);
}