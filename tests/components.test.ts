import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/constants';
import {
    componentBounds,
    createComponentDefinition,
    detachComponentElements,
    instantiateComponent,
    syncModelComponents,
    updateComponentInstances
} from '../src/component-core';
import '../src/state';
import { validateProject } from '../src/model';
import { remapProjectAssets } from '../src/project-binding';
import type { CanvasElement, Model } from '../src/types';

function rect(id: string, x: number, y: number, w = 100, h = 50): CanvasElement {
    return {
        id, type: 'rect', x, y, w, h,
        rotation: 0, skewX: 0, skewY: 0, pivotX: 0.5, pivotY: 0.5, zIndex: 1,
        locked: false, exportVisible: true, opacity: 1, borderRadius: 0, shapeParams: {},
        fill: { enabled: true, mode: 'solid', color: '#112233', start: '#112233', end: '#112233', stops: [{ color: '#112233', pos: 0 }, { color: '#112233', pos: 100 }], angle: 90, posX: 50, posY: 50, alpha: 1 },
        text: null, line: null, curve: null, image: null, maskAssetId: null,
        name: id, visible: true, groupId: null, linkId: null,
        stroke: { color: '#000000', width: 0, style: 'solid', align: 'center', gradient: null },
        shadow: { enabled: false, type: 'drop', color: '#000000', x: 0, y: 0, blur: 0, opacity: 1 },
        blendMode: 'normal', effectTint: null,
        componentId: null, componentInstanceId: null, componentSourceId: null
    };
}

function project(elements: CanvasElement[], components?: Model['components']): Model {
    return {
        version: VERSION, name: 'components', canvas: { w: 800, h: 600, lockedRatio: false, background: rect('bg', 0, 0).fill },
        elements, guides: [], components
    };
}

describe('component definitions and instances', () => {
    it('normalizes master geometry and creates independent instance transforms', () => {
        const first = rect('source_a', 100, 80, 100, 50);
        const second = rect('source_b', 240, 110, 60, 40);
        second.zIndex = 2;
        const definition = createComponentDefinition([second, first], 'cmp_1', ' Card ');
        expect(definition.name).toBe('Card');
        expect(componentBounds(definition.elements)).toEqual({ x: 0, y: 0, w: 200, h: 70 });
        expect(definition.elements.map(el => el.id)).toEqual(['source_a', 'source_b']);
        expect(definition.elements[0]).toMatchObject({ x: 0, y: 0, zIndex: 0, componentId: null });

        let next = 0;
        const instances = instantiateComponent(definition, 'inst_1', 'grp_1', 300, 200, 1.5, 0.5, () => `el_${++next}`);
        expect(instances.map(el => el.id)).toEqual(['el_1', 'el_2']);
        expect(instances[0]).toMatchObject({ x: 300, y: 200, w: 150, h: 25, groupId: 'grp_1', componentId: 'cmp_1', componentInstanceId: 'inst_1', componentSourceId: 'source_a' });
        expect(instances[1]).toMatchObject({ x: 510, y: 215, w: 90, h: 20, componentSourceId: 'source_b' });
        instances[0].fill.color = '#ffffff';
        expect(definition.elements[0].fill.color).toBe('#112233');
        expect(first.x).toBe(100);
    });

    it('synchronizes master styles while retaining instance position, scale and overrides', () => {
        const master = rect('source_a', 100, 80);
        const previous = createComponentDefinition([master], 'cmp_1', 'Card');
        master.componentId = 'cmp_1';
        master.componentInstanceId = null;
        master.componentSourceId = master.id;
        const instance = instantiateComponent(previous, 'inst_1', 'grp_1', 300, 200, 2, 0.5, () => 'instance_a')[0];
        instance.fill.color = '#abcdef';
        instance.rotation = 15;
        instance.opacity = 0.4;

        master.fill.color = '#445566';
        master.borderRadius = 12;
        const next = createComponentDefinition([master], 'cmp_1', 'Card');
        let created = 0;
        const updated = updateComponentInstances(previous, next, [master, instance], () => `new_${++created}`)[1];
        expect(updated).toMatchObject({ x: 300, y: 200, w: 200, h: 25, fill: { color: '#abcdef' }, borderRadius: 12, rotation: 15, opacity: 0.4 });
        expect(updated.id).toBe('instance_a');
        expect(created).toBe(0);
    });

    it('adds and removes source elements without changing surviving instance ids', () => {
        const first = rect('source_a', 0, 0);
        const previous = createComponentDefinition([first], 'cmp_1', 'Card');
        const instance = instantiateComponent(previous, 'inst_1', 'grp_1', 100, 100, 1, 1, () => 'instance_a')[0];
        const second = rect('source_b', 150, 0, 50, 50);
        const next = createComponentDefinition([first, second], 'cmp_1', 'Card');
        let created = 0;
        const expanded = updateComponentInstances(previous, next, [instance], () => `new_${++created}`);
        expect(expanded.map(el => el.componentSourceId)).toEqual(['source_a', 'source_b']);
        expect(expanded[0].id).toBe('instance_a');
        expect(expanded[1].id).toBe('new_1');
        expect(expanded[1]).toMatchObject({ x: 250, y: 100, w: 50, h: 50 });

        const reduced = updateComponentInstances(next, previous, expanded, () => 'unused');
        expect(reduced).toHaveLength(1);
        expect(reduced[0].id).toBe('instance_a');
    });

    it('updates model definitions only for structural master changes', () => {
        const master = rect('source_a', 100, 80);
        const definition = createComponentDefinition([master], 'cmp_1', 'Card');
        master.componentId = 'cmp_1';
        master.componentSourceId = master.id;
        const instance = instantiateComponent(definition, 'inst_1', 'grp_1', 300, 200, 1, 1, () => 'instance_a')[0];
        const model = project([master, instance], [definition]);
        master.x += 50;
        master.y += 20;
        expect(syncModelComponents(model, () => 'unused')).toBe(false);
        expect(model.elements[1].x).toBe(300);

        master.fill.color = '#778899';
        expect(syncModelComponents(model, () => 'unused')).toBe(true);
        expect(model.components![0].elements[0].fill.color).toBe('#778899');
        expect(model.elements[1].fill.color).toBe('#778899');
        expect(syncModelComponents(model, () => 'unused')).toBe(false);
    });
    it('detaches instance groups while preserving ordinary master groups', () => {
        const master = rect('source_a', 0, 0);
        master.groupId = 'grp_master';
        const definition = createComponentDefinition([master], 'cmp_1', 'Card');
        const instance = instantiateComponent(definition, 'inst_1', 'grp_1', 100, 100, 1, 1, () => 'instance_a')[0];
        detachComponentElements([master, instance]);
        expect(master).toMatchObject({ groupId: 'grp_master', componentId: null, componentInstanceId: null, componentSourceId: null });
        expect(instance).toMatchObject({ groupId: null, componentId: null, componentInstanceId: null, componentSourceId: null });
        expect(instance.fill.color).toBe('#112233');
    });
});

describe('component persistence', () => {
    it('accepts old projects and validates component linkage and duplicate ids', () => {
        const old = validateProject(project([rect('el_1', 0, 0)]));
        expect(old.components).toBeUndefined();
        expect(old.elements[0].componentId).toBeNull();

        const source = rect('source_a', 10, 20);
        const definition = createComponentDefinition([source], 'cmp_1', 'Card');
        const valid = validateProject(project([source], [definition]));
        expect(valid.components).toEqual([definition]);
        expect(() => validateProject(project([], [{ ...definition, elements: [source, source] }]))).toThrow('重复');
        expect(() => validateProject(project([], [definition, definition]))).toThrow('重复');
    });

    it('remaps assets referenced only by component definitions', () => {
        const source = rect('source_a', 0, 0);
        source.image = { assetId: 'shared', originalAssetId: 'original', crop: null };
        source.maskAssetId = 'mask';
        const definition = createComponentDefinition([source], 'cmp_1', 'Photo');
        const original = project([], [definition]);
        original.assets = { shared: 'data:image/png;base64,AA==', original: 'data:image/png;base64,BB==', mask: 'data:image/png;base64,CC==' };
        let next = 0;
        const remapped = remapProjectAssets(original, () => `fresh_${++next}`);
        const image = remapped.components![0].elements[0];
        expect(image.image!.assetId).not.toBe('shared');
        expect(image.image!.originalAssetId).not.toBe('original');
        expect(image.maskAssetId).not.toBe('mask');
        expect(Object.keys(remapped.assets!).sort()).toEqual([image.image!.assetId, image.image!.originalAssetId, image.maskAssetId!].sort());
        expect(definition.elements[0].image!.assetId).toBe('shared');
    });
});
