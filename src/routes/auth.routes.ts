// TEMPORARY - remove after first use
router.post('/setup-password', async (req, res) => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(req.body.password, 10);
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  await sb.from('users').update({ password_hash: hash }).eq('email', req.body.email);
  res.json({ success: true, hash });
});
