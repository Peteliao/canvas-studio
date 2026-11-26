import type { PinchState } from './types';

export function pinchViewport(pinch: PinchState, distance: number, cx: number, cy: number, minZoom: number, maxZoom: number): { zoom: number; panX: number; panY: number } {
    const zoom = Math.max(minZoom, Math.min(maxZoom, pinch.zoom * distance / Math.max(1, pinch.dist)));
    return {
        zoom,
        panX: cx - (pinch.cx - pinch.panX) * zoom / pinch.zoom,
        panY: cy - (pinch.cy - pinch.panY) * zoom / pinch.zoom
    };
}
