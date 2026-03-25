-- Migration to add missing activity types to the activity_type enum
-- Run this in the Supabase SQL Editor

DO $$
BEGIN
    -- Add VISIT type
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'VISIT') THEN
        ALTER TYPE activity_type ADD VALUE 'VISIT';
    END IF;

    -- Add other common types from the dashboard if missing
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'GT') THEN
        ALTER TYPE activity_type ADD VALUE 'GT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'MT') THEN
        ALTER TYPE activity_type ADD VALUE 'MT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'SAMPLING') THEN
        ALTER TYPE activity_type ADD VALUE 'SAMPLING';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'DEMO') THEN
        ALTER TYPE activity_type ADD VALUE 'DEMO';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'SURVEY') THEN
        ALTER TYPE activity_type ADD VALUE 'SURVEY';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'activity_type' AND e.enumlabel = 'OTHER') THEN
        ALTER TYPE activity_type ADD VALUE 'OTHER';
    END IF;
END
$$;
