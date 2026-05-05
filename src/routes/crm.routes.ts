import { Router } from 'express';

import * as settings   from '../controllers/crm/settings.controller';
import * as pipeline   from '../controllers/crm/pipeline.controller';
import * as leads      from '../controllers/crm/leads.controller';
import * as contacts   from '../controllers/crm/contacts.controller';
import * as accounts   from '../controllers/crm/accounts.controller';
import * as deals      from '../controllers/crm/deals.controller';
import * as activities from '../controllers/crm/activities.controller';
import * as analytics  from '../controllers/crm/analytics.controller';
import * as ai         from '../controllers/crm/ai.controller';
import {
  leadSources, territories, assignmentRules, customFields,
  automations, emailTemplates, emails, products, productCategories,
  whatsappTemplates, whatsapp, importJobs, states, cities,
} from '../controllers/crm/lookup.controller';

const router = Router();

// ── Settings ─────────────────────────────────────────────────
router.get('/settings', settings.getSettings);
router.patch('/settings', settings.updateSettings);
router.post('/settings/seed-defaults', settings.seedDefaults);

// ── Pipelines ────────────────────────────────────────────────
router.get('/pipelines', pipeline.listPipelines);
router.post('/pipelines', pipeline.createPipeline);
router.get('/pipelines/:id', pipeline.getPipeline);
router.patch('/pipelines/:id', pipeline.updatePipeline);
router.delete('/pipelines/:id', pipeline.deletePipeline);

// ── Stages ───────────────────────────────────────────────────
router.get('/stages', pipeline.listStages);
router.post('/stages', pipeline.createStage);
router.get('/stages/:id', pipeline.getStage);
router.patch('/stages/:id', pipeline.updateStage);
router.delete('/stages/:id', pipeline.deleteStage);

// ── Leads ────────────────────────────────────────────────────
router.get('/leads', leads.listLeads);
router.post('/leads', leads.createLead);
router.get('/leads/:id', leads.getLead);
router.patch('/leads/:id', leads.updateLead);
router.delete('/leads/:id', leads.deleteLead);
router.post('/leads/:id/score', leads.scoreLead);
router.post('/leads/:id/convert', leads.convertLead);
router.get('/leads/:id/activities', leads.getLeadActivities);
router.get('/leads/:id/score-history', leads.getLeadScoreHistory);
router.get('/leads/:id/deals', leads.getLeadDeals);

// ── Contacts ─────────────────────────────────────────────────
router.get('/contacts', contacts.listContacts);
router.post('/contacts', contacts.createContact);
router.get('/contacts/:id', contacts.getContact);
router.patch('/contacts/:id', contacts.updateContact);
router.delete('/contacts/:id', contacts.deleteContact);
router.get('/contacts/:id/activities', contacts.getContactActivities);
router.get('/contacts/:id/deals', contacts.getContactDeals);
router.get('/contacts/:id/notes', contacts.getContactNotes);

// ── Accounts ─────────────────────────────────────────────────
router.get('/accounts', accounts.listAccounts);
router.post('/accounts', accounts.createAccount);
router.get('/accounts/:id', accounts.getAccount);
router.patch('/accounts/:id', accounts.updateAccount);
router.delete('/accounts/:id', accounts.deleteAccount);
router.get('/accounts/:id/contacts', accounts.getAccountContacts);
router.get('/accounts/:id/deals', accounts.getAccountDeals);
router.get('/accounts/:id/activities', accounts.getAccountActivities);
router.get('/accounts/:id/notes', accounts.getAccountNotes);

// ── Deals ────────────────────────────────────────────────────
router.get('/deals', deals.listDeals);
router.post('/deals', deals.createDeal);
router.get('/deals/:id', deals.getDeal);
router.patch('/deals/:id', deals.updateDeal);
router.delete('/deals/:id', deals.deleteDeal);
router.post('/deals/:id/move-stage', deals.moveStage);
router.post('/deals/:id/win', deals.winDeal);
router.post('/deals/:id/lose', deals.loseDeal);
router.get('/deals/:id/history', deals.getDealHistory);
router.get('/deals/:id/activities', deals.getDealActivities);
router.get('/deals/:id/contacts', deals.getDealContacts);
router.get('/deals/:id/notes', deals.getDealNotes);
router.get('/deals/:id/line-items', deals.listLineItems);
router.post('/deals/:id/line-items', deals.addLineItem);

// ── Line Items (standalone update/delete) ────────────────────
router.patch('/line-items/:id', deals.updateLineItem);
router.delete('/line-items/:id', deals.removeLineItem);

// ── Activities ───────────────────────────────────────────────
router.get('/activities/calendar', activities.getCalendar);
router.get('/activities', activities.listActivities);
router.post('/activities', activities.createActivity);
router.get('/activities/:id', activities.getActivity);
router.patch('/activities/:id', activities.updateActivity);
router.delete('/activities/:id', activities.deleteActivity);

// ── Tasks ────────────────────────────────────────────────────
router.get('/tasks', activities.listTasks);
router.post('/tasks', activities.createTask);
router.get('/tasks/:id', activities.getTask);
router.patch('/tasks/:id', activities.updateTask);
router.delete('/tasks/:id', activities.deleteTask);

// ── Notes ────────────────────────────────────────────────────
router.get('/notes', activities.listNotes);
router.post('/notes', activities.createNote);
router.get('/notes/:id', activities.getNote);
router.patch('/notes/:id', activities.updateNote);
router.delete('/notes/:id', activities.deleteNote);

// ── Lead Sources ─────────────────────────────────────────────
router.get('/lead-sources', leadSources.list);
router.post('/lead-sources', leadSources.create);
router.get('/lead-sources/:id', leadSources.getOne);
router.patch('/lead-sources/:id', leadSources.update);
router.delete('/lead-sources/:id', leadSources.remove);

// ── Territories ──────────────────────────────────────────────
router.get('/territories', territories.list);
router.post('/territories', territories.create);
router.get('/territories/:id', territories.getOne);
router.patch('/territories/:id', territories.update);
router.delete('/territories/:id', territories.remove);

// ── Assignment Rules ─────────────────────────────────────────
router.get('/assignment-rules', assignmentRules.list);
router.post('/assignment-rules', assignmentRules.create);
router.get('/assignment-rules/:id', assignmentRules.getOne);
router.patch('/assignment-rules/:id', assignmentRules.update);
router.delete('/assignment-rules/:id', assignmentRules.remove);

// ── Custom Fields ────────────────────────────────────────────
router.get('/custom-fields', customFields.list);
router.post('/custom-fields', customFields.create);
router.get('/custom-fields/:id', customFields.getOne);
router.patch('/custom-fields/:id', customFields.update);
router.delete('/custom-fields/:id', customFields.remove);

// ── Automations ──────────────────────────────────────────────
router.get('/automations', automations.list);
router.post('/automations', automations.create);
router.get('/automations/:id', automations.getOne);
router.patch('/automations/:id', automations.update);
router.delete('/automations/:id', automations.remove);

// ── Email Templates ──────────────────────────────────────────
router.get('/email-templates', emailTemplates.list);
router.post('/email-templates', emailTemplates.create);
router.get('/email-templates/:id', emailTemplates.getOne);
router.patch('/email-templates/:id', emailTemplates.update);
router.delete('/email-templates/:id', emailTemplates.remove);

// ── Emails (send + log) ──────────────────────────────────────
router.get('/emails', emails.list);
router.post('/emails/send', emails.send);

// ── Products & Categories ────────────────────────────────────
router.get('/product-categories', productCategories.list);
router.post('/product-categories', productCategories.create);
router.patch('/product-categories/:id', productCategories.update);
router.delete('/product-categories/:id', productCategories.remove);

router.get('/products', products.list);
router.post('/products', products.create);
router.get('/products/:id', products.getOne);
router.patch('/products/:id', products.update);
router.delete('/products/:id', products.remove);

// ── WhatsApp ──────────────────────────────────────────────────
router.get('/whatsapp-templates', whatsappTemplates.list);
router.post('/whatsapp-templates', whatsappTemplates.create);
router.patch('/whatsapp-templates/:id', whatsappTemplates.update);
router.delete('/whatsapp-templates/:id', whatsappTemplates.remove);
router.post('/whatsapp/send', whatsapp.send);
router.get('/whatsapp/logs', whatsapp.logs);

// ── Import ───────────────────────────────────────────────────
router.get('/import/jobs', importJobs.list);
router.post('/import/upload', importJobs.upload);
router.post('/import/preview', importJobs.preview);
router.post('/import/commit', importJobs.commit);
router.get('/import/jobs/:id', importJobs.getJob);

// ── States & Cities ──────────────────────────────────────────
router.get('/states', states.list);
router.post('/states', states.create);
router.post('/states/seed-indian', states.seedIndian);
router.get('/states/:id/cities', states.getCities);
router.get('/cities', cities.list);
router.post('/cities', cities.create);
router.get('/cities/:id', cities.getOne);
router.patch('/cities/:id', cities.update);
router.delete('/cities/:id', cities.remove);

// ── Analytics ────────────────────────────────────────────────
router.get('/analytics/dashboard-summary', analytics.dashboardSummary);
router.get('/analytics/pipeline-value', analytics.pipelineValue);
router.get('/analytics/funnel', analytics.funnel);
router.get('/analytics/win-rate', analytics.winRate);
router.get('/analytics/sales-cycle', analytics.salesCycle);
router.get('/analytics/forecast', analytics.forecast);
router.get('/analytics/activity-heatmap', analytics.activityHeatmap);
router.get('/analytics/lead-source-roi', analytics.leadSourceRoi);
router.get('/analytics/lead-score-distribution', analytics.leadScoreDistribution);
router.get('/analytics/by-state', analytics.byState);

// ── AI ────────────────────────────────────────────────────────
router.post('/ai/score-lead/:id', ai.scoreLead);
router.post('/ai/draft-reply', ai.draftReply);
router.post('/ai/next-best-action/:dealId', ai.nextBestAction);
router.post('/ai/win-probability/:dealId', ai.winProbability);
router.post('/ai/summarize/account/:id', ai.summarizeAccount);
router.post('/ai/summarize/deal/:id', ai.summarizeDeal);
router.post('/ai/chat', ai.chat);

export default router;
