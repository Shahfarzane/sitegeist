import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { Globe } from "lucide";

function favicon(url: string | undefined): TemplateResult {
	if (!url) return icon(Globe, "md", "shrink-0");
	return keyed(
		url,
		html`<img
			src=${url}
			alt=""
			class="size-5 shrink-0 rounded-sm"
			@error=${(e: Event) => {
				(e.target as HTMLImageElement).style.visibility = "hidden";
			}}
		/>`,
	) as TemplateResult;
}

/** The tab the agent works on, above the composer. The row keeps its height when empty, so the composer never moves. */
export function ContextTab(tab: chrome.tabs.Tab | undefined): TemplateResult {
	const label = tab?.title || tab?.url;
	return html`<div class="flex items-center gap-2 h-8 mb-2 px-4 text-[13px] leading-4 text-muted-foreground" title=${tab?.url ?? ""}>
		${label ? html`${favicon(tab?.favIconUrl)}<span class="truncate">${label}</span>` : ""}
	</div>`;
}
