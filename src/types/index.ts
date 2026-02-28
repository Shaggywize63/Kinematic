import { Request } from 'express';

export type UserRole = 'super_admin' | 'admin' | 'city_manager' | 'supervisor' | 'executive';

export interface AuthUser {
  id: string;
  org_id: string;
  name: string;
  mobile: string;
  role: UserRole;
  zone_id?: string;
  supervisor_id?: string;
  fcm_token?: string;
  is_active: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  accessToken?: string;
}

export type ApiResponse<T = unknown> = {
  success: true;
  data: T;
  message?: string;
} | {
  success: false;
  error: string;
  details?: unknown;
};

export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
