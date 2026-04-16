const ECLIPSE_BASE = 'https://api.johnstonenyct.com:5000';

function formatCatalogNumber(model) {
  if (model && model.startsWith('BMS500-')) {
    return model.replace('BMS500-', '').replace(/-/g, '');
  }
  return model;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, username, password, sessionToken, branch, customerAccount, customerPO, orderBy, lines } = req.body;

  // Action: login
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
      return res.status(200).json({ sessionToken: data.sessionToken, sessionId: data.id, username: data.sessionUser?.userName });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Action: searchCustomers
  if (action === 'searchCustomers') {
    try {
      const { keyword } = req.body;
      const r = await fetch(`${ECLIPSE_BASE}/Customers?keyword=${encodeURIComponent(keyword)}&pageSize=25`, {
        headers: { 'Accept': 'application/json', 'sessionToken': sessionToken }
      });
      if (!r.ok) return res.status(r.status).json({ error: `Customer search failed: ${r.status}` });
      const data = await r.json();
      const results = (data.results || [])
        .filter(c => c.isBillTo === true)
        .slice(0, 10)
        .map(c => ({
        id: c.id,
        name: c.name,
        city: c.city,
        state: c.state,
        requiresAuth: c.noOrderEntryUnlessAuth || false,
        contacts: (c.contacts || []).map(ct => ({ id: ct.id, name: ct.name }))
      }));
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Action: order
  if (action === 'order') {
    const doOrder = async (token) => {
      return await fetch(`${ECLIPSE_BASE}/SalesOrders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'sessionToken': token
        },
        body: JSON.stringify({
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
        })
      });
    };

    try {
      let r = await doOrder(sessionToken);

      if (r.status === 419 && username && password) {
        const loginR = await fetch(`${ECLIPSE_BASE}/Sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        if (!loginR.ok) return res.status(401).json({ error: 'Session expired — please log in again' });
        const loginData = await loginR.json();
        r = await doOrder(loginData.sessionToken);
        if (r.ok) {
          const order = await r.json();
          const o = order.results ? order.results[0] : (Array.isArray(order) ? order[0] : order);
          const rawId = o.id || o.orderNumber || o.orderId || o.salesOrderId;
          return res.status(200).json({ success: true, orderId: 'S10' + rawId, newToken: loginData.sessionToken });
        }
      }

      if (!r.ok) {
        const errBody = await r.text();
        return res.status(r.status).json({ error: `Order failed: ${r.status}`, detail: errBody });
      }

      const order = await r.json();
      const o = order.results ? order.results[0] : (Array.isArray(order) ? order[0] : order);
      const rawId = o.id || o.orderNumber || o.orderId || o.salesOrderId;
      return res.status(200).json({ success: true, orderId: 'S10' + rawId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
