import { initializeDatabase } from '$lib/db/index.js';
import { handle as authHandle } from './auth.js';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

// Initialize database schema on server startup
await initializeDatabase();

// Protection handle - redirect unauthenticated users to login
async function protectionHandle({ event, resolve }) {
	const session = await event.locals.auth();

	// Allow access to login page, auth routes, and static assets
	// /public/* pages are customer-facing reports — they must whitelist what they show
	// Whole path segments: a bare prefix match on '/auth' also let '/authub' through
	const unprotectedPaths = ['/login', '/auth', '/api/public', '/public'];
	const { pathname } = event.url;
	const isUnprotected = unprotectedPaths.some(
		(path) => pathname === path || pathname.startsWith(`${path}/`)
	);

	if (!session && !isUnprotected) {
		throw redirect(303, '/login');
	}

	return resolve(event);
}

export const handle = sequence(authHandle, protectionHandle);
