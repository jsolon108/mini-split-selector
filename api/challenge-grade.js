// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE GRADER — slice 2a
// ─────────────────────────────────────────────────────────────────────
// Pure grading logic. Takes a quote in the app's state shape + a scenario
// spec, returns { passed, fail_reasons[], diagnostics }.
//
// Domain rules (see chat history):
//   1. Cassettes have built-in condensate pumps — don't expect separate pump
//   2. Hisense has factory WiFi — don't expect separate WiFi module
//   3. Slimduct qty >= 2 → require coupler(s), qty = slimduct_qty - 1
//   4. Surge protector: universally optional, EXCEPT forbidden on 115V scenarios
//   5. Line set counting: SKU prefix B62 = 0.5 each (must pair); else 1; unpaired B62 = fail
//   6. Disconnect-with-surge: must be G38-072 or G81-048 (combo SKUs).
//      Combo SKUs also satisfy a plain `disconnect` requirement.
//   7. 115V: scenario voltage:115 → OU must match brand pattern
//      Daikin RXQ%, Fujitsu %KNAS1, Bosch BMS500-AAS012-0CSXRD
// ═══════════════════════════════════════════════════════════════════════

const SURGE_COMBO_SKUS = new Set(['G38-072', 'G81-048']);
const VOLTAGE_115_PATTERNS = {
  Daikin:  (ou) => /^RXQ/i.test(ou || ''),
  Fujitsu: (ou) => /KNAS1$/i.test(ou || ''),
  Bosch:   (ou) => /^BMS500-AAS\d+-0CSX/i.test(ou || ''),
};

// Map scenario indoor-unit style → quote zone `type` field values.
// The app uses fuller names: "Wall Mount", "4-Way Cassette", "1-Way Cassette", "Ducted",
// "Floor Mount (...)", "Air Handler", "Mid-Static Duct", "Ceiling".
// Scenarios use short tokens: "wall", "cassette", "ducted", "floor", "ceiling".
function styleMatches(scenarioStyle, quoteType) {
  if (!scenarioStyle || !quoteType) return false;
  const s = scenarioStyle.toLowerCase();
  const t = quoteType.toLowerCase();
  if (s === 'wall')     return t.includes('wall mount');
  if (s === 'cassette') return t.includes('cassette');
  if (s === 'ducted')   return t === 'ducted' || t === 'mid-static duct';
  if (s === 'floor')    return t.includes('floor');
  if (s === 'ceiling')  return t === 'ceiling';
  return s === t;
}

// Map a quote line item (description + SKU/order_num) to an accessory `type` token.
// Mirrors the scenario spec's accessory type vocabulary.
function classifyAccessory(line) {
  const desc = String(line.description || '').toUpperCase();
  const sku  = String(line.sku || line.orderNumber || line.order_num || '').toUpperCase();

  // 1) Disconnect+surge combo SKUs (must check before generic disconnect)
  if (SURGE_COMBO_SKUS.has(sku.replace(/\s/g, ''))) {
    return { type: 'disconnect_with_surge', sku, desc };
  }

  // 2) Line sets — DuraGuard (B62 prefix) separately tracked
  if (sku.startsWith('B62')) {
    return { type: 'lineset', sku, desc, half: true };
  }
  if (/\bLINE.?SET\b|\bLINESET\b|\bCOPPER TUBING\b|\bTUBING COPPER\b|\bREFRIGERANT LINE\b/.test(desc)) {
    return { type: 'lineset', sku, desc };
  }

  // 3) Slimduct / line hide (with size+color extraction)
  if (/SLIMDUCT|SLIM DUCT|LINE.?HIDE|LINESET COVER/.test(desc)) {
    const sizeMatch =
      desc.match(/\b(77|100|140)\b/) ||
      desc.match(/3[\s"\-]*[xX]\s*2-?1\/2/) || // 77
      desc.match(/4[\s"\-]*[xX]\s*2-?3\/4/) || // 100
      desc.match(/5-?1\/2[\s"\-]*[xX]\s*3/);   // 140
    let size = null;
    if (sizeMatch) {
      if (sizeMatch[1]) size = sizeMatch[1];
      else if (sizeMatch[0].includes('3') && !sizeMatch[0].includes('5')) size = '77';
      else if (sizeMatch[0].includes('4')) size = '100';
      else if (sizeMatch[0].includes('5')) size = '140';
    }
    const colorMatch = desc.match(/\b(WHITE|IVORY|BROWN|BLACK)\b/);
    const color = colorMatch ? colorMatch[1].toLowerCase() : null;
    const isCoupler = /COUPLER|JOINT/.test(desc);
    return {
      type: isCoupler ? 'linehide_coupler' : 'linehide',
      sku, desc, attrs: { size, color }
    };
  }

  // 4) Disconnects & whips — combined category in source data; split here
  if (/\bDISCONNECT\b/.test(desc)) return { type: 'disconnect', sku, desc };
  if (/\bWHIP\b/.test(desc))       return { type: 'whip', sku, desc };

  // 5) Mounting — split pad vs stand vs bracket
  if (/WALL.?BRACKET|WALL BRKT/.test(desc))               return { type: 'wall_bracket', sku, desc };
  if (/CONDENSER STAND|EQUIPMENT STAND|GROUND.?STAND/.test(desc)) return { type: 'condenser_stand', sku, desc };
  if (/\bPAD\b/.test(desc))                                return { type: 'pad', sku, desc };

  // 6) Other discrete types
  if (/SURGE/.test(desc))                                  return { type: 'surge_protector', sku, desc };
  if (/CONDENSATE PUMP|MINI.?PUMP/.test(desc))             return { type: 'condensate_pump', sku, desc };
  if (/WI-?FI|WIFI/.test(desc))                            return { type: 'wifi', sku, desc };
  if (/WALL OUTLET|RECEPTACLE/.test(desc))                 return { type: 'wall_outlet', sku, desc };
  if (/THERMOSTAT/.test(desc))                             return { type: 'thermostat', sku, desc };

  return { type: 'unknown', sku, desc };
}

// Flatten the app's quote state into a normalized line-item list.
// Accepts the same shape the frontend builds: { zones: [...], common: {...}, lineHide: {...}, customItems: {...} }
function flattenQuoteLines(quote, lookups) {
  const lines = [];
  const commonBySku = lookups.commonBySku || {};
  const lineHideByOrder = lookups.lineHideByOrder || {};

  // Common addons: { sku: qty }
  for (const [sku, qty] of Object.entries(quote.common || {})) {
    const q = Number(qty) || 0;
    if (q <= 0) continue;
    const meta = commonBySku[sku] || {};
    lines.push({
      sku, description: meta.description || '', qty: q, source: 'common'
    });
  }

  // Line hide: { order_num: qty }
  for (const [orderNum, qty] of Object.entries(quote.lineHide || {})) {
    const q = Number(qty) || 0;
    if (q <= 0) continue;
    const meta = lineHideByOrder[orderNum] || {};
    lines.push({
      sku: orderNum, description: meta.description || '', qty: q,
      attrs: { size: meta.size_str, color: meta.color },
      source: 'linehide'
    });
  }

  // Custom items: ad-hoc additions {key: {orderNumber, description, qty}}
  for (const item of Object.values(quote.customItems || {})) {
    const q = Number(item.qty) || 0;
    if (q <= 0) continue;
    lines.push({
      sku: item.orderNumber || item.catalogNumber || '',
      description: item.description || '',
      qty: q, source: 'custom'
    });
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// THE GRADER
// ─────────────────────────────────────────────────────────────────────
function gradeQuote(quote, scenario, lookups) {
  const fail = [];
  const diag = { matched: {}, extras: [], classified: [] };
  const spec = scenario.spec || scenario;

  const zones = Array.isArray(quote.zones) ? quote.zones : [];
  const lines = flattenQuoteLines(quote, lookups || {});

  // ─── EQUIPMENT CHECKS ───

  // Brand
  const brand = zones[0]?.brand;
  if (!brand) {
    fail.push('No equipment selected');
  } else if (spec.brand && brand.toLowerCase() !== spec.brand.toLowerCase()) {
    fail.push(`Brand: expected ${spec.brand}, got ${brand}`);
  }

  // System type
  const isMulti = zones.length > 1 || (zones[0]?.systemType === 'multi');
  const expectedMulti = spec.system_type === 'multi';
  if (zones.length && isMulti !== expectedMulti) {
    fail.push(`System type: expected ${spec.system_type}-zone, got ${isMulti ? 'multi' : 'single'}-zone`);
  }

  // Indoor unit count
  const expectedIduCount = (spec.indoor_units || []).length;
  if (expectedIduCount && zones.length !== expectedIduCount) {
    fail.push(`Indoor unit count: expected ${expectedIduCount}, got ${zones.length}`);
  }

  // Per-IDU BTU + style match (order-independent — match as a multiset)
  if (zones.length === expectedIduCount && expectedIduCount > 0) {
    const expected = (spec.indoor_units || []).map(u => ({ btu: u.btu, style: u.style, matched: false }));
    const actual = zones.map(z => ({ cap: z.cap, type: z.type }));
    for (const a of actual) {
      const actualBtu = a.cap * 1000;
      const slot = expected.find(e => !e.matched && e.btu === actualBtu && styleMatches(e.style, a.type));
      if (slot) slot.matched = true;
      else fail.push(`Unexpected indoor unit: ${a.cap}K ${a.type}`);
    }
    for (const e of expected.filter(e => !e.matched)) {
      fail.push(`Missing indoor unit: ${e.btu/1000}K ${e.style}`);
    }
  }

  // Voltage (115V) check — RULE 7
  if (spec.voltage === 115 && brand) {
    const ou = zones[0]?.ou || zones[0]?.outdoor;
    const matcher = VOLTAGE_115_PATTERNS[brand];
    if (!matcher) {
      fail.push(`115V scenario but no voltage rule for brand ${brand}`);
    } else if (!matcher(ou)) {
      fail.push(`Voltage: expected 115V outdoor unit, ${ou || '(none)'} doesn't match the 115V pattern for ${brand}`);
    }
  }

  // ─── ACCESSORY CHECKS ───
  // Classify every line, then count by type with rules applied.

  const classified = lines.map(l => ({ ...classifyAccessory(l), qty: l.qty }));
  diag.classified = classified;

  // Aggregate counts by type, applying B62 half-counting + cassette/Hisense built-ins
  const counts = {}; // type -> { qty: number, items: [...] }
  const linesetItems = [];
  let b62HalfRemainder = 0;

  for (const c of classified) {
    if (c.type === 'unknown') continue;
    if (c.type === 'lineset') {
      // B62 pairs to make 1 line set; non-B62 lines = 1 each
      if (c.half) {
        const halfUnits = c.qty * 0.5;
        b62HalfRemainder += halfUnits;
        linesetItems.push({ ...c, lineset_units: halfUnits });
      } else {
        linesetItems.push({ ...c, lineset_units: c.qty });
      }
      continue;
    }
    counts[c.type] = counts[c.type] || { qty: 0, items: [] };
    counts[c.type].qty += c.qty;
    counts[c.type].items.push(c);
  }

  // Finalize line set count, after B62 pairing — RULE 5
  if (b62HalfRemainder > 0 && Math.abs(b62HalfRemainder - Math.round(b62HalfRemainder)) > 0.001) {
    fail.push(`Unpaired DuraGuard line set component (must come in liquid+gas pairs)`);
  }
  const totalLinesetUnits = linesetItems.reduce((s, x) => s + x.lineset_units, 0);
  if (totalLinesetUnits > 0) counts.lineset = { qty: totalLinesetUnits, items: linesetItems };

  // Combo disconnects (G38-072 / G81-048) satisfy BOTH disconnect AND surge_protector
  // We track them in a separate `disconnect_with_surge` bucket — but the require-loop
  // below knows that a plain `disconnect` requirement is satisfied by either.
  const comboDisconnects = counts['disconnect_with_surge']?.qty || 0;
  const plainDisconnects = counts['disconnect']?.qty || 0;
  const effectiveDisconnects = plainDisconnects + comboDisconnects;
  const effectiveSurges = (counts['surge_protector']?.qty || 0) + comboDisconnects;

  // Cassette built-in pump — RULE 1
  // If ALL indoor units are cassettes, condensate pump is not expected.
  // (Not currently triggered as a "you added an extra" since we allow optional accessories...
  // but adding a pump to a cassette-only quote is technically an extra → fail.)
  const allCassette = zones.length > 0 && zones.every(z => /cassette/i.test(z.type || ''));

  // Hisense factory WiFi — RULE 2
  const isHisense = brand && brand.toLowerCase() === 'hisense';

  // 115V scenario — RULE 4 (surge forbidden)
  const is115V = spec.voltage === 115;

  // ─── REQUIRED ACCESSORIES ───
  const required = spec.required_accessories || [];
  const requiredTypes = new Set();

  for (const req of required) {
    requiredTypes.add(req.type);
    const expectedQty = req.qty || 1;

    if (req.type === 'lineset') {
      if (Math.abs((counts.lineset?.qty || 0) - expectedQty) > 0.001) {
        fail.push(`Line sets: expected ${expectedQty}, got ${counts.lineset?.qty || 0}`);
      }
    } else if (req.type === 'disconnect') {
      if (effectiveDisconnects < expectedQty) {
        fail.push(`Disconnect: expected ${expectedQty}, got ${effectiveDisconnects}`);
      } else if (effectiveDisconnects > expectedQty) {
        fail.push(`Disconnect: too many (${effectiveDisconnects}, expected ${expectedQty})`);
      }
    } else if (req.type === 'disconnect_with_surge') {
      if (comboDisconnects < expectedQty) {
        fail.push(`Surge-protected disconnect required (must be G38-072 or G81-048)`);
      }
      if (comboDisconnects > expectedQty) {
        fail.push(`Too many surge-protected disconnects`);
      }
    } else if (req.type === 'surge_protector') {
      if (effectiveSurges < expectedQty) {
        fail.push(`Surge protector: expected ${expectedQty}, got ${effectiveSurges}`);
      }
    } else if (req.type === 'linehide') {
      const got = counts.linehide?.qty || 0;
      if (got !== expectedQty) {
        fail.push(`Slimduct: expected ${expectedQty}, got ${got}`);
      }
      // Check size + color attrs on the linehide items
      const items = counts.linehide?.items || [];
      const wantSize  = req.attrs?.size;
      const wantColor = (req.attrs?.color || '').toLowerCase();
      for (const item of items) {
        if (wantSize && item.attrs?.size && String(item.attrs.size) !== String(wantSize)) {
          fail.push(`Slimduct size: expected ${wantSize}, got ${item.attrs.size}`);
        }
        if (wantColor && item.attrs?.color && item.attrs.color !== wantColor) {
          fail.push(`Slimduct color: expected ${wantColor}, got ${item.attrs.color}`);
        }
      }
      // Slimduct coupler rule — RULE 3
      if (expectedQty >= 2) {
        const couplers = counts.linehide_coupler?.qty || 0;
        const expectedCouplers = expectedQty - 1;
        if (couplers < expectedCouplers) {
          fail.push(`Slimduct coupler: expected ${expectedCouplers} (qty - 1), got ${couplers}`);
        } else if (couplers > expectedCouplers) {
          fail.push(`Slimduct coupler: too many (${couplers}, expected ${expectedCouplers})`);
        }
      }
    } else {
      // Generic: condensate_pump, wifi, pad, whip, wall_bracket, condenser_stand, wall_outlet, thermostat...
      const got = counts[req.type]?.qty || 0;
      if (got < expectedQty) {
        fail.push(`${req.type}: expected ${expectedQty}, got ${got}`);
      } else if (got > expectedQty) {
        fail.push(`${req.type}: too many (${got}, expected ${expectedQty})`);
      }
    }
  }

  // ─── EXTRA / FORBIDDEN ACCESSORIES (strict mode: any unexpected category = fail) ───
  // Walk every classified type and complain about anything not in requiredTypes,
  // with rule-based exemptions baked in.
  for (const [type, info] of Object.entries(counts)) {
    if (requiredTypes.has(type)) continue;
    if (type === 'lineset' || type === 'linehide_coupler' || type === 'unknown') continue;

    // Combo disconnects (disconnect_with_surge) are OK if a plain disconnect was required
    // (they satisfy it). We've already credited them. Don't double-flag.
    if (type === 'disconnect_with_surge') {
      if (requiredTypes.has('disconnect') || requiredTypes.has('disconnect_with_surge')) continue;
      fail.push(`Unexpected surge-protected disconnect on quote`);
      continue;
    }

    // RULE 4: surge protector is universally optional, EXCEPT forbidden on 115V
    if (type === 'surge_protector') {
      if (is115V) {
        fail.push(`Surge protector not allowed on 115V system`);
      }
      // else: optional, ignore
      continue;
    }

    // RULE 1: cassette quotes — extra condensate pump is wrong
    if (type === 'condensate_pump' && allCassette) {
      fail.push(`Condensate pump not needed on cassette (built in)`);
      continue;
    }

    // RULE 2: Hisense quotes — extra WiFi module is wrong
    if (type === 'wifi' && isHisense) {
      fail.push(`WiFi module not needed on Hisense (factory installed)`);
      continue;
    }

    // Anything else not in the spec is an extra → fail
    fail.push(`Unexpected ${type} on quote (${info.qty})`);
    diag.extras.push({ type, qty: info.qty });
  }

  return {
    passed: fail.length === 0,
    fail_reasons: fail,
    diagnostics: diag
  };
}

// ─────────────────────────────────────────────────────────────────────
// HTTP HANDLER
// ─────────────────────────────────────────────────────────────────────
// Expects POST body: { quote, scenario_id, lookups? }
// Returns: { passed, fail_reasons, diagnostics, scenario }

const SB_URL = 'https://jnhgmnpcwiutkidkadbg.supabase.co';
const SB_KEY = 'sb_publishable_jnXngFrJ8t1eG5sxAcTOUQ_1RJ2KnFV';

async function fetchLookups() {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const [commonRes, lineHideRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/common_addons?active=eq.true&select=sku,mfg_num,description`, { headers }),
    fetch(`${SB_URL}/rest/v1/line_hide_products?active=eq.true&select=order_num,description,size_str,color`, { headers }),
  ]);
  const commonRows = await commonRes.json();
  const lineHideRows = await lineHideRes.json();
  const commonBySku = {};
  for (const r of commonRows) commonBySku[r.sku] = r;
  const lineHideByOrder = {};
  for (const r of lineHideRows) lineHideByOrder[r.order_num] = r;
  return { commonBySku, lineHideByOrder };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { quote, scenario_id } = req.body || {};
    if (!quote || !scenario_id) return res.status(400).json({ error: 'quote and scenario_id required' });

    // Fetch scenario
    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    const scenarioRes = await fetch(`${SB_URL}/rest/v1/challenge_scenarios?id=eq.${scenario_id}&select=*`, { headers });
    const scenarioRows = await scenarioRes.json();
    if (!scenarioRows.length) return res.status(404).json({ error: 'Scenario not found' });
    const scenario = scenarioRows[0];

    const lookups = await fetchLookups();
    const result = gradeQuote(quote, scenario, lookups);

    return res.status(200).json({
      ...result,
      scenario: { id: scenario.id, name: scenario.name, blurb: scenario.customer_blurb }
    });
  } catch (err) {
    console.error('[challenge-grade] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Export the pure grader for testing / reuse from other handlers
export { gradeQuote, classifyAccessory, flattenQuoteLines };
