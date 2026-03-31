-- ── RBAC Schema Migration ─────────────────────────────────────

-- 1. Create table for Modules (Module IDs)
CREATE TABLE IF NOT EXISTS public.modules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Seed default modules
INSERT INTO public.modules (id, name, description) VALUES
('orders', 'Orders Management', 'Control visibility and operations on orders'),
('users', 'Users Management', 'Control visibility and operations on dashboard users'),
('analytics', 'Analytics Dashboard', 'Access to data visualization and summaries'),
('inventory', 'Inventory Management', 'Control stock and warehouse data'),
('reports', 'Reports Generation', 'Access to exportable data reports')
ON CONFLICT (id) DO NOTHING;

-- 3. Mapping for User <-> Modules (Permissions)
CREATE TABLE IF NOT EXISTS public.user_module_permissions (
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    module_id TEXT REFERENCES public.modules(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, module_id)
);

-- 4. Mapping for User <-> Cities (City Restriction)
-- Note: Reusing the existing UUID for cities if possible. Assuming city_id is UUID.
CREATE TABLE IF NOT EXISTS public.user_city_assignments (
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    city_id UUID REFERENCES public.cities(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, city_id)
);

-- 5. Add comments
COMMENT ON TABLE public.user_module_permissions IS 'Stores granular module access for sub-admins and city managers.';
COMMENT ON TABLE public.user_city_assignments IS 'Stores city-level data restrictions for city managers.';
