/**
 * Reference documents attached to a CRM account (price lists, contracts, spec sheets, etc).
 *
 * Table: crm_account_documents (migration_crm_account_documents.sql). Until that migration is applied,
 * every route answers 503 NOT_MIGRATED instead of a raw 500 — same pattern as makesBrands.service.ts.
 *
 * The file bytes are NOT handled here: they go through the existing private-storage pipeline —
 * POST /api/v1/upload/material to upload (already accepts application/pdf, BUCKET_MATERIALS, private)
 * and GET /api/v1/media/sign to read (already signs BUCKET_MATERIALS objects, tenant-safe by the
 * org_id/user_id path prefix). This service only persists the metadata linking an uploaded object
 * to an account.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { isMissingSchemaError } from './accountMerge.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DbErr { code?: string; message?: string }

export const NOT_MIGRATED_MESSAGE = 'Account documents are not set up in this database yet. Apply migration_crm_account_documents.sql.';
export const notMigrated = (): AppError => new AppError(503, NOT_MIGRATED_MESSAGE, 'NOT_MIGRATED');

function dbError(e: DbErr): AppError {
  if (isMissingSchemaError(e)) return notMigrated();
  return new AppError(500, String(e?.message ?? 'Database error'), 'DB_ERROR');
}

export interface AccountDocument {
  id: string;
  org_id: string;
  client_id: string | null;
  account_id: string;
  name: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  bucket: string;
  path: string;
  uploaded_by: string | null;
  created_at: string;
}

export async function listAccountDocuments(orgId: string, accountId: string): Promise<AccountDocument[]> {
  const { data, error } = await supabaseAdmin
    .from('crm_account_documents')
    .select('*')
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw dbError(error);
  return (data ?? []) as AccountDocument[];
}

export interface CreateAccountDocumentInput {
  orgId: string;
  clientId: string | null;
  accountId: string;
  uploadedBy: string | null;
  name: string;
  fileName: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  bucket: string;
  path: string;
}

export async function createAccountDocument(input: CreateAccountDocumentInput): Promise<AccountDocument> {
  const { data, error } = await supabaseAdmin
    .from('crm_account_documents')
    .insert({
      org_id: input.orgId,
      client_id: input.clientId,
      account_id: input.accountId,
      name: input.name,
      file_name: input.fileName,
      content_type: input.contentType ?? null,
      size_bytes: input.sizeBytes ?? null,
      bucket: input.bucket,
      path: input.path,
      uploaded_by: input.uploadedBy,
    })
    .select('*')
    .single();
  if (error) throw dbError(error);
  return data as AccountDocument;
}

export async function deleteAccountDocument(orgId: string, accountId: string, documentId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('crm_account_documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .eq('id', documentId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new AppError(404, 'Document not found', 'NOT_FOUND');
}
