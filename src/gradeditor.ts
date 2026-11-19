/* 渐变色标编辑器：渐变条上单击添加、拖动调整、增删色标；填充 / 曲线填充 / 描边共用 */
import { HEX_RE } from './constants';
import { mixHex } from './style';
import type { GradientStop } from './types';
import { $, clamp, cloneStops, normalizeStops, round2 } from './utils';

const MAX_STOPS = 8;
type StopsHandler = (stops: GradientStop[]) => void;

interface Editor {
    bar: HTMLElement;
    markers: HTMLElement;
    color: HTMLInputElement;
    pos: HTMLInputElement;
    stops: GradientStop[];
    active: number;
    onChange: StopsHandler;
}

const defaultStops = (): GradientStop[] => [{ color: '#ffffff', pos: 0 }, { color: '#1f2937', pos: 100 }];

function sampleColor(stops: GradientStop[], pos: number): string {
    if (pos <= stops[0].pos) return stops[0].color;
    const last = stops[stops.length - 1];
    if (pos >= last.pos) return last.color;
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (pos >= a.pos && pos <= b.pos) {
            const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
            return mixHex(a.color, b.color, t);
        }
    }
    return last.color;
}

function render(ed: Editor): void {
    ed.bar.style.background = 'linear-gradient(90deg, ' + ed.stops.map(s => `${s.color} ${round2(s.pos)}%`).join(', ') + ')';
    ed.markers.textContent = '';
    ed.stops.forEach((s, i) => {
        const m = document.createElement('div');
        m.className = 'grad-stop' + (i === ed.active ? ' active' : '');
        m.dataset.i = String(i);
        m.style.left = round2(s.pos) + '%';
        m.style.background = s.color;
        m.title = `${s.color.toUpperCase()} · ${round2(s.pos)}%（拖动调整位置）`;
        ed.markers.appendChild(m);
    });
    if (document.activeElement !== ed.color) ed.color.value = ed.stops[ed.active].color;
    if (document.activeElement !== ed.pos) ed.pos.value = String(round2(ed.stops[ed.active].pos));
}

function emit(ed: Editor): void {
    ed.onChange(cloneStops(ed.stops));
}

function mount(host: HTMLElement, onChange: StopsHandler): Editor {
    host.classList.add('grad-editor');
    host.textContent = '';
    const bar = document.createElement('div');
    bar.className = 'grad-bar';
    bar.title = '单击渐变条添加色标 · 拖动色标调整位置';
    const markers = document.createElement('div');
    markers.className = 'grad-bar-stops';
    bar.appendChild(markers);
    const row = document.createElement('div');
    row.className = 'grad-stop-controls';
    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'grad-color';
    color.setAttribute('aria-label', '选中色标颜色');
    const pos = document.createElement('input');
    pos.type = 'number';
    pos.className = 'num-mini grad-pos';
    pos.min = '0'; pos.max = '100'; pos.step = '1';
    pos.setAttribute('aria-label', '选中色标位置');
    const unit = document.createElement('span');
    unit.className = 'unit'; unit.textContent = '%';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'mini-btn grad-add'; add.textContent = '＋色标';
    add.title = `在最大间隔处添加色标（最多 ${MAX_STOPS} 个）`;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'mini-btn grad-del danger'; del.textContent = '删除';
    del.title = '删除选中色标（至少保留两个）';
    row.append(color, pos, unit, add, del);
    host.append(bar, row);

    const ed: Editor = { bar, markers, color, pos, stops: defaultStops(), active: 0, onChange };
    const posAt = (clientX: number): number => {
        const r = bar.getBoundingClientRect();
        return r.width > 0 ? clamp(round2((clientX - r.left) / r.width * 100), 0, 100) : 0;
    };
    const sortKeep = (s: GradientStop): void => {
        ed.stops.sort((a, b) => a.pos - b.pos);
        ed.active = ed.stops.indexOf(s);
    };
    const startDrag = (e: PointerEvent): void => {
        e.preventDefault();
        const move = (ev: PointerEvent): void => {
            const s = ed.stops[ed.active];
            if (!s) return;
            s.pos = posAt(ev.clientX);
            sortKeep(s);
            render(ed);
            emit(ed);
        };
        const stop = (): void => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    };

    bar.addEventListener('pointerdown', e => {
        const marker = (e.target as HTMLElement).closest<HTMLElement>('.grad-stop');
        if (marker) {
            ed.active = clamp(Number(marker.dataset.i), 0, ed.stops.length - 1);
            render(ed);
            startDrag(e);
            return;
        }
        if (ed.stops.length >= MAX_STOPS) return;
        const p = posAt(e.clientX);
        const stop: GradientStop = { color: sampleColor(ed.stops, p), pos: p };
        ed.stops.push(stop);
        sortKeep(stop);
        render(ed);
        emit(ed);
        startDrag(e);
    });
    color.addEventListener('input', () => {
        const s = ed.stops[ed.active];
        if (!s || !HEX_RE.test(color.value)) return;
        s.color = color.value;
        render(ed);
        emit(ed);
    });
    pos.addEventListener('input', () => {
        const s = ed.stops[ed.active];
        const v = Number(pos.value);
        if (!s || !Number.isFinite(v)) return;
        s.pos = clamp(round2(v), 0, 100);
        sortKeep(s);
        render(ed);
        emit(ed);
    });
    add.addEventListener('click', () => {
        if (ed.stops.length >= MAX_STOPS) return;
        let gi = 0, best = -1;
        for (let i = 0; i < ed.stops.length - 1; i++) {
            const gap = ed.stops[i + 1].pos - ed.stops[i].pos;
            if (gap > best) { best = gap; gi = i; }
        }
        const p = round2((ed.stops[gi].pos + ed.stops[gi + 1].pos) / 2);
        const stop: GradientStop = { color: sampleColor(ed.stops, p), pos: p };
        ed.stops.push(stop);
        sortKeep(stop);
        render(ed);
        emit(ed);
    });
    del.addEventListener('click', () => {
        if (ed.stops.length <= 2) return;
        ed.stops.splice(ed.active, 1);
        ed.active = clamp(ed.active, 0, ed.stops.length - 1);
        render(ed);
        emit(ed);
    });
    render(ed);
    return ed;
}

let fillEd: Editor | null = null;
let curveEd: Editor | null = null;
let strokeEd: Editor | null = null;
let curveStrokeEd: Editor | null = null;
let inited = false;

export interface GradientEditorHandlers { fill: StopsHandler; curve: StopsHandler; stroke: StopsHandler; curveStroke: StopsHandler; }
export function initGradientEditors(h: GradientEditorHandlers): void {
    if (inited) return;
    inited = true;
    fillEd = mount($('elGradEditor'), h.fill);
    curveEd = mount($('curveGradEditor'), h.curve);
    strokeEd = mount($('strokeGradEditor'), h.stroke);
    curveStrokeEd = mount($('curveStrokeGradEditor'), h.curveStroke);
}
export function setFillGradientStops(stops: GradientStop[]): void {
    if (!fillEd) return;
    fillEd.stops = normalizeStops(stops) || defaultStops();
    fillEd.active = clamp(fillEd.active, 0, fillEd.stops.length - 1);
    render(fillEd);
}
export function setCurveGradientStops(stops: GradientStop[]): void {
    if (!curveEd) return;
    curveEd.stops = normalizeStops(stops) || defaultStops();
    curveEd.active = clamp(curveEd.active, 0, curveEd.stops.length - 1);
    render(curveEd);
}
export function setStrokeGradientStops(stops: GradientStop[]): void {
    if (!strokeEd) return;
    strokeEd.stops = normalizeStops(stops) || defaultStops();
    strokeEd.active = clamp(strokeEd.active, 0, strokeEd.stops.length - 1);
    render(strokeEd);
}
export function setCurveStrokeGradientStops(stops: GradientStop[]): void {
    if (!curveStrokeEd) return;
    curveStrokeEd.stops = normalizeStops(stops) || defaultStops();
    curveStrokeEd.active = clamp(curveStrokeEd.active, 0, curveStrokeEd.stops.length - 1);
    render(curveStrokeEd);
}
export function getFillGradientStops(): GradientStop[] {
    return fillEd ? cloneStops(fillEd.stops) : [];
}
export function getCurveGradientStops(): GradientStop[] {
    return curveEd ? cloneStops(curveEd.stops) : [];
}
export function getStrokeGradientStops(): GradientStop[] {
    return strokeEd ? cloneStops(strokeEd.stops) : [];
}
export function getCurveStrokeGradientStops(): GradientStop[] {
    return curveStrokeEd ? cloneStops(curveStrokeEd.stops) : [];
}
