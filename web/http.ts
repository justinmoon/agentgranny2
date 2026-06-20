export function readError(error: unknown): string {
  return cleanErrorText(error instanceof Error ? error.message : String(error));
}

export async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 120)}`);
  }
}

export async function readResponseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: unknown };
    if (payload.error) return cleanErrorText(String(payload.error));
  } catch {
    // Non-JSON responses still get surfaced below.
  }
  return cleanErrorText(text);
}

function cleanErrorText(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}
