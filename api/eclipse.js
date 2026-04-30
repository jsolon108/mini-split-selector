const ECLIPSE_BASE = 'https://api.johnstonenyct.com:5000';
const https = require('https');

// Reuse TCP connections across Eclipse API calls — without this, each parallel fetch
// opens a new connection, exhausting the pool after a few searches.
const eclipseAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,        // max concurrent connections to Eclipse
  maxFreeSockets: 5,     // keep up to 5 idle connections warm
  timeout: 15000         // 15s socket timeout
});

// Wrapper that always passes the keepAlive agent to Eclipse API calls
const eclipseFetch = (url, opts = {}) => fetch(url, {
  ...opts,
  agent: eclipseAgent,
  headers: { 'Connection': 'keep-alive', ...(opts.headers || {}) }
});

function formatCatalogNumber(model) {
  if (model && model.startsWith('BMS500-')) {
    return model.replace('BMS500-', '');
  }
  return model;
}

async function createSession(username, password) {
  const r = await eclipseFetch(`${ECLIPSE_BASE}/Sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  const data = await r.json();
  return data.sessionToken;
}

function buildOrderPayload(branch, customerAccount, customerPO, orderBy, lines, username) {
  return {
    priceBranch: branch,
    shipBranch: branch,
    glBranch: branch,
    billToCustomer: customerAccount || '',
    shipToCustomer: customerAccount || '',
    customerPONumber: customerPO || '',
    customerReleaseNumber: 'API',
    orderBy: orderBy || '',
    orderType: '',
    lines: lines.map(l => ({
      lineItemProduct: {
        catalogNumber: formatCatalogNumber(l.model),
        quantity: l.qty,
        um: 'EA',
        umQuantity: 1,
        productDescription: l.description || ''
      }
    }))
  };
}

async function postOrder(token, payload) {
  const r = await eclipseFetch(`${ECLIPSE_BASE}/SalesOrders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'sessionToken': token
    },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  return { status: r.status, text };
}

function extractOrderId(text) {
  const data = JSON.parse(text);
  const o = data.results ? data.results[0] : (Array.isArray(data) ? data[0] : data);
  return o.eclipseOid || o.id || null;
}

async function authedFetch(url, options, username, password, sessionToken) {
  let r = await fetch(url, { ...options, headers: { ...options.headers, 'sessionToken': sessionToken } });
  if (r.status === 419) {
    const newToken = await createSession(username, password);
    sessionToken = newToken;
    r = await fetch(url, { ...options, headers: { ...options.headers, 'sessionToken': newToken } });
    r._newToken = newToken;
  }
  return r;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, username, password, sessionToken, branch, customerAccount, customerPO, orderBy, lines, keyword } = req.body;

  // Login
  if (action === 'login') {
    try {
      const r = await eclipseFetch(`${ECLIPSE_BASE}/Sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (r.status === 401) return res.status(401).json({ error: 'Invalid username or password' });
      if (!r.ok) return res.status(r.status).json({ error: `Login failed: ${r.status}` });
      const data = await r.json();
      const token = data.sessionToken;
      const userName = data.sessionUser?.userName;
      let homeBranch = null;
      try {
        const userR = await eclipseFetch(`${ECLIPSE_BASE}/Users/${userName}`, {
          headers: { 'Accept': 'application/json', 'sessionToken': token }
        });
        if (userR.ok) {
          const userData = await userR.json();
          homeBranch = userData.homeBranchId || userData.homeBranch || userData.defaultBranch || null;
        }
      } catch(e) {}
      return res.status(200).json({ sessionToken: token, sessionId: data.id, username: userName, homeBranch });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Customer search
  if (action === 'searchCustomers') {
    try {
      const isNumeric = /^\d+$/.test(keyword.trim());
      let searchUrl = `${ECLIPSE_BASE}/Customers?keyword=${encodeURIComponent(keyword)}&pageSize=25`;
      if (isNumeric) searchUrl += `&id=${encodeURIComponent(keyword.trim())}`;
      const r = await fetch(searchUrl, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!r.ok) return res.status(r.status).json({ error: `Customer search failed: ${r.status}` });
      const data = await r.json();
      const results = (data.results || [])
        .filter(c => c.isBillTo === true && !c.autoDelete)
        .slice(0, 10)
        .map(c => ({
          id: c.id,
          name: c.name,
          city: c.city,
          state: c.state,
          contacts: (c.creditAuthPersonnelList || c.contacts || []).map(ct => ({ id: ct.contactId || ct.name, name: ct.name }))
        }));
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Create order
  if (action === 'order') {
    try {
      const payload = buildOrderPayload(branch, customerAccount, customerPO, orderBy, lines, username);
      let { status, text } = await postOrder(sessionToken, payload);
      if (status === 419) {
        let newToken;
        try {
          newToken = await createSession(username, password);
        } catch {
          return res.status(401).json({ error: 'Session expired — please log out and sign in again.' });
        }
        const retry = await postOrder(newToken, payload);
        status = retry.status;
        text = retry.text;
        if (status === 200 || status === 201) {
          return res.status(200).json({ success: true, orderId: extractOrderId(text), newToken });
        }
        return res.status(status).json({ error: `Order failed: ${status}`, detail: text });
      }
      if (status !== 200 && status !== 201) {
        return res.status(status).json({ error: `Order failed: ${status}`, detail: text });
      }
      const orderId = extractOrderId(text);
      return res.status(200).json({ success: true, orderId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Get pricing and inventory
  if (action === 'pricing') {
    try {
      const { customerId, userId, userBranch, catalogNumbers, catalogPairs } = req.body;
      const userIdUpper = (userId || '').toUpperCase();
      const FARM = 'FARM';

      // Normalize input. New clients send `catalogPairs: [{cat, order}]`.
      // Old clients send `catalogNumbers: [...]` — we treat each as a pair with no order #.
      const pairs = Array.isArray(catalogPairs) && catalogPairs.length
        ? catalogPairs.filter(p => p && p.cat).map(p => ({ cat: String(p.cat), order: p.order ? String(p.order) : null }))
        : (catalogNumbers || []).filter(Boolean).map(cn => ({ cat: String(cn), order: null }));

      // Helper: does Eclipse's productDescription identify this product as the one we want
      // (i.e. starts with the Johnstone order #)? Eclipse stores descriptions like
      // "G38-428 711 1/2IN SEALING LOCKNUT" — order # is a leading token.
      const descMatchesOrder = (desc, order) => {
        if (!desc || !order) return false;
        const d = String(desc).toUpperCase().trim();
        const o = String(order).toUpperCase().trim();
        if (d.startsWith(o + ' ') || d.startsWith(o + '-') || d.startsWith(o + ':')) return true;
        const re = new RegExp('(^|[^A-Z0-9])' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Z0-9])');
        return re.test(d);
      };

      // ─── Pricing pass (also yields inventory via stockInfo) ──────────
      // The pricing endpoint returns price, productDescription, totalWarehouseQty,
      // and per-warehouse stockInfo — everything we need in one call.
      // This replaces the previous separate inventory pass, which used a different
      // endpoint that returned different/missing fields and broke disambiguation.
      // Eclipse caps results around ~20-25 per call, so batch.
      const cats = pairs.map(p => p.cat);
      const uniqueCats = [...new Set(cats)];
      let allResults = [];
      const BATCH_SIZE = 20;
      for (let i = 0; i < uniqueCats.length; i += BATCH_SIZE) {
        const batch = uniqueCats.slice(i, i + BATCH_SIZE);
        const pricingByIdParams = new URLSearchParams();
        batch.forEach(cn => pricingByIdParams.append('CatalogNumber', cn));
        pricingByIdParams.append('Quantity', '1');
        if (customerId) pricingByIdParams.append('CustomerId', customerId);
        pricingByIdParams.append('CalculateOnlyForBranch', userBranch);
        const pricingUrl = `${ECLIPSE_BASE}/ProductInventoryPricingMassInquiry?` + pricingByIdParams.toString();
        const pricingRes = await fetch(pricingUrl, {
          headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
        });
        // 401 on any batch means the session is dead — surface to the client so it can
        // prompt re-login. Without this, expired sessions silently produce empty pricing.
        if (pricingRes.status === 401) {
          return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
        }
        if (!pricingRes.ok) continue;
        const pricingText = await pricingRes.text();
        try {
          const pricingData = JSON.parse(pricingText);
          allResults = allResults.concat(pricingData.results || []);
        } catch { /* ignore parse errors on a single batch */ }
      }

      // Map each pair to the right result(s).
      // For each pair we filter Eclipse's results down to ones that "belong" to it.
      // Eclipse may return multiple products for an ambiguous catalog # like "711" —
      // we use the order # (when present) to pick the right one via descMatchesOrder.
      const pricingMap = {};
      const invMap = {};
      const debugAmbiguous = [];

      for (const { cat, order } of pairs) {
        const outKey = order || cat;
        // Pricing endpoint doesn't echo back the requested catalog #, but multiple results
        // for the same query share that query context. We need to identify which results
        // came from THIS catalog query. Approach: look at all returned descriptions and
        // find ones whose description CONTAINS the catalog # as a token. (Eclipse's
        // descriptions reliably embed the manufacturer part #.)
        const catUpper = cat.toUpperCase();
        const candidatesForCat = allResults.filter(r => {
          const desc = String(r.productDescription || '').toUpperCase();
          // Match the cat as a whole word (handles dashes/no-dashes, e.g. "AAS036-1CSXLD" → "AAS0361CSXLD")
          const noDashCat = catUpper.replace(/-/g, '');
          const noDashDesc = desc.replace(/-/g, '');
          return desc.includes(catUpper) || noDashDesc.includes(noDashCat);
        });

        let item = null;
        if (candidatesForCat.length === 1) {
          item = candidatesForCat[0];
        } else if (candidatesForCat.length > 1) {
          // Disambiguate via order #
          if (order) {
            item = candidatesForCat.find(r => descMatchesOrder(r.productDescription, order));
          }
          if (!item) {
            // No order # or order # didn't match — record for debug, refuse to guess
            debugAmbiguous.push({
              cat, order,
              descriptions: candidatesForCat.map(r => r.productDescription)
            });
            invMap[outKey] = { userQty: 0, farmQty: 0, total: 0, ambiguous: true, noOrderMatch: !!order };
            continue;
          }
        } else {
          // 0 results — not found in Eclipse at all
          invMap[outKey] = { userQty: 0, farmQty: 0, total: 0 };
          continue;
        }

        // Got one. Extract pricing.
        pricingMap[outKey] = {
          price: item.unitPrice?.value ?? item.productUnitPrice?.value ?? null,
          list: item.listPrice?.value ?? item.list?.value ?? null
        };
        // Extract inventory from stockInfo / totalWarehouseQty
        const stock = item.stockInfo || [];
        invMap[outKey] = {
          userQty: stock.find(s => (s.warehouse || '').startsWith(userBranch))?.warehouseQty ?? 0,
          farmQty: stock.find(s => (s.warehouse || '').startsWith(FARM))?.warehouseQty ?? 0,
          total: item.totalWarehouseQty ?? 0,
          productId: item.productId,
          ambiguous: candidatesForCat.length > 1
        };
      }

      // ─── Fallback for items that returned no pricing results ──────
      // Eclipse's pricing endpoint does strict catalog # matching, including whitespace
      // (e.g. "WBB-300SS" vs "WBB-300SS " with trailing space). For pairs that returned
      // nothing, try resolving the canonical catalog # via Products/BasicInformation
      // (which is more lenient) and retry pricing once with the canonical form.
      const unresolvedPairs = pairs.filter(p => !(p.order || p.cat) || !pricingMap[p.order || p.cat]);
      const retried = [];
      for (const { cat, order } of unresolvedPairs) {
        const outKey = order || cat;
        // Only retry if we haven't already gotten a real (non-empty) inventory for this key.
        // Skip noOrderMatch entries — those are ambiguity failures, not lookup failures.
        if (invMap[outKey]?.noOrderMatch) continue;
        try {
          const searchKeyword = order || cat; // order # is the more unique search term when present
          const searchR = await eclipseFetch(`${ECLIPSE_BASE}/Products/BasicInformation?keyword=${encodeURIComponent(searchKeyword)}&pageSize=5`, {
            headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
          });
          if (searchR.status === 401) {
            return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
          }
          if (!searchR.ok) continue;
          const searchData = await searchR.json();
          const items = searchData.results || [];
          if (!items.length) continue;
          // Pick the right item: when we have an order #, find one whose description starts with it.
          let canonical = null;
          for (const it of items) {
            const info = it.basicInfo || [];
            const get = k => info.find(i => i.key === k)?.value || '';
            const cn = get('catalogNumber');
            const desc = (get('description') || '').replace(/\n/g, ' ').trim();
            if (!cn) continue;
            if (order && descMatchesOrder(desc, order)) { canonical = { cat: cn, desc }; break; }
            if (!canonical) canonical = { cat: cn, desc };
          }
          if (!canonical) continue;

          // Re-query pricing with the canonical catalog # (preserving whitespace)
          const pp = new URLSearchParams();
          pp.append('CatalogNumber', canonical.cat);
          pp.append('Quantity', '1');
          if (customerId) pp.append('CustomerId', customerId);
          pp.append('CalculateOnlyForBranch', userBranch);
          const pr = await eclipseFetch(`${ECLIPSE_BASE}/ProductInventoryPricingMassInquiry?` + pp.toString(), {
            headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
          });
          if (pr.status === 401) {
            return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
          }
          if (!pr.ok) continue;
          const pd = await pr.json();
          const item = (pd.results || [])[0];
          if (!item) continue;
          pricingMap[outKey] = {
            price: item.unitPrice?.value ?? item.productUnitPrice?.value ?? null,
            list: item.listPrice?.value ?? item.list?.value ?? null
          };
          const stock = item.stockInfo || [];
          invMap[outKey] = {
            userQty: stock.find(s => (s.warehouse || '').startsWith(userBranch))?.warehouseQty ?? 0,
            farmQty: stock.find(s => (s.warehouse || '').startsWith(FARM))?.warehouseQty ?? 0,
            total: item.totalWarehouseQty ?? 0,
            productId: item.productId,
            ambiguous: false,
            resolved: canonical.cat // for debugging
          };
          retried.push({ from: cat, to: canonical.cat, outKey });
        } catch (e) { /* skip on error */ }
      }

      return res.status(200).json({
        userBranch,
        pricing: pricingMap,
        inventory: invMap,
        rawPricing: allResults.slice(0, 2),
        rawInv: Object.entries(invMap).slice(0, 2),
        debug: {
          requestedCount: pairs.length,
          pricingReturned: allResults.length,
          mappedCount: Object.keys(pricingMap).length,
          pairsWithOrder: pairs.filter(p => p.order).length,
          pairsWithoutOrder: pairs.filter(p => !p.order).length,
          ambiguousUnresolved: debugAmbiguous,
          retriedViaSearch: retried,
          firstResultKeys: allResults[0] ? Object.keys(allResults[0]) : []
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Search recent orders by customer
  if (action === 'searchOrders') {
    try {
      const { customerId, username, orderStatus, productCatalog } = req.body;
      const params = new URLSearchParams();
      if (customerId) params.append('BillTo', customerId);
      if (username) params.append('Writer', username.toUpperCase());
      if (orderStatus === 'open') {
        ['ShipWhenAvailable','CallWhenAvailable','ShipWhenComplete','CallWhenComplete'].forEach(s => params.append('OrderStatus', s));
      } else {
        params.append('OrderStatus', 'Bid');
      }
      // Try server-side product filter (Eclipse may ignore this param if it doesn't support it;
      // we also filter client-side below as a safety net).
      if (productCatalog) params.append('CatalogNumber', String(productCatalog));
      params.append('pageSize', '200');
      params.append('sort', '-OrderDate');
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      params.append('OrderDateStart', start.toISOString());
      const r = await eclipseFetch(`${ECLIPSE_BASE}/SalesOrders?` + params.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (r.status === 401) return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
      if (!r.ok) return res.status(r.status).json({ error: `Order search failed: ${r.status}` });
      const data = await r.json();
      let orders = (data.results || data || []).map(o => {
        const gen = o.generations?.[0] || {};
        return {
          id: (o.id || o.eclipseOid || '').replace(/\.\d+$/, ''),
          date: gen.orderDate || o.orderDate,
          customer: gen.shipToName || o.billToCustomer,
          customerId: gen.billToId,
          branch: gen.shipBranch,
          orderedBy: gen.orderedByName,
          writer: gen.writer,
          status: gen.status,
          po: gen.poNumber || '',
          total: gen.salesTotal?.value,
          lines: (o.lines || []).map(l => ({
            description: l.productDecription?.split('\n')[0],
            qty: l.orderQty,
            status: l.status,
            id: l.productId
          })).slice(0, 10)
        };
      });

      // Client-side product filter — runs whether or not Eclipse honored the server-side param.
      // Match against line description (case-insensitive substring) — covers both SKU codes
      // (which appear as a token in the description like "B88-363 83869 ...") and product
      // names ("condensate pump"). Also match against productId for direct numeric SKUs.
      if (productCatalog) {
        const needle = String(productCatalog).toLowerCase().trim();
        const needleNoDash = needle.replace(/-/g, '');
        orders = orders.filter(o => (o.lines || []).some(l => {
          const desc = (l.description || '').toLowerCase();
          if (desc.includes(needle)) return true;
          if (needleNoDash && desc.replace(/-/g, '').includes(needleNoDash)) return true;
          if (l.id && String(l.id).toLowerCase() === needle) return true;
          return false;
        }));
      }

      orders.sort((a, b) => (b.id || '').localeCompare(a.id || '', undefined, {numeric: true}));
      return res.status(200).json({ orders });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Branch inventory lookup for a single product
  if (action === 'branchInventory') {
    try {
      const { catalogNumber, username } = req.body;
      const cleanCatalog = catalogNumber.replace(/^BMS500-/, '');
      const params = new URLSearchParams();
      params.append('CatalogNumber', cleanCatalog);
      params.append('ConsiderUserAuthBranch', 'true');
      if (username) params.append('UserId', username.toUpperCase());
      const r = await eclipseFetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?` + params.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!r.ok) return res.status(r.status).json({ error: `Inventory lookup failed: ${r.status}` });
      const data = await r.json();
      const item = (data.results || [])[0];
      if (!item) return res.status(200).json({ branches: [] });
      const branches = (item.branchAvailableQuantity || [])
        .map(b => {
          const code = b.warehouse.split(' ')[0];
          return { code, qty: b.warehouseQty || 0 };
        })
        .sort((a, b) => a.code.localeCompare(b.code));
      return res.status(200).json({ branches, total: item.totalWarehouseQty, debug: cleanCatalog });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Search open orders by customer
  if (action === 'searchOpenOrders') {
    try {
      const { customerId, username, productCatalog } = req.body;
      const params = new URLSearchParams();
      if (customerId) params.append('BillTo', customerId);
      if (username) params.append('Writer', username.toUpperCase());
      ['ShipWhenAvailable','CallWhenAvailable','ShipWhenComplete','CallWhenComplete','ShipItemComplete','PickUpNow','ShipWhenSpecified','CallWhenSpecified'].forEach(s => params.append('OrderStatus', s));
      // Try server-side product filter (Eclipse may ignore it; we filter client-side too).
      if (productCatalog) params.append('CatalogNumber', String(productCatalog));
      params.append('pageSize', '50');
      const r = await eclipseFetch(`${ECLIPSE_BASE}/SalesOrders?` + params.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (r.status === 401) return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
      if (!r.ok) return res.status(r.status).json({ error: `Order search failed: ${r.status}` });
      const data = await r.json();
      let orders = (data.results || data || []).map(o => {
        const gen = o.generations?.[0] || {};
        return {
          id: (o.id || o.eclipseOid || '').replace(/\.\d+$/, ''),
          date: gen.orderDate || o.orderDate,
          customer: gen.shipToName || o.billToCustomer,
          branch: gen.shipBranch,
          orderedBy: gen.orderedByName,
          status: gen.status,
          po: gen.poNumber || '',
          total: gen.salesTotal?.value,
          lines: (o.lines || []).map(l => ({
            description: l.productDecription?.split('\n')[0],
            qty: l.orderQty,
            status: l.status,
            id: l.productId
          })).slice(0, 15)
        };
      });

      // Client-side product filter as a safety net (matches the searchOrders logic above)
      if (productCatalog) {
        const needle = String(productCatalog).toLowerCase().trim();
        const needleNoDash = needle.replace(/-/g, '');
        orders = orders.filter(o => (o.lines || []).some(l => {
          const desc = (l.description || '').toLowerCase();
          if (desc.includes(needle)) return true;
          if (needleNoDash && desc.replace(/-/g, '').includes(needleNoDash)) return true;
          if (l.id && String(l.id).toLowerCase() === needle) return true;
          return false;
        }));
      }

      orders.sort((a, b) => parseInt((b.id||'').replace(/\D/g,''),10) - parseInt((a.id||'').replace(/\D/g,''),10));
      return res.status(200).json({ orders });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Lightweight product search — for typeahead / picker UIs.
  // Returns up to 30 matches with stock info, sorted in-stock first.
  // We do ONE batch inventory call for all hits (not N individual calls) to keep this fast.
  if (action === 'searchProductsLite') {
    try {
      const { keyword, userBranch, userId } = req.body;
      if (!keyword || keyword.trim().length < 2) return res.status(200).json({ results: [] });
      const branch = userBranch || 'FARM';
      const userIdUpper = (userId || '').toUpperCase();
      const searchR = await eclipseFetch(`${ECLIPSE_BASE}/Products/BasicInformation?keyword=${encodeURIComponent(keyword.trim())}&pageSize=10`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (searchR.status === 401) return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
      if (!searchR.ok) return res.status(searchR.status).json({ error: `Product search failed: ${searchR.status}` });
      const searchData = await searchR.json();
      const raw = (searchData.results || []).map(item => {
        const info = item.basicInfo || [];
        const get = key => info.find(i => i.key === key)?.value || '';
        const description = (get('description') || '').replace(/\n/g, ' ').trim();
        const orderMatch = description.match(/^([A-Z]\d+-\d+)\b/);
        return {
          productId: get('id'),
          catalogNumber: (get('catalogNumber') || '').trim(),
          orderNumber: orderMatch ? orderMatch[1] : null,
          description
        };
      }).filter(r => r.catalogNumber);

      // Inventory lookups — parallel single-SKU calls keyed by productId.
      // The batch ProductId array approach returned empty results in testing,
      // so we fan out instead. Capped at 15 results to limit concurrent calls.
      const invByCat = {};
      if (raw.length) {
        await Promise.all(raw.map(async r => {
          try {
            const params = new URLSearchParams();
            params.append('CatalogNumber', r.catalogNumber);
            params.append('ConsiderUserAuthBranch', 'true');
            if (userIdUpper) params.append('UserId', userIdUpper);
            const invR = await eclipseFetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?` + params.toString(), {
              headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
            });
            if (!invR.ok) return;
            const invData = await invR.json();
            let item = (invData.results || []).find(it => String(it.productId || '') === String(r.productId));
            if (!item) item = (invData.results || [])[0];
            if (!item) return;
            const branches = item.branchAvailableQuantity || [];
            invByCat[r.catalogNumber] = {
              userQty: branches.find(b => b.warehouse?.startsWith(branch))?.warehouseQty ?? 0,
              total: item.totalWarehouseQty ?? 0
            };
          } catch(e) { /* skip */ }
        }));
      }

      // Annotate + sort: in-stock at user's branch first, then in-stock anywhere, then no-stock.
      // Within each tier, preserve Eclipse's original ordering (already roughly relevance-ranked).
      const annotated = raw.map(r => {
        const inv = invByCat[r.catalogNumber] || { userQty: 0, total: 0 };
        let stockTier = 2; // no stock
        if (inv.userQty > 0) stockTier = 0;        // in stock at user's branch
        else if (inv.total > 0) stockTier = 1;     // in stock at another branch
        return { ...r, userQty: inv.userQty, totalQty: inv.total, stockTier };
      });
      annotated.sort((a, b) => {
        if (a.stockTier !== b.stockTier) return a.stockTier - b.stockTier;
        return (a.description || '').localeCompare(b.description || '');
      });

      return res.status(200).json({ results: annotated, userBranch: branch });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Future ledger lookup — aggregates incoming POs across all specified branches.
  // Body: { productIds: [number], branches: [string] }
  // Returns: { ledgers: { [productId]: { totalIncoming, byBranch: [{branch, qty, etas: [{date, qty, poNumber}]}] } } }
  if (action === 'futureLedger') {
    try {
      const { productIds, branches } = req.body;
      if (!Array.isArray(productIds) || !productIds.length) return res.status(200).json({ ledgers: {} });
      const branchList = (Array.isArray(branches) && branches.length) ? branches : ['FARM'];

      // Build all (productId, branch) pairs and fan them out in parallel.
      // ~13 branches × ~5 products = ~65 calls — Promise.all keeps this under one round-trip
      // for most cases (Eclipse can handle the concurrency).
      const calls = [];
      for (const pid of productIds) {
        for (const br of branchList) {
          calls.push((async () => {
            try {
              const url = `${ECLIPSE_BASE}/ProductInquiry/FutureLedger/${encodeURIComponent(pid)}/${encodeURIComponent(br)}`;
              const r = await fetch(url, {
                headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
              });
              if (r.status === 401) return { error: 401 };
              if (!r.ok) return null;
              const data = await r.json();
              return { productId: pid, branch: br, data };
            } catch(e) { return null; }
          })());
        }
      }
      const results = await Promise.all(calls);

      // If any call returned a 401, surface that to trigger the session-expired banner
      if (results.some(r => r?.error === 401)) {
        return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
      }

      // Aggregate into the response shape using the documented FutureLedger schema.
      // Key fields:
      //   data[]        → FutureLedgerLines rows
      //   data[].in     → qty incoming (PO receipts have in > 0)
      //   data[].out    → qty outgoing
      //   data[].date   → ETA date string
      //   data[].orderNumber → PO number
      //   data[].type   → transaction type ('P' = PO receipt, 'T' = transfer, etc.)
      //   data[].customerVendor → vendor name
      //   stock.onPO    → total qty on PO (quick summary without parsing rows)
      //   stock.onTransfer → total qty on inbound transfer
      const ledgers = {};
      for (const r of results) {
        if (!r || !r.data) continue;
        const pid = String(r.productId);
        const br = r.branch;
        if (!ledgers[pid]) ledgers[pid] = { totalIncoming: 0, byBranch: [] };

        const d = r.data;
        // Quick summary totals from the stock object
        const onPO = parseFloat(d.stock?.onPO || 0);
        const onTransfer = parseFloat(d.stock?.onTransfer || 0);
        const branchTotal = onPO + onTransfer;
        if (branchTotal <= 0) continue;

        // Parse individual rows for ETAs
        const rows = d.data || [];
        const etas = rows
          .filter(row => (row.in || 0) > 0) // only incoming rows
          .map(row => ({
            date: row.date || null,
            qty: row.in,
            poNumber: row.orderNumber || '',
            type: row.type || '',
            vendor: row.customerVendor || ''
          }))
          .sort((a, b) => {
            // Sort by date ascending so soonest ETA comes first
            if (!a.date) return 1;
            if (!b.date) return -1;
            return new Date(a.date) - new Date(b.date);
          });

        ledgers[pid].totalIncoming += branchTotal;
        ledgers[pid].byBranch.push({ branch: br, qty: branchTotal, onPO, onTransfer, etas });
      }

      // Sort each product's branches: home branch first, then by qty desc
      const homeBranch = req.body.homeBranch || 'FARM';
      for (const pid of Object.keys(ledgers)) {
        ledgers[pid].byBranch.sort((a, b) => {
          if (a.branch === homeBranch && b.branch !== homeBranch) return -1;
          if (b.branch === homeBranch && a.branch !== homeBranch) return 1;
          return b.qty - a.qty;
        });
      }

      // Include one raw sample for debugging the response shape on first deploy
      const sampleRaw = results.find(r => r?.data && (r.data.results?.length || r.data.receipts?.length));

      return res.status(200).json({
        ledgers,
        debug: {
          callCount: calls.length,
          productCount: productIds.length,
          branchCount: branchList.length,
          successCount: results.filter(r => r && r.data).length,
          sampleResponse: sampleRaw ? sampleRaw.data : null
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Single product image URL lookup — called lazily per-result after search renders.
  if (action === 'productImageUrl') {
    try {
      const { productId } = req.body;
      if (!productId) return res.status(200).json({ url: null });
      const r = await eclipseFetch(`${ECLIPSE_BASE}/Products/${encodeURIComponent(productId)}/ImageUrl?thumbnail=true`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (r.status === 401) return res.status(401).json({ error: 'Eclipse session expired — please sign in again.' });
      if (!r.ok) return res.status(200).json({ url: null }); // 404 = no image, not an error
      const url = await r.json();
      return res.status(200).json({ url: (url && typeof url === 'string' && url.startsWith('http')) ? url : null });
    } catch(err) {
      return res.status(200).json({ url: null }); // never error on a cosmetic feature
    }
  }

  // Search products by keyword with tag-along accessories and inventory
  if (action === 'searchProducts') {
    try {
      const { keyword } = req.body;

      // Step 1: Search by keyword
      const searchR = await eclipseFetch(`${ECLIPSE_BASE}/Products/BasicInformation?keyword=${encodeURIComponent(keyword)}&pageSize=5`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!searchR.ok) return res.status(searchR.status).json({ error: `Product search failed: ${searchR.status}` });
      const searchData = await searchR.json();

      const results = [];
      for (const item of (searchData.results || []).slice(0, 3)) {
        const info = item.basicInfo || [];
        const get = key => info.find(i => i.key === key)?.value || '';
        const productId = get('id');
        const catalogNumber = get('catalogNumber');
        const description = (get('description') || '').replace(/\n/g, ' ').trim();

        // Step 2: Get full product details for tagAlongs
        let tagAlongs = [], substitutes = [];
        if (productId) {
          try {
            const detailR = await eclipseFetch(`${ECLIPSE_BASE}/Products/${productId}`, {
              headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
            });
            if (detailR.ok) {
              const detail = await detailR.json();
              tagAlongs = detail.tagAlongs || [];
              substitutes = detail.substitutes || [];
            }
          } catch(e) {}
        }

        // Step 3: Get total inventory
        let qty = null;
        if (catalogNumber) {
          try {
            const invR = await eclipseFetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?CatalogNumber=${encodeURIComponent(catalogNumber)}&ConsiderUserAuthBranch=true`, {
              headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
            });
            if (invR.ok) {
              const invData = await invR.json();
              qty = invData.results?.[0]?.totalWarehouseQty ?? null;
            }
          } catch(e) {}
        }

        results.push({ id: catalogNumber, catalogNumber, name: description, qty, tagAlongs, substitutes });
      }

      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }


  // Get single product by ID with inventory
  if (action === 'getProduct') {
    try {
      const { productId } = req.body;
      const detailR = await eclipseFetch(`${ECLIPSE_BASE}/Products/${productId}`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!detailR.ok) return res.status(detailR.status).json({ error: 'Product not found' });
      const detail = await detailR.json();

      // Get inventory
      let qty = null;
      if (detail.catalogNumber) {
        try {
          const invR = await eclipseFetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?CatalogNumber=${encodeURIComponent(detail.catalogNumber)}&ConsiderUserAuthBranch=true`, {
            headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
          });
          if (invR.ok) {
            const invData = await invR.json();
            qty = invData.results?.[0]?.totalWarehouseQty ?? null;
          }
        } catch(e) {}
      }

      return res.status(200).json({
        id: detail.id,
        catalogNumber: detail.catalogNumber,
        description: (detail.description || '').replace(/\n/g, ' ').trim(),
        qty,
        tagAlongs: detail.tagAlongs || [],
        substitutes: detail.substitutes || []
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
