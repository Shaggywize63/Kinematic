/**
 * supabase-js RPCs RESOLVE `{ error }` instead of throwing. The old login code only had try/catch, so a failed
 * rotate_user_session still returned a fresh session_id that was never stored -> the device sent an id that could
 * never match users.active_session_id -> 401 DEVICE_REPLACED right after login.
 */
import { rotateDeviceSession, buildDeviceLabel } from '../src/lib/deviceSession';

function admin(rpcResult: any, updateSpy = jest.fn().mockResolvedValue({ error: null })) {
  const eq = jest.fn().mockResolvedValue({ error: null });
  return {
    rpc: jest.fn().mockImplementation(() => (rpcResult instanceof Error ? Promise.reject(rpcResult) : Promise.resolve(rpcResult))),
    from: jest.fn().mockReturnValue({ update: (v: unknown) => { updateSpy(v); return { eq }; } }),
    updateSpy, eq,
  };
}

it('returns the id the database accepted', async () => {
  const a = admin({ error: null });
  const id = await rotateDeviceSession(a as any, 'u1', 'Pixel · Android 14', 'fixed-id');
  expect(id).toBe('fixed-id');
  expect(a.rpc).toHaveBeenCalledWith('rotate_user_session', { p_user_id: 'u1', p_new_session_id: 'fixed-id', p_device_label: 'Pixel · Android 14' });
  expect(a.updateSpy).not.toHaveBeenCalled();
});

it('returns null (not a phantom id) and clears the stale row when the RPC resolves an error', async () => {
  const a = admin({ error: { message: 'permission denied for function rotate_user_session' } });
  expect(await rotateDeviceSession(a as any, 'u1', 'x')).toBeNull();
  expect(a.updateSpy).toHaveBeenCalledWith({ active_session_id: null, active_session_device: null });
  expect(a.eq).toHaveBeenCalledWith('id', 'u1');
});

it('returns null when the RPC throws', async () => {
  const a = admin(new Error('network down'));
  expect(await rotateDeviceSession(a as any, 'u1', 'x')).toBeNull();
});

it('buildDeviceLabel formats the kicked-device toast text', () => {
  expect(buildDeviceLabel({ brand: 'Realme', model: '12 Pro', os: '14', platform: 'android' })).toBe('Realme 12 Pro · Android 14');
  expect(buildDeviceLabel({ model: 'iPhone15,3', os: '17.4', platform: 'ios' })).toBe('iPhone15,3 · iOS 17.4');
  expect(buildDeviceLabel({})).toBe('mobile device');
});
