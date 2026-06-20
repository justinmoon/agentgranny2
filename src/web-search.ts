import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppConfig } from "./config.js";

const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const DEFAULT_MAX_URLS = 5;
const DEFAULT_MAX_SNIPPETS = 20;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_SNIPPET_CHARS = 1_500;

const searchSchema = Type.Object({
  query: Type.String({
    description: "Search query. Keep it focused; Brave accepts up to 400 characters and 50 words."
  }),
  country: Type.Optional(
    Type.String({
      description: "Optional 2-letter country code for result locality, for example US, GB, or DE."
    })
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "Optional result language code, for example en, es, fr, or de."
    })
  ),
  freshness: Type.Optional(
    Type.String({
      description: "Optional freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD."
    })
  ),
  max_urls: Type.Optional(
    Type.Number({
      description: "Maximum distinct source URLs to return. Default 5, maximum 10."
    })
  ),
  max_snippets: Type.Optional(
    Type.Number({
      description: "Maximum snippets/chunks to return across sources. Default 20, maximum 40."
    })
  ),
  max_tokens: Type.Optional(
    Type.Number({
      description: "Approximate maximum Brave context tokens. Default 4096, maximum 12000."
    })
  )
});

export type WebSearchParams = {
  query: string;
  country?: string;
  search_lang?: string;
  freshness?: string;
  max_urls?: number;
  max_snippets?: number;
  max_tokens?: number;
};

export type WebSearchSource = {
  title: string;
  url: string;
  hostname?: string;
  age?: string[];
  snippets: string[];
};

export type WebSearchDetails = {
  provider: "brave";
  endpoint: "llm_context";
  query: string;
  sources: WebSearchSource[];
};

type BraveSourceMetadata = {
  title?: unknown;
  hostname?: unknown;
  age?: unknown;
  snippet?: unknown;
};

type BraveGenericGrounding = {
  url?: unknown;
  title?: unknown;
  snippets?: unknown;
};

type BraveLlmContextResponse = {
  grounding?: {
    generic?: unknown;
  };
  sources?: unknown;
  error?: unknown;
  type?: unknown;
};

type WebSearchConfig = Pick<AppConfig, "braveApiKey">;

export function createWebSearchTool(config: WebSearchConfig): ToolDefinition {
  const definition: ToolDefinition<typeof searchSchema, WebSearchDetails> = {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web with Brave LLM Context and return source-grounded, current context snippets with URLs.",
    promptSnippet: "Search the web for current source-grounded information",
    promptGuidelines: [
      "Use web_search when the user asks for current, recent, or externally verifiable information.",
      "When using web_search results, cite the source URLs in the final answer."
    ],
    parameters: searchSchema,
    executionMode: "parallel",
    prepareArguments(args) {
      return normalizeSearchArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      return executeBraveWebSearch(config, params, signal, onUpdate);
    }
  };
  return definition as unknown as ToolDefinition;
}

export async function executeBraveWebSearch(
  config: WebSearchConfig,
  params: WebSearchParams,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<WebSearchDetails>
): Promise<{ content: [{ type: "text"; text: string }]; details: WebSearchDetails }> {
  const apiKey = config.braveApiKey?.trim();
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY is not configured");
  }

  const query = params.query.trim();
  if (!query) {
    throw new Error("web_search query is required");
  }

  const maxUrls = clampInteger(params.max_urls ?? DEFAULT_MAX_URLS, 1, 10);
  const url = new URL(BRAVE_LLM_CONTEXT_URL);
  url.searchParams.set("q", query.slice(0, 400));
  url.searchParams.set("count", String(clampInteger(maxUrls * 4, 1, 50)));
  url.searchParams.set("maximum_number_of_urls", String(maxUrls));
  url.searchParams.set(
    "maximum_number_of_snippets",
    String(clampInteger(params.max_snippets ?? DEFAULT_MAX_SNIPPETS, 1, 40))
  );
  url.searchParams.set(
    "maximum_number_of_tokens",
    String(clampInteger(params.max_tokens ?? DEFAULT_MAX_TOKENS, 1024, 12_000))
  );
  url.searchParams.set("maximum_number_of_tokens_per_url", "2048");
  url.searchParams.set("enable_source_metadata", "true");

  if (params.country) url.searchParams.set("country", params.country.trim().toUpperCase());
  if (params.search_lang) url.searchParams.set("search_lang", params.search_lang.trim().toLowerCase());
  if (params.freshness) url.searchParams.set("freshness", params.freshness.trim());

  onUpdate?.({
    content: [{ type: "text", text: `Searching Brave for: ${query}` }],
    details: {
      provider: "brave",
      endpoint: "llm_context",
      query,
      sources: []
    }
  });

  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey
    }
  });

  const bodyText = await response.text();
  const body = parseJson(bodyText);
  if (!response.ok) {
    throw new Error(`Brave search failed (${response.status}): ${formatBraveError(body, bodyText)}`);
  }

  const sources = extractSources(body);
  const details: WebSearchDetails = {
    provider: "brave",
    endpoint: "llm_context",
    query,
    sources
  };

  return {
    content: [{ type: "text", text: formatSearchResult(query, sources) }],
    details
  };
}

function normalizeSearchArgs(args: unknown): WebSearchParams {
  const input = isRecord(args) ? args : {};
  const query = stringValue(input.query ?? input.q);
  return {
    query,
    country: optionalString(input.country),
    search_lang: optionalString(input.search_lang ?? input.searchLang ?? input.language),
    freshness: optionalString(input.freshness),
    max_urls: optionalNumber(input.max_urls ?? input.maxUrls ?? input.count),
    max_snippets: optionalNumber(input.max_snippets ?? input.maxSnippets),
    max_tokens: optionalNumber(input.max_tokens ?? input.maxTokens)
  };
}

function extractSources(body: unknown): WebSearchSource[] {
  if (!isRecord(body)) return [];
  const response = body as BraveLlmContextResponse;
  const sourceMetadata = isRecord(response.sources) ? response.sources : {};
  const grounding = isRecord(response.grounding) ? response.grounding : {};
  const generic = Array.isArray(grounding.generic) ? grounding.generic : [];

  const sources: WebSearchSource[] = [];
  for (const item of generic) {
    if (!isRecord(item)) continue;
    const entry = item as BraveGenericGrounding;
    const url = stringValue(entry.url);
    if (!url) continue;

    const metadata = isRecord(sourceMetadata[url]) ? (sourceMetadata[url] as BraveSourceMetadata) : undefined;
    const title = stringValue(entry.title) || stringValue(metadata?.title) || url;
    const snippets = Array.isArray(entry.snippets)
      ? entry.snippets.map((snippet) => cleanSnippet(stringValue(snippet))).filter(Boolean)
      : [];
    const fallbackSnippet = cleanSnippet(stringValue(metadata?.snippet));
    if (snippets.length === 0 && fallbackSnippet) snippets.push(fallbackSnippet);

    sources.push({
      title,
      url,
      hostname: optionalString(metadata?.hostname),
      age: arrayOfStrings(metadata?.age),
      snippets
    });
  }

  return sources;
}

function formatSearchResult(query: string, sources: WebSearchSource[]): string {
  if (sources.length === 0) {
    return `No web_search results for: ${query}`;
  }

  const lines = [`web_search results for: ${query}`, ""];
  for (const [index, source] of sources.entries()) {
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.hostname) lines.push(`Host: ${source.hostname}`);
    if (source.age?.length) lines.push(`Date: ${source.age.join(" | ")}`);
    for (const snippet of source.snippets) {
      lines.push(`- ${truncate(snippet, MAX_SNIPPET_CHARS)}`);
    }
    lines.push("");
  }

  return truncate(lines.join("\n").trimEnd(), MAX_OUTPUT_CHARS);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function formatBraveError(body: unknown, bodyText: string): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error)) {
      const message = stringValue(error.message ?? error.detail ?? error.code);
      if (message) return message;
    }
    const message = stringValue(body.message ?? body.type);
    if (message) return message;
  }
  return truncate(bodyText.trim() || "unknown error", 1000);
}

function cleanSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}... [truncated]` : value;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map((item) => stringValue(item)).filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
