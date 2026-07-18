import type { FetchResponse, PromptFetcher } from "../lifecycle-contract.ts";
import { PromptLayerError } from "../lifecycle-contract.ts";
import { errorMessage } from "../repository-boundary.ts";

const RAW_ORIGIN = "https://raw.githubusercontent.com/openai/codex";

export async function fetchOfficial(
  fetcher: PromptFetcher,
  commit: string,
  path: string,
): Promise<Buffer> {
  const url = `${RAW_ORIGIN}/${commit}/${path}`;
  let response: FetchResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new PromptLayerError(
      `Failed to fetch ${path}: ${errorMessage(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new PromptLayerError(
      `Failed to fetch ${path}: HTTP ${response.status}.`,
    );
  }
  const body = Buffer.from(response.body);
  if (body.byteLength === 0) {
    throw new PromptLayerError(`Failed to fetch ${path}: empty response.`);
  }
  return body;
}

export async function networkFetcher(url: string): Promise<FetchResponse> {
  const response = await fetch(url, { redirect: "error" });
  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}
