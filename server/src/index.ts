import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { findMatchingRoute } from './matcher.js';
import { HttpError, methodFromRequest, readJson, sendJson, sendText } from './http.js';
import { MockStore, normalizePath } from './store.js';
import type { HttpMethod, MockRouteInput, ReplayRequest } from './types.js';

const port = Number(process.env.PORT || 4000);
const store = new MockStore();
const allowedMethods = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : '服务器内部错误';
    sendJson(response, statusCode, { error: message });
  }
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  applyCors(response);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/mocks' && request.method === 'GET') {
    sendJson(response, 200, { data: store.list() });
    return;
  }

  if (url.pathname === '/api/mocks' && request.method === 'POST') {
    const input = validateRouteInput(await readJson<MockRouteInput>(request));
    sendJson(response, 201, { data: store.create(input) });
    return;
  }

  const mockIdMatch = url.pathname.match(/^\/api\/mocks\/([^/]+)$/);
  if (mockIdMatch && request.method === 'GET') {
    const route = store.get(decodeURIComponent(mockIdMatch[1]));
    if (!route) throw new HttpError(404, 'Mock 路由不存在');
    sendJson(response, 200, { data: route });
    return;
  }
  if (mockIdMatch && request.method === 'PUT') {
    const input = validateRouteInput(await readJson<MockRouteInput>(request));
    const route = store.update(decodeURIComponent(mockIdMatch[1]), input);
    if (!route) throw new HttpError(404, 'Mock 路由不存在');
    sendJson(response, 200, { data: route });
    return;
  }
  if (mockIdMatch && request.method === 'DELETE') {
    const deleted = store.delete(decodeURIComponent(mockIdMatch[1]));
    if (!deleted) throw new HttpError(404, 'Mock 路由不存在');
    response.statusCode = 204;
    response.end();
    return;
  }

  if (url.pathname === '/api/recordings' && request.method === 'POST') {
    const input = await readJson<RecordingInput>(request);
    const normalizedRecording = normalizeRecordingInput(input);
    sendJson(response, 201, { data: store.record(normalizedRecording) });
    return;
  }

  if (url.pathname === '/api/replay' && request.method === 'POST') {
    const replayRequest = await readJson<ReplayRequest>(request);
    const method = normalizeMethod(replayRequest.method);
    const route = findMatchingRoute(store.list(), method, replayRequest.path || '/');
    if (!route) {
      sendJson(response, 404, {
        matched: false,
        request: replayRequest,
        response: { statusCode: 404, headers: {}, body: '没有找到匹配的 Mock 路由' }
      });
      return;
    }
    sendJson(response, 200, {
      matched: true,
      route,
      request: replayRequest,
      response: buildMockResponse(route)
    });
    return;
  }

  if (url.pathname === '/api/mocks' || url.pathname.startsWith('/api/')) {
    throw new HttpError(404, 'API 路径不存在');
  }

  if (url.pathname.startsWith('/mock')) {
    const mockPath = url.pathname.slice('/mock'.length) || '/';
    const method = normalizeMethod(methodFromRequest(request));
    const route = findMatchingRoute(store.list(), method, mockPath);
    if (!route) {
      sendJson(response, 404, { error: `没有找到 ${method} ${mockPath} 的 Mock 路由` });
      return;
    }
    const mockResponse = buildMockResponse(route);
    sendText(response, mockResponse.statusCode, mockResponse.body, mockResponse.headers);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

function normalizeMethod(method: unknown): HttpMethod {
  const normalized = String(method || 'GET').toUpperCase() as HttpMethod;
  if (!allowedMethods.has(normalized)) throw new HttpError(400, `不支持的 HTTP 方法: ${String(method)}`);
  return normalized;
}

function normalizeStatusCode(value: unknown): number {
  const statusCode = Number(value);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new HttpError(400, 'statusCode 必须是 100-599 的整数');
  }
  return statusCode;
}

function validateRouteInput(input: MockRouteInput): MockRouteInput {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw new HttpError(400, 'name 不能为空');
  const method = normalizeMethod(input.method);
  const path = normalizePath(input.path);
  if (!path.startsWith('/')) throw new HttpError(400, 'path 必须以 / 开头');
  return {
    ...input,
    name,
    method,
    path,
    statusCode: normalizeStatusCode(input.statusCode),
    responseHeaders: input.responseHeaders || {},
    responseBody: input.responseBody || '',
    description: input.description || ''
  };
}

type RecordingInput = {
  name?: string;
  request?: { method?: string; path?: string };
  response?: { statusCode?: number | string; headers?: Record<string, string>; body?: string };
};

type NormalizedRecording = {
  name?: string;
  request: { method: HttpMethod; path: string };
  response: { statusCode: number; headers: Record<string, string>; body: string };
};

// 录制与创建/更新共用同一套规范化规则（normalizeMethod / normalizePath /
// normalizeStatusCode），保证录制生成的路由与页面创建的一致，且可以被回放。
// 所有校验都在写入 store 之前完成，非法录制返回 400，不会留下脏数据。
function normalizeRecordingInput(input: RecordingInput): NormalizedRecording {
  if (!input?.request || !input?.response) {
    throw new HttpError(400, '录制请求必须包含 request 和 response');
  }
  const rawPath = input.request.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new HttpError(400, '录制请求的 path 不能为空');
  }
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined,
    request: {
      method: normalizeMethod(input.request.method),
      path: normalizePath(rawPath)
    },
    response: {
      statusCode: normalizeStatusCode(input.response.statusCode),
      headers: input.response.headers || {},
      body: input.response.body || ''
    }
  };
}

function buildMockResponse(route: { statusCode: number; responseHeaders: Record<string, string>; responseBody: string }) {
  return {
    statusCode: route.statusCode,
    headers: route.responseHeaders,
    body: route.responseBody
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

function applyCors(response: ServerResponse): void {
  for (const [key, value] of Object.entries(corsHeaders())) response.setHeader(key, value);
}

server.listen(port, () => {
  console.log(`API Mock server listening on http://localhost:${port}`);
});

export { server, store, handleRequest };
