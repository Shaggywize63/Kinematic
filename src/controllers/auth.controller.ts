import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase';

const JWT_SECRET = process.env.JWT_SECRET || 'kinematic-secret-2024';
const JWT_EXPIRES_IN = '24h';

export const login = async (req: Request, res: Response) => {
  try {
    const { mobile, email, password } = req.body;
    const identifier = (mobile || email || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        error: 'Login identifier (mobile or email) and password are required',
      });
    }

    const isEmail = identifier.includes('@');
    const lookupField = isEmail ? 'email' : 'mobile';

    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, name, mobile, email, role, org_id, employee_id, zone_id, is_active, password_hash')
      .eq(lookupField, identifier)
      .limit(1);

    if (error) {
      console.error('[auth] DB error:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const user = users?.[0];

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, error: 'Account is deactivated' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, org_id: user.org_id, name: user.name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      data: {
        access_token: token,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          org_id: user.org_id,
          employee_id: user.employee_id,
          zone_id: user.zone_id,
          mobile: user.mobile,
          email: user.email,
        },
      },
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const me = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, name, role, org_id, employee_id, zone_id, mobile, email, is_active')
      .eq('id', userId)
      .single();

    if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });

    return res.json({ success: true, data: user });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const logout = async (_req: Request, res: Response) => {
  return res.json({ success: true, message: 'Logged out' });
};
