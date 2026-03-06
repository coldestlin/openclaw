import type { IncomingMessage, ServerResponse } from "node:http";

export type FeishuHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterFeishuHttpHandlerArgs = {
  path?: string | null;
  handler: FeishuHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

const feishuHttpRoutes = new Map<string, FeishuHttpRequestHandler>();

export function normalizeFeishuWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/feishu/events";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function registerFeishuHttpHandler(params: RegisterFeishuHttpHandlerArgs): () => void {
  const normalizedPath = normalizeFeishuWebhookPath(params.path);
  if (feishuHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`feishu: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  feishuHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    feishuHttpRoutes.delete(normalizedPath);
  };
}

export async function handleFeishuHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = feishuHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
