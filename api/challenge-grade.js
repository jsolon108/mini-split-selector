// ═══════════════════════════════════════════════════════════════════════
// CHALLENGE GRADER — slice 2a
// ─────────────────────────────────────────────────────────────────────
// Pure grading logic. Takes a quote in the app's state shape + a scenario
// spec, returns { passed, fail_reasons[], diagnostics }.
//
// Domain rules (see chat history):
//   1. Cassettes have built-in condensate pumps — don't expect separate pump
//   2. WiFi is non-graded — factory-installed WiFi counts toward the WiFi
//      requirement, and an add-on WiFi module is never penalized either way.
//   3. Slimduct qty >= 2 → require coupler(s), qty = slimduct_qty - 1
//   4. Surge protector: strict like everything else — only allowed when scenario lists it
//   5. Line sets — Standard (paired LS... SKU) vs UV rated (DuraGuard, sold as separate
//      liquid + gas rolls; B62 prefix or "DURAGUARD"/"UV INSULATED" in description).
//      If scenario doesn't specify, whole quote must be one kind (no mixing).
//      Standard: match liq×gas connection + optional length per zone.
//      UV rated: each zone needs two items, one liquid OD + one gas OD matching the zone.
//   6. Disconnect-with-surge: must be G38-072 or G81-048 (combo SKUs).
//      Combo SKUs also satisfy a plain `disconnect` requirement.
//   7. 115V: scenario voltage:115 → OU must match brand pattern
//      Daikin RXQ%, Fujitsu %KNAS1, Bosch BMS500-AAS012-0CSXRD
//   8. Whip size by OU capacity: G89-797 only for OUs ≤24K, G89-798 only for >24K.
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

  // 1) Disconnect+surge combo units (G38-072 / G81-048).
  //    These order numbers appear in the description, not the SKU field.
  //    Catalog numbers vary (M83915 for G38-072), so we match the order number in the desc.
  if (/\bG38-?072\b|\bG81-?048\b/.test(desc) || SURGE_COMBO_SKUS.has(sku.replace(/\s/g, ''))) {
    return { type: 'disconnect_with_surge', sku, desc };
  }

  // 2) Line sets — two variants:
  //    STANDARD: bagged paired line sets (e.g. LS14121250DMSF). Description includes paired
  //              connection like 1/4"x1/2" and a length like 50FT.
  //    UV RATED (DuraGuard): per-pipe rolls, sold liquid + gas separately. SKU starts with B62
  //              OR description contains "DURAGUARD" / "UV INSULATED". Each item describes a
  //              single OD (e.g. "1/4IN OD"). Length not graded for UV.
  function extractStandardLinesetAttrs(d) {
    const lenMatch = d.match(/\b(\d{2,3})\s?(?:FT|')\b/);
    const length = lenMatch ? lenMatch[1] : null;
    const connMatch = d.match(/(\d\/\d)["']?\s?[xX]\s?(\d\/\d)/);
    return {
      length,
      liq: connMatch ? connMatch[1] : null,
      gas: connMatch ? connMatch[2] : null,
      kind: 'standard'
    };
  }
  function extractUVLinesetAttrs(d) {
    // Look for "1/4IN OD" or "1/4 IN OD" — the first dimension followed by IN OD.
    // Avoid matching "1/2IN INSUL" (insulation thickness).
    const odMatch = d.match(/(\d\/\d)\s?IN\s?OD\b/i);
    return {
      od: odMatch ? odMatch[1] : null,
      kind: 'uv_rated'
    };
  }
  const isUVDuraguard = sku.startsWith('B62') || /DURAGUARD|UV INSULATED/.test(desc);
  if (isUVDuraguard) {
    return { type: 'lineset', sku, desc, attrs: extractUVLinesetAttrs(desc) };
  }
  if (/\bLINE.?SET\b|\bLINESET\b|\bCOPPER TUBING\b|\bTUBING COPPER\b|\bREFRIGERANT LINE\b/.test(desc)) {
    return { type: 'lineset', sku, desc, attrs: extractStandardLinesetAttrs(desc) };
  }

  // 3) Slimduct / line hide — classified by mfg_num prefix, not description.
  //    SD = slimduct length (the actual duct run)
  //    SJ = coupler (joins multiple SD lengths)
  //    SW = wall inlet (where line set enters the wall)
  //    SC/SK/SF/SI/SP/ST/SE = various fittings (ells, tees, end caps, flexible adapters)
  //    Size + color come from the line_hide_products table metadata (size_str, color).
  if (line.source === 'linehide' || /^S[DJWCKFIPTE]/i.test(line.mfg_num || '')) {
    const m = (line.mfg_num || '').toUpperCase();
    // Map size_str ("3\" x 2-1/2\" O.D.") → token ("77", "100", "140")
    const sizeStr = line.attrs?.size || '';
    let size = null;
    if (/3\".*2-?1\/2/.test(sizeStr) || /^3 ?x ?2/.test(sizeStr)) size = '77';
    else if (/4\".*2-?3\/4/.test(sizeStr) || /^4 ?x ?2/.test(sizeStr)) size = '100';
    else if (/5-?1\/2/.test(sizeStr)) size = '140';
    else {
      const m2 = sizeStr.match(/\b(77|100|140)\b/);
      if (m2) size = m2[1];
    }
    const color = (line.attrs?.color || '').toLowerCase() || null;
    const attrs = { size, color };

    if (m.startsWith('SD')) return { type: 'linehide',             sku, desc, attrs };
    if (m.startsWith('SJ')) return { type: 'linehide_coupler',     sku, desc, attrs };
    if (m.startsWith('SW')) return { type: 'linehide_wall_inlet',  sku, desc, attrs };
    // All other line hide fittings (ells, tees, end caps, etc.) — treat as a generic fitting
    return { type: 'linehide_fitting', sku, desc, attrs };
  }

  // 4) Disconnects & whips — combined category in source data; split here
  if (/\bDISCONNECT\b/.test(desc)) return { type: 'disconnect', sku, desc };
  if (/\bWHIP\b/.test(desc))       return { type: 'whip', sku, desc };

  // 5) Mounting — split pad vs stand vs bracket
  // wall_bracket is checked FIRST so wall-mounted brackets aren't swept up by the stand rule.
  if (/WALL.?BRACKET|WALL BRKT/.test(desc))               return { type: 'wall_bracket', sku, desc };
  // condenser_stand: any ground/equipment stand. Covers "Condenser Stand", "Equipment Stand",
  // "Ground Stand", and product-named stands like "12in High Mini Split Stand Wide" / "Quick-Sling".
  // The \bSTAND\b catch-all is safe here because wall brackets were already returned above.
  if (/CONDENSER STAND|EQUIPMENT STAND|GROUND.?STAND|MINI.?SPLIT STAND|\bSTAND\b/.test(desc))
                                                           return { type: 'condenser_stand', sku, desc };
  if (/\bPAD\b/.test(desc))                                return { type: 'pad', sku, desc };

  // 6) Other discrete types
  if (/SURGE/.test(desc))                                  return { type: 'surge_protector', sku, desc };
  if (/CONDENSATE PUMP|MINI.?PUMP/.test(desc))             return { type: 'condensate_pump', sku, desc };
  if (/WI-?FI|WIFI/.test(desc))                            return { type: 'wifi', sku, desc };
  if (/WALL OUTLET|RECEPTACLE/.test(desc))                 return { type: 'wall_outlet', sku, desc };
  // Wire (communication / thermostat): 14/4, 14-4, 16/4, 18/4, etc., plus "COMMUNICATION"
  if (/\b1[468][-\/]4\b|COMMUNICATION/.test(desc))         return { type: 'wire', sku, desc };
  // Thermostats & remotes: physical t-stats AND wired/wireless controllers (excluding WiFi adapters caught above)
  if (/THERMOSTAT|\bT-?STAT\b|WIRED REMOTE|WIRELESS REMOTE|REMOTE CONTROL|WIRED CONTROLLER|WIRELESS CONTROLLER|REMOTE CONTROLLER/.test(desc))
                                                            return { type: 'thermostat', sku, desc };

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
      mfg_num: meta.mfg_num || '',
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

  // Aggregate counts by type. Line sets get bucketed separately for kind-aware matching.
  const counts = {}; // type -> { qty: number, items: [...] }
  const linesetItems = []; // every classified lineset item (standard + UV mixed), one entry per logical unit

  for (const c of classified) {
    if (c.type === 'unknown') continue;
    if (c.type === 'lineset') {
      // Expand by qty: if rep added "1/4x3/8 line set" with qty 2, that's TWO logical line sets.
      const n = Math.max(1, Math.round(c.qty || 1));
      for (let i = 0; i < n; i++) linesetItems.push({ ...c, qty: 1 });
      continue;
    }
    counts[c.type] = counts[c.type] || { qty: 0, items: [] };
    counts[c.type].qty += c.qty;
    counts[c.type].items.push(c);
  }
  if (linesetItems.length) {
    counts.lineset = { qty: linesetItems.length, items: linesetItems };
  }

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

  // (WiFi handling is now brand-agnostic and non-graded — see RULE 2.)

  // 115V scenario — RULE 4 (surge forbidden)
  const is115V = spec.voltage === 115;

  // RULE 8: Whip size by OU capacity. Look at every classified whip; flag mismatches.
  // Take the largest ou_cap on the quote as the "system" cap (handles multi-zone correctly).
  const ouCapK = Math.max(0, ...zones.map(z => Number(z.ou_cap || z.cap) || 0));
  for (const c of classified) {
    if (c.type !== 'whip') continue;
    const sku = (c.sku || '').toUpperCase();
    if (sku === 'G89-797' && ouCapK > 24) {
      fail.push(`Whip size: G89-797 is for systems ≤24K, but OU is ${ouCapK}K (use G89-798)`);
    } else if (sku === 'G89-798' && ouCapK > 0 && ouCapK <= 24) {
      fail.push(`Whip size: G89-798 is for systems >24K, but OU is ${ouCapK}K (use G89-797)`);
    }
  }

  // ─── REQUIRED ACCESSORIES ───
  const required = spec.required_accessories || [];
  const requiredTypes = new Set();

  for (const req of required) {
    requiredTypes.add(req.type);
    const expectedQty = req.qty || 1;

    // WiFi is non-graded: factory-installed WiFi (e.g. Hisense) counts toward the
    // WiFi requirement, so missing an add-on module never fails. Skip the qty check.
    if (req.type === 'wifi') continue;

    if (req.type === 'lineset') {
      // Helper: strip trailing quote/whitespace from pipe size strings ('1/4"' → '1/4')
      const normSize = s => String(s || '').replace(/["'\s]/g, '');
      // expectedQty = number of line sets needed (one per zone).
      // req.attrs.kind = "standard" | "uv_rated" | undefined (any, but no mixing).
      // req.attrs.length = optional, applies only to standard.
      const items = (counts.lineset?.items || []);
      const stdItems = items.filter(i => (i.attrs?.kind || 'standard') === 'standard');
      const uvItems  = items.filter(i => i.attrs?.kind === 'uv_rated');

      // Determine effective kind. If spec asks for one, use it. If not, infer from quote.
      let kind = req.attrs?.kind;
      if (!kind) {
        if (stdItems.length && uvItems.length) {
          fail.push(`Line sets: mix of standard and UV rated — pick one or the other for the whole quote`);
          kind = null; // skip further per-zone matching; the mix is already a fail
        } else if (uvItems.length && !stdItems.length) {
          kind = 'uv_rated';
        } else {
          kind = 'standard';
        }
      } else if (kind === 'standard' && uvItems.length) {
        fail.push(`Line sets: scenario calls for standard line sets, but UV rated (DuraGuard) found`);
      } else if (kind === 'uv_rated' && stdItems.length) {
        fail.push(`Line sets: scenario calls for UV rated (DuraGuard) line sets, but standard found`);
      }

      const wantLen = req.attrs?.length || null;

      if (kind === 'standard') {
        // Each zone needs exactly one standard line set with matching liq/gas (and length if specified).
        const pool = stdItems.slice();
        if (pool.length !== expectedQty) {
          fail.push(`Line sets: expected ${expectedQty} (standard), got ${pool.length}`);
        }
        const used = new Array(pool.length).fill(false);
        for (let zi = 0; zi < zones.length; zi++) {
          const z = zones[zi];
          const zLiq = normSize(z.liq), zGas = normSize(z.gas);
          let foundIdx = -1;
          for (let i = 0; i < pool.length; i++) {
            if (used[i]) continue;
            const a = pool[i].attrs || {};
            const aLiq = normSize(a.liq), aGas = normSize(a.gas);
            if (aLiq && aGas && zLiq && zGas && (aLiq !== zLiq || aGas !== zGas)) continue;
            // If the spec requires a specific length, the line set must match it.
            // If a.length couldn't be parsed from the description, treat it as a mismatch
            // (unknown length cannot satisfy a specific-length requirement).
            if (wantLen && (a.length == null || a.length !== wantLen)) continue;
            foundIdx = i; break;
          }
          if (foundIdx === -1) {
            const sizeStr = `${z.liq||'?'}x${z.gas||'?'}`;
            const lenStr = wantLen ? ` ${wantLen}FT` : '';
            fail.push(`Line set for zone ${z.z || zi+1}: need a ${sizeStr}${lenStr} line set — check size and length`);
          } else used[foundIdx] = true;
        }
        for (let i = 0; i < pool.length; i++) {
          if (used[i]) continue;
          const a = pool[i].attrs || {};
          const msg = `Extra standard line set (${a.liq||'?'}x${a.gas||'?'}${a.length?` ${a.length}FT`:''}) doesn't match any zone`;
          if (!fail.includes(msg)) fail.push(msg);
        }
      } else if (kind === 'uv_rated') {
        // Each zone needs TWO UV items: one with OD matching zone.liq, one matching zone.gas.
        if (uvItems.length !== expectedQty * 2) {
          fail.push(`UV rated line sets: expected ${expectedQty*2} items (${expectedQty} pairs), got ${uvItems.length}`);
        }
        const used = new Array(uvItems.length).fill(false);
        for (let zi = 0; zi < zones.length; zi++) {
          const z = zones[zi];
          for (const want of [{role:'liquid', size:normSize(z.liq)}, {role:'gas', size:normSize(z.gas)}]) {
            let foundIdx = -1;
            for (let i = 0; i < uvItems.length; i++) {
              if (used[i]) continue;
              const a = uvItems[i].attrs || {};
              const aOd = normSize(a.od);
              if (aOd && want.size && aOd !== want.size) continue;
              foundIdx = i; break;
            }
            if (foundIdx === -1) {
              fail.push(`UV line set for zone ${z.z || zi+1} ${want.role} (${want.size||'?'}): not found`);
            } else used[foundIdx] = true;
          }
        }
        for (let i = 0; i < uvItems.length; i++) {
          if (used[i]) continue;
          const a = uvItems[i].attrs || {};
          const msg = `Extra UV line set component (${a.od||'?'} OD) doesn't match any zone`;
          if (!fail.includes(msg)) fail.push(msg);
        }
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

    // RULE 1: cassette quotes — extra condensate pump is wrong
    if (type === 'condensate_pump' && allCassette) {
      fail.push(`Condensate pump not needed on cassette (built in)`);
      continue;
    }

    // RULE 2: WiFi is non-graded. Factory-installed WiFi (Hisense ships with it)
    // counts toward any WiFi requirement, and an add-on WiFi module is never
    // penalized as an extra. Ignore WiFi entirely, regardless of brand.
    if (type === 'wifi') continue;

    // Anything else not in the spec is an extra → fail (this catches surge_protector too).
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
    fetch(`${SB_URL}/rest/v1/line_hide_products?active=eq.true&select=order_num,mfg_num,description,size_str,color`, { headers }),
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
