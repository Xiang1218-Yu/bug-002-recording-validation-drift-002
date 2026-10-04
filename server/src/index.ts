import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { findMatchingRoute } from './matcher.js';
import { HttpError, methodFromRequest, readJson, sendJson, sendText } from './http.js';
import { MockStore } from './store.js';
import {
  normalizeHttpMethod,
  normalizeRecordingInput,
  normalizeReplayRequest,
  normalizeRouteInput
} from './validation.js';

const port = Number(process.env.PORT || 4000);
const store = new MockStore();

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
    const input = normalizeRouteInput(await readJson(request));
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
    const input = normalizeRouteInput(await readJson(request));
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
    const input = normalizeRecordingInput(await readJson(request));
    sendJson(response, 201, { data: store.record(input) });
    return;
  }

  if (url.pathname === '/api/replay' && request.method === 'POST') {
    const replayRequest = normalizeReplayRequest(await readJson(request));
    const route = findMatchingRoute(store.list(), replayRequest.method, replayRequest.path);
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
    const method = normalizeHttpMethod(methodFromRequest(request));
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

if (process.env.API_MOCK_SERVER_LISTEN !== '0') {
  server.listen(port, () => {
    console.log(`API Mock server listening on http://localhost:${port}`);
  });
}

export { server, store, handleRequest };
