import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import Plugin from '../src/main';
import { renderCrop } from '../src/render';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import manifest from '../manifest.json';
import type { CropRow } from '../src/crop';
import { SuggestModal, type Command } from 'obsidian';
vi.mock('../src/render', () => ({ renderCrop: vi.fn() }));
let plugin: Plugin;
let app: ReturnType<typeof App.createConfigured__>;
const bytes = new Uint8Array([1,2,3]).buffer;
const link = '[[A.pdf#page=1&rect=20,200,120,250]]';
const row = (): CropRow => ({ path: 'A.pdf', page: 1, rect: [20,200,120,250], scale: 1, image: 'crop.png', sourceMtime: 0, sourceSize: 0, renderedAt: 0 });
beforeEach(async () => {
	app = App.createConfigured__({ files: { 'A.pdf': 'pdf', 'crop.png': 'old', 'Note.md': '![[crop.png]]', 'ordinary.png': 'image', 'Folder/N.md': '![[crop.png]]' } });
	plugin = new Plugin(app as never, manifest as never);
	vi.mocked(renderCrop).mockReset().mockResolvedValue({ bytes, bounds: { x: 20,y:50,width:100,height:50 } });
	await plugin.loadSettings();
});
afterEach(() => { resetPro(); vi.restoreAllMocks(); });
describe('registry operations', () => {
	it('restores source data and ignores malformed registry rows', async () => {
		vi.spyOn(plugin,'loadData').mockResolvedValue({settings:{scale:2,folder:'Saved crops'},rows:[row(),null,{path:null},{...row(),image:'../bad.png'}]});
		await plugin.loadSettings();expect(plugin.rows).toEqual([row()]);expect(plugin.settings).toEqual({scale:2,folder:'Saved crops'});
	});
	it('renders a repeated image once during folder refresh', async () => {
		bindPro({isPro:()=>true,onChange:()=>()=>{}} as never);plugin.rows=[row()];
		await plugin.refreshFolder('');expect(renderCrop).toHaveBeenCalledOnce();
	});
	it('uses unsaved active editor embeds during folder refresh', async () => {
		bindPro({isPro:()=>true,onChange:()=>()=>{}} as never);plugin.rows=[row()];
		const note=app.vault.getFileByPath('Note.md')!;await app.vault.modify(note,'No image on disk.');
		vi.spyOn(app.workspace,'getActiveViewOfType').mockReturnValue({file:note,getMode:()=>'source',editor:{getValue:()=>'![[crop.png]]'}} as never);
		expect(await plugin.refreshFolder('')).toEqual([{image:'crop.png',status:'Refreshed'}]);
		expect(renderCrop).toHaveBeenCalledOnce();
	});
	it('uses the saved note in reading mode instead of its hidden editor', async () => {
		bindPro({isPro:()=>true,onChange:()=>()=>{}} as never);plugin.rows=[row()];
		const note=app.vault.getFileByPath('Note.md')!;
		vi.spyOn(app.workspace,'getActiveViewOfType').mockReturnValue({file:note,getMode:()=>'preview',editor:{getValue:()=>''}} as never);
		expect(await plugin.refreshFolder('')).toEqual([{image:'crop.png',status:'Refreshed'}]);
	});
	it('loads defaults', () => expect(plugin.settings).toEqual(DEFAULT_SETTINGS));
	it('repairs settings', () => expect(normalizeSettings({scale: NaN,folder:'../bad'})).toEqual(DEFAULT_SETTINGS));
	it('creates a PNG and persists its source', async () => {
		const saved = await plugin.createCrop(link, 'Note.md');
		expect(app.vault.getFileByPath(saved.image)).not.toBeNull(); expect(plugin.rows).toHaveLength(1);
		expect(saved).toMatchObject({path:'A.pdf',page:1,rect:[20,200,120,250],scale:1});
		const save = vi.spyOn(plugin,'saveData'); await plugin.saveSettings();
		expect(save).toHaveBeenCalledWith({settings:plugin.settings,rows:plugin.rows});
	});
	it('rejects a missing PDF', async () => {
		await expect(plugin.createCrop('[[Gone.pdf#page=1&rect=20,200,120,250]]','Note.md')).rejects.toThrow('Missing source'); expect(plugin.rows).toHaveLength(0);
	});
	it('does not write when rendering rejects a page beyond numPages', async () => {
		vi.mocked(renderCrop).mockRejectedValue(new Error('Invalid source'));
		const spy = vi.spyOn(app.vault,'createBinary'); await expect(plugin.createCrop(link,'Note.md')).rejects.toThrow('Invalid source'); expect(spy).not.toHaveBeenCalled();
	});
	it.each(['page=0&rect=1,2,3,4','page=1&rect=1,NaN,3,4'])('rejects invalid source %s', async source => {
		await expect(plugin.createCrop(`[[A.pdf#${source}]]`,'Note.md')).rejects.toThrow('Invalid source'); expect(renderCrop).not.toHaveBeenCalled();
	});
	it('refreshes bytes at the same path', async () => {
		const r=row(); plugin.rows=[r]; const spy=vi.spyOn(app.vault,'modifyBinary');
		expect(await plugin.refreshRow(r)).toEqual({image:'crop.png',status:'Refreshed'}); expect(spy).toHaveBeenCalledWith(app.vault.getFileByPath('crop.png'),bytes);
		expect(r.image).toBe('crop.png'); expect(r.renderedAt).toBeGreaterThan(0);
	});
	it('keeps the PNG when the PDF is missing', async () => {
		const r={...row(),path:'gone.pdf'}; plugin.rows=[r]; const spy=vi.spyOn(app.vault,'modifyBinary');
		expect((await plugin.refreshRow(r)).status).toBe('Missing source'); expect(spy).not.toHaveBeenCalled();
	});
	it('blocks both rows in a conflict', async () => {
		plugin.rows=[row(),{...row(),path:'B.pdf'}]; for(const r of plugin.rows) expect((await plugin.refreshRow(r)).status).toContain('Conflict'); expect(renderCrop).not.toHaveBeenCalled();
	});
	it('keeps the PNG when rendering fails', async () => {
		const r=row(); plugin.rows=[r]; vi.mocked(renderCrop).mockRejectedValue(new Error('Invalid source'));
		const spy=vi.spyOn(app.vault,'modifyBinary'); expect((await plugin.refreshRow(r)).status).toBe('Invalid source'); expect(spy).not.toHaveBeenCalled();
	});
	it('reports an ordinary PNG without touching it', async () => {
		const results=await plugin.refreshNote(app.vault.getFileByPath('Note.md')! as never,'![[ordinary.png]]'); expect(results).toEqual([{image:'ordinary.png',status:'No saved source'}]); expect(renderCrop).not.toHaveBeenCalled();
	});
	it('uses active editor text when supplied', async () => {
		plugin.rows=[row()]; const results=await plugin.refreshNote(app.vault.getFileByPath('Note.md')! as never,'![[ordinary.png]]'); expect(results[0]!.status).toBe('No saved source');
	});
	it('gates folder refresh and change report', async () => {
		await expect(plugin.refreshFolder('Folder')).rejects.toThrow('Pro'); expect(() => plugin.changedSources()).toThrow('Pro');
	});
	it('refreshes a selected folder with Pro', async () => {
		bindPro({isPro:()=>true,onChange:()=>()=>{}} as never); plugin.rows=[row()]; expect(await plugin.refreshFolder('Folder')).toEqual([{image:'crop.png',status:'Refreshed'}]);
	});
	it('reports changed and missing PDF sources with Pro', () => {
		bindPro({isPro:()=>true,onChange:()=>()=>{}} as never); plugin.rows=[row(),{...row(),image:'other.png',path:'missing.pdf'}]; expect(plugin.changedSources().map(r=>r.status)).toEqual(['Source changed: A.pdf','Missing source']);
	});
	it('uses the reference sponsor values', () => expect(SPONSORS).toMatchObject({clientId:'Ov23lic5UPGPZqhBlBGg',minMonthlyUsd:5,oneTimeUsd:15}));
});

describe('review regressions', () => {
	async function commands(): Promise<Command[]> {
		const items: Command[] = [];
		vi.spyOn(plugin, 'addCommand').mockImplementation(command => { items.push(command); return command; });
		vi.spyOn(plugin, 'registerInterval').mockImplementation(id => { window.clearInterval(id); return id; });
		await plugin.onload();
		return items;
	}
	it('does not insert into a different note with the same selection', async () => {
		const items = await commands();
		const original = app.vault.getFileByPath('Note.md')!;
		const editor = { getSelection: () => link, getCursor: () => ({ line: 0, ch: 0 }), replaceSelection: vi.fn() };
		const ctx = { file: original, editor };
		vi.spyOn(plugin, 'createCrop').mockImplementation(async () => {
			ctx.file = app.vault.getFileByPath('Folder/N.md')!;
			return row();
		});
		vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
		await new Promise<void>(resolve => {
			const run = plugin.run.bind(plugin);
			vi.spyOn(plugin, 'run').mockImplementation(async fn => { await run(fn); resolve(); });
			items.find(c => c.id === 'create-crop')!.editorCallback!(editor as never, ctx as never);
		});
		expect(editor.replaceSelection).not.toHaveBeenCalled();
	});
	it.each(['image rename', 'source rename', 'image edit', 'source edit'])('keeps the PNG after %s during render', async change => {
		const r = row(); plugin.rows = [r];
		const output = app.vault.getFileByPath(r.image)!;
		const source = app.vault.getFileByPath(r.path)!;
		const write = vi.spyOn(app.vault, 'modifyBinary');
		vi.mocked(renderCrop).mockImplementation(async () => {
			if (change === 'image rename') await app.vault.rename(output, 'moved.png');
			if (change === 'source rename') await app.vault.rename(source, 'moved.pdf');
			if (change === 'image edit') output.stat.mtime += 1;
			if (change === 'source edit') source.stat.mtime += 1;
			return { bytes, bounds: { x: 20, y: 50, width: 100, height: 50 } };
		});
		expect((await plugin.refreshRow(r)).status).toContain('changed');
		expect(write).not.toHaveBeenCalled();
		expect(r.renderedAt).toBe(0);
	});
	it('does not save a new crop if the source moves during render', async () => {
		vi.mocked(renderCrop).mockImplementation(async () => {
			await app.vault.rename(app.vault.getFileByPath('A.pdf')!, 'moved.pdf');
			return { bytes, bounds: { x: 20, y: 50, width: 100, height: 50 } };
		});
		const write = vi.spyOn(app.vault, 'createBinary');
		await expect(plugin.createCrop(link, 'Note.md')).rejects.toThrow('changed');
		expect(write).not.toHaveBeenCalled();
	});
	it.each(['create', 'refresh'])('stops %s writes after unload during render', async task => {
		plugin.rows = [row()];
		vi.mocked(renderCrop).mockImplementation(async () => {
			plugin.onunload();
			return { bytes, bounds: { x: 20, y: 50, width: 100, height: 50 } };
		});
		const create = vi.spyOn(app.vault, 'createBinary');
		const modify = vi.spyOn(app.vault, 'modifyBinary');
		const save = vi.spyOn(plugin, 'saveSettings');
		if (task === 'create') await expect(plugin.createCrop(link, 'Note.md')).rejects.toThrow('unloaded');
		else expect((await plugin.refreshRow(plugin.rows[0]!)).status).toContain('unloaded');
		expect(create).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
	});
	it('closes the folder picker on unload', async () => {
		const items = await commands();
		bindPro({ isPro: () => true, onChange: () => () => {} } as never);
		const open = vi.spyOn(SuggestModal.prototype, 'open').mockImplementation(() => undefined);
		const close = vi.spyOn(SuggestModal.prototype, 'close').mockImplementation(() => undefined);
		items.find(c => c.id === 'refresh-folder')!.callback!();
		expect(open).toHaveBeenCalledOnce();
		plugin.onunload();
		expect(close.mock.contexts).toContain(open.mock.contexts[0]);
	});
});
