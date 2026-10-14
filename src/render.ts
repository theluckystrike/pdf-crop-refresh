import { loadPdfJs, type App, type TFile } from 'obsidian';
import { cropBounds, pageIssue, validSource, type CropSource, type Bounds } from './crop';
interface Viewport { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] }
interface PdfPage {
	view: number[];
	getViewport(options: { scale: number }): Viewport;
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: Viewport; transform: number[] }): { promise: Promise<void> };
}
interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
export interface PdfJs { getDocument(options: { data: ArrayBuffer; isEvalSupported: boolean }): { promise: Promise<PdfDocument> } }
export interface RenderResult { bytes: ArrayBuffer; bounds: Bounds }

export async function renderCrop(app: App, file: TFile, source: CropSource): Promise<RenderResult> {
	if (!validSource(source)) throw new Error('Invalid source: check page, rectangle and scale.');
	const pdfjs = await loadPdfJs() as PdfJs;
	const doc = await pdfjs.getDocument({ data: await app.vault.readBinary(file), isEvalSupported: false }).promise;
	let canvas: HTMLCanvasElement | null = null;
	try {
		if (pageIssue(source, doc.numPages)) throw new Error('Invalid source: page is beyond the page count.');
		const page = await doc.getPage(source.page);
		const [x1,y1,x2,y2] = source.rect as [number,number,number,number];
		if (x1 < page.view[0]! || y1 < page.view[1]! || x2 > page.view[2]! || y2 > page.view[3]!) throw new Error('Invalid source: rectangle is outside the page.');
		const viewport = page.getViewport({ scale: source.scale });
		const bounds = cropBounds(source.rect, (x,y) => viewport.convertToViewportPoint(x,y));
		canvas = createEl('canvas');
		canvas.width = bounds.width; canvas.height = bounds.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Cannot create a canvas.');
		await page.render({ canvasContext: ctx, viewport, transform: [1,0,0,1,-bounds.x,-bounds.y] }).promise;
		const blob = await new Promise<Blob>((resolve,reject) => canvas!.toBlob(b => b ? resolve(b) : reject(new Error('Cannot encode PNG.')), 'image/png'));
		return { bytes: await blob.arrayBuffer(), bounds };
	} finally {
		if (canvas) { canvas.width = 0; canvas.height = 0; }
		await doc.destroy();
	}
}
