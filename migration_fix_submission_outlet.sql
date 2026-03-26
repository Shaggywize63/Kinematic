-- Add outlet_id to form_submissions if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'form_submissions' AND column_name = 'outlet_id') THEN
        ALTER TABLE form_submissions ADD COLUMN outlet_id UUID REFERENCES builder_outlets(id);
    END IF;
END $$;
