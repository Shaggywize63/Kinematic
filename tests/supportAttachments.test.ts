import {
  ALLOWED_TYPES, AttachmentError, MAX_ATTACHMENTS, MAX_BYTES, SUPPORT_BUCKET,
  _resetAttachmentState, fromRow, prefixFor, signAttachments, toAttachments, uploadAttachments,
} from '../src/services/support/supportAttachments';

/**
 * Support screenshots. The security-critical part is `toAttachments`: the browser uploads first and names the
 * files afterwards, so the create path receives client-supplied descriptors. If it accepted any path in the
 * bucket, one customer could name another customer's object and be handed a signed URL for their screenshot.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

const png = (bytes = 32): any => ({ originalname: 'Screen Shot.png', mimetype: 'image/png', size: bytes, buffer: Buffer.alloc(bytes) });

/** A storage double standing in for the support project's admin client. */
function fakeDb(opts: { uploadError?: string; signError?: string; missingBucket?: boolean } = {}) {
  const uploaded: Array<{ bucket: string; path: string; contentType?: string; bytes: number }> = [];
  const created: string[] = [];
  const signed: Array<{ bucket: string; path: string; ttl: number }> = [];
  const db: any = {
    storage: {
      getBucket: async () => ({ data: opts.missingBucket ? null : { name: SUPPORT_BUCKET, public: false }, error: null }),
      createBucket: async (name: string) => { created.push(name); return { error: null }; },
      from: (bucket: string) => ({
        upload: async (path: string, buffer: Buffer, o: any) => {
          if (opts.uploadError) return { error: { message: opts.uploadError } };
          uploaded.push({ bucket, path, contentType: o?.contentType, bytes: buffer.length });
          return { error: null };
        },
        createSignedUrl: async (path: string, ttl: number) => {
          signed.push({ bucket, path, ttl });
          if (opts.signError) return { data: null, error: { message: opts.signError } };
          return { data: { signedUrl: `https://signed.example/${path}?t=${ttl}` }, error: null };
        },
      }),
    },
  };
  return { db, uploaded, created, signed };
}

beforeEach(() => _resetAttachmentState());

describe('toAttachments — what the client may claim', () => {
  const good = {
    path: `${prefixFor(ORG)}abc.png`, bucket: SUPPORT_BUCKET, name: 'shot.png',
    size: 1234, content_type: 'image/png', uploaded_at: '2026-11-27T10:00:00Z',
  };

  it('accepts a descriptor under the caller\'s own prefix', () => {
    expect(toAttachments([good], ORG)).toEqual([expect.objectContaining({ path: good.path, bucket: SUPPORT_BUCKET, name: 'shot.png', size: 1234 })]);
  });

  it("refuses another organisation's object, which is the whole point", () => {
    const theirs = { ...good, path: `${prefixFor(OTHER_ORG)}abc.png` };
    expect(toAttachments([theirs], ORG)).toEqual([]);
  });

  it('refuses another bucket, a traversal, an unknown type and a bare prefix match', () => {
    expect(toAttachments([{ ...good, bucket: 'kinematic-selfies' }], ORG)).toEqual([]);
    expect(toAttachments([{ ...good, path: `${prefixFor(ORG)}../../etc/passwd` }], ORG)).toEqual([]);
    expect(toAttachments([{ ...good, content_type: 'application/pdf' }], ORG)).toEqual([]);
    // A path that merely *starts* like the prefix of a different org must not pass.
    expect(toAttachments([{ ...good, path: `support/${ORG}x/abc.png` }], ORG)).toEqual([]);
  });

  it('refuses everything when there is no org to scope to, or the value is not a list', () => {
    expect(toAttachments([good], null)).toEqual([]);
    expect(toAttachments([good], '')).toEqual([]);
    expect(toAttachments('nope', ORG)).toEqual([]);
    expect(toAttachments(null, ORG)).toEqual([]);
    expect(toAttachments([null, 42, 'x'], ORG)).toEqual([]);
  });

  it(`keeps at most ${MAX_ATTACHMENTS}, even when more are claimed`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...good, path: `${prefixFor(ORG)}f${i}.png` }));
    expect(toAttachments(many, ORG)).toHaveLength(MAX_ATTACHMENTS);
  });

  it('sanitises the display name and never trusts a path in it', () => {
    const [a] = toAttachments([{ ...good, name: '../../../etc/passwd' }], ORG);
    expect(a.name).toBe('passwd');
    const [b] = toAttachments([{ ...good, name: 'C:\\Users\\me\\shot<>.png' }], ORG);
    expect(b.name).toBe('shot__.png');
  });

  it('clamps an absurd size rather than storing it', () => {
    const [a] = toAttachments([{ ...good, size: 99 ** 9 }], ORG);
    expect(a.size).toBe(MAX_BYTES);
  });
});

describe('uploadAttachments', () => {
  it('stores each file under the org prefix with its own id, and describes it', async () => {
    const { db, uploaded } = fakeDb();
    const out = await uploadAttachments(db, [png(10), png(20)], { orgId: ORG });
    expect(out).toHaveLength(2);
    expect(uploaded.map((u) => u.bucket)).toEqual([SUPPORT_BUCKET, SUPPORT_BUCKET]);
    for (const a of out) {
      expect(a.path.startsWith(prefixFor(ORG))).toBe(true);
      expect(a.path.endsWith('.png')).toBe(true);
      expect(a.name).toBe('Screen Shot.png');
      expect(a.bucket).toBe(SUPPORT_BUCKET);
      expect(a.uploaded_at).toBeTruthy();
    }
    // Two files never share an object id.
    expect(new Set(out.map((a) => a.path)).size).toBe(2);
  });

  it('creates the private bucket on first use only', async () => {
    const { db, created } = fakeDb({ missingBucket: true });
    await uploadAttachments(db, [png()], { orgId: ORG });
    await uploadAttachments(db, [png()], { orgId: ORG });
    expect(created).toEqual([SUPPORT_BUCKET]);
  });

  it('refuses a type that is not an image we allow', async () => {
    const { db, uploaded } = fakeDb();
    await expect(uploadAttachments(db, [{ ...png(), mimetype: 'application/pdf' }], { orgId: ORG }))
      .rejects.toThrow(/PNG, JPEG, WEBP or HEIC/);
    expect(uploaded).toHaveLength(0);
  });

  it('refuses a file over the size cap, and too many files', async () => {
    const { db } = fakeDb();
    await expect(uploadAttachments(db, [{ ...png(), size: MAX_BYTES + 1 }], { orgId: ORG })).rejects.toThrow(/under 8 MB/);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => png());
    await expect(uploadAttachments(db, many, { orgId: ORG })).rejects.toThrow(new RegExp(`up to ${MAX_ATTACHMENTS} images`));
  });

  it('refuses with no org and with no files', async () => {
    const { db } = fakeDb();
    await expect(uploadAttachments(db, [png()], { orgId: null })).rejects.toBeInstanceOf(AttachmentError);
    await expect(uploadAttachments(db, [], { orgId: ORG })).rejects.toThrow(/at least one image/);
  });

  it('surfaces a storage failure as an error the caller can show', async () => {
    const { db } = fakeDb({ uploadError: 'bucket is full' });
    await expect(uploadAttachments(db, [png()], { orgId: ORG })).rejects.toThrow(/could not be uploaded/);
  });

  it('accepts every type it advertises', async () => {
    const { db, uploaded } = fakeDb();
    const files = Object.keys(ALLOWED_TYPES).map((mimetype) => ({ ...png(), mimetype }));
    const out = await uploadAttachments(db, files, { orgId: ORG });
    expect(out).toHaveLength(files.length);
    expect(uploaded.map((u) => u.path.split('.').pop())).toEqual(Object.values(ALLOWED_TYPES));
  });
});

describe('signAttachments', () => {
  const list = [{ path: `${prefixFor(ORG)}a.png`, bucket: SUPPORT_BUCKET, name: 'a.png', size: 1, content_type: 'image/png', uploaded_at: '' }];

  it('issues a short-lived URL per file', async () => {
    const { db, signed } = fakeDb();
    const out = await signAttachments(db, list);
    expect(out[0].url).toContain('https://signed.example/');
    expect(signed[0].ttl).toBeGreaterThan(0);
    expect(signed[0].ttl).toBeLessThanOrEqual(3600);
  });

  it('returns a null URL instead of throwing when the object has gone', async () => {
    const { db } = fakeDb({ signError: 'Object not found' });
    const out = await signAttachments(db, list);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBeNull();
    expect(out[0].name).toBe('a.png');
  });
});

describe('fromRow', () => {
  it('reads what is on the row and tolerates junk, since the column is jsonb', () => {
    expect(fromRow(null)).toEqual([]);
    expect(fromRow({})).toEqual([]);
    expect(fromRow([null, 'x', { name: 'no path' }])).toEqual([]);
    const out = fromRow([{ path: 'support/o/a.png' }]);
    expect(out).toEqual([expect.objectContaining({ path: 'support/o/a.png', bucket: SUPPORT_BUCKET, content_type: 'image/png' })]);
  });
});
