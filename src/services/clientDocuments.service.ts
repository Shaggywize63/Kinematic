/**
 * Reference documents attached to a `clients` row (Client Management → Documents) — e.g. a client's
 * own product price list. Platform-admin-only, same access level as the rest of Client Management.
 *
 * Table: client_documents (migration_client_documents.sql). Until that migration is applied, every
 * route answers 503 NOT_MIGRATED instead of a raw 500 — same pattern as makesBrands.service.ts.
 *
 * The file bytes are NOT handled here: they go through the existing private-storage pipeline —
 * POST /api/v1/upload/material to upload and GET /api/v1/media/sign to read (both already live).
 * This service only persists the metadata linking an uploaded object to a client.
 */
import { supabaseAdmin } from '../lib/supabase';
import { AppError } from '../utils';
import { isMissingSchemaError } from './crm/accountMerge.service';

interface DbErr { code?: string; message?: string }

export const NOT_MIGRATED_MESSAGE = 'Client documents are not set up in this database yet. Apply migration_client_documents.sql.';
export const notMigrated = (): AppError => new AppError(503, NOT_MIGRATED_MESSAGE, 'NOT_MIGRATED');

function dbError(e: DbErr): AppError {
  if (isMissingSchemaError(e)) return notMigrated();
  return new AppError(500, String(e?.message ?? 'Database error'), 'DB_ERROR');
}

export interface ClientDocument {
  id: string;
  client_id: string;
  org_id: string | null;
  name: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  bucket: string;
  path: string;
  uploaded_by: string | null;
  created_at: string;
}

export async function listClientDocuments(clientId: string): Promise<ClientDocument[]> {
  const { data, error } = await supabaseAdmin
    .from('client_documents')
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw dbError(error);
  return (data ?? []) as ClientDocument[];
}

export interface CreateClientDocumentInput {
  clientId: string;
  orgId: string | null;
  uploadedBy: string | null;
  name: string;
  fileName: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  bucket: string;
  path: string;
}

export async function createClientDocument(input: CreateClientDocumentInput): Promise<ClientDocument> {
  const { data, error } = await supabaseAdmin
    .from('client_documents')
    .insert({
      client_id: input.clientId,
      org_id: input.orgId,
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
  return data as ClientDocument;
}

export async function deleteClientDocument(clientId: string, documentId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('client_documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('id', documentId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new AppError(404, 'Document not found', 'NOT_FOUND');
}
