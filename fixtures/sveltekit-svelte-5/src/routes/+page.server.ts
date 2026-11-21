import { fail, redirect } from '@sveltejs/kit';
import { MAX_NAME_LENGTH, SESSION_COOKIE } from '#lib/session.ts';
import type { Actions } from './$types';

export const actions: Actions = {
	signin: async ({ request, cookies }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();

		if (!name) {
			return fail(400, { name, error: 'Enter a name to sign in.' });
		}
		if (name.length > MAX_NAME_LENGTH) {
			return fail(400, { name, error: `Use ${MAX_NAME_LENGTH} characters or fewer.` });
		}

		cookies.set(SESSION_COOKIE, name, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24
		});
		redirect(303, '/');
	},

	signout: async ({ cookies }) => {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/');
	}
};
