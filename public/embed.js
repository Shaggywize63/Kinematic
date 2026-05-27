/* Kinematic CRM embed.js — public lead-capture loader.
 *
 * Drop into any page:
 *   <div data-kinematic-form="<WEBHOOK_URL>"></div>
 *   <script src="https://<your-backend>/embed.js" async></script>
 *
 * Optional attributes on the host div:
 *   data-primary-color="#0F62FE"   accent for button + focus ring (default red)
 *   data-radius="10"               px corner radius (default 10)
 *   data-theme="light|dark"        auto-defaults to light
 *   data-title="Get a callback"    heading shown above the fields
 *   data-success="Thanks! We will be in touch shortly."  post-submit message
 *   data-fields="name,email,phone,city,company,message"  comma list, order kept
 *
 * The script scans for every `[data-kinematic-form]` on load and again
 * when the DOM is mutated, so it works for SPAs that insert the host
 * div after page load. Submits POST <url> JSON with the standard
 * Kinematic field names — the backend dedup + city defaulting + client
 * scope already handle the rest.
 */
(function () {
  'use strict';
  if (window.__kinematicEmbedLoaded) return;
  window.__kinematicEmbedLoaded = true;

  var DEFAULT_PRIMARY = '#E01E2C';
  var FIELD_DEFS = {
    name:    { label: 'Name',    type: 'text',  required: true,  placeholder: 'Your name' },
    email:   { label: 'Email',   type: 'email', required: false, placeholder: 'you@company.com' },
    phone:   { label: 'Mobile',  type: 'tel',   required: true,  placeholder: '10-digit number' },
    city:    { label: 'City',    type: 'text',  required: true,  placeholder: 'City' },
    company: { label: 'Company', type: 'text',  required: false, placeholder: 'Company / organisation' },
    message: { label: 'Message', type: 'textarea', required: false, placeholder: 'What do you need help with?' },
  };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(n.style, attrs[k]);
      else if (k === 'cls') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    });
    return n;
  }

  function applyTheme(root, primary, radius, theme) {
    var dark = theme === 'dark';
    Object.assign(root.style, {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      background: dark ? '#0A0E1A' : '#ffffff',
      color: dark ? '#E5E7EB' : '#111827',
      border: '1px solid ' + (dark ? '#1F2937' : '#E5E7EB'),
      borderRadius: radius + 'px',
      padding: '18px',
      maxWidth: '420px',
      boxSizing: 'border-box',
      lineHeight: '1.5',
    });
    root.style.setProperty('--km-primary', primary);
    root.style.setProperty('--km-radius', radius + 'px');
    root.style.setProperty('--km-input-bg', dark ? '#111827' : '#F9FAFB');
    root.style.setProperty('--km-input-border', dark ? '#1F2937' : '#D1D5DB');
    root.style.setProperty('--km-text', dark ? '#E5E7EB' : '#111827');
    root.style.setProperty('--km-muted', dark ? '#9CA3AF' : '#6B7280');
  }

  function field(key, def) {
    var wrap = el('div', { style: { marginBottom: '12px' } });
    var label = el('label', {
      style: { display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: 'var(--km-text)' },
    }, [def.label + (def.required ? ' *' : '')]);
    var inputAttrs = {
      name: key,
      placeholder: def.placeholder || '',
      style: 'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:var(--km-radius);'
        + 'border:1px solid var(--km-input-border);background:var(--km-input-bg);color:var(--km-text);'
        + 'font-size:14px;outline:none;font-family:inherit;',
    };
    if (def.required) inputAttrs.required = 'required';
    if (key === 'phone') { inputAttrs.inputmode = 'numeric'; inputAttrs.pattern = '[0-9]{10}'; inputAttrs.maxlength = '10'; }
    var input = def.type === 'textarea'
      ? el('textarea', Object.assign({ rows: '3' }, inputAttrs))
      : el('input',    Object.assign({ type: def.type }, inputAttrs));
    input.addEventListener('focus', function () { input.style.borderColor = 'var(--km-primary)'; input.style.boxShadow = '0 0 0 3px ' + hexToRgba(getComputedStyle(input.parentElement.parentElement).getPropertyValue('--km-primary').trim() || DEFAULT_PRIMARY, 0.15); });
    input.addEventListener('blur',  function () { input.style.borderColor = 'var(--km-input-border)'; input.style.boxShadow = 'none'; });
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([a-f0-9]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(0,0,0,' + alpha + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function showError(form, msg) {
    var existing = form.querySelector('[data-km-err]');
    if (existing) existing.remove();
    var box = el('div', {
      'data-km-err': '1',
      style: {
        background: 'rgba(239, 68, 68, 0.10)', border: '1px solid rgba(239, 68, 68, 0.35)',
        color: 'rgb(239, 68, 68)', borderRadius: 'var(--km-radius)',
        padding: '8px 12px', fontSize: '12px', marginBottom: '10px', fontWeight: '600',
      },
    }, [msg]);
    form.insertBefore(box, form.firstChild);
  }

  function showSuccess(root, msg) {
    var node = el('div', {
      style: {
        textAlign: 'center', padding: '24px 8px',
        background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.35)',
        color: 'rgb(34, 197, 94)', borderRadius: 'var(--km-radius)', fontWeight: '600', fontSize: '14px',
      },
    }, ['✓ ' + msg]);
    root.innerHTML = '';
    root.appendChild(node);
  }

  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
  function validPhone(s) { return /^[0-9]{10}$/.test(String(s).replace(/\D/g, '')); }

  function buildForm(root) {
    var url = root.getAttribute('data-kinematic-form');
    if (!url) return;
    if (root.__kmInit) return; // idempotent
    root.__kmInit = true;

    var primary = root.getAttribute('data-primary-color') || DEFAULT_PRIMARY;
    var radius  = parseInt(root.getAttribute('data-radius') || '10', 10);
    var theme   = (root.getAttribute('data-theme') || 'light').toLowerCase();
    var title   = root.getAttribute('data-title') || 'Get a callback';
    var success = root.getAttribute('data-success') || 'Thanks! We\'ll be in touch shortly.';
    var fieldsAttr = (root.getAttribute('data-fields') || 'name,email,phone,city,message').toLowerCase();
    var fieldKeys = fieldsAttr.split(',').map(function (s) { return s.trim(); }).filter(function (k) { return FIELD_DEFS[k]; });
    if (fieldKeys.length === 0) fieldKeys = ['name', 'email', 'phone', 'city'];

    applyTheme(root, primary, radius, theme);

    var heading = el('div', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '14px', color: 'var(--km-text)' } }, [title]);
    var form = el('form', { novalidate: 'novalidate', style: { margin: '0' } });

    fieldKeys.forEach(function (k) { form.appendChild(field(k, FIELD_DEFS[k])); });

    var btn = el('button', {
      type: 'submit',
      style: 'width:100%;background:var(--km-primary);color:#fff;border:none;padding:11px 16px;'
        + 'border-radius:var(--km-radius);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;',
    }, ['Submit']);
    form.appendChild(btn);

    var poweredBy = el('div', {
      style: { fontSize: '10px', color: 'var(--km-muted)', textAlign: 'center', marginTop: '10px' },
    }, ['Powered by Kinematic']);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      fieldKeys.forEach(function (k) {
        var inp = form.querySelector('[name="' + k + '"]');
        if (inp) data[k] = (inp.value || '').trim();
      });
      // Client-side validation — required + format checks.
      for (var i = 0; i < fieldKeys.length; i++) {
        var k = fieldKeys[i];
        if (FIELD_DEFS[k].required && !data[k]) return showError(form, FIELD_DEFS[k].label + ' is required');
      }
      if (data.email && !validEmail(data.email)) return showError(form, 'Please enter a valid email address');
      if (data.phone && !validPhone(data.phone)) return showError(form, 'Mobile must be a 10-digit number');

      data.referrer_url = window.location.href;
      btn.disabled = true; btn.textContent = 'Sending…';

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok !== false, j: j, status: r.status }; });
      }).then(function (out) {
        if (out.ok) showSuccess(root, success);
        else { btn.disabled = false; btn.textContent = 'Submit'; showError(form, (out.j && (out.j.error || out.j.message)) || ('Submission failed (HTTP ' + out.status + ')')); }
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Submit';
        showError(form, err && err.message ? err.message : 'Network error — please retry');
      });
    });

    root.innerHTML = '';
    root.appendChild(heading);
    root.appendChild(form);
    root.appendChild(poweredBy);
  }

  function scan() {
    var nodes = document.querySelectorAll('[data-kinematic-form]');
    for (var i = 0; i < nodes.length; i++) buildForm(nodes[i]);
  }

  // Initial scan + SPA-friendly mutation observer so dynamically-rendered
  // host elements still pick up the form without a manual call.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  if (window.MutationObserver) {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Public API for hosts that want imperative control.
  window.Kinematic = window.Kinematic || {};
  window.Kinematic.render = scan;
})();
