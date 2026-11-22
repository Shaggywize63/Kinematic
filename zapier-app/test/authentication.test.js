'use strict';

const { expect } = require('chai');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');
const appTester = zapier.createAppTester(App);

const WEBHOOK_URL =
  'https://api.kinematicapp.com/api/v1/integrations/webhook/generic-webhook/int_abc123?key=sekret-key-value';

describe('authentication', () => {
  before(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  after(() => {
    nock.enableNetConnect();
  });

  it('passes the webhook URL through untouched and resolves on ok:true', async () => {
    nock('https://api.kinematicapp.com')
      .get('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(200, { ok: true, label: 'Generic Webhook — Typeform', provider: 'generic_webhook' });

    const bundle = { authData: { webhookUrl: WEBHOOK_URL } };
    const result = await appTester(App.authentication.test, bundle);

    expect(result.ok).to.equal(true);
    expect(result.label).to.equal('Generic Webhook — Typeform');
    expect(result.provider).to.equal('generic_webhook');
  });

  it('throws a clear, plain-language error on a bad/missing key (401)', async () => {
    nock('https://api.kinematicapp.com')
      .get('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(401, { ok: false, error: 'invalid or missing key' });

    const bundle = { authData: { webhookUrl: WEBHOOK_URL } };

    let thrown;
    try {
      await appTester(App.authentication.test, bundle);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/Couldn't verify this Webhook URL/);
  });

  it('throws the same clear error when the integration is disabled (403)', async () => {
    nock('https://api.kinematicapp.com')
      .get('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(403, { ok: false, error: 'integration disabled' });

    const bundle = { authData: { webhookUrl: WEBHOOK_URL } };

    let thrown;
    try {
      await appTester(App.authentication.test, bundle);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/Couldn't verify this Webhook URL/);
  });

  it('throws the same clear error when the integration id does not exist (404)', async () => {
    nock('https://api.kinematicapp.com')
      .get('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(404, { ok: false, error: 'integration not found' });

    const bundle = { authData: { webhookUrl: WEBHOOK_URL } };

    let thrown;
    try {
      await appTester(App.authentication.test, bundle);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/Couldn't verify this Webhook URL/);
  });

  it('throws the same clear error on a 200 response missing ok:true (defensive)', async () => {
    // Not a shape the real GET handler sends today (verifyChallenge() only
    // answers 200 on genuine success), but the auth test should not treat a
    // 200 as success unless the body actually says ok:true — guard against
    // a future/alternate response shape slipping through.
    nock('https://api.kinematicapp.com')
      .get('/api/v1/integrations/webhook/generic-webhook/int_abc123')
      .query({ key: 'sekret-key-value' })
      .reply(200, { message: 'unexpected shape' });

    const bundle = { authData: { webhookUrl: WEBHOOK_URL } };

    let thrown;
    try {
      await appTester(App.authentication.test, bundle);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/Couldn't verify this Webhook URL/);
  });
});
