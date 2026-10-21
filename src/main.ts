import { Notice, Plugin, Modal, SuggestModal, MarkdownView, normalizePath, type Editor, type TFile } from 'obsidian';
import { createGitHubSponsors } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, PdfCropRefreshSettingTab, normalizeSettings, type PdfCropRefreshSettings } from './settings';
import { changed, conflict, imageLinks, inFolder, insertion, parseSource, safePath, validSource, refreshIssue, type CropRow } from './crop';
import { renderCrop } from './render';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';
export interface Report { image: string; status: string }

export default class PdfCropRefreshPlugin extends Plugin {
	settings: PdfCropRefreshSettings = { ...DEFAULT_SETTINGS };
	rows: CropRow[] = [];
	pro: SponsorsManager | null = null;
	busy = false;
	private settingTab: PdfCropRefreshSettingTab | null = null;
	private report: CropReport | null = null;
	private picker: FolderPicker | null = null;
	private unloaded = false;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		this.unloaded = false;
		await this.loadSettings();
		this.assertLoaded();
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init(); this.pro = pro; bindPro(pro);
		this.settingTab = new PdfCropRefreshSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.app.workspace.onLayoutReady(() => { void pro.refresh(); });
		this.registerInterval(window.setInterval(() => { void pro.refresh(); }, 6 * 60 * 60 * 1000));
		this.addCommand({ id: 'create-crop', name: 'Save selected PDF rectangle as PNG', editorCallback: (editor: Editor, ctx) => {
			const note = ctx.file;
			const path = note?.path;
			const selected = editor.getSelection();
			const from = editor.getCursor('from');
			const to = editor.getCursor('to');
			if (!path) return;
			void this.run(async () => {
				const row = await this.createCrop(selected, path);
				this.assertLoaded();
				if (ctx.file === note && ctx.file?.path === path && ctx.editor === editor && editor.getSelection() === selected && JSON.stringify(editor.getCursor('from')) === JSON.stringify(from) && JSON.stringify(editor.getCursor('to')) === JSON.stringify(to)) editor.replaceSelection(insertion(row));
				else new Notice(`Crop saved at ${row.image}. The selection changed, so insert its image link from the registry.`);
				this.showReport('Crop saved', [{ image: row.image, status: 'Saved with source page link' }]);
			});
		} });
		this.addCommand({ id: 'refresh-note', name: 'Refresh crops in active note', callback: () => { void this.run(async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') throw new Error('Open a Markdown note first.');
			const reports = await this.refreshNote(file, this.editorText(file));
			this.showReport('Active note refresh', reports);
		}); } });
		this.addCommand({ id: 'registry', name: 'Show crop registry', callback: () => this.showReport('Crop registry', this.rows.map(r => ({ image: r.image, status: `${r.path} · page ${r.page} · rect ${r.rect.join(',')} · scale ${r.scale}` }))) });
		this.addCommand({ id: 'refresh-folder', name: 'Refresh crops in a folder (pro)', callback: () => {
			if (!this.requirePro()) return;
			this.picker?.close();
			this.picker = new FolderPicker(this);
			this.picker.open();
		} });
		this.addCommand({ id: 'changed-sources', name: 'Report changed sources (pro)', callback: () => { if (this.requirePro()) this.showReport('Changed source PDFs (Pro)', this.changedSources()); } });
	}
	onunload(): void { this.unloaded = true; this.picker?.close(); this.picker = null; this.closeReport(); resetPro(); }
	private assertLoaded(): void { if (this.unloaded) throw new Error('The plugin was unloaded.'); }
	private assertFile(file: TFile, path: string, stat: { mtime: number; size: number }, kind: string): void {
		if (file.path !== path || this.app.vault.getFileByPath(path) !== file || file.stat.mtime !== stat.mtime || file.stat.size !== stat.size) throw new Error(`${kind} changed during render. Run the command again.`);
	}
	async loadSettings(): Promise<void> {
		const data: unknown = await this.loadData();
		const saved = data && typeof data === 'object' ? data as { settings?: PdfCropRefreshSettings; rows?: unknown[] } : {};
		this.settings = normalizeSettings(saved.settings);
		this.rows = Array.isArray(saved.rows) ? saved.rows.filter((r): r is CropRow => {
			if (!r || typeof r !== 'object') return false;
			const row = r as CropRow;
			return validSource(row) && typeof row.image === 'string' && safePath(row.image) && /\.png$/i.test(row.image) && [row.sourceMtime,row.sourceSize,row.renderedAt].every(Number.isFinite);
		}) : [];
	}
	async saveSettings(): Promise<void> { this.assertLoaded(); await this.saveData({ settings: this.settings, rows: this.rows }); }
	requirePro(): boolean {
		if (isPro()) return true;
		new Notice('This command needs pro. Open the plugin settings to sign in with GitHub.');
		return false;
	}
	async run(fn: () => Promise<void>): Promise<void> {
		if (this.unloaded) return;
		if (this.busy) { new Notice('A crop task is in progress.'); return; }
		this.busy = true;
		try { await fn(); } catch (error) { if (!this.unloaded) new Notice(error instanceof Error ? error.message : String(error)); }
		finally { this.busy = false; }
	}
	async createCrop(link: string, note: string): Promise<CropRow> {
		this.assertLoaded();
		const source = parseSource(link, this.settings.scale);
		if (!source) throw new Error('Invalid source: select one local PDF link with page and rect.');
		const file = this.app.metadataCache.getFirstLinkpathDest(source.path, note);
		if (!file || file.extension.toLowerCase() !== 'pdf') throw new Error('Missing source.');
		source.path = file.path;
		if (!validSource(source)) throw new Error('Invalid source path.');
		const mtime = file.stat.mtime, size = file.stat.size;
		const rendered = await renderCrop(this.app, file, source);
		this.assertLoaded();
		this.assertFile(file, source.path, { mtime, size }, 'Source');
		const folder = normalizePath(this.settings.folder);
		let current = '';
		for (const part of folder.split('/')) { this.assertLoaded(); current = normalizePath(current ? `${current}/${part}` : part); if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current); }
		const image = normalizePath(`${folder}/${file.basename}-p${source.page}-${crypto.randomUUID().slice(0, 8)}.png`);
		const row: CropRow = { ...source, image, sourceMtime: mtime, sourceSize: size, renderedAt: Date.now() };
		this.assertLoaded();
		this.assertFile(file, source.path, { mtime, size }, 'Source');
		await this.app.vault.createBinary(image, rendered.bytes);
		this.assertLoaded();
		this.rows.push(row);
		try { await this.saveSettings(); } catch (error) { this.rows.pop(); throw error; }
		return row;
	}
	async refreshRow(row: CropRow): Promise<Report> {
		const result = (status: string): Report => ({ image: row.image, status });
		const file = this.app.vault.getFileByPath(row.path);
		const output = this.app.vault.getFileByPath(row.image);
		const issue = refreshIssue(this.rows, row, !!file, !!output);
		if (issue) return result(issue);
		if (!file || !output) return result('Missing source');
		try {
			this.assertLoaded();
			const mtime = file.stat.mtime, size = file.stat.size;
			const outputStat = { mtime: output.stat.mtime, size: output.stat.size };
			const rendered = await renderCrop(this.app, file, row);
			this.assertLoaded();
			this.assertFile(file, row.path, { mtime, size }, 'Source');
			this.assertFile(output, row.image, outputStat, 'Image');
			await this.app.vault.modifyBinary(output, rendered.bytes);
			this.assertLoaded();
			Object.assign(row, { sourceMtime: mtime, sourceSize: size, renderedAt: Date.now() });
			await this.saveSettings();
			return result('Refreshed');
		} catch (error) { return result(error instanceof Error ? error.message : String(error)); }
	}
	async refreshNote(note: TFile, text?: string, seen = new Set<string>()): Promise<Report[]> {
		this.assertLoaded();
		const paths = imageLinks(text ?? await this.app.vault.read(note));
		const reports: Report[] = [];
		for (const path of paths) {
			this.assertLoaded();
			const resolved = this.app.metadataCache.getFirstLinkpathDest(path, note.path)?.path ?? normalizePath(path);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			const row = this.rows.find(r => r.image === resolved);
			reports.push(row ? await this.refreshRow(row) : { image: path, status: 'No saved source' });
		}
		return reports;
	}
	private editorText(note: TFile): string | undefined {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file?.path === note.path && view.getMode() === 'source' ? view.editor.getValue() : undefined;
	}
	async refreshFolder(folder: string): Promise<Report[]> {
		if (!isPro()) throw new Error('Folder refresh needs Pro.');
		if (folder && !safePath(folder)) throw new Error('Invalid folder.');
		const reports: Report[] = [];
		const seen = new Set<string>();
		for (const note of this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, folder))) {
			const text = this.editorText(note);
			for (const report of await this.refreshNote(note, text, seen)) if (!reports.some(r => r.image === report.image)) reports.push(report);
		}
		return reports;
	}
	changedSources(): Report[] {
		if (!isPro()) throw new Error('Changed source report needs Pro.');
		return this.rows.flatMap(row => {
			const file = this.app.vault.getFileByPath(row.path);
			if (conflict(this.rows, row.image)) return [{ image: row.image, status: 'Conflict: multiple sources use this image path' }];
			return !file ? [{ image: row.image, status: 'Missing source' }] : changed(row, file.stat) ? [{ image: row.image, status: `Source changed: ${row.path}` }] : [];
		});
	}
	closeReport(): void { this.report?.close(); this.report = null; }
	showReport(title: string, reports: Report[]): void {
		if (this.unloaded) return;
		this.closeReport();
		this.report = new CropReport(this, title, reports);
		this.report.open();
	}
}

class FolderPicker extends SuggestModal<string> {
	constructor(private plugin: PdfCropRefreshPlugin) { super(plugin.app); this.setPlaceholder('Select a note folder, including subfolders'); }
	getSuggestions(query: string): string[] {
		const folders = new Set(['']);
		for (const f of this.app.vault.getMarkdownFiles()) { const parts = f.path.split('/'); parts.pop(); while (parts.length) { folders.add(parts.join('/')); parts.pop(); } }
		return [...folders].sort().filter(f => f.toLowerCase().includes(query.toLowerCase()));
	}
	renderSuggestion(folder: string, el: HTMLElement): void { el.setText(folder || '/ (vault root)'); }
	onChooseSuggestion(folder: string): void { void this.plugin.run(async () => this.plugin.showReport('Folder refresh (Pro)', await this.plugin.refreshFolder(folder))); }
}
class CropReport extends Modal {
	constructor(private plugin: PdfCropRefreshPlugin, private title: string, private reports: Report[]) { super(plugin.app); }
	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.addClass('pdf-crop-report');
		this.contentEl.createEl('p', { text: `${this.reports.length} image ${this.reports.length === 1 ? 'result' : 'results'}. Crops use local PDF files.` });
		if (!this.reports.length) this.contentEl.createEl('p', { text: 'No crop results. Select a PDF link to save a crop, or open a note with registered PNG embeds.' });
		for (const report of this.reports) {
			const card = this.contentEl.createDiv({ cls: 'pdf-crop-card' });
			card.createEl('strong', { text: report.status });
			card.createEl('p', { text: report.image });
			const file = this.app.vault.getFileByPath(report.image);
			if (file && file.extension.toLowerCase() === 'png') card.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: 'Saved PDF rectangle' } });
			const row = this.plugin.rows.find(r => r.image === report.image);
			if (row) card.createEl('p', { text: `${row.path} · page ${row.page} · rect ${row.rect.join(',')} · scale ${row.scale}` });
		}
	}
	onClose(): void { this.contentEl.empty(); }
}
