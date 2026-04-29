ALTER TABLE public.planogram_captures
ADD CONSTRAINT fk_planogram_captures_fe
FOREIGN KEY (fe_id) REFERENCES public.users(id)
ON DELETE CASCADE;

ALTER TABLE public.planogram_captures
ADD CONSTRAINT fk_planogram_captures_store
FOREIGN KEY (store_id) REFERENCES public.stores(id)
ON DELETE SET NULL;

-- Also add for compliance table for consistency
ALTER TABLE public.planogram_compliance
ADD CONSTRAINT fk_planogram_compliance_fe
FOREIGN KEY (fe_id) REFERENCES public.users(id)
ON DELETE SET NULL;

ALTER TABLE public.planogram_compliance
ADD CONSTRAINT fk_planogram_compliance_store
FOREIGN KEY (store_id) REFERENCES public.stores(id)
ON DELETE SET NULL;
