export interface CropSource { path: string; page: number; rect: number[]; scale: number }
export interface CropRow extends CropSource { image: string; sourceMtime: number; sourceSize: number; renderedAt: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export const MAX_PIXELS = 16_000_000;
export const MAX_SIDE = 8192;

export function safePath(path: string): boolean {
	return typeof path === 'string' && !!path && !/[:[\]#|\n\r\\]/.test(path) && !path.startsWith('/') && !path.split('/').some(p => p === '..' || p === '.' || !p);
}

/** Read a local PDF link. Page and rectangle are required. Coordinates are PDF points. */
export function parseSource(text: string, defaultScale = 1): CropSource | null {
	let s = text.trim();
	const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(s);
	const md = /^!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)$/.exec(s);
	if (wiki) s = wiki[1]!.split('|')[0]!;
	else if (md) { try { s = decodeURIComponent(md[1] ?? md[2]!); } catch { return null; } }
	const hash = s.indexOf('#');
	if (hash < 1) return null;
	const path = s.slice(0, hash);
	if (!safePath(path) || !/\.pdf$/i.test(path)) return null;
	const params = new URLSearchParams(s.slice(hash + 1));
	if (['page', 'rect', 'scale'].some(k => params.getAll(k).length > 1)) return null;
	const page = Number(params.get('page'));
	const parts = params.get('rect')?.split(',');
	if (!parts || parts.length !== 4 || parts.some(n => n.trim() === '')) return null;
	const rect = parts.map(Number);
	const scale = params.has('scale') ? Number(params.get('scale')) : defaultScale;
	const result = { path, page, rect, scale };
	return validSource(result) ? result : null;
}

export function validSource(s: CropSource): boolean {
	return safePath(s.path) && /\.pdf$/i.test(s.path) && Number.isInteger(s.page) && s.page >= 1 &&
		Array.isArray(s.rect) && s.rect.length === 4 && s.rect.every(Number.isFinite) &&
		s.rect[2]! > s.rect[0]! && s.rect[3]! > s.rect[1]! && Number.isFinite(s.scale) && s.scale >= 0.25 && s.scale <= 4;
}

/** Transform four corners, then round out to pixel boundaries. */
export function cropBounds(rect: number[], convert: (x: number, y: number) => number[]): Bounds {
	const [x1, y1, x2, y2] = rect as [number, number, number, number];
	const pts = [[x1,y1],[x1,y2],[x2,y1],[x2,y2]].map(([x,y]) => convert(x!,y!));
	const x = Math.floor(Math.min(...pts.map(p => p[0]!)));
	const y = Math.floor(Math.min(...pts.map(p => p[1]!)));
	const width = Math.ceil(Math.max(...pts.map(p => p[0]!))) - x;
	const height = Math.ceil(Math.max(...pts.map(p => p[1]!))) - y;
	if (![x,y,width,height].every(Number.isFinite) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new Error('Invalid source: crop exceeds the canvas limit.');
	return { x, y, width, height };
}

export function sourceLink(s: CropSource): string {
	return `[[${s.path}#page=${s.page}&rect=${s.rect.join(',')}&scale=${s.scale}|PDF source page ${s.page}]]`;
}
export function insertion(row: CropRow): string { return `![[${row.image}]]\n${sourceLink(row)}`; }
export function conflict(rows: CropRow[], image: string): boolean {
	return rows.filter(r => r.image.normalize('NFC').toLowerCase() === image.normalize('NFC').toLowerCase()).length > 1;
}
export function changed(row: CropRow, stat: { mtime: number; size: number }): boolean {
	return stat.mtime > row.sourceMtime || stat.size !== row.sourceSize;
}
export function inFolder(path: string, folder: string): boolean { return !folder || path.startsWith(folder + '/'); }
export function imageLinks(text: string): string[] {
	const out: string[] = [];
	const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g;
	for (const m of text.matchAll(re)) {
		let path = (m[1] ?? m[2] ?? m[3] ?? '').split('|')[0]!;
		if (!m[1]) { try { path = decodeURIComponent(path); } catch { continue; } }
		if (/\.png$/i.test(path) && safePath(path)) out.push(path);
	}
	return [...new Set(out)];
}

export function refreshIssue(rows: CropRow[], row: CropRow, sourceExists: boolean, imageExists: boolean): string | null {
	if (conflict(rows, row.image)) return 'Conflict: multiple sources use this image path';
	if (!validSource(row) || !safePath(row.image) || !/\.png$/i.test(row.image)) return 'Invalid source';
	if (!sourceExists) return 'Missing source';
	if (!imageExists) return 'Missing image';
	return null;
}
export function pageIssue(source: CropSource, numPages: number): string | null {
	return !validSource(source) || source.page > numPages ? 'Invalid source' : null;
}
