/**
 * Reads a store of the app database from the service worker, where the app storage classes
 * cannot load: they pull in the UI. The connection stays open only for the read, so it never
 * holds up a panel that upgrades the database.
 */

const DATABASE = "sitegeist-storage";

export function readStore<T>(store: string): Promise<T[]> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(DATABASE);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			if (!db.objectStoreNames.contains(store)) {
				db.close();
				resolve([]);
				return;
			}
			const request = db.transaction(store).objectStore(store).getAll();
			request.onerror = () => {
				db.close();
				reject(request.error);
			};
			request.onsuccess = () => {
				db.close();
				resolve(request.result as T[]);
			};
		};
	});
}
