import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong. Please try again.');
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = any>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
  /** Sends a file as raw bytes. */
  upload: async <T = any>(path: string, file: File) => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'The upload failed.');
    return data as T;
  },
};

/** Uploads with progress, because a large brochure can take minutes on a phone. */
export function uploadWithProgress<T = any>(path: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api${path}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    const failed = () => reject(new ApiError(0, 'The upload stopped. Check your connection and try again.'));
    request.onerror = failed;
    request.onabort = failed;
    request.onload = () => {
      let data: any = {};
      try { data = JSON.parse(request.responseText); } catch { /* Not JSON. */ }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new ApiError(request.status, data.error ?? 'The upload failed.'));
    };
    request.send(file);
  });
}

// Live updates: the server only says "this topic changed", and pages re-fetch.
export const liveUpdates = new EventTarget();

export function connectLiveUpdates() {
  const source = new EventSource('/api/events');
  source.addEventListener('change', (e) => {
    const { topic } = JSON.parse((e as MessageEvent).data);
    liveUpdates.dispatchEvent(new CustomEvent('change', { detail: topic }));
  });
  return () => source.close();
}

export function useApi<T = any>(path: string | null, topics: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(path));
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const call = ++latest.current;
    try {
      const result = await api.get<T>(path);
      if (call === latest.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (call === latest.current) setError((e as Error).message);
    } finally {
      if (call === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(Boolean(path));
    void load();
  }, [load, path]);

  const topicKey = topics.join(',');
  useEffect(() => {
    if (!topicKey) return;
    const wanted = topicKey.split(',');
    const handler = (e: Event) => {
      if (wanted.includes((e as CustomEvent).detail)) void load();
    };
    liveUpdates.addEventListener('change', handler);
    return () => liveUpdates.removeEventListener('change', handler);
  }, [topicKey, load]);

  return { data, error, loading, reload: load };
}
