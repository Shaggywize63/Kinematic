-- 1. Add send_push to notification_broadcasts (if it doesn't exist)
ALTER TABLE public.notification_broadcasts
ADD COLUMN IF NOT EXISTS send_push BOOLEAN DEFAULT FALSE;

-- 2. Add broadcast_id to individual notifications
ALTER TABLE public.notifications
ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES public.notification_broadcasts(id) ON DELETE CASCADE;

-- 3. Create an index for faster read_count calculations and cascading deletes
CREATE INDEX IF NOT EXISTS idx_notifications_broadcast_id ON public.notifications(broadcast_id);

-- 4. Create an atomic increment function for read counting
CREATE OR REPLACE FUNCTION increment_broadcast_read_count(b_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.notification_broadcasts
  SET read_count = read_count + 1
  WHERE id = b_id;
END;
$$;
