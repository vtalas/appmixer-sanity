import { redirect } from '@sveltejs/kit';

export async function load({ locals }) {
	const session = await locals.auth();

	// Redirect authenticated users to home
	if (session) {
		throw redirect(303, '/');
	}

	return {};
}
