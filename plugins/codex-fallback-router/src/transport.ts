import http, {
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import https from "node:https";
import tls from "node:tls";

export interface UpstreamRequestOptions {
  target: URL;
  method: string;
  headers: OutgoingHttpHeaders;
  body?: Buffer;
  proxyUrl?: string;
  timeoutMs?: number;
}

function requestModule(target: URL): typeof http | typeof https {
  return target.protocol === "https:" ? https : http;
}

function connectTunnel(target: URL, proxyUrl: string, timeoutMs: number): Promise<tls.TLSSocket> {
  if (target.protocol !== "https:") {
    throw new Error("The configured upstream proxy supports HTTPS targets only.");
  }
  const proxy = new URL(proxyUrl);
  const targetPort = Number(target.port || 443);
  const authority = `${target.hostname}:${targetPort}`;
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port),
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Proxy CONNECT timed out.")));
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode ?? 502}.`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      const secureSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: true,
      });
      secureSocket.once("secureConnect", () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });
    request.end();
  });
}

export async function createUpstreamRequest(
  options: UpstreamRequestOptions,
  onResponse: (response: IncomingMessage) => void,
): Promise<ClientRequest> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!options.proxyUrl) {
    return requestModule(options.target).request(
      options.target,
      { method: options.method, headers: options.headers },
      onResponse,
    );
  }
  const socket = await connectTunnel(options.target, options.proxyUrl, timeoutMs);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_connectionOptions, callback) => {
    callback?.(null, socket);
    return socket;
  };
  const request = https.request(
    options.target,
    {
      method: options.method,
      headers: options.headers,
      agent,
    },
    onResponse,
  );
  request.once("close", () => agent.destroy());
  return request;
}

export function openUpstreamRequest(options: UpstreamRequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    void createUpstreamRequest(options, (response) => {
      // Response headers have arrived; a long SSE stream may idle far longer
      // than the connect timeout, so the socket timeout must not keep running.
      request?.setTimeout(0);
      resolve(response);
    }).then((created) => {
      request = created;
      // Persistent listener: reject is a no-op once the promise has settled,
      // and a second error must never surface as an uncaught exception.
      created.on("error", reject);
      created.setTimeout(options.timeoutMs ?? 120_000, () => {
        created.destroy(new Error("Upstream request timed out."));
      });
      created.end(options.body);
    }, reject);
  });
}
