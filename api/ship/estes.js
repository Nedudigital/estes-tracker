// api/ship/estes.js — Vercel Serverless function
// Live Estes tracking JSON + optional redirect mode for email links.

const ENDPOINT =
  'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

// Build a public Estes deep-link (digits-only PRO recommended)
function deepLink(proDigits) {
  return `https://www.estes-express.com/myestes/shipment-tracking/?type=PRO&proNumbers=${encodeURIComponent(
    proDigits
  )}`;
}

// CORS helper (optional allowlist via CORS_ALLOW; adds Vary: Origin)
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
  const t = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action,
        'User-Agent': 'ArmadilloTough-EstesTracker/1.0 (+vercel)',
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

function parseXml(xml) {
  // SOAP Fault?
  const fault =
    (xml.match(/<faultstring>\s*([^<]+)\s*<\/faultstring>/i) || [])[1] ||
    (xml.match(/<soap:Fault>[\s\S]*?<\/soap:Fault>/i) || [])[0];
  if (fault) return { error: `SOAP fault: ${fault}` };

  const pick = (re) => (xml.match(re) || [])[1] || null;

  // Status: try several tag names
  const status =
    pick(/<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i) ||
    pick(/<ship:statusDescription>\s*([^<]+)\s*<\/ship:statusDescription>/i) ||
    pick(/<currentStatus>\s*([^<]+)\s*<\/currentStatus>/i) ||
    pick(/<status>\s*([^<]+)\s*<\/status>/i);

  // ETA variants
  const estimatedDelivery =
    pick(/<deliveryDate>\s*([^<]+)\s*<\/deliveryDate>/i) ||
    pick(/<estimatedDeliveryDate>\s*([^<]+)\s*<\/estimatedDeliveryDate>/i) ||
    pick(/<firstDeliveryDate>\s*([^<]+)\s*<\/firstDeliveryDate>/i) ||
    pick(/<ship:firstDeliveryDate>\s*([^<]+)\s*<\/ship:firstDeliveryDate>/i);

  // Pieces/weight variants
  const pieces = pick(/<pieces>\s*([^<]+)\s*<\/pieces>/i) || pick(/<totalPieces>\s*([^<]+)\s*<\/totalPieces>/i);
  const weight = pick(/<weight>\s*([^<]+)\s*<\/weight>/i) || pick(/<totalWeight>\s*([^<]+)\s*<\/totalWeight>/i);

  // Events (date+time sometimes split)
  const events = [];
  const reEvent = /<shipmentEvent\b[\s\S]*?<\/shipmentEvent>/gi;
  let m;
  while ((m = reEvent.exec(xml))) {
    const b = m[0];
    const dateTime =
      (b.match(/<eventDateTime>\s*([^<]+)\s*<\/eventDateTime>/i) || [])[1] ||
      (() => {
        const d = (b.match(/<eventDate>\s*([^<]+)\s*<\/eventDate>/i) || [])[1];
        const t = (b.match(/<eventTime>\s*([^<]+)\s*<\/eventTime>/i) || [])[1];
        return d || t ? [d, t].filter(Boolean).join(' ') : null;
      })();

    events.push({
      when: dateTime,
      desc: (b.match(/<event>\s*([^<]+)\s*<\/event>/i) || [])[1] || null,
      city: (b.match(/<city>\s*([^<]+)\s*<\/city>/i) || [])[1] || null,
      state: (b.match(/<state>\s*([^<]+)\s*<\/state>/i) || [])[1] || null,
    });
  }

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

    if (!pro) return send(res, 400, { error: 'Missing or invalid PRO' }, headers);

    // Redirect mode (for email links)
    if (format === 'redirect') {
      res.writeHead(302, { Location: deepLink(pro), ...headers });
      return res.end();
    }

    const user = process.env.ESTES_USER;
    const pass = process.env.ESTES_PASS;

    if (mock || !user || !pass) {
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, mockPayload(pro), headers);
    }

    const soap = buildSoap(pro, user, pass);

    // Try common SOAPAction strings (providers vary)
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

    const parsed = parseXml(result.xml);

    if (parsed.error) {
      const payload = { error: parsed.error, carrier: 'Estes', pro, link: deepLink(pro) };
      if (debug) payload.hint = (result.xml || '').slice(0, 240);
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
