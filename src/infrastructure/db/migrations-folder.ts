/**
 * Directory of committed Drizzle SQL migrations (AGENTS.md §9).
 *
 * The integration helper and the migrate entry point both import this.
 * Keep the module free of database and `.env` access. Importing the entry
 * point used to call `main()` and migrate whatever `DATABASE_URL` resolved to,
 * including when the integration suite was skipped.
 */
export const MIGRATIONS_FOLDER = 'drizzle';
