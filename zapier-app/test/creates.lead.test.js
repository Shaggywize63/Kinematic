'use strict';

const { expect } = require('chai');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const appTester = zapier.createAppTester(App);

const WEBHOOK_URL =
  'https://api.kinematicapp.com/api/v1/integrations/webhook/generic-webhook/int_abc123?key=sekret-key-value';

describe('creates.create_lead', () => {
  before(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  after(() => {
    nock.enableNetConnect();
  });

  it('posts only the filled-in fields as JSON, dropping empty/undefined ones', async () => {
    let capturedBody;
    nock('https://api.kinematicapp.com')
      .post('/api/v1/integrations/webhook/generic-webhook/int_abc123', (body) => {
        capturedBody = body;
        return true;
      })
      .query({ key: 'sekret-key-value' })
      .matchHeader('content-type', /application\/json/)
      .reply(200, { ok: true, created: 1, merged: 0 });

    const bundle = {
      authData: { webhookUrl: WEBHOOK_URL },
      inputData: {
        first_name: 'Asha',
        last_name: '',
        email: 'asha@example.com',
        phone: undefined,
        company: null,
        notes: 'Wants a callback',
      },
    };

    const result = await appTester(App.creates.create_lead.operation.perform, bundle);

    expect(capturedBody).to.deep.equal({
      first_name: 'Asha',
      email: 'asha@example.com',
      notes: 'Wants a callback',
    });
    expect(capturedBody).to.not.have.property('last_name');
    expect(capturedBody).to.not.have.property('phone');
    expect(capturedBody).to.not.have.property('company');

    expect(result).to.not.have.property('id');
    expect(result.ok).to.equal(true);
    expect(result.created).to.equal(1);
    expect(result.merged).to.equal(0);
    expect(result.first_name).to.equal('Asha');
    expect(result.email).to.equal('asha@example.com');
  });

  it('parses custom_fields_json into a nested custom_fields object', async () => {
    let capturedBody;
    nock('https://api.kinematicapp.com')
      .post('/api/v1/integrations/webhook/generic-webhook/int_abc123', (body) => {
        capturedBody = body;
        return true;
      })
      .query({ key: 'sekret-key-value' })
      .reply(200, { ok: true, created: 1, merged: 0 });

    const bundle = {
      authData: { webhookUrl: WEBHOOK_URL },
      inputData: {
        email: 'lead@example.com',
        custom_fields_json: '{"preferred_contact_time": "evening", "budget_lakhs": 5}',
      },
    };

    await appTester(App.creates.create_lead.operation.perform, bundle);

    expect(capturedBody.custom_fields).to.deep.equal({
      preferred_contact_time: 'evening',
      budget_lakhs: 5,
    });
  });

  it('drops custom_fields silently (without failing the create) on malformed JSON', async () => {
    let capturedBody;
    nock('https://api.kinematicapp.com')
      .post('/api/v1/integrations/webhook/generic-webhook/int_abc123', (body) => {
        capturedBody = body;
        return true;
      })
      .query({ key: 'sekret-key-value' })
      .reply(200, { ok: true, created: 1, merged: 0 });

    const bundle = {
      authData: { webhookUrl: WEBHOOK_URL },
      inputData: {
        email: 'lead@example.com',
        custom_fields_json: '{not valid json',
      },
    };

    const result = await appTester(App.creates.create_lead.operation.perform, bundle);

    expect(capturedBody).to.not.have.property('custom_fields');
    expect(capturedBody.email).to.equal('lead@example.com');
    expect(result.ok).to.equal(true);
  });

  it('coerces consent fields to real booleans and omits them when unset', async () => {
    let capturedBody;
    nock('https://api.kinematicapp.com')
      .post('/api/v1/integrations/webhook/generic-webhook/int_abc123', (body) => {
        capturedBody = body;
        return true;
      })
      .query({ key: 'sekret-key-value' })
      .reply(200, { ok: true, created: 1, merged: 0 });

    const bundle = {
      authData: { webhookUrl: WEBHOOK_URL },
      inputData: {
        email: 'lead@example.com',
        marketing_consent: 'true',
        // whatsapp_consent intentionally omitted
      },
    };

    await appTester(App.creates.create_lead.operation.perform, bundle);

    expect(capturedBody.marketing_consent).to.equal(true);
    expect(capturedBody).to.not.have.property('whatsapp_consent');
  });

  it('never fabricates a lead id — only echoes created/merged counts and submitted fields', async () => {
    nock('https://api.kinematicapp.com')
      .post('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(200, { ok: true, created: 0, merged: 1 });

    const bundle = {
      authData: { webhookUrl: WEBHOOK_URL },
      inputData: { email: 'existing-lead@example.com' },
    };

    const result = await appTester(App.creates.create_lead.operation.perform, bundle);

    expect(result).to.not.have.property('id');
    expect(result.created).to.equal(0);
    expect(result.merged).to.equal(1);
  });
});
