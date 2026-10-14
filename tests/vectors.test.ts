import { describe, it, expect } from 'vitest';
import * as crop from '../src/crop';
import vectors from './vectors.json';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const specPath = resolve('../../packages/spec/vectors/pdf-crop-refresh.json');
const functions: Record<string, (...args: any[]) => unknown> = {
	...crop,
	testBounds: (rect: number[], rotation: number, scale: number) => crop.cropBounds(rect, (x,y) => {
		const point = rotation === 90 ? [y,x] : rotation === 180 ? [300-x,y] : [x,300-y];
		return point.map(n => n * scale);
	}),
};
describe('golden vectors', () => {
	it.skipIf(!existsSync(specPath))('matches the factory vector file', () => expect(JSON.parse(readFileSync(specPath, 'utf8'))).toEqual(vectors));
	for (const c of vectors.cases) it(c.name, () => expect(functions[c.function]!(...c.args)).toEqual(c.expected));
	it('rejects a large canvas', () => expect(() => crop.cropBounds([0,0,9000,9000], (x,y) => [x,y])).toThrow('canvas limit'));
});
