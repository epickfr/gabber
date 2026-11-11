const fs = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  console.error('Set them in Render Dashboard -> Environment (or in your local shell).');
  process.exit(1);
}

const output = `
window.EPICK_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url)},
  SUPABASE_ANON_KEY: ${JSON.stringify(key)}
};
`;

fs.writeFileSync(path.join(__dirname, 'js', 'config.js'), output, 'utf8');
console.log('Wrote js/config.js from environment variables.');
