const API = process.env.NEXT_PUBLIC_API_URL ?? '';

const tok = () =>
  typeof window !== 'undefined'
    ? localStorage.getItem('kinematic_token') ?? ''
    : '';

export async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tok()}`, // 🔥 FIX
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  const json = await res.json();
  return json.data ?? json;
}
