import { expect } from '@wdio/globals';
import { pluginId, reloadPlugin } from './load';
describe(`${pluginId} smoke test`, function () {
	it('loads and reloads without errors', async () => expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] }));
});
