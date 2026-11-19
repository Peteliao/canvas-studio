/* 流体形状点位生成：闭合轮廓统一归一化到 0–100 盒子坐标 */
type Pt = [number, number];

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function normalize(raw: Pt[]): Pt[] {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    raw.forEach(([x, y]) => {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    const w = maxX - minX || 1, h = maxY - minY || 1;
    return raw.map(([x, y]) => [Math.round((x - minX) / w * 1000) / 10, Math.round((y - minY) / h * 1000) / 10]);
}

/** 有机流体色块：环形多谐波轮廓，波瓣数与起伏可调 */
export function blobPoints(lobes = 5, depth = 24): Pt[] {
    const l = Math.round(clampNum(lobes, 3, 9));
    const d = clampNum(depth, 5, 40) / 100;
    const raw: Pt[] = [];
    const n = 96;
    for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2;
        const r = 1 + d * Math.sin(l * a + 0.9) + d * 0.5 * Math.sin(2 * a + 2.1) + 0.03 * Math.sin(3 * a + 0.4);
        raw.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return normalize(raw);
}

/** 液态波浪色带：上下两条相位错开的正弦边构成闭合带 */
export function wavePoints(amp = 14, thick = 44): Pt[] {
    const a = clampNum(amp, 0, 40);
    const t = clampNum(thick, 10, 80);
    const top: Pt[] = [], bottom: Pt[] = [];
    const n = 64;
    for (let i = 0; i <= n; i++) {
        const x = i / n * 100;
        const p = i / n * Math.PI * 2;
        top.push([x, 50 - t / 2 + a * Math.sin(p * 1.2 + 0.5)]);
        bottom.push([x, 50 + t / 2 + a * Math.sin(p * 1.2 + 1.7)]);
    }
    return normalize([...top, ...bottom.reverse()]);
}

/** 飞溅水花：尖角幂次整形的环形轮廓，尖角数与强度可调 */
export function splashPoints(spikes = 7, depth = 24): Pt[] {
    const s = Math.round(clampNum(spikes, 3, 12));
    const d = clampNum(depth, 5, 35) / 100;
    const raw: Pt[] = [];
    const n = 120;
    for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2;
        const w = Math.sin(s * a + 0.8);
        const sharp = Math.sign(w) * Math.pow(Math.abs(w), 0.65);
        const r = 1 + d * sharp + d * 0.4 * Math.sin(2 * a + 2.6) + 0.025 * Math.sin(11 * a + 0.3);
        raw.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return normalize(raw);
}
