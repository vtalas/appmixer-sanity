import { initializeDatabase } from '$lib/db/index.js';

// Initialize database schema on server startup
await initializeDatabase();
