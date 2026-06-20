import { loadConfig } from "../src/config.js";
import { createWebSearchTool, type WebSearchDetails } from "../src/web-search.js";

const config = loadConfig();
const tool = createWebSearchTool(config);
const params =
  tool.prepareArguments?.({
    q: "Brave Search API LLM Context endpoint",
    max_urls: 3,
    max_snippets: 6,
    max_tokens: 2048
  }) ?? {};
const result = await tool.execute("smoke-web-search", params, AbortSignal.timeout(15_000), undefined, undefined as never);
const details = result.details as WebSearchDetails | undefined;

if (!details || details.sources.length === 0) {
  throw new Error("Brave web_search smoke returned no sources");
}

const firstSource = details.sources[0];
if (!firstSource.url.startsWith("http")) {
  throw new Error(`Brave web_search smoke returned an invalid first URL: ${firstSource.url}`);
}

console.log(`brave web_search smoke ok: ${details.sources.length} sources`);
console.log(`first source: ${firstSource.url}`);
