import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../dist/index.js';

let baseUrl;

function api(path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
}

async function jsonRequest(path, method, payload, options = {}) {
  const response = await api(path, {
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    ...options
  });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('recording normalizes method and path and stays replayable through both endpoints', async () => {
  const payload = {
    name: '录制订单创建',
    request: { method: 'post', path: 'recorded-orders/' },
    response: { statusCode: 201, headers: { 'content-type': 'application/json' }, body: '{"id":"rec-1"}' }
  };

  const created = await jsonRequest('/api/recordings', 'POST', payload);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.method, 'POST');
  assert.equal(created.body.data.path, '/recorded-orders');
  assert.equal(created.body.data.statusCode, 201);

  const replay = await jsonRequest('/api/replay', 'POST', { method: 'post', path: 'recorded-orders' });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.matched, true);
  assert.equal(replay.body.route.id, created.body.data.id);
  assert.equal(replay.body.response.body, '{"id":"rec-1"}');

  const direct = await api('/mock/recorded-orders/', { method: 'POST' });
  assert.equal(direct.status, 201);
  assert.equal(await direct.text(), '{"id":"rec-1"}');
});

test('invalid recordings return 400 before writing any route', async () => {
  const beforeList = await jsonRequest('/api/mocks', 'GET');
  assert.equal(beforeList.response.status, 200);
  const beforeCount = beforeList.body.data.length;

  const invalidPayloads = [
    { request: { method: 'GET', path: '/missing-response' } },
    { request: { method: 'LINK', path: '/bad-method' }, response: { statusCode: 200 } },
    { request: { method: 'GET', path: '   ' }, response: { statusCode: 200 } },
    { request: { method: 'GET', path: '/bad-status' }, response: { statusCode: '201' } },
    { request: { method: 'GET', path: '/bad-status' }, response: { statusCode: 99 } },
    { request: { method: 'GET', path: '/bad-headers' }, response: { statusCode: 200, headers: { 'bad@header': 'x' } } }
  ];

  for (const invalidPayload of invalidPayloads) {
    const result = await jsonRequest('/api/recordings', 'POST', invalidPayload);
    assert.equal(result.response.status, 400, JSON.stringify(invalidPayload));
    assert.match(result.body.error, /必须|不支持|不能为空|非法/);
  }

  const afterList = await jsonRequest('/api/mocks', 'GET');
  assert.equal(afterList.body.data.length, beforeCount);
});

test('create and update apply the same validation and normalization rules', async () => {
  const created = await jsonRequest('/api/mocks', 'POST', {
    name: '  页面创建规则  ',
    method: 'get',
    path: 'widgets/?x=1',
    statusCode: 200,
    responseBody: '{"ok":true}'
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.name, '页面创建规则');
  assert.equal(created.body.data.method, 'GET');
  assert.equal(created.body.data.path, '/widgets');

  const invalidUpdate = await jsonRequest(`/api/mocks/${created.body.data.id}`, 'PUT', {
    name: '页面更新规则',
    method: 'GET',
    path: '/widgets',
    statusCode: '200'
  });
  assert.equal(invalidUpdate.response.status, 400);

  const unchanged = await jsonRequest(`/api/mocks/${created.body.data.id}`, 'GET');
  assert.equal(unchanged.body.data.statusCode, 200);
  assert.equal(unchanged.body.data.responseBody, '{"ok":true}');

  const validUpdate = await jsonRequest(`/api/mocks/${created.body.data.id}`, 'PUT', {
    name: '页面更新规则',
    method: 'patch',
    path: '/widgets/42/',
    statusCode: 202,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"accepted":true}',
    description: 'updated'
  });
  assert.equal(validUpdate.response.status, 200);
  assert.equal(validUpdate.body.data.method, 'PATCH');
  assert.equal(validUpdate.body.data.path, '/widgets/42');
  assert.equal(validUpdate.body.data.statusCode, 202);

  const replay = await jsonRequest('/api/replay', 'POST', { method: 'PATCH', path: '/widgets/42' });
  assert.equal(replay.body.matched, true);
  assert.equal(replay.body.route.id, created.body.data.id);
});
