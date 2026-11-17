import type { ApiFailure, ApiSuccess, ClientBootstrapInfo } from '@competition/contracts';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly traceId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ApiBaseState {
  apiBaseUrl: string;
  source: 'configured' | 'same_origin';
  configVersion: number;
  issuedAt: string;
  error: string | null;
  stale: boolean;
}

const CACHE_MS = 60_000;
const API_PATH = `${import.meta.env.BASE_URL}api/v1`;
const BOOTSTRAP_PATH = `${API_PATH}/system/client-bootstrap`;

let cached: { info: ClientBootstrapInfo; fetchedAt: number } | null = null;
let fallback: { state: ApiBaseState; fetchedAt: number } | null = null;
let inflight: Promise<string> | null = null;

function sameOriginBase(): string {
  return `${window.location.origin}${API_PATH}`;
}

function actorHeaders(): Record<string, string> {
  if (!cached?.info.devIdentityAllowed) return {};
  return {
    'x-actor-id': encodeURIComponent(localStorage.getItem('actorId') ?? 'u-demo'),
    'x-actor-name': encodeURIComponent(localStorage.getItem('actorName') ?? '演示用户'),
    'x-actor-roles': encodeURIComponent(
      localStorage.getItem('actorRoles') ?? 'admin,reviewer,editor,viewer',
    ),
  };
}

function baseOf(info: ClientBootstrapInfo): string {
  if (info.apiBaseSource === 'configured' && info.apiBaseUrl) {
    return info.apiBaseUrl.replace(/\/$/, '');
  }
  return sameOriginBase();
}

export function getApiBaseInfo(): ApiBaseState {
  if (cached) {
    return {
      apiBaseUrl: baseOf(cached.info),
      source: cached.info.apiBaseSource,
      configVersion: cached.info.configVersion,
      issuedAt: cached.info.issuedAt,
      error: null,
      stale: Date.now() - cached.fetchedAt > CACHE_MS,
    };
  }
  if (fallback) {
    return { ...fallback.state, stale: Date.now() - fallback.fetchedAt > CACHE_MS };
  }
  return {
    apiBaseUrl: sameOriginBase(),
    source: 'same_origin',
    configVersion: 0,
    issuedAt: '',
    error: '尚未取得客户端引导信息',
    stale: true,
  };
}

async function fetchBootstrap(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${window.location.origin}${BOOTSTRAP_PATH}`, {
      headers: { Accept: 'application/json', ...actorHeaders() },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`引导接口返回 ${response.status}`);
    const payload = (await response.json()) as ApiSuccess<ClientBootstrapInfo>;
    const info = payload.data;
    cached = { info, fetchedAt: Date.now() };
    fallback = null;
    return baseOf(info);
  } catch (error) {
    const state: ApiBaseState = {
      apiBaseUrl: sameOriginBase(),
      source: 'same_origin',
      configVersion: 0,
      issuedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : '引导信息获取失败',
      stale: false,
    };
    fallback = { state, fetchedAt: Date.now() };
    return state.apiBaseUrl;
  } finally {
    clearTimeout(timer);
  }
}

export async function bootstrapClient(force = false): Promise<ApiBaseState> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) return getApiBaseInfo();
  if (!inflight) {
    inflight = fetchBootstrap().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return getApiBaseInfo();
}

async function resolveBase(): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return baseOf(cached.info);
  if (fallback && Date.now() - fallback.fetchedAt < 10_000) return fallback.state.apiBaseUrl;
  const state = await bootstrapClient(true);
  return state.apiBaseUrl;
}

async function requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await resolveBase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  for (const [key, value] of Object.entries(actorHeaders())) headers.set(key, value);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as ApiFailure | null;
    throw new ApiError(
      failure?.error?.code ?? 'INTERNAL_ERROR',
      failure?.error?.message ?? '请求失败',
      failure?.error?.traceId,
      failure?.error?.details,
    );
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(path, init);
  return ((await response.json()) as ApiSuccess<T>).data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: 'PUT',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  download: async (path: string) => (await requestResponse(path)).blob(),
};

export function getUser(): { name: string; roles: string[] } {
  return {
    name: localStorage.getItem('actorName') ?? '演示用户',
    roles: (localStorage.getItem('actorRoles') ?? 'admin,reviewer,editor,viewer').split(','),
  };
}
