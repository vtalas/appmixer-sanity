<script>
	import { signIn } from '@auth/sveltekit/client';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';

	const error = $derived($page.url.searchParams.get('error'));
</script>

<div class="flex min-h-[calc(100vh-200px)] items-center justify-center">
	<Card class="w-full max-w-md">
		<CardHeader class="text-center">
			<CardTitle class="text-2xl">Appmixer Sanity Check</CardTitle>
			<CardDescription>Sign in with your @appmixer.ai account to continue</CardDescription>
		</CardHeader>
		<CardContent class="space-y-4">
			{#if error === 'AccessDenied'}
				<div class="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
					Access denied. Only @appmixer.ai accounts are allowed.
				</div>
			{:else if error}
				<div class="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
					An error occurred during sign in. Please try again.
				</div>
			{/if}
			<Button class="w-full" onclick={() => signIn('google')}>
				Sign in with Google
			</Button>
		</CardContent>
	</Card>
</div>
