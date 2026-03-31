-- ── Multi-Tenant Client Layer Migration (FIXED) ─────────────────────

-- 1. Create the Clients table
CREATE TABLE IF NOT EXISTS public.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES public.organisations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    contact_details JSONB DEFAULT '{}'::jsonb,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create the Client-Module Access mapping
CREATE TABLE IF NOT EXISTS public.client_module_access (
    client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
    module_id TEXT REFERENCES public.modules(id) ON DELETE CASCADE,
    PRIMARY KEY (client_id, module_id)
);

-- 3. Seed initial client for 'Horizonn Tech Studio'
DO $$ 
DECLARE 
    main_org_id UUID;
    new_client_id UUID;
BEGIN
    SELECT id INTO main_org_id FROM public.organisations WHERE name = 'Horizonn Tech Studio' LIMIT 1;
    
    -- Create default client if it doesn't exist
    INSERT INTO public.clients (org_id, name) 
    VALUES (main_org_id, 'Horizonn Default Client')
    ON CONFLICT DO NOTHING
    RETURNING id INTO new_client_id;

    IF new_client_id IS NULL THEN
        SELECT id INTO new_client_id FROM public.clients WHERE org_id = main_org_id AND name = 'Horizonn Default Client' LIMIT 1;
    END IF;
    
    -- Assign all current modules to this default client
    INSERT INTO public.client_module_access (client_id, module_id)
    SELECT new_client_id, id FROM public.modules
    ON CONFLICT DO NOTHING;
    
    -- 4. Add client_id to the Users table
    ALTER TABLE public.users ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    
    -- 5. Backfill existing users and data to the default client
    UPDATE public.users SET client_id = new_client_id WHERE client_id IS NULL;
    
    -- 6. Add client_id to core data tables for strict isolation
    ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.visit_logs ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.activities ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.route_plans ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.grievances ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.cities ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.activity_users ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.broadcast_questions ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    ALTER TABLE public.broadcast_answers ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id);
    
    -- Backfill all existing data to the default client
    UPDATE public.attendance SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.visit_logs SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.activities SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.route_plans SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.form_submissions SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.sos_alerts SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.grievances SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.stores SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.zones SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.cities SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.skus SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.assets SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.activity_users SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.broadcast_questions SET client_id = new_client_id WHERE client_id IS NULL;
    UPDATE public.broadcast_answers SET client_id = new_client_id WHERE client_id IS NULL;
END $$;
