-- Add missing values to material_type enum
-- These values are required for the training and docs section
ALTER TYPE material_type ADD VALUE IF NOT EXISTS 'image';
ALTER TYPE material_type ADD VALUE IF NOT EXISTS 'slides';
ALTER TYPE material_type ADD VALUE IF NOT EXISTS 'document';
ALTER TYPE material_type ADD VALUE IF NOT EXISTS 'link';
