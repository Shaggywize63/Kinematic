const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('kinematic_token');
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  get<T>(path: string) { return this.request<T>(path); }
  post<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  login(email: string, password: string) {
    return this.post<{ success: boolean; data: { user: object; access_token: string } }>(
      '/api/v1/auth/login',
      { email, password }
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  getDashboardStats() {
    return this.get('/api/v1/dashboard/stats');
  }
  getLiveActivity() {
    return this.get('/api/v1/dashboard/live');
  }

  // ── Field Executives ──────────────────────────────────────────────────────
  getFieldExecutives(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/api/v1/field-executives${qs}`);
  }
  getFieldExecutive(id: string) {
    return this.get(`/api/v1/field-executives/${id}`);
  }

  // ── Attendance ────────────────────────────────────────────────────────────
  getAttendance(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/api/v1/attendance${qs}`);
  }

  // ── Forms (CC) ────────────────────────────────────────────────────────────
  getForms(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/api/v1/forms${qs}`);
  }

  // ── Stock ─────────────────────────────────────────────────────────────────
  getStock() { return this.get('/api/v1/stock'); }
  getStockAllocations(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.get(`/api/v1/stock/allocations${qs}`);
  }
  allocateStock(feId: string, items: Array<{ item_id: string; qty: number }>) {
    return this.post('/api/v1/stock/allocate', { fe_id: feId, items });
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────
  getBroadcast() { return this.get('/api/v1/broadcast'); }
  createBroadcast(data: object) { return this.post('/api/v1/broadcast', data); }

  // ── Notifications ─────────────────────────────────────────────────────────
  getNotifications() { return this.get('/api/v1/notifications'); }
  sendNotification(data: object) { return this.post('/api/v1/notifications/send', data); }

  // ── Analytics ─────────────────────────────────────────────────────────────
  getAnalytics(period: string) {
    return this.get(`/api/v1/analytics?period=${period}`);
  }
}

export const api = new ApiClient(API_URL);
export default api;
