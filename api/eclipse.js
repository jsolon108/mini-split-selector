const ECLIPSE_BASE = 'https://api.johnstonenyct.com:5000';

function formatCatalogNumber(model) {
  if (model && model.startsWith('BMS500-')) {
    return model.replace('BMS500-', '');
  }
  return model;
}

async function createSession(username, password) {
  const r = await fetch(`${ECLIPSE_BASE}/Sessions`, {
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
  const r = await fetch(`${ECLIPSE_BASE}/SalesOrders`, {
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
      const r = await fetch(`${ECLIPSE_BASE}/Sessions`, {
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
        const userR = await fetch(`${ECLIPSE_BASE}/Users/${userName}`, {
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
      const { customerId, userId, userBranch, catalogNumbers } = req.body;
      const userIdUpper = (userId || '').toUpperCase();
      const FARM = 'FARM';
      const invMap = {};
      for (const cn of catalogNumbers) {
        const params = new URLSearchParams();
        params.append('CatalogNumber', cn);
        params.append('ConsiderUserAuthBranch', 'true');
        if (userIdUpper) params.append('UserId', userIdUpper);
        const r = await fetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?` + params.toString(), {
          headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
        });
        if (!r.ok) continue;
        const d = await r.json();
        const results = d.results || [];
        // Eclipse may return multiple matches for a short/ambiguous catalog number (e.g. "711"
        // matching B7711-XXX). Find the result that EXACTLY matches what we asked for; reject the rest.
        const cnLower = String(cn).toLowerCase();
        const item = results.find(it => {
          // Try every plausible catalog field on the result
          const candidates = [
            it.catalogNumber, it.CatalogNumber,
            it.productCatalogNumber, it.ProductCatalogNumber,
            it.product?.catalogNumber, it.product?.CatalogNumber,
          ].filter(Boolean).map(s => String(s).toLowerCase());
          return candidates.includes(cnLower);
        }) || results[0]; // fall back to first if no field-match available
        if (!item) { invMap[cn] = { userQty: 0, farmQty: 0, total: 0 }; continue; }
        const branches = item.branchAvailableQuantity || [];
        invMap[cn] = {
          userQty: branches.find(b => b.warehouse.startsWith(userBranch))?.warehouseQty ?? 0,
          farmQty: branches.find(b => b.warehouse.startsWith(FARM))?.warehouseQty ?? 0,
          total: item.totalWarehouseQty ?? 0,
          productId: item.productId,
          // Track how many results Eclipse actually returned for this catalog#
          // (helpful for debugging short/ambiguous SKUs)
          ambiguous: results.length > 1
        };
      }
      const productIds = Object.values(invMap).map(v => v.productId).filter(Boolean);
      let pricingResults = [];
      if (productIds.length > 0) {
        // Eclipse's ProductInventoryPricingMassInquiry appears to cap returned results
        // (observed ~20-25 max), so batch the request to avoid silent truncation.
        const BATCH_SIZE = 20;
        for (let i = 0; i < catalogNumbers.length; i += BATCH_SIZE) {
          const batch = catalogNumbers.slice(i, i + BATCH_SIZE);
          const pricingByIdParams = new URLSearchParams();
          batch.forEach(cn => pricingByIdParams.append('CatalogNumber', cn));
          pricingByIdParams.append('Quantity', '1');
          if (customerId) pricingByIdParams.append('CustomerId', customerId);
          pricingByIdParams.append('CalculateOnlyForBranch', userBranch);
          const pricingUrl = `${ECLIPSE_BASE}/ProductInventoryPricingMassInquiry?` + pricingByIdParams.toString();
          const pricingRes = await fetch(pricingUrl, {
            headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
          });
          if (!pricingRes.ok) continue;
          const pricingText = await pricingRes.text();
          const pricingData = JSON.parse(pricingText);
          pricingResults = pricingResults.concat(pricingData.results || []);
        }
      }
      const pricingMap = {};
      // Build a productId → catalogNumber lookup from the inventory pass we already did,
      // so we can reliably reverse-map pricing results back to the SKU they came from.
      const pidToCat = {};
      Object.entries(invMap).forEach(([cn, v]) => { if (v?.productId) pidToCat[v.productId] = cn; });
      const requestedSet = new Set((catalogNumbers || []).map(s => String(s)));

      pricingResults.forEach(r => {
        // Try every plausible SKU field on the response row
        const candidateKeys = [
          r.catalogNumber, r.CatalogNumber,
          r.productCatalogNumber, r.ProductCatalogNumber,
          r.catalog_number,
          // Sometimes nested under product
          r.product?.catalogNumber, r.product?.CatalogNumber,
          // Reverse-lookup via productId (we already have this mapping from inventory pass)
          r.productId ? pidToCat[r.productId] : null,
          r.ProductId ? pidToCat[r.ProductId] : null,
        ].filter(Boolean).map(String);

        // Pick the first candidate that we actually requested (so we don't accidentally
        // store under a different normalization Eclipse echoes back)
        let catKey = candidateKeys.find(k => requestedSet.has(k)) || candidateKeys[0];
        if (!catKey) return; // nothing to key on, skip

        pricingMap[catKey] = {
          price: r.unitPrice?.value ?? r.productUnitPrice?.value ?? null,
          list: r.listPrice?.value ?? r.list?.value ?? null
        };
      });
      return res.status(200).json({
        userBranch,
        pricing: pricingMap,
        inventory: invMap,
        rawPricing: pricingResults.slice(0, 2),
        rawInv: Object.entries(invMap).slice(0, 2),
        debug: {
          requestedCount: catalogNumbers?.length || 0,
          returnedCount: pricingResults.length,
          mappedCount: Object.keys(pricingMap).length,
          firstResultKeys: pricingResults[0] ? Object.keys(pricingResults[0]) : []
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Search recent orders by customer
  if (action === 'searchOrders') {
    try {
      const { customerId, username, orderStatus } = req.body;
      const params = new URLSearchParams();
      if (customerId) params.append('BillTo', customerId);
      if (username) params.append('Writer', username.toUpperCase());
      if (orderStatus === 'open') {
        ['ShipWhenAvailable','CallWhenAvailable','ShipWhenComplete','CallWhenComplete'].forEach(s => params.append('OrderStatus', s));
      } else {
        params.append('OrderStatus', 'Bid');
      }
      params.append('pageSize', '20');
      params.append('sort', '-OrderDate');
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      params.append('OrderDateStart', start.toISOString());
      const r = await fetch(`${ECLIPSE_BASE}/SalesOrders?` + params.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!r.ok) return res.status(r.status).json({ error: `Order search failed: ${r.status}` });
      const data = await r.json();
      const orders = (data.results || data || []).map(o => {
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
      const r = await fetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?` + params.toString(), {
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
      const { customerId, username } = req.body;
      const params = new URLSearchParams();
      if (customerId) params.append('BillTo', customerId);
      if (username) params.append('Writer', username.toUpperCase());
      ['ShipWhenAvailable','CallWhenAvailable','ShipWhenComplete','CallWhenComplete','ShipItemComplete','PickUpNow','ShipWhenSpecified','CallWhenSpecified'].forEach(s => params.append('OrderStatus', s));
      params.append('pageSize', '50');
      const r = await fetch(`${ECLIPSE_BASE}/SalesOrders?` + params.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!r.ok) return res.status(r.status).json({ error: `Order search failed: ${r.status}` });
      const data = await r.json();
      const orders = (data.results || data || []).map(o => {
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
      orders.sort((a, b) => parseInt((b.id||'').replace(/\D/g,''),10) - parseInt((a.id||'').replace(/\D/g,''),10));
      return res.status(200).json({ orders });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Search products by keyword with tag-along accessories and inventory
  if (action === 'searchProducts') {
    try {
      const { keyword } = req.body;

      // Step 1: Search by keyword
      const searchR = await fetch(`${ECLIPSE_BASE}/Products/BasicInformation?keyword=${encodeURIComponent(keyword)}&pageSize=5`, {
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
            const detailR = await fetch(`${ECLIPSE_BASE}/Products/${productId}`, {
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
            const invR = await fetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?CatalogNumber=${encodeURIComponent(catalogNumber)}&ConsiderUserAuthBranch=true`, {
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
      const detailR = await fetch(`${ECLIPSE_BASE}/Products/${productId}`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!detailR.ok) return res.status(detailR.status).json({ error: 'Product not found' });
      const detail = await detailR.json();

      // Get inventory
      let qty = null;
      if (detail.catalogNumber) {
        try {
          const invR = await fetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?CatalogNumber=${encodeURIComponent(detail.catalogNumber)}&ConsiderUserAuthBranch=true`, {
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
