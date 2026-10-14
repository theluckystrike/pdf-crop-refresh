import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCrop } from '../src/render';
import { loadPdfJs } from 'obsidian';
import type { CropSource } from '../src/crop';
vi.mock('obsidian',async importOriginal => ({ ...await importOriginal<object>(), loadPdfJs: vi.fn() }));
const source: CropSource={path:'A.pdf',page:1,rect:[20,200,120,250],scale:1};
let destroy: ReturnType<typeof vi.fn>;
let render: ReturnType<typeof vi.fn>;
let getPage: ReturnType<typeof vi.fn>;
beforeEach(()=>{
	destroy=vi.fn().mockResolvedValue(undefined);render=vi.fn().mockReturnValue({promise:Promise.resolve()});
	getPage=vi.fn().mockResolvedValue({view:[0,0,300,300],getViewport:()=>({width:300,height:300,convertToViewportPoint:(x:number,y:number)=>[x,300-y]}),render});
	vi.mocked(loadPdfJs).mockResolvedValue({getDocument:()=>({promise:Promise.resolve({numPages:1,getPage,destroy})})});
	vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({} as never);
	vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb(new Blob([new Uint8Array([1,2,3])],{type:'image/png'})));
});
afterEach(()=>vi.restoreAllMocks());
const app={vault:{readBinary:async()=>new ArrayBuffer(0)}};
describe('PDF renderer',()=>{
	it('uses a cropped canvas and a translated PDF viewport',async()=>{
		const result=await renderCrop(app as never,{} as never,source);
		expect(result.bounds).toEqual({x:20,y:50,width:100,height:50});expect(render).toHaveBeenCalledWith(expect.objectContaining({transform:[1,0,0,1,-20,-50]}));expect(destroy).toHaveBeenCalledOnce();
	});
	it('rejects a page beyond the document and releases the document',async()=>{
		await expect(renderCrop(app as never,{} as never,{...source,page:2})).rejects.toThrow('Invalid source');expect(getPage).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce();
	});
	it('rejects an out of page rectangle without rendering',async()=>{
		await expect(renderCrop(app as never,{} as never,{...source,rect:[20,200,301,250]})).rejects.toThrow('outside');expect(render).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce();
	});
	it('releases the document after a render failure',async()=>{
		render.mockReturnValue({promise:Promise.reject(new Error('PDF render failed'))});await expect(renderCrop(app as never,{} as never,source)).rejects.toThrow('PDF render failed');expect(destroy).toHaveBeenCalledOnce();
	});
});
