import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import LOC from '../lib/bd-locations.mjs';

export const config = { path: ['/api/*', '/client/tracking.js'] };

const env = (k, d = '') => process.env[k] ?? d;
const SITE_URL = env('SITE_URL', 'https://meherluna.store').replace(/\/$/, '');
const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];

class UserError extends Error {}

let _sb;
const sb = () => (_sb ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } }));
const must = ({ data, error }) => { if (error) throw error; return data; };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAdmin(req) {
  if (!env('ADMIN_USER') || !env('ADMIN_PASS')) return false;
  const [scheme, b64] = (req.headers.get('authorization') || '').split(' ');
  if (scheme !== 'Basic' || !b64) return false;
  const decoded = Buffer.from(b64, 'base64').toString();
  const i = decoded.indexOf(':');
  return safeEq(decoded.slice(0, i), env('ADMIN_USER')) && safeEq(decoded.slice(i + 1), env('ADMIN_PASS'));
}

async function settingsMap() {
  const rows = must(await sb().from('settings').select('key,value'));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function deliveryCharge(district, subtotal) {
  const s = await settingsMap();
  const free = Number(s.free_delivery_over || 0);
  if (free > 0 && subtotal >= free) return 0;
  const row = must(await sb().from('district_charges').select('charge').eq('district', district).maybeSingle());
  return row ? row.charge : Number(s.default_charge || 0);
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  try {
    if (path === '/client/tracking.js') return trackingJs();
    if (path === '/api/locations') return json(LOC, 200, { 'Cache-Control': 'public, max-age=86400' });

    if (path === '/api/products' && method === 'GET') {
      const rows = must(await sb().from('products').select('id,slug,name,name_bn,description,price,stock,image,category').eq('active', true).order('id', { ascending: false }));
      return json(rows, 200, { 'Cache-Control': 'public, max-age=30' });
    }

    if (path === '/api/delivery-charge' && method === 'GET') {
      const subtotal = Math.max(0, Number(url.searchParams.get('subtotal')) || 0);
      return json({ charge: await deliveryCharge(url.searchParams.get('district') || '', subtotal) });
    }

    if (path === '/api/orders' && method === 'POST') return await createOrder(req, context);

    if (path === '/api/seo/jsonld') {
      const products = must(await sb().from('products').select('id,slug,name,description,price,stock,image').eq('active', true));
      return json({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Store', name: 'Meherluna', url: SITE_URL, description: 'Authentic beauty and skincare products in Bangladesh', areaServed: 'BD', priceRange: '৳' },
          ...products.map((p) => ({
            '@type': 'Product', name: p.name, description: p.description || undefined, image: p.image || undefined,
            offers: { '@type': 'Offer', priceCurrency: 'BDT', price: p.price, url: SITE_URL, availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
          })),
        ],
      }, 200, { 'Cache-Control': 'public, max-age=600' });
    }

    if (path.startsWith('/api/admin')) {
      if (!isAdmin(req)) return json({ error: 'Login required' }, 401);
      return await admin(req, path, method, url);
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
        return json({ error: path.startsWith('/api/admin') ? 'Server error: ' + (e.message || JSON.stringify(e)) : 'Something went wrong. Please try again.' }, 500);

  }
};

// ---------- orders ----------
async function createOrder(req, context) {
  let b;
  try { b = await req.json(); } catch { throw new UserError('Invalid request'); }

  const name = String(b.name || '').trim().slice(0, 100);
  const phone = String(b.phone || '').replace(/[\s-]/g, '').replace(/^(\+?88)/, '');
  const address = String(b.address || '').trim().slice(0, 300);
  const { division, district, upazila } = b;
  if (!name || !address) throw new UserError('Name and address are required');
  if (!/^01[3-9]\d{8}$/.test(phone)) throw new UserError('Enter a valid Bangladesh mobile number (01XXXXXXXXX)');
  if (!LOC[division] || !LOC[division][district] || !LOC[division][district].includes(upazila)) {
    throw new UserError('Select a valid division, district and upazila');
  }

  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 50) throw new UserError('Cart is empty');
  const qtyById = new Map();
  for (const it of items) {
    const id = Number(it.productId), q = Math.floor(Number(it.qty));
    if (!Number.isInteger(id) || !(q > 0)) throw new UserError('Invalid item in cart');
    qtyById.set(id, (qtyById.get(id) || 0) + q);
  }
  const lines = [...qtyById].map(([productId, qty]) => ({ productId, qty }));

  // basic spam guard: max 3 orders per phone number in 10 minutes
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await sb().from('orders').select('id', { count: 'exact', head: true }).eq('phone', phone).gte('created_at', since);
  if ((count || 0) >= 3) throw new UserError('Too many orders from this number. Please wait a few minutes.');

  const publicId = 'ML' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const { data, error } = await sb().rpc('create_order', {
    p: { publicId, name, phone, division, district, upazila, address, note: String(b.note || '').slice(0, 300), items: lines },
  });
  if (error) {
    const m = String(error.message || '');
    if (m.startsWith('USER:')) throw new UserError(m.slice(5));
    throw error;
  }

  await sendMetaPurchase({ publicId, name, phone, district, total: data.total, contents: data.contents }, req, context, b);
  return json({ ok: true, orderId: publicId, subtotal: data.subtotal, deliveryCharge: data.deliveryCharge, total: data.total, contents: data.contents });
}

// Meta Conversions API (server-side Purchase). Same event_id as the browser Pixel, so Meta de-duplicates.
async function sendMetaPurchase(o, req, context, body) {
  const id = env('META_PIXEL_ID'), token = env('META_CAPI_TOKEN');
  if (!id || !token) return;
  const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: o.publicId,
      action_source: 'website',
      event_source_url: SITE_URL,
      user_data: {
        ph: [sha('880' + o.phone.slice(1))],
        fn: [sha(o.name.split(' ')[0])],
        ct: [sha(o.district)],
        country: [sha('bd')],
        client_ip_address: context?.ip,
        client_user_agent: req.headers.get('user-agent') || undefined,
        fbp: body.fbp ? String(body.fbp).slice(0, 200) : undefined,
        fbc: body.fbc ? String(body.fbc).slice(0, 200) : undefined,
      },
      custom_data: {
        currency: 'BDT', value: o.total, content_type: 'product',
        contents: o.contents.map((l) => ({ id: String(l.id), quantity: l.qty, item_price: l.price })),
      },
    }],
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${id}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) console.error('Meta CAPI error', r.status, await r.text());
  } catch (e) {
    console.error('Meta CAPI failed:', e.message);
  }
}

// ---------- admin ----------
async function admin(req, path, method, url) {
  const [resource, id] = path.replace('/api/admin/', '').split('/');
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await req.json().catch(() => ({})) : {};

  if (resource === 'orders') {
    if (method === 'GET') {
      let q = sb().from('orders').select('*, order_items(name,price,qty)').order('id', { ascending: false }).limit(500);
      const st = url.searchParams.get('status');
      if (st) q = q.eq('status', st);
      return json(must(await q).map(({ order_items, ...o }) => ({ ...o, items: order_items })));
    }
    if (method === 'PATCH') {
      if (!STATUSES.includes(body.status)) throw new UserError('Invalid status');
      must(await sb().from('orders').update({ status: body.status }).eq('id', Number(id)));
      return json({ ok: true });
    }
  }

  if (resource === 'products') {
    if (method === 'GET') return json(must(await sb().from('products').select('*').order('id', { ascending: false })));
    if (method === 'POST') {
      if (!body.name || !(Number(body.price) >= 0)) throw new UserError('Name and price are required');
      let slug = slugify(body.name);
      const exists = must(await sb().from('products').select('id').eq('slug', slug).maybeSingle());
      if (exists) slug += '-' + crypto.randomBytes(2).toString('hex');
      const row = must(await sb().from('products').insert({
        slug, name: String(body.name).trim(), name_bn: body.name_bn || null, description: body.description || null,
        price: Math.round(Number(body.price)), stock: Math.max(0, Math.floor(Number(body.stock) || 0)),
                image: body.image || null, category: body.category || null, active: true,
      }).select('id').single());
      return json({ ok: true, id: row.id });
    }
    if (method === 'PUT') {
      const patch = {};
      for (const k of ['name', 'name_bn', 'description', 'image', 'category']) if (body[k] !== undefined) patch[k] = body[k];
      if (body.price !== undefined) patch.price = Math.max(0, Math.round(Number(body.price)));
      if (body.stock !== undefined) patch.stock = Math.max(0, Math.floor(Number(body.stock)));
      if (body.active !== undefined) patch.active = !!body.active;
      if (Object.keys(patch).length) must(await sb().from('products').update(patch).eq('id', Number(id)));
      return json({ ok: true });
    }
  }

  if (resource === 'settings') {
    if (method === 'GET') {
      const s = await settingsMap();
      const districts = must(await sb().from('district_charges').select('district,charge').order('district'));
      return json({ default_charge: Number(s.default_charge || 0), free_delivery_over: Number(s.free_delivery_over || 0), districts });
    }
    if (method === 'PUT') {
      const rows = [];
      if (body.default_charge !== undefined) rows.push({ key: 'default_charge', value: String(Math.max(0, Math.round(Number(body.default_charge) || 0))) });
      if (body.free_delivery_over !== undefined) rows.push({ key: 'free_delivery_over', value: String(Math.max(0, Math.round(Number(body.free_delivery_over) || 0))) });
      if (rows.length) must(await sb().from('settings').upsert(rows));
      return json({ ok: true });
    }
  }

  // charge = number sets a district price; empty/null removes the override
  if (resource === 'district-charge' && method === 'PUT') {
    const district = String(body.district || '');
    if (!Object.values(LOC).some((d) => d[district])) throw new UserError('Unknown district');
    const c = body.charge;
    if (c === '' || c === null || c === undefined) must(await sb().from('district_charges').delete().eq('district', district));
    else must(await sb().from('district_charges').upsert({ district, charge: Math.max(0, Math.round(Number(c) || 0)) }));
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- tracking script (Meta Pixel + GA4); IDs come from environment variables ----------
function trackingJs() {
  const px = JSON.stringify(env('META_PIXEL_ID'));
  const ga = JSON.stringify(env('GA4_ID'));
  return new Response(`(function(){
var PIXEL=${px},GA=${ga},BASE=new URL(document.currentScript.src).origin;
if(PIXEL){!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',PIXEL);fbq('track','PageView');}
if(GA){var g=document.createElement('script');g.async=true;g.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(GA);document.head.appendChild(g);window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config',GA);}
function gi(l){return(l||[]).map(function(i){return{item_id:String(i.id),item_name:i.name,price:i.price,quantity:i.qty||1}})}
function fc(l){return(l||[]).map(function(i){return{id:String(i.id),quantity:i.qty||1,item_price:i.price}})}
window.mlTrack={
viewProduct:function(p){PIXEL&&fbq('track','ViewContent',{content_ids:[String(p.id)],content_name:p.name,content_type:'product',value:p.price,currency:'BDT'});GA&&gtag('event','view_item',{currency:'BDT',value:p.price,items:gi([p])});},
addToCart:function(p,q){q=q||1;PIXEL&&fbq('track','AddToCart',{content_ids:[String(p.id)],content_name:p.name,content_type:'product',value:p.price*q,currency:'BDT'});GA&&gtag('event','add_to_cart',{currency:'BDT',value:p.price*q,items:gi([{id:p.id,name:p.name,price:p.price,qty:q}])});},
beginCheckout:function(l,t){PIXEL&&fbq('track','InitiateCheckout',{contents:fc(l),content_type:'product',value:t,currency:'BDT',num_items:(l||[]).length});GA&&gtag('event','begin_checkout',{currency:'BDT',value:t,items:gi(l)});},
purchase:function(id,t,l){PIXEL&&fbq('track','Purchase',{contents:fc(l),content_type:'product',value:t,currency:'BDT'},{eventID:id});GA&&gtag('event','purchase',{transaction_id:id,currency:'BDT',value:t,items:gi(l)});}
};
fetch(BASE+'/api/seo/jsonld').then(function(r){return r.json()}).then(function(d){var s=document.createElement('script');s.type='application/ld+json';s.text=JSON.stringify(d);document.head.appendChild(s);}).catch(function(){});
})();`, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' } });
}
