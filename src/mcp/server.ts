// Kinematic CRM MCP server.
//
// Exposes a small set of CRM tools to external assistants (ChatGPT Apps, Claude
// connectors) over Streamable HTTP. A fresh McpServer + transport is built per
// request (stateless) with the connected user's context captured in closure, so
// every tool acts strictly AS that user: scope ∩ role, org/client scoped, writes
// blocked for read-only accounts, and every write audited.

import { Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// Import from zod/v3 (not 'zod') to match the MCP SDK's ZodRawShapeCompat, which
// is typed against `zod/v3`. In zod 3.25 the bare 'zod' entry exposes slightly
// different number/effects types that don't unify with the SDK's expected shape.
import { z } from 'zod/v3';
import { AuthRequest } from '../types';
import { clientScopedList, get, update, create } from '../services/crm/crud.service';
import {
  McpCtx, mcpCtxFromReq, textResult, errorResult, denyIfNotAllowed, ownerScopeOpts, audit,
} from './context';

// ------------------------------------------------------------- formatting ----

function fullName(l: any): string {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)';
}

function formatLeadList(rows: any[]): string {
  if (!rows.length) return 'No leads found.';
  const lines = rows.map((l) => {
    const bits = [fullName(l), l.phone, l.status, l.city].filter(Boolean).join(' · ');
    return `• ${bits}  (id: ${l.id})`;
  });
  return `${rows.length} lead(s):\n${lines.join('\n')}`;
}

function formatLead(l: any): string {
  const pairs: Array<[string, unknown]> = [
    ['Name', fullName(l)], ['Phone', l.phone], ['Email', l.email], ['Status', l.status],
    ['Company', l.company], ['City', l.city], ['Owner', l.owner_id], ['Score', l.score],
    ['Notes', l.notes], ['Created', l.created_at], ['id', l.id],
  ];
  return pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
}

function formatDealList(rows: any[]): string {
  if (!rows.length) return 'No deals found.';
  const lines = rows.map((d) => {
    const money = d.amount != null ? `${d.amount} ${d.currency || ''}`.trim() : '';
    const bits = [d.name, money, d.status].filter(Boolean).join(' · ');
    return `• ${bits}  (id: ${d.id}, stage: ${d.stage_id || '—'})`;
  });
  return `${rows.length} deal(s):\n${lines.join('\n')}`;
}

// ------------------------------------------------------------------ tools ----

function registerTools(server: McpServer, ctx: McpCtx): void {
  // ---- reads -----------------------------------------------------------------
  server.registerTool('list_leads', {
    title: 'List leads',
    description: 'List CRM leads in the connected Kinematic account, newest first. Optionally filter by status or search by name / phone / email / company.',
    inputSchema: {
      status: z.string().optional().describe('Filter by lead status, e.g. "new", "qualified"'),
      query: z.string().optional().describe('Free-text search across name, phone, email, company'),
      limit: z.number().min(1).max(100).optional().describe('Max results (default 25)'),
    },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'crm:read', module: 'crm_leads' });
    if (denied) return denied;
    const rows = await clientScopedList('crm_leads', ctx.orgId, ctx.userClientId, {
      ...(args.status ? { status: args.status } : {}),
      ...(args.query ? { q: args.query } : {}),
      limit: args.limit ?? 25, sort: 'created_at', order: 'desc',
    }, { strictClient: true, searchColumns: ['first_name', 'last_name', 'phone', 'email', 'company'], ...ownerScopeOpts(ctx) }) as any[];
    return textResult(formatLeadList(rows));
  });

  server.registerTool('get_lead', {
    title: 'Get a lead',
    description: 'Fetch a single lead by its id.',
    inputSchema: { lead_id: z.string().describe('The lead id (uuid)') },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'crm:read', module: 'crm_leads' });
    if (denied) return denied;
    try {
      const lead = await get('crm_leads', ctx.orgId, args.lead_id, true, ctx.userClientId);
      return textResult(formatLead(lead));
    } catch { return errorResult('No lead with that id in your account.'); }
  });

  server.registerTool('list_deals', {
    title: 'List deals',
    description: 'List CRM deals in the connected account, newest first. Optionally filter by pipeline stage or search by name.',
    inputSchema: {
      stage_id: z.string().optional().describe('Filter by pipeline stage id'),
      query: z.string().optional().describe('Search deal name'),
      limit: z.number().min(1).max(100).optional(),
    },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'crm:read', module: 'crm_deals' });
    if (denied) return denied;
    const rows = await clientScopedList('crm_deals', ctx.orgId, ctx.userClientId, {
      ...(args.stage_id ? { stage_id: args.stage_id } : {}),
      ...(args.query ? { q: args.query } : {}),
      limit: args.limit ?? 25, sort: 'created_at', order: 'desc',
    }, { strictClient: true, searchColumns: ['name'], ...ownerScopeOpts(ctx) }) as any[];
    return textResult(formatDealList(rows));
  });

  // ---- writes ----------------------------------------------------------------
  server.registerTool('update_lead', {
    title: 'Update a lead',
    description: 'Update a lead\'s status, owner, or notes. Only the fields you pass are changed.',
    inputSchema: {
      lead_id: z.string().describe('The lead id (uuid)'),
      status: z.string().optional().describe('New status, e.g. "qualified", "contacted"'),
      owner_id: z.string().optional().describe('User id to assign as the lead owner'),
      notes: z.string().optional().describe('Replace the lead notes'),
    },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'leads:write', module: 'crm_leads', write: true });
    if (denied) { await audit(ctx, { tool: 'update_lead', targetType: 'lead', targetId: args.lead_id, outcome: 'denied' }); return denied; }

    const payload: Record<string, unknown> = {};
    if (args.status != null) payload.status = args.status;
    if (args.owner_id != null) payload.owner_id = args.owner_id;
    if (args.notes != null) payload.notes = args.notes;
    if (Object.keys(payload).length === 0) return errorResult('Nothing to update — pass status, owner_id, or notes.');

    try {
      const updated = await update('crm_leads', ctx.orgId, args.lead_id, payload, ctx.userId, ctx.userClientId) as any;
      await audit(ctx, { tool: 'update_lead', targetType: 'lead', targetId: args.lead_id, request: payload, outcome: 'ok' });
      return textResult(`Updated ${fullName(updated)} — ${Object.keys(payload).join(', ')} saved.`);
    } catch (e: any) {
      await audit(ctx, { tool: 'update_lead', targetType: 'lead', targetId: args.lead_id, request: payload, outcome: 'error', error: e?.message });
      return errorResult('Could not update that lead (it may not exist in your account).');
    }
  });

  server.registerTool('create_activity', {
    title: 'Log an activity',
    description: 'Log an activity or note against a lead — a call, meeting, or note.',
    inputSchema: {
      lead_id: z.string().describe('The lead id (uuid) to attach this to'),
      body: z.string().describe('What happened / the note text'),
      type: z.string().optional().describe('Activity type: note, call, meeting, whatsapp… (default "note")'),
      subject: z.string().optional().describe('Short subject line'),
      outcome: z.string().optional().describe('Outcome, e.g. "connected", "no answer"'),
    },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'activities:write', module: 'crm_activities', write: true });
    if (denied) { await audit(ctx, { tool: 'create_activity', targetType: 'lead', targetId: args.lead_id, outcome: 'denied' }); return denied; }

    // Confirm the lead is in the user's tenant before attaching.
    try { await get('crm_leads', ctx.orgId, args.lead_id, true, ctx.userClientId); }
    catch { return errorResult('No lead with that id in your account.'); }

    const payload: Record<string, unknown> = {
      lead_id: args.lead_id,
      type: args.type || 'note',
      subject: args.subject ?? null,
      body: args.body,
      outcome: args.outcome ?? null,
      owner_id: ctx.userId,
      assigned_to: ctx.userId,
      status: 'completed',
      completed_at: new Date().toISOString(),
      client_id: ctx.userClientId,
    };
    try {
      const row = await create('crm_activities', ctx.orgId, payload, ctx.userId) as any;
      await audit(ctx, { tool: 'create_activity', targetType: 'lead', targetId: args.lead_id, request: { type: payload.type }, outcome: 'ok' });
      return textResult(`Logged a ${payload.type} on the lead (activity id: ${row.id}).`);
    } catch (e: any) {
      await audit(ctx, { tool: 'create_activity', targetType: 'lead', targetId: args.lead_id, outcome: 'error', error: e?.message });
      return errorResult('Could not log the activity.');
    }
  });

  server.registerTool('update_deal_stage', {
    title: 'Move a deal to a stage',
    description: 'Move a deal to a different pipeline stage.',
    inputSchema: {
      deal_id: z.string().describe('The deal id (uuid)'),
      stage_id: z.string().describe('The target pipeline stage id (uuid)'),
    },
  }, async (args) => {
    const denied = denyIfNotAllowed(ctx, { scope: 'deals:write', module: 'crm_deals', write: true });
    if (denied) { await audit(ctx, { tool: 'update_deal_stage', targetType: 'deal', targetId: args.deal_id, outcome: 'denied' }); return denied; }

    // Validate the target stage exists in this org (crm_deal_stages has no
    // client_id / deleted_at columns → softDelete=false, no client scope).
    try { await get('crm_deal_stages', ctx.orgId, args.stage_id, false); }
    catch { return errorResult('That stage doesn\'t exist in your account.'); }

    try {
      const d = await update('crm_deals', ctx.orgId, args.deal_id, { stage_id: args.stage_id }, ctx.userId, ctx.userClientId) as any;
      await audit(ctx, { tool: 'update_deal_stage', targetType: 'deal', targetId: args.deal_id, request: { stage_id: args.stage_id }, outcome: 'ok' });
      return textResult(`Moved deal "${d.name}" to the new stage.`);
    } catch (e: any) {
      await audit(ctx, { tool: 'update_deal_stage', targetType: 'deal', targetId: args.deal_id, request: { stage_id: args.stage_id }, outcome: 'error', error: e?.message });
      return errorResult('Could not move that deal (it may not exist in your account).');
    }
  });
}

// --------------------------------------------------------------- transport ----

export function buildMcpServer(req: AuthRequest): McpServer {
  const ctx = mcpCtxFromReq(req);
  const server = new McpServer({ name: 'kinematic-crm', version: '1.0.0' });
  registerTools(server, ctx);
  return server;
}

/**
 * Express handler for POST /mcp. Stateless: a fresh server + transport per
 * request. req.user / req.oauth are already populated by requireOAuth, and the
 * request runs inside the token's project (runWithProject) so every
 * supabaseAdmin call in the tools targets the right tenant.
 */
export async function mcpHandler(req: AuthRequest, res: Response): Promise<void> {
  const server = buildMcpServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/**
 * RFC 9728 protected-resource metadata — tells MCP clients which authorization
 * server protects this resource so they can start the OAuth flow.
 */
export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['crm:read', 'leads:write', 'deals:write', 'activities:write', 'contacts:write'],
    bearer_methods_supported: ['header'],
  };
}
