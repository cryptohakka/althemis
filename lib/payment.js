// api/payment.js - Dual payment middleware (L402 + x402 + API_KEY)
const L402_SERVER = process.env.L402_SERVER_URL || 'https://a2aflow.space';
const API_KEYS = (process.env.ALLOWED_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

// ── L402 helpers ──
export async function createL402Invoice(amountSats, memo) {
  const res = await fetch(`${L402_SERVER}/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_sats: amountSats, memo }),
  });
  if (!res.ok) throw new Error(`Invoice creation failed: ${res.status}`);
  return res.json();
}

export async function verifyL402Payment(preimage) {
  const { createHash } = await import('crypto');
  const rHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  const res = await fetch(`${L402_SERVER}/check-payment?r_hash=${rHash}`);
  if (!res.ok) return false;
  const data = await res.json();
  return data.settled === true;
}

// ── x402 helpers ──
// x402: client sends X-Payment header with signed EVM tx receipt
// For now: verify via a2aflow.space/x402/verify endpoint
export async function verifyX402Payment(paymentHeader) {
  try {
    const res = await fetch(`${L402_SERVER}/x402/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment: paymentHeader }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

// ── Main middleware factory ──
export function withPayment(amountSats, memo, handler) {
  return async (req, res) => {
    // ① API_KEY check (free pass for hackathon/devs)
    const apiKey = req.headers['x-api-key'];
    if (apiKey && API_KEYS.includes(apiKey)) {
      req.paymentMethod = 'api_key';
      return handler(req, res);
    }

    // ② L402 check
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('L402 ')) {
      try {
        const parts = authHeader.slice(5).split(':');
        const preimage = parts[parts.length - 1];
        const valid = await verifyL402Payment(preimage);
        if (valid) {
          req.paymentMethod = 'l402';
          return handler(req, res);
        }
      } catch (e) {
        return res.status(401).json({ error: 'L402 verification failed', detail: e.message });
      }
      return res.status(401).json({ error: 'Payment not settled' });
    }

    // ③ x402 check
    const x402Header = req.headers['x-payment'];
    if (x402Header) {
      const valid = await verifyX402Payment(x402Header);
      if (valid) {
        req.paymentMethod = 'x402';
        return handler(req, res);
      }
      return res.status(401).json({ error: 'x402 payment invalid' });
    }

    // ④ No payment → issue 402 with both options
    try {
      const invoice = await createL402Invoice(amountSats, memo);
      res.setHeader('WWW-Authenticate', `L402 invoice="${invoice.invoice}", r_hash="${invoice.r_hash}"`);
      return res.status(402).json({
        error: 'Payment Required',
        payment_options: {
          l402: {
            invoice: invoice.invoice,
            r_hash: invoice.r_hash,
            amount_sats: amountSats,
            pay_url: invoice.pay_url,
            qr_code: invoice.qr_code,
          },
          x402: {
            network: 'base',
            token: 'USDC',
            amount: '0.001',
            recipient: process.env.X402_RECIPIENT_ADDRESS || '',
            note: 'Send with X-Payment header containing tx hash',
          },
          api_key: {
            note: 'Contact ClawdMint for dev access key',
            header: 'X-Api-Key: <your-key>',
          },
        },
      });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to create invoice', detail: e.message });
    }
  };
}

// Backward compat alias
export const withL402 = withPayment;
