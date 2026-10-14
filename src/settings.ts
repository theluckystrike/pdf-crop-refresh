import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import type PdfCropRefreshPlugin from './main';
import { safePath } from './crop';
export interface PdfCropRefreshSettings { scale: number; folder: string }
export const DEFAULT_SETTINGS: PdfCropRefreshSettings = { scale: 1, folder: 'PDF crops' };
export function normalizeSettings(saved: Partial<PdfCropRefreshSettings> | null | undefined): PdfCropRefreshSettings {
	const s = saved ?? {};
	return {
		scale: typeof s.scale === 'number' && Number.isFinite(s.scale) && s.scale >= 0.25 && s.scale <= 4 ? s.scale : 1,
		folder: typeof s.folder === 'string' && safePath(s.folder) ? s.folder : DEFAULT_SETTINGS.folder,
	};
}
export class PdfCropRefreshSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], public plugin: PdfCropRefreshPlugin) { super(app, plugin); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'PNG folder', desc: 'Vault folder for new crops. Existing crops keep their paths.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } },
			{ name: 'Render scale', desc: 'Pixels per PDF point, from 0.25 to 4. A scale in the link takes priority.', control: { type: 'slider', key: 'scale', defaultValue: 1, min: 0.25, max: 4, step: 0.25 } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'folder' && (typeof value !== 'string' || !safePath(value.trim()))) return;
		if (key === 'folder' && typeof value === 'string') value = value.trim();
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
		await this.plugin.saveSettings();
	}
}
