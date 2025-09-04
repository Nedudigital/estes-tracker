// /api/track/estes.js
const ENDPOINT = 'https://www.estes-express.com/shipmenttracking/services/ShipmentTrackingService';

function corsHeaders(origin, allowList) {
  if (!allowList) return { 'Access-Control-Allow-Origin': '*' };
  const allowed = allowList.split(',').map(s => s.trim());
  const isAllowed = allowed.includes('*') || (origin && allowed.includes(origin));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin, process.env.CORS_ALLOW);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers).end();
    return;
  }

  try {
    const pro = (req.query.pro || '').toString().replace(/\D/g, ''); // keep leading zeros
    const mock = req.query.mock === '1';
    if (!pro) return res.status(400).set(headers).json({ error: 'Missing or invalid PRO' });

    const user = process.env.ESTES_USER;
    const pass = process.env.ESTES_PASS;

    // No creds yet or explicit mock → return realistic fake so you can wire UI now
    if (mock || !user || !pass) {
      return res.status(200).set(headers).json({
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
      });
    }

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
      </soapenv:Envelope>
    `.trim();

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'search' },
      body: soap
    });

    const xml = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).set(headers).json({ error: 'Estes service error', status: resp.status });
    }

    const pick = (re) => (xml.match(re) || [])[1] || null;
    const status =
      pick(/<statusDescription>\s*([^<]+)\s*<\/statusDescription>/i) ||
      pick(/<ship:statusDescription>\s*([^<]+)\s*<\/ship:statusDescription>/i) ||
      pick(/<status>\s*([^<]+)\s*<\/status>/i);
    const est =
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

    res.status(200)
      .set({ ...headers, 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' })
      .json({ carrier: 'Estes', pro, status, estimatedDelivery: est, pieces, weight, events });

  } catch (e) {
    res.status(500).set(headers).json({ error: 'Server exception', details: String(e) });
  }
}
