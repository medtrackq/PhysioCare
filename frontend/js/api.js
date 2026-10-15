// Fetch wrapper — Bearer token สำหรับ API, cookie httpOnly (ตั้งตอน login) ใช้กับ <img>/EventSource
const store = {
  get() { try { return sessionStorage.getItem('pc_token'); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('pc_token', v) : sessionStorage.removeItem('pc_token'); } catch { /* private mode */ } },
};
let token = store.get();

export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = error?.code;
    this.details = error?.details;
  }
}

export async function request(method, url, body, { form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && url !== '/auth/login') { setToken(null); location.hash = ''; location.reload(); }
    throw new ApiError(res.status, data?.error);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, form) => request('POST', u, undefined, { form }),
};

export function setToken(t) { token = t; store.set(t); }
export const hasToken = () => Boolean(token);
