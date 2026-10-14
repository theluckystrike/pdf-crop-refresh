import { browser, expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { obsidianPage } from 'wdio-obsidian-service';
import type PdfCropRefreshPlugin from '../../src/main';
import { reloadPlugin } from './load';
const fixture = (name: string) => [...readFileSync(`test/e2e/fixtures/${name}.pdf`)];

describe('PDF crop workflow', () => {
	before(async () => {
		await browser.executeObsidian(async ({app}, a, rotated) => {
			for (const [path,values] of [['A.pdf',a],['Rotated.pdf',rotated]] as [string,number[]][]) {
				const existing=app.vault.getFileByPath(path);
				if(existing) await app.vault.modifyBinary(existing,new Uint8Array(values).buffer);
				else await app.vault.createBinary(path,new Uint8Array(values).buffer);
			}
		},fixture('A'),fixture('Rotated'));
		await browser.waitUntil(async () => browser.executeObsidian(({app}) => !!app.metadataCache.getFirstLinkpathDest('A.pdf','Review.md')), { timeout: 10000 });
	});
	it('runs the selected-link command and saves a 100 by 50 PNG with source data', async () => {
		await obsidianPage.write('Review.md','[[A.pdf#page=1&rect=20,200,120,250]]');
		await obsidianPage.openFile('Review.md');
		await browser.waitUntil(async () => browser.executeObsidian(({app}) => app.workspace.activeEditor?.file?.path === 'Review.md'),{timeout:10000});
		await browser.executeObsidian(({app}) => {
			const e=app.workspace.activeEditor!.editor!; e.setSelection({line:0,ch:0},{line:0,ch:e.getLine(0).length});
		});
		await browser.executeObsidianCommand('pdf-crop-refresh:create-crop');
		await browser.waitUntil(async () => browser.executeObsidian(({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			return !p.busy && p.rows.length===1;
		}),{timeout:30000});
		const state=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			const row=p.rows[0]!; const file=app.vault.getFileByPath(row.image)!;
			const data=await app.vault.readBinary(file); const view=new DataView(data);
			const bitmap=await createImageBitmap(new Blob([data],{type:'image/png'}));
			const c=document.createElement('canvas'); c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d')!;ctx.drawImage(bitmap,0,0);bitmap.close();
			return {width:view.getUint32(16),height:view.getUint32(20),text:app.workspace.activeEditor!.editor!.getValue(),left:[...ctx.getImageData(10,10,1,1).data],right:[...ctx.getImageData(90,10,1,1).data],row};
		});
		expect(state.width).toBe(100);expect(state.height).toBe(50);expect(state.text).toContain(`![[${state.row.image}]]`);expect(state.text).toContain('PDF source page 1');
		expect(state.left).toEqual([255,0,0,255]);expect(state.right).toEqual([0,255,0,255]);
	});
	it('keeps registry data when settings change and the plugin reloads', async () => {
		const saved=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			await (p as any).settingTab.setControlValue('scale',2);
			return {image:p.rows[0]!.image,settings:p.settings};
		});
		expect((await reloadPlugin('pdf-crop-refresh')).reloaded).toBe(true);
		const loaded=await browser.executeObsidian(({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			return {image:p.rows[0]!.image,settings:p.settings};
		});
		expect(loaded).toEqual(saved);expect(loaded.settings.scale).toBe(2);
	});
	it('refreshes the same image after PDF content changes', async () => {
		const result=await browser.executeObsidian(async ({app}, updated) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			const row=p.rows[0]!;const path=row.image; const image=app.vault.getFileByPath(path)!;
			const before=[...new Uint8Array(await app.vault.readBinary(image))];
			await app.vault.modifyBinary(app.vault.getFileByPath('A.pdf')!,new Uint8Array(updated).buffer);
			const report=await p.refreshNote(app.vault.getFileByPath('Review.md')!,`![[${path}]]`);
			return {report,same:path===row.image,changed:JSON.stringify(before)!==JSON.stringify([...new Uint8Array(await app.vault.readBinary(image))])};
		},fixture('B'));
		expect(result.same).toBe(true);expect(result.changed).toBe(true);expect(result.report[0]!.status).toBe('Refreshed');
	});
	it('runs the active note refresh command', async () => {
		await browser.executeObsidian(({app}) => ((app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin).closeReport());
		await browser.executeObsidianCommand('pdf-crop-refresh:refresh-note');
		await browser.waitUntil(async () => browser.executeObsidian(({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			return !p.busy && [...document.querySelectorAll('.pdf-crop-card strong')].some(el=>el.textContent==='Refreshed');
		}),{timeout:30000});
	});
	it('refreshes the active note in reading mode', async () => {
		await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;p.closeReport();
			const text=`![[${p.rows[0]!.image}]]`;const file=app.vault.getFileByPath('Reading.md');
			if(file) await app.vault.modify(file,text);else await app.vault.create('Reading.md',text);
			await app.workspace.getLeaf(false).setViewState({type:'markdown',state:{file:'Reading.md',mode:'preview'}});
		});
		await browser.executeObsidianCommand('pdf-crop-refresh:refresh-note');
		await browser.waitUntil(async () => browser.executeObsidian(({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			return !p.busy && [...document.querySelectorAll('.pdf-crop-card strong')].some(el=>el.textContent==='Refreshed');
		}),{timeout:30000});
	});
	it('renders a 90 degree crop with the correct pixel orientation', async () => {
		const result=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			const row=await p.createCrop('[[Rotated.pdf#page=1&rect=20,200,120,250&scale=1]]','Review.md');
			const bitmap=await createImageBitmap(new Blob([await app.vault.readBinary(app.vault.getFileByPath(row.image)!)],{type:'image/png'}));
			const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d')!;ctx.drawImage(bitmap,0,0);bitmap.close();
			return {w:c.width,h:c.height,top:[...ctx.getImageData(10,10,1,1).data],bottom:[...ctx.getImageData(10,90,1,1).data]};
		});
		expect(result).toEqual({w:50,h:100,top:[255,0,0,255],bottom:[0,255,0,255]});
	});
	it('rejects invalid pages and NaN without saving PNG files', async () => {
		const state=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;const before=p.rows.length;const errors=[];
			for(const params of ['page=0&rect=20,200,120,250','page=2&rect=20,200,120,250','page=1&rect=20,NaN,120,250']) {
				try {await p.createCrop(`[[A.pdf#${params}]]`,'Review.md');}catch(e){errors.push(String(e));}
			}
			return {same:before===p.rows.length,errors};
		});
		expect(state.same).toBe(true);expect(state.errors.length).toBe(3);for(const error of state.errors)expect(error).toContain('Invalid source');
	});
	it('keeps bytes for missing and conflicting sources and skips ordinary PNGs', async () => {
		const state=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;const original=p.rows[0]!;
			const before=[...new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(original.image)!))];
			const path=original.path;original.path='Gone.pdf';const missing=await p.refreshRow(original);original.path=path;
			const dupe={...original,path:'Rotated.pdf'};p.rows.push(dupe);const conflict=await p.refreshRow(original);p.rows.pop();
			const png=app.vault.getFileByPath('ordinary.png');if(!png)await app.vault.createBinary('ordinary.png',new Uint8Array(before).buffer);
			const ordinary=await p.refreshNote(app.vault.getFileByPath('Review.md')!,'![[ordinary.png]]');
			return {missing:missing.status,conflict:conflict.status,ordinary:ordinary[0]!.status,same:JSON.stringify(before)===JSON.stringify([...new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(original.image)!))])};
		});
		expect(state).toEqual({missing:'Missing source',conflict:'Conflict: multiple sources use this image path',ordinary:'No saved source',same:true});
	});
	it('uses a sponsor check to enable folder refresh and the changed source report', async () => {
		const result=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;
			(p.pro as any).opts.http=async()=>({status:200,json:{data:{viewer:{login:'test-sponsor'},user:{sponsorshipForViewerAsSponsor:{isActive:true,isOneTimePayment:false,tier:{name:'Monthly',monthlyPriceInCents:500}}}}}});
			app.secretStorage.setSecret('pdf-crop-refresh-github-token','gho_'+'0'.repeat(36));
			try {
				await p.pro!.refreshNow();p.rows[0]!.sourceMtime=1;
				const changed=p.changedSources();
				const note=app.vault.getFileByPath('Batch.md');
				const text=`![[${p.rows[0]!.image}]]`;
				if(note) await app.vault.modify(note,text); else await app.vault.create('Batch.md',text);
				const folder=await p.refreshFolder('');
				return {pro:p.pro!.isPro(),changed:changed.some(r=>r.status.startsWith('Source changed')),refreshed:folder.some(r=>r.status==='Refreshed'),statuses:folder.map(r=>r.status)};
			} finally { p.pro!.signOut(); }
		});
		if (!result.refreshed) throw new Error(JSON.stringify(result));
		expect(result).toMatchObject({pro:true,changed:true,refreshed:true});
	});
	it('gates the Pro entry points while signed out', async () => {
		const state=await browser.executeObsidian(async ({app}) => {
			const p=(app as any).plugins.plugins['pdf-crop-refresh'] as PdfCropRefreshPlugin;p.pro!.signOut();let folder=false,report=false;
			try{await p.refreshFolder('');}catch{folder=true;}try{p.changedSources();}catch{report=true;}return {folder,report};
		});
		expect(state).toEqual({folder:true,report:true});
	});
});
