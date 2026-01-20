import { SvelteKitAuth } from '@auth/sveltekit';
import Google from '@auth/sveltekit/providers/google';
import { env } from '$env/dynamic/private';

export const { handle, signIn, signOut } = SvelteKitAuth(async (event) => {
	return {
		providers: [
			Google({
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET
			})
		],
		secret: env.AUTH_SECRET,
		trustHost: true,
		callbacks: {
			async signIn({ user, account, profile }) {
				// Only allow @appmixer.ai domain
				const email = user.email || profile?.email;
				if (!email || !email.endsWith('@appmixer.ai')) {
					return false;
				}
				return true;
			},
			async session({ session, token }) {
				// Include email in session
				if (session.user && token.email) {
					session.user.email = token.email;
				}
				return session;
			},
			async jwt({ token, user }) {
				if (user) {
					token.email = user.email;
				}
				return token;
			}
		}
	};
});
