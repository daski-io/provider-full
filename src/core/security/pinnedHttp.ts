import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface PinnedHttpRequestArgs {
  url: URL;
  pinnedIp: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  timeoutMs: number;
  maxResponseBytes: number;
  /** The caller's cancellation; it bounds the whole exchange with the timeout. */
  signal?: AbortSignal;
}

export interface PinnedHttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  body: Buffer;
}

async function bodyBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new Error("pinned outbound requests do not support streaming or multipart bodies");
}

/** Dial a pre-validated IP while retaining the original host for SNI and Host. */
export async function pinnedHttpRequest(
  args: PinnedHttpRequestArgs,
): Promise<PinnedHttpResponse> {
  const body = await bodyBuffer(args.body);
  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(new Error("pinned outbound request was aborted before it started"));
      return;
    }
    const isHttps = args.url.protocol === "https:";
    const detectedFamily = isIP(args.pinnedIp);
    if (detectedFamily === 0) {
      reject(new Error("pinned outbound address is not an IP literal"));
      return;
    }
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        callback(null, [{ address: args.pinnedIp, family: detectedFamily }]);
      } else {
        callback(null, args.pinnedIp, detectedFamily);
      }
    };
    const headers = new Headers(args.headers);
    if (body && !headers.has("content-length")) {
      headers.set("content-length", String(body.byteLength));
    }
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });
    const options: https.RequestOptions = {
      protocol: args.url.protocol,
      hostname: args.url.hostname,
      port: args.url.port || (isHttps ? 443 : 80),
      path: `${args.url.pathname}${args.url.search}`,
      method: args.method ?? "GET",
      headers: requestHeaders,
      lookup: pinnedLookup,
    };
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const onAbort = () => request.destroy(new Error("pinned outbound request was aborted"));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      args.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onResponse = (response: http.IncomingMessage) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        finish(() => reject(new Error("outbound redirects are not allowed")));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > args.maxResponseBytes) {
          response.destroy(new Error(`outbound response exceeds ${args.maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(() => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          headers: responseHeaders,
          body: Buffer.concat(chunks, size),
        });
      }));
      response.on("error", (error) => finish(() => reject(error)));
    };
    const request = isHttps
      ? https.request(options, onResponse)
      : http.request(options, onResponse);
    deadline = setTimeout(() => {
      request.destroy(new Error(`outbound request timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);
    deadline.unref();
    // Destroying the request also ends a response whose body is still
    // streaming, so the abort reaches the body read.
    args.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => finish(() => reject(error)));
    if (body) request.write(body);
    request.end();
  });
}
