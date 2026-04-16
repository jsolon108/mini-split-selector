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

function buildOrderPayload(branch, customerAccount, customerPO, orderBy, lines) {
  return {
    priceBranch: branch,
    shipBranch: branch,
    billToCustomer: customerAccount || '',
    shipToCustomer: customerAccount || '',
    customerPONumber: customerPO || '',
    orderBy: orderBy || '',
    lines: lines.map(l => ({
      lineItemProduct: {
        catalogNumber: formatCatalogNumber(l.model),
        quantity: l.qty,
        um: 'EA',
        umQuantity: l.qty,
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
      // Fetch user details to get home branch
      let homeBranch = null;
      let debugUser = null;
      try {
        const userR = await fetch(`${ECLIPSE_BASE}/Users/${userName}`, {
          headers: { 'Accept': 'application/json', 'sessionToken': token }
        });
        if (userR.ok) {
          const userData = await userR.json();
          debugUser = JSON.stringify(userData).slice(0, 500);
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
      const payload = buildOrderPayload(branch, customerAccount, customerPO, orderBy, lines);
      let { status, text } = await postOrder(sessionToken, payload);

      // Token expired — refresh and retry
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

      // Inventory call — use catalog numbers to find products
      const invParams = new URLSearchParams();
      catalogNumbers.forEach(cn => invParams.append('CatalogNumber', cn));
      invParams.append('ConsiderUserAuthBranch', 'true');
      if (userIdUpper) invParams.append('UserId', userIdUpper);

      // Step 1: Get inventory + product IDs using catalog numbers
      const invRes = await fetch(`${ECLIPSE_BASE}/ProductInventoryMassInquiry?` + invParams.toString(), {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      const invData = invRes.ok ? await invRes.json() : {};
      const invResults = invData.results || [];

      // Build catalog# -> productId map from inventory results
      // We need to correlate by position since inventory doesn't return catalog#
      // Store by productId and also build productId list for pricing call
      const productIds = invResults.map(r => r.productId).filter(Boolean);

      // Step 2: Get pricing using productIds
      let pricingResults = [];
      if (productIds.length > 0) {
        const pricingByIdParams = new URLSearchParams();
        // Use catalog numbers directly for pricing — more reliable than productId positional match
        catalogNumbers.forEach(cn => pricingByIdParams.append('CatalogNumber', cn));
        pricingByIdParams.append('Quantity', '1');
        if (customerId) pricingByIdParams.append('CustomerId', customerId);
        pricingByIdParams.append('CalculateOnlyForBranch', userBranch);

        const pricingUrl = `${ECLIPSE_BASE}/ProductInventoryPricingMassInquiry?` + pricingByIdParams.toString();
        console.log('Pricing URL:', pricingUrl);
        const pricingRes = await fetch(pricingUrl, {
          headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
        });
        console.log('Pricing status:', pricingRes.status);
        const pricingText = await pricingRes.text();
        console.log('Pricing raw text:', pricingText.slice(0, 500));
        const pricingData = pricingRes.ok ? JSON.parse(pricingText) : {};
        pricingResults = pricingData.results || [];
      }

      // Build pricing map keyed by catalog number (positional match)
      const pricingByProductId = {};
      pricingResults.forEach((r, i) => {
        const catKey = catalogNumbers[i];
        if (catKey) pricingByProductId[catKey] = {
          price: r.unitPrice?.value ?? r.productUnitPrice?.value ?? null,
          list: r.listPrice?.value ?? r.list?.value ?? null
        };
      });

      // Build final maps keyed by catalog number
      const pricingMap = {};
      const invMap = {};
      
      // Pricing map from direct catalog number lookup
      Object.assign(pricingMap, pricingByProductId);

      // Inventory map from inventory results (positional)
      invResults.forEach((r, i) => {
        const catKey = catalogNumbers[i];
        if (!catKey) return;
        const branches = r.branchAvailableQuantity || [];
        const userQty = branches.find(b => b.warehouse.startsWith(userBranch))?.warehouseQty ?? null;
        const farmQty = branches.find(b => b.warehouse.startsWith(FARM))?.warehouseQty ?? null;
        invMap[catKey] = { userQty, farmQty, total: r.totalWarehouseQty ?? null };
      });

      return res.status(200).json({
        userBranch,
        pricing: pricingMap,
        inventory: invMap,
        rawPricing: pricingResults.slice(0, 2),
        rawInv: invResults.slice(0, 2),
        debug: { productIds, catalogNumbers, customerId, userBranch }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
