import type { RequestHandler } from './$types';

/** Reports the signed-in state as JSON, so a test can check that the cookie survives a proxy. */
export const GET: RequestHandler = ({ locals }) => {
	return Response.json({ user: locals.user }, { headers: { 'cache-control': 'no-store' } });
};
