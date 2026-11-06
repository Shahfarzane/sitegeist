import { Store, type StoreConfig } from "@mariozechner/pi-web-ui";

/** A reusable prompt, offered in the `/` menu of the composer. */
export interface SavedPrompt {
	name: string;
	text: string;
	createdAt: string;
}

export class PromptsStore extends Store {
	getConfig(): StoreConfig {
		return { name: "prompts" };
	}

	async list(): Promise<SavedPrompt[]> {
		const keys = await this.getBackend().keys("prompts");
		const prompts = await Promise.all(keys.map((key) => this.getBackend().get<SavedPrompt>("prompts", key)));
		return prompts.filter((p): p is SavedPrompt => p !== null).sort((a, b) => a.name.localeCompare(b.name));
	}

	async save(prompt: SavedPrompt): Promise<void> {
		await this.getBackend().set("prompts", prompt.name, prompt);
	}

	async delete(name: string): Promise<void> {
		await this.getBackend().delete("prompts", name);
	}
}
