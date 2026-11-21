import type { PageServerLoad } from './$types';

const DELAY_MS = 800;

/**
 * `slow` is returned without awaiting it, so SvelteKit sends the page shell
 * first and streams the resolved value in a later chunk of the same response.
 */
export const load: PageServerLoad = () => {
	return {
		delayMs: DELAY_MS,
		slow: new Promise<string>((resolve) => {
			setTimeout(() => resolve('streamed value arrived'), DELAY_MS);
		})
	};
};
