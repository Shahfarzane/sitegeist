import { Store, type StoreConfig } from "@mariozechner/pi-web-ui";
import { matchesAnyPattern } from "../skill-match.js";

export interface Skill {
	name: string;
	domainPatterns: string[];
	shortDescription: string;
	description: string;
	createdAt: string;
	lastUpdated: string;
	examples: string;
	library: string;
}

/**
 * Store for managing site skills.
 */
export class SkillsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "skills",
		};
	}

	async get(name: string): Promise<Skill | null> {
		return this.getBackend().get("skills", name);
	}

	async save(skill: Skill): Promise<void> {
		await this.getBackend().set("skills", skill.name, skill);
	}

	async delete(name: string): Promise<void> {
		await this.getBackend().delete("skills", name);
	}

	async list(currentUrl?: string): Promise<Skill[]> {
		const keys = await this.getBackend().keys("skills");
		const skills = await Promise.all(keys.map((key) => this.getBackend().get<Skill>("skills", key)));
		const validSkills = skills.filter((s): s is Skill => s !== null);

		if (currentUrl) {
			return validSkills.filter((skill) => this.matchesAnyPattern(currentUrl, skill.domainPatterns));
		}

		return validSkills;
	}

	async getForUrl(url: string): Promise<Skill[]> {
		return this.list(url);
	}

	// Alias methods for backward compatibility
	async getSkillsForUrl(url: string): Promise<Skill[]> {
		return this.getForUrl(url);
	}

	async getSkill(name: string): Promise<Skill | null> {
		return this.get(name);
	}

	async saveSkill(skill: Skill): Promise<void> {
		return this.save(skill);
	}

	async deleteSkill(name: string): Promise<void> {
		return this.delete(name);
	}

	async listSkills(currentUrl?: string): Promise<Skill[]> {
		return this.list(currentUrl);
	}

	matchesAnyPattern(url: string, patterns: string[]): boolean {
		return matchesAnyPattern(url, patterns);
	}
}
