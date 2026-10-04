import { HttpError } from './http.js';
import type {
  HttpMethod,
  MockRouteInput,
  NormalizedRecordingInput,
  ReplayRequest
} from './types.js';

export const allowedMethods = new Set<HttpMethod>([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7E\x80-\xFF]*$/;

export function normalizeHttpMethod(value: unknown, label = 'method'): HttpMethod {
  if (typeof value !== 'string') throw new HttpError(400, `${label} 必须是字符串`);
  const method = value.trim().toUpperCase();
  if (!method) throw new HttpError(400, `${label} 不能为空`);
  if (!allowedMethods.has(method as HttpMethod)) {
    throw new HttpError(400, `不支持的 HTTP 方法: ${value}`);
  }
  return method as HttpMethod;
}

export function normalizePath(path: string): string {
  const source = path.trim();
  if (!source) return '/';
  const withoutQueryOrHash = source.split(/[?#]/)[0] || '/';
  const withLeadingSlash = withoutQueryOrHash.startsWith('/')
    ? withoutQueryOrHash
    : `/${withoutQueryOrHash}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : '/';
}

export function requireRoutePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${label} 不能为空`);
  }
  return normalizePath(value);
}

export function normalizeStatusCode(value: unknown, label = 'statusCode'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new HttpError(400, `${label} 必须是 100-599 的整数`);
  }
  return value;
}

export function normalizeHeaders(
  value: unknown,
  label = 'responseHeaders'
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (!isPlainObject(value)) throw new HttpError(400, `${label} 必须是对象`);

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.trim();
    if (!HEADER_NAME_PATTERN.test(normalizedName)) {
      throw new HttpError(400, `${label} 包含非法 Header 名称: ${name}`);
    }
    if (typeof headerValue !== 'string' || !HEADER_VALUE_PATTERN.test(headerValue)) {
      throw new HttpError(400, `${label}.${normalizedName} 必须是合法字符串`);
    }
    headers[normalizedName] = headerValue;
  }
  return headers;
}

export function normalizeOptionalString(
  value: unknown,
  label: string,
  fallback = ''
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, `${label} 必须是字符串`);
  return value;
}

export function normalizeRouteInput(input: unknown): MockRouteInput {
  if (!isPlainObject(input)) throw new HttpError(400, '请求体必须是对象');

  return {
    name: normalizeRequiredName(input.name, 'name'),
    method: normalizeHttpMethod(input.method, 'method'),
    path: requireRoutePath(input.path, 'path'),
    statusCode: normalizeStatusCode(input.statusCode, 'statusCode'),
    responseHeaders: normalizeHeaders(input.responseHeaders, 'responseHeaders'),
    responseBody: normalizeOptionalString(input.responseBody, 'responseBody'),
    description: normalizeOptionalString(input.description, 'description')
  };
}

export function normalizeRecordingInput(input: unknown): NormalizedRecordingInput {
  if (!isPlainObject(input)) throw new HttpError(400, '录制请求必须是对象');
  if (!isPlainObject(input.request)) {
    throw new HttpError(400, '录制请求必须包含 request 对象');
  }
  if (!isPlainObject(input.response)) {
    throw new HttpError(400, '录制请求必须包含 response 对象');
  }

  const name = normalizeOptionalRecordingName(input.name);
  const method = normalizeHttpMethod(input.request.method, '录制请求的 method');
  const path = requireRoutePath(input.request.path, '录制请求的 path');
  const statusCode = normalizeStatusCode(input.response.statusCode, '录制响应的 statusCode');
  const headers = normalizeHeaders(input.response.headers, '录制响应的 headers');
  const body = normalizeOptionalString(input.response.body, '录制响应的 body');

  return {
    name,
    request: { method, path },
    response: { statusCode, headers: headers ?? {}, body }
  };
}

export function normalizeReplayRequest(input: unknown): ReplayRequest {
  if (!isPlainObject(input)) throw new HttpError(400, '回放请求必须是对象');

  let path = '/';
  if (input.path !== undefined && input.path !== null) {
    if (typeof input.path !== 'string') throw new HttpError(400, 'path 必须是字符串');
    if (input.path.trim()) path = normalizePath(input.path);
  }

  return {
    method: normalizeHttpMethod(input.method ?? 'GET', 'method'),
    path,
    headers: normalizeHeaders(input.headers, 'headers') ?? {},
    body: normalizeOptionalString(input.body, 'body')
  };
}

function normalizeRequiredName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} 必须是字符串`);
  const name = value.trim();
  if (!name) throw new HttpError(400, `${label} 不能为空`);
  return name;
}

function normalizeOptionalRecordingName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'name 必须是字符串');
  const name = value.trim();
  return name || undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
