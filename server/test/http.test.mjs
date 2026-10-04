import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

// 使用随机端口，避免与本地开发服务器冲突。
process.env.PORT = '0';
const { server, store } = await import('../dist/index.js');

if (!server.listening) await once(server, 'listening');
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function requestJson(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : undefined };
}

test('recording normalizes method, path and statusCode like manual creation', async () => {
  const recorded = await requestJson('POST', '/api/recordings', {
    name: '录制的订单',
    request: { method: 'post', path: 'orders?source=recording', body: '{"sku":"demo"}' },
    response: { statusCode: '201', headers: { 'content-type': 'application/json' }, body: '{"id":"order-1"}' }
  });
  assert.equal(recorded.status, 201);
  assert.equal(recorded.payload.data.method, 'POST');
  assert.equal(recorded.payload.data.path, '/orders');
  assert.equal(recorded.payload.data.statusCode, 201);

  // 同样的数据经手动创建入口进入，规范化结果必须一致。
  const manual = await requestJson('POST', '/api/mocks', {
    name: '手动订单',
    method: 'POST',
    path: '/orders',
    statusCode: 201
  });
  assert.equal(manual.status, 201);
  assert.equal(manual.payload.data.method, recorded.payload.data.method);
  assert.equal(manual.payload.data.path, recorded.payload.data.path);
  assert.equal(manual.payload.data.statusCode, recorded.payload.data.statusCode);
});

test('recording without a name derives it from the normalized request', async () => {
  const recorded = await requestJson('POST', '/api/recordings', {
    request: { method: 'post', path: 'unnamed-orders' },
    response: { statusCode: 200 }
  });
  assert.equal(recorded.status, 201);
  assert.equal(recorded.payload.data.name, '录制 POST /unnamed-orders');
});

test('recorded route is reachable via /api/replay and /mock/...', async () => {
  const recorded = await requestJson('POST', '/api/recordings', {
    request: { method: 'post', path: 'replay-me' },
    response: { statusCode: '202', headers: { 'content-type': 'application/json' }, body: '{"recorded":true}' }
  });
  assert.equal(recorded.status, 201);

  const replay = await requestJson('POST', '/api/replay', { method: 'POST', path: '/replay-me' });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.matched, true);
  assert.equal(replay.payload.response.statusCode, 202);
  assert.equal(replay.payload.response.body, '{"recorded":true}');

  const mockResponse = await fetch(`${base}/mock/replay-me`, { method: 'POST' });
  assert.equal(mockResponse.status, 202);
  assert.equal(mockResponse.headers.get('content-type'), 'application/json');
  assert.equal(await mockResponse.text(), '{"recorded":true}');
});

test('rejects invalid recordings with 400 and leaves no dirty data', async () => {
  const before = store.list().map((route) => route.id);
  const invalidBodies = [
    { request: { method: 'TELEPORT', path: '/x' }, response: { statusCode: 200 } },
    { request: { method: 'GET', path: '/x' }, response: { statusCode: 'not-a-number' } },
    { request: { method: 'GET', path: '/x' }, response: { statusCode: 99 } },
    { request: { method: 'GET', path: '/x' }, response: { statusCode: 600 } },
    { request: { method: 'GET', path: '/x' }, response: {} },
    { request: { method: 'GET', path: '   ' }, response: { statusCode: 200 } },
    { request: { method: 'GET' }, response: { statusCode: 200 } },
    { response: { statusCode: 200 } },
    { request: { method: 'GET', path: '/x' } },
    {}
  ];
  for (const body of invalidBodies) {
    const { status, payload } = await requestJson('POST', '/api/recordings', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(payload.error, JSON.stringify(body));
  }

  const malformed = await fetch(`${base}/api/recordings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
  assert.equal(malformed.status, 400);

  assert.deepEqual(store.list().map((route) => route.id), before);
});

test('create and update apply the same normalization and reject invalid data', async () => {
  const created = await requestJson('POST', '/api/mocks', {
    name: '手动规则',
    method: 'post',
    path: 'manual',
    statusCode: '201'
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.method, 'POST');
  assert.equal(created.payload.data.path, '/manual');
  assert.equal(created.payload.data.statusCode, 201);

  const id = created.payload.data.id;
  const updated = await requestJson('PUT', `/api/mocks/${id}`, {
    name: '手动规则',
    method: 'put',
    path: 'manual',
    statusCode: '204'
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.data.method, 'PUT');
  assert.equal(updated.payload.data.statusCode, 204);

  const rejected = await requestJson('PUT', `/api/mocks/${id}`, {
    name: '手动规则',
    method: 'NOPE',
    path: '/manual',
    statusCode: 200
  });
  assert.equal(rejected.status, 400);
  // 更新失败不得污染已存储的数据。
  assert.equal(store.get(id).method, 'PUT');
  assert.equal(store.get(id).statusCode, 204);
});
