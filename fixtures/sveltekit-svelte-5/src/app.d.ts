declare global {
	namespace App {
		interface Locals {
			/** Name stored in the session cookie, or null when signed out. */
			user: string | null;
		}
	}
}

export {};
