const ECLIPSE_BASE = 'https://api.johnstonenyct.com:5000';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, username, password, sessionToken, branch, customerAccount, customerPO, lines } = req.body;

  // Action: login — get a session token
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

  // Action: order — create a sales order
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
          customerPONumber: customerPO || '',
          lines: lines.map(l => ({
            lineItemProduct: {
              catalogNumber: l.model,
              quantity: l.qty,
              um: 'EA',
              productDescription: l.description || ''
            }
          }))
        })
      });
    };

    try {
      let r = await doOrder(sessionToken);

      // If token expired, re-auth with passed credentials and retry once
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
          return res.status(200).json({ success: true, orderId: order.id || order.orderNumber, newToken: loginData.sessionToken });
        }
      }

      if (!r.ok) {
        const errBody = await r.text();
        return res.status(r.status).json({ error: `Order failed: ${r.status}`, detail: errBody });
      }

      const order = await r.json();
      return res.status(200).json({ success: true, orderId: order.id || order.orderNumber });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
