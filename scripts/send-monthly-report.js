#!/usr/bin/env node
require('dotenv').config();
const nodemailer = require('nodemailer');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BASE = (process.env.REPORT_BASE_URL || process.env.BASE_URL || process.env.COUPON_BASE_URL || '').replace(/\/$/, '');

// Mirror the slugs in index.js and read tokens/recipients from env
const CLIENTS = [
  { slug: 'popeyes-mckinney', name: 'Popeyes McKinney', token: process.env.CLIENT_POPEYES_TOKEN, to: process.env.REPORT_POPEYES_TO },
  { slug: 'sonic-frisco',     name: 'Sonic Frisco',       token: process.env.CLIENT_SONIC_TOKEN,   to: process.env.REPORT_SONIC_TO },
  { slug: 'braums-stacy',     name: "Braum's Stacy Rd",   token: process.env.CLIENT_BRAUMS_TOKEN,  to: process.env.REPORT_BRAUMS_TO },
  { slug: 'rudys-mckinney',   name: "Rudy's BBQ McKinney",token: process.env.CLIENT_RUDYS_TOKEN,   to: process.env.REPORT_RUDYS_TO },
  { slug: 'babes-allen',      name: "Babe's Chicken — Allen", token: process.env.CLIENT_BABES_TOKEN, to: process.env.REPORT_BABES_TO },
];

(async () => {
  if (!BASE) throw new Error('Set REPORT_BASE_URL or BASE_URL');

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const month = new Date().toLocaleString('en-US', { month:'long', year:'numeric' });

  for (const c of CLIENTS) {
    if (!c.token || !c.to) { console.log(`Skipping ${c.slug} (missing token or REPORT_*_TO)`); continue; }
    const url = `${BASE}/api/client/${c.slug}/report.csv`;
    const r = await fetch(url, { headers: { 'x-client-token': c.token } });
    if (!r.ok) throw new Error(`Download failed for ${c.slug}: ${r.status}`);
    const csv = await r.text();

    await transport.sendMail({
      from: process.env.SMTP_FROM || 'reports@example.com',
      to: c.to,
      subject: `${c.name} — Coupon Performance (${month})`,
      text: `Hi — attached is your monthly coupon performance report.\n\nLive dashboard: ${BASE}/client/${c.slug}?token=${c.token}\n\n— All City Pages`,
      attachments: [{ filename: `${c.slug}_${month.replace(/\s+/g,'_').toLowerCase()}.csv`, content: csv }]
    });

    console.log(`Monthly report sent for ${c.slug}`);
  }
})().catch(err => { console.error(err); process.exit(1); });
