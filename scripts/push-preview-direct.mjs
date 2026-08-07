import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const DOMAIN = 'vermietung.brainions.digital';
const hostawayId = process.argv[2] || '172749';
const token = process.env.CHECK24_API_TOKEN;
const base =
  process.env.CHECK24_API_BASE_URL ||
  'https://supplyapistaging.ferienwohnung.check24-test.de/api/v2';

function httpJson(method, urlStr, { authToken, bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlStr.startsWith('http') ? urlStr : `https://${DOMAIN}${urlStr}`);
    const headers = {
      Accept: 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(data
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          }
        : {}),
    };
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const login = await httpJson('POST', '/api/v1/admin/auth/login', {
  body: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
});
const adminToken = JSON.parse(login.body).accessToken;
const preview = await httpJson(
  'GET',
  `/api/v1/admin/check24/preview/${hostawayId}`,
  { authToken: adminToken },
);
const property = JSON.parse(preview.body);

// Try variants
const variants = [
  ['as-is', property],
  [
    'supplier-only-ref',
    {
      ...property,
      referenceIds: [{ reference: 'supplier', id: String(hostawayId) }],
    },
  ],
  [
    'no-group-nulls',
    (() => {
      const p = {
        ...property,
        referenceIds: [{ reference: 'supplier', id: String(hostawayId) }],
      };
      delete p.phone;
      delete p.groupId;
      if (p.groupId == null) delete p.groupId;
      return p;
    })(),
  ],
  [
    'minimal',
    {
      propertyId: property.propertyId,
      referenceIds: [{ reference: 'supplier', id: String(hostawayId) }],
      name: property.name,
      city: property.city,
      countryCode: property.countryCode,
      latitude: property.latitude,
      longitude: property.longitude,
      hostType: property.hostType,
      termsConditions: property.termsConditions,
      maxOccupancy: property.maxOccupancy,
      maxAdults: property.maxAdults,
      pricingMethod: property.pricingMethod,
      currencyCode: 'EUR',
      defaultCancellation: property.defaultCancellation,
      defaultPayment: property.defaultPayment,
      testProperty: true,
      status: 'active',
      type: 'apartment',
      street: property.street,
      zip: property.zip,
      images: property.images?.slice(0, 3),
    },
  ],
];

for (const [label, prop] of variants) {
  // strip nulls
  const cleaned = JSON.parse(
    JSON.stringify(prop, (_, v) => (v === null ? undefined : v)),
  );
  const res = await httpJson('POST', `${base.replace(/\/$/, '')}/properties`, {
    bearer: token,
    body: { properties: [cleaned] },
  });
  console.log('\n===', label, res.status, '===');
  console.log(res.body.slice(0, 1500));
  if (res.status < 400) break;
}
