-- Add missing columns to clients table to support creation from dashboard
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Ensure contact_person exists (double check)
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS contact_person TEXT;
