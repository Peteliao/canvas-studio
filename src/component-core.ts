import type { CanvasElement, ComponentDefinition, Model } from './types';

export interface ComponentBounds { x: number; y: number; w: number; h: number; }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function componentBounds(elements: readonly CanvasElement[]): ComponentBounds {
    if (!elements.length) return { x: 0, y: 0, w: 1, h: 1 };
    const left = Math.min(...elements.map(el => el.x));
    const top = Math.min(...elements.map(el => el.y));
    const right = Math.max(...elements.map(el => el.x + el.w));
    const bottom = Math.max(...elements.map(el => el.y + el.h));
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
}

export function createComponentDefinition(
    elements: readonly CanvasElement[],
    id: string,
    name: string
): ComponentDefinition {
    const ordered = elements.slice().sort((a, b) => a.zIndex - b.zIndex);
    const bounds = componentBounds(ordered);
    return {
        id,
        name: name.trim().slice(0, 80) || '组件',
        elements: ordered.map(el => ({
            ...clone(el),
            x: round2(el.x - bounds.x),
            y: round2(el.y - bounds.y),
            zIndex: 0,
            groupId: el.groupId,
            linkId: null,
            componentId: null,
            componentInstanceId: null,
            componentSourceId: null
        }))
    };
}

export function instantiateComponent(
    definition: ComponentDefinition,
    instanceId: string,
    groupId: string,
    x: number,
    y: number,
    scaleX = 1,
    scaleY = scaleX,
    createId: (source: CanvasElement) => string
): CanvasElement[] {
    const bounds = componentBounds(definition.elements);
    return definition.elements.map(source => {
        const el = clone(source);
        el.id = createId(source);
        el.x = round2(x + (source.x - bounds.x) * scaleX);
        el.y = round2(y + (source.y - bounds.y) * scaleY);
        el.w = Math.max(1, round2(source.w * scaleX));
        el.h = Math.max(1, round2(source.h * scaleY));
        el.zIndex = 0;
        el.locked = false;
        el.groupId = groupId;
        el.linkId = null;
        el.componentId = definition.id;
        el.componentInstanceId = instanceId;
        el.componentSourceId = source.id;
        el.name = `${definition.name} · ${source.name}`.slice(0, 80);
        return el;
    });
}

const OVERRIDE_KEYS = [
    'type', 'rotation', 'skewX', 'skewY', 'pivotX', 'pivotY', 'locked', 'exportVisible',
    'opacity', 'borderRadius', 'shapeParams', 'fill', 'text', 'line', 'curve', 'image',
    'maskAssetId', 'visible', 'stroke', 'shadow', 'blendMode', 'effectTint'
] as const;

type InstanceOverrides = Map<string, Partial<CanvasElement>>;

function collectOverrides(expected: readonly CanvasElement[], actual: readonly CanvasElement[]): InstanceOverrides {
    const actualBySource = new Map(actual.map(el => [el.componentSourceId || '', el]));
    const overrides: InstanceOverrides = new Map();
    for (const base of expected) {
        const current = actualBySource.get(base.componentSourceId || '');
        if (!current) continue;
        const patch: Partial<CanvasElement> = {};
        for (const key of OVERRIDE_KEYS) {
            if (JSON.stringify(current[key]) !== JSON.stringify(base[key])) {
                (patch as Record<string, unknown>)[key] = clone(current[key]);
            }
        }
        if (Object.keys(patch).length) overrides.set(base.componentSourceId || '', patch);
    }
    return overrides;
}

export function updateComponentInstances(
    previous: ComponentDefinition,
    next: ComponentDefinition,
    elements: readonly CanvasElement[],
    createId: () => string
): CanvasElement[] {
    const groups = new Map<string, CanvasElement[]>();
    elements.forEach(el => {
        if (el.componentId !== previous.id || !el.componentInstanceId) return;
        const group = groups.get(el.componentInstanceId) || [];
        group.push(el);
        groups.set(el.componentInstanceId, group);
    });
    if (!groups.size) return elements.slice();

    const replacements = new Map<string, CanvasElement[]>();
    const replacedIds = new Set<string>();
    for (const [instanceId, current] of groups) {
        const groupId = current[0].groupId || `grp_${instanceId}`;
        const currentBounds = componentBounds(current);
        const previousBounds = componentBounds(previous.elements);
        const scaleX = currentBounds.w / previousBounds.w;
        const scaleY = currentBounds.h / previousBounds.h;
        const currentIds = new Map(current.map(el => [el.componentSourceId || '', el.id]));
        const expected = instantiateComponent(previous, instanceId, groupId, currentBounds.x, currentBounds.y,
            scaleX, scaleY, source => currentIds.get(source.id) || createId());
        const overrides = collectOverrides(expected, current);
        const nextElements = instantiateComponent(next, instanceId, groupId, currentBounds.x, currentBounds.y,
            scaleX, scaleY, source => currentIds.get(source.id) || createId());
        nextElements.forEach(el => {
            const patch = overrides.get(el.componentSourceId || '');
            if (patch) Object.assign(el, patch);
        });
        replacements.set(instanceId, nextElements);
        current.forEach(el => replacedIds.add(el.id));
    }

    const out: CanvasElement[] = [];
    const emitted = new Set<string>();
    for (const el of elements) {
        if (el.componentId !== previous.id || !el.componentInstanceId) { out.push(el); continue; }
        if (emitted.has(el.componentInstanceId)) continue;
        emitted.add(el.componentInstanceId);
        out.push(...(replacements.get(el.componentInstanceId) || []));
    }
    if (!replacedIds.size) return out;
    return out;
}

export function detachComponentElements(elements: readonly CanvasElement[]): void {
    elements.forEach(el => {
        if (el.componentInstanceId) el.groupId = null;
        el.componentId = null;
        el.componentInstanceId = null;
        el.componentSourceId = null;
    });
}

export function syncModelComponents(model: Model, createId: () => string): boolean {
    if (!model.components?.length) return false;
    let changed = false;
    for (let i = 0; i < model.components.length; i++) {
        const current = model.components[i];
        const masters = model.elements.filter(el => el.componentId === current.id && !el.componentInstanceId);
        if (!masters.length) continue;
        const next = createComponentDefinition(masters, current.id, current.name);
        if (JSON.stringify(next) === JSON.stringify(current)) continue;
        model.components[i] = next;
        model.elements = updateComponentInstances(current, next, model.elements, createId);
        changed = true;
    }
    return changed;
}
