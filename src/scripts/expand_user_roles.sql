-- Expanding the user_role enum to support granular administrative roles
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'sub_admin';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'client';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'hr';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'mis';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'warehouse_manager';
