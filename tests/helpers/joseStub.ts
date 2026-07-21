/**
 * CommonJS stub for `jose` (which ships ESM-only and can't be required by the
 * Jest CJS runtime). None of the tests exercise real JWT verification — the
 * HTTP E2E suite authenticates via the demo-token bypass, which never reaches
 * `verifyProjectToken`. If a future test needs real signing/verification,
 * replace this mapping with a proper ESM transform for `jose`.
 */
export const jwtVerify = async () => {
  throw new Error('jose stub: jwtVerify not implemented in tests');
};
export const createRemoteJWKSet = () => async () => {
  throw new Error('jose stub: JWKS not implemented in tests');
};
export class SignJWT {
  setProtectedHeader() { return this; }
  setIssuedAt() { return this; }
  setExpirationTime() { return this; }
  setSubject() { return this; }
  async sign() { return 'stub.jwt.token'; }
}
export const importPKCS8 = async () => ({});
export const importSPKI = async () => ({});
