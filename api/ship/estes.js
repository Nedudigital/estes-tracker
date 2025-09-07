// api/ship/estes.js — Vercel Node function
const ENDPOINT = 'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

// CORS helper (adds Vary: Origin to avoid CDN caching the wrong ACAO)
function cors(origin, allowList) {
  if (!allowList) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
  }
  const allow = allowList.split(',').map(s => s.trim());
  const allowAny = allow.includes('*');
  const ok = allowAny || (origin && allow.includes(origin));
  const value = ok ? (allowAny ? '*' : origin) : (allow[0] || '*');
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function send(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(data === null ? '' : JSON.stringify(data));
}

function mockPayload(pro) {
  return {
    carrier: 'Estes',
    pro,
    status: 'In Transit',
    estimatedDelivery: '09/04/2025 – 09/10/2025',
    pieces: '12',
    weight: '748',
    events: [
      { when: '2025-09-03 08:12', desc: 'Departed Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-02 14:03', desc: 'Arrived at Terminal', city: 'Richmond', state: 'VA' },
      { when: '2025-09-01 09:55', desc: 'Picked Up', city: 'Raleigh', state: 'NC' }
    ]
  };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  const headers = cors(origin, process.env.CORS_ALLOW);

  // Preflight
  if (req.method === 'OPTIONS') return send(res, 204, null, headers);

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pro = (url.searchParams.get('pro') || '').replace(/\D/g, '');
    const mock = url.searchParams.get('mock') === '1';
    if (!pro) return send(res, 400, { error: 'Missing or invalid PRO' }, headers);

    const user = process.env.ESTES_USER;
    const pass = process.env.ESTES_PASS;

    // Mock mode (or no creds yet)
    if (mock || !user || !pass) {
      return send(res, 200, mockPayload(pro), headers);
    }

    // Live SOAP call
    const soap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:ship="http://ws.estesexpress.com/shipmenttracking"
                        xmlns:s1="http://ws.estesexpress.com/schema/2012/12/shipmenttracking">
        <soapenv:Header>
          <ship:auth><ship:user>${user}</ship:user><ship:password>${pass}</ship:password></ship:auth>
        </soapenv:Header>
        <soapenv:Body>
          <s1:search><s1:requestID>${Date.now()}</s1:requestID><s1:pro>${pro}</s1:pro></s1:search>
        </soapenv:Body>
      </soapenv:Envelope>`.trim();

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'search' },
      body: soap
    });

    const xml = await resp.text();
    if (!resp.ok) {
      return send(res, resp.status, { error: 'Estes service error', status: resp.status }, headers);
    }

    const pick = (re) => (xml.match(re) || [])[1] || null;
    const status =
      pick(/<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i) ||
      pick(/<ship:statusDescription>\s*([^<]+)\s*<\/ship:statusDescription>/i) ||
      pick(/<status>\s*([^<]+)\s*<\/status>/i);
    const estimatedDelivery =
      pick(/<deliveryDate>\s*([^<]+)\s*<\/deliveryDate>/i) ||
      pick(/<firstDeliveryDate>\s*([^<]+)\s*<\/firstDeliveryDate>/i) ||
      pick(/<ship:firstDeliveryDate>\s*([^<]+)\s*<\/ship:firstDeliveryDate>/i);
    const pieces = pick(/<pieces>\s*([^<]+)\s*<\/pieces>/i);
    const weight = pick(/<weight>\s*([^<]+)\s*<\/weight>/i);

    const events = [];
    const reEvent = /<shipmentEvent>[\s\S]*?<\/shipmentEvent>/gi;
    let m;
    while ((m = reEvent.exec(xml))) {
      const b = m[0];
      events.push({
        when:  (b.match(/<eventDateTime>\s*([^<]+)\s*<\/eventDateTime>/i) || [])[1] || null,
        desc:  (b.match(/<event>\s*([^<]+)\s*<\/event>/i) || [])[1] || null,
        city:  (b.match(/<city>\s*([^<]+)\s*<\/city>/i) || [])[1] || null,
        state: (b.match(/<state>\s*([^<]+)\s*<\/state>/i) || [])[1] || null
      });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return send(res, 200, { carrier: 'Estes', pro, status, estimatedDelivery, pieces, weight, events }, headers);
  } catch (e) {
    return send(res, 500, { error: 'Server exception', details: String(e) }, headers);
  }
};
