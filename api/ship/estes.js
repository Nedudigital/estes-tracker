// api/ship/estes.js — Vercel Serverless function
// Live Estes tracking via SOAP -> JSON.
// Adds robust XML parsing, debug hints, and optional redirect mode.

const ENDPOINT =
  'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

// Build a public Estes deep-link (digits-only PRO recommended)
function deepLink(proDigits) {
  return `https://www.estes-express.com/myestes/shipment-tracking/?type=PRO&proNumbers=${encodeURIComponent(
    proDigits
  )}`;
}

// CORS helper
function cors(origin, allowList) {
  if (!allowList) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  }
  const allow = allowList.split(',').map((s) => s.trim()).filter(Boolean);
  const any = allow.includes('*');
  const ok = any || (origin && allow.includes(origin));
  return {
    'Access-Control-Allow-Origin': ok ? (any ? '*' : origin) : allow[0] || '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function send(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(data == null ? '' : JSON.stringify(data));
}

function mockPayload(pro) {
  return {
    carrier: 'Estes',
    pro,
    status: 'In Transit',
    estimatedDelivery: '2025-09-04 – 2025-09-10',
    pieces: '12',
    weight: '748',
    events: [
      { when: '2025-09-03 08:12', desc: 'Departed Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-02 14:03', desc: 'Arrived at Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-01 09:55', desc: 'Picked Up', city: 'Raleigh', state: 'NC' },
    ],
    link: deepLink(pro),
    mock: true,
  };
}

// ---- SOAP helpers ----------------------------------------------------------

function buildSoap(pro, user, pass) {
  return `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:ship="http://ws.estesexpress.com/shipmenttracking"
                    xmlns:s1="http://ws.estesexpress.com/schema/2012/12/shipmenttracking">
    <soapenv:Header>
      <ship:auth>
        <ship:user>${user}</ship:user>
        <ship:password>${pass}</ship:password>
      </ship:auth>
    </soapenv:Header>
    <soapenv:Body>
      <s1:search>
        <s1:requestID>${Date.now()}</s1:requestID>
        <s1:pro>${pro}</s1:pro>
      </s1:search>
    </soapenv:Body>
  </soapenv:Envelope>`.replace(/\n\s+/g, ' ').trim();
}

async function soapRequest(soap, action) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action,
        'User-Agent': 'ArmadilloTough-EstesTracker/1.1 (+vercel)',
      },
      body: soap,
      signal: controller.signal,
    });
    const xml = await resp.text();
    return { ok: resp.ok, status: resp.status, xml };
  } catch (e) {
    return { ok: false, status: 599, xml: `__NETWORK__ ${String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

// ---- XML parsing -----------------------------------------------------------

function pick(xml, patterns) {
  for (const re of patterns) {
    const m = xml.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function parseEvents(xml) {
  const events = [];

  // 1) <shipmentEvent> ... </shipmentEvent>
  const re1 = /<shipmentEvent\b[\s\S]*?<\/shipmentEvent>/gi;

  // 2) <eventDetail> ... </eventDetail>  (common in some Estes payloads)
  const re2 = /<eventDetail\b[\s\S]*?<\/eventDetail>/gi;

  // 3) generic <event> blocks but avoid the enclosing <eventList>
  const re3 = /<event\b[\s\S]*?<\/event>/gi;

  const blocks = [];
  let m;
  while ((m = re1.exec(xml))) blocks.push(m[0]);
  while ((m = re2.exec(xml))) blocks.push(m[0]);

  // Only use generic <event> if we didn't find the specific ones
  if (blocks.length === 0) {
    while ((m = re3.exec(xml))) {
      const b = m[0];
      if (!/^\s*<eventList/i.test(b)) blocks.push(b);
    }
  }

  for (const b of blocks) {
    const when =
      pick(b, [
        /<eventDateTime>\s*([^<]+)\s*<\/eventDateTime>/i,
        /<statusDateTime>\s*([^<]+)\s*<\/statusDateTime>/i,
        /<statusDate>\s*([^<]+)\s*<\/statusDate>/i,
        /<eventDate>\s*([^<]+)\s*<\/eventDate>/i,
      ]) ||
      (() => {
        const d =
          pick(b, [
            /<eventDate>\s*([^<]+)\s*<\/eventDate>/i,
            /<statusDate>\s*([^<]+)\s*<\/statusDate>/i,
            /<date>\s*([^<]+)\s*<\/date>/i,
          ]) || '';
        const t =
          pick(b, [
            /<eventTime>\s*([^<]+)\s*<\/eventTime>/i,
            /<statusTime>\s*([^<]+)\s*<\/statusTime>/i,
            /<time>\s*([^<]+)\s*<\/time>/i,
          ]) || '';
        return (d || t) ? [d, t].filter(Boolean).join(' ') : null;
      })();

    const desc = pick(b, [
      /<statusCodeDescription>\s*([^<]+)\s*<\/statusCodeDescription>/i,
      /<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i,
      /<event>\s*([^<]+)\s*<\/event>/i,
      /<description>\s*([^<]+)\s*<\/description>/i,
    ]);

    const city = pick(b, [
      /<statusCity>\s*([^<]+)\s*<\/statusCity>/i,
      /<city>\s*([^<]+)\s*<\/city>/i,
    ]);

    const state = pick(b, [
      /<statusState>\s*([^<]+)\s*<\/statusState>/i,
      /<state>\s*([^<]+)\s*<\/state>/i,
    ]);

    if (when || desc || city || state) {
      events.push({ when, desc, city, state });
    }
  }

  return events;
}

function parseXml(xml) {
  // SOAP Fault?
  const fault =
    (xml.match(/<faultstring>\s*([^<]+)\s*<\/faultstring>/i) || [])[1] ||
    (xml.match(/<soap:Fault>[\s\S]*?<\/soap:Fault>/i) || [])[0];
  if (fault) return { error: `SOAP fault: ${fault}` };

  // Some Estes responses wrap in <ship:trackingInfo> … grab inside for searching
  const trackingInfoBlock =
    (xml.match(/<(?:\w+:)?trackingInfo\b[\s\S]*?<\/(?:\w+:)?trackingInfo>/i) || [])[0] || xml;

  // Primary fields
  const status =
    pick(trackingInfoBlock, [
      /<statusCodeDescription>\s*([^<]+)\s*<\/statusCodeDescription>/i,
      /<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i,
      /<currentStatus>\s*([^<]+)\s*<\/currentStatus>/i,
      /<status>\s*([^<]+)\s*<\/status>/i,
    ]) || null;

  const estimatedDelivery =
    pick(trackingInfoBlock, [
      /<deliveryDate>\s*([^<]+)\s*<\/deliveryDate>/i,
      /<estimatedDeliveryDate>\s*([^<]+)\s*<\/estimatedDeliveryDate>/i,
      /<firstDeliveryDate>\s*([^<]+)\s*<\/firstDeliveryDate>/i,
      /<deliveryApptDate>\s*([^<]+)\s*<\/deliveryApptDate>/i,
      /<appointmentDate>\s*([^<]+)\s*<\/appointmentDate>/i,
    ]) || null;

  const pieces =
    pick(trackingInfoBlock, [
      /<pieces>\s*([^<]+)\s*<\/pieces>/i,
      /<totalPieces>\s*([^<]+)\s*<\/totalPieces>/i,
      /<pieceCount>\s*([^<]+)\s*<\/pieceCount>/i,
    ]) || null;

  const weight =
    pick(trackingInfoBlock, [
      /<weight>\s*([^<]+)\s*<\/weight>/i,
      /<totalWeight>\s*([^<]+)\s*<\/totalWeight>/i,
      /<weightLbs>\s*([^<]+)\s*<\/weightLbs>/i,
    ]) || null;

  // Events
  const events = parseEvents(trackingInfoBlock);

  if (!status && !estimatedDelivery && events.length === 0) {
    return { error: 'No tracking result in response' };
  }

  return { status, estimatedDelivery, pieces, weight, events };
}

// ---- Handler ---------------------------------------------------------------

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  const headers = cors(origin, process.env.CORS_ALLOW);

  if (req.method === 'OPTIONS') return send(res, 204, null, headers);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, headers);

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const raw = (url.searchParams.get('pro') || '').trim();
    const pro = raw.replace(/\D/g, ''); // digits only
    const mock = url.searchParams.get('mock') === '1';
    const format = url.searchParams.get('format') || 'json';
    const debug = url.searchParams.get('debug') === '1';
    const rawXml = url.searchParams.get('raw') === '1';

    if (!pro) return send(res, 400, { error: 'Missing or invalid PRO' }, headers);

    // Redirect mode (for email links)
    if (format === 'redirect') {
      res.writeHead(302, { Location: deepLink(pro), ...headers });
      return res.end();
    }

    const user = process.env.ESTES_USER;
    const pass = process.env.ESTES_PASS;

    if (mock) {
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, mockPayload(pro), headers);
    }
    if (!user || !pass) {
      return send(res, 500, { error: 'Missing ESTES_USER or ESTES_PASS in env' }, headers);
    }

    const soap = buildSoap(pro, user, pass);

    // Try common SOAPAction strings
    let result = await soapRequest(soap, 'search');
    if (!result.ok || /Fault/i.test(result.xml) || /__NETWORK__/.test(result.xml)) {
      const alt = await soapRequest(soap, 'ShipmentTrackingService/search');
      if (alt.ok || (!result.ok && !alt.ok && alt.status !== result.status)) result = alt;
    }

    if (!result.ok) {
      return send(
        res,
        result.status || 500,
        { error: 'Estes service error', status: result.status, link: deepLink(pro) },
        headers
      );
    }

    if (rawXml) {
      // Debug-only: return the first chunk of XML to inspect schema quickly.
      return send(res, 200, { xml: result.xml.slice(0, 4000) }, headers);
    }

    const parsed = parseXml(result.xml);

    if (parsed.error) {
      const payload = { error: parsed.error, carrier: 'Estes', pro, link: deepLink(pro) };
      if (debug) payload.hint = (result.xml || '').slice(0, 1200);
      return send(res, 404, payload, headers);
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return send(
      res,
      200,
      {
        carrier: 'Estes',
        pro,
        status: parsed.status,
        estimatedDelivery: parsed.estimatedDelivery,
        pieces: parsed.pieces,
        weight: parsed.weight,
        events: parsed.events,
        link: deepLink(pro),
      },
      headers
    );
  } catch (e) {
    return send(res, 500, { error: 'Server exception', details: String(e) }, headers);
  }
};
