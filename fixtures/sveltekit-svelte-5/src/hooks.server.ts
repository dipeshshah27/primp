import type { Handle } from '@sveltejs/kit/hooks';
import { SESSION_COOKIE } from '#lib/session.ts';

const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * SvelteKit rejects form submissions whose Origin header differs from the
 * origin it derives from the request (in dev: "http://" + the Host header).
 * SvelteKit 3 skips that check under `vite dev` (it is wrapped in
 * `if (!__SVELTEKIT_DEV__)`), so this fixture applies the same rule itself.
 * A proxy in front of the dev server then has to keep Host and Origin
 * consistent, exactly as it would in front of a production build.
 */
function isCrossSiteFormRequest(request: Request, selfOrigin: string): boolean {
	if (!MUTATING_METHODS.has(request.method)) return false;
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	const isForm = !contentType || FORM_CONTENT_TYPES.includes(contentType);
	return isForm && request.headers.get('origin') !== selfOrigin;
}

export const handle: Handle = async ({ event, resolve }) => {
	const { request } = event;

	if (isCrossSiteFormRequest(request, event.url.origin)) {
		// Same status and message as SvelteKit's own check; the extra header says who rejected it.
		const message = `Cross-site ${request.method} form submissions are forbidden`;
		const init = { status: 403, headers: { 'x-fixture-origin-check': 'rejected' } };
		return request.headers.get('accept') === 'application/json'
			? Response.json({ message }, init)
			: new Response(message, init);
	}

	event.locals.user = event.cookies.get(SESSION_COOKIE) || null;
	return resolve(event);
};
