/**
 * POST /salesman/uploads/sign — the signed-upload kind. The Android app asks for "distribution/cheque" and
 * "distribution/return" (its bucket-prefix wording); the strict enum refused those with a 400, so a cheque
 * payment's photo could never be uploaded. Both spellings are accepted now and sign the same path.
 */
const signUpload = jest.fn(async (_org: string, kind: string) => ({
  upload_url: 'https://storage.example/u', token: 't', bucket: 'distribution',
  path: `org/o1/distribution/${kind}/x.jpg`, public_url: `https://storage.example/${kind}.jpg`, expires_in: 300,
}));
jest.mock('../src/utils/upload-signer', () => ({ signUpload: (...a: unknown[]) => (signUpload as any)(...a) }));

import { sign } from '../src/controllers/distribution/uploads.controller';

const USER = { id: 'u1', org_id: 'o1', role: 'executive' };

function call(body: unknown) {
  return new Promise<{ res: any; body: any }>((resolve, reject) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn((b) => resolve({ res, body: b })) };
    (sign as any)({ user: USER, body }, res, (err: unknown) => reject(err ?? new Error('next() called')));
  });
}

beforeEach(() => signUpload.mockClear());

describe('sign upload kind', () => {
  it.each(['cheque', 'pod', 'return', 'signature', 'kyc'])('accepts the plain kind %s', async (kind) => {
    const { res } = await call({ kind, ext: 'jpg' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(signUpload).toHaveBeenCalledWith('o1', kind, 'jpg');
  });

  it.each([['distribution/cheque', 'cheque'], ['distribution/return', 'return'], [' Distribution/Cheque ', 'cheque']])(
    'accepts the prefixed spelling %s and signs the plain kind',
    async (sent, plain) => {
      const { res } = await call({ kind: sent, ext: 'jpg' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(signUpload).toHaveBeenCalledWith('o1', plain, 'jpg');
    },
  );

  it.each(['', 'invoice', 'distribution/', 'distribution/other', 'a/cheque', 42])('still refuses %p', async (kind) => {
    const { res } = await call({ kind });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(signUpload).not.toHaveBeenCalled();
  });
});
