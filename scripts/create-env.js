
const fs = require('fs');
const path = require('path');

const envContent = 'VITE_SUPABASE_URL=' + (process.env.VITE_SUPABASE_URL || '') + '\n' +
                   'VITE_SUPABASE_ANON_KEY=' + (process.env.VITE_SUPABASE_ANON_KEY || '') + '\n';

const envPath = path.resolve(__dirname, '..', '.env.local');
fs.writeFileSync(envPath, envContent, 'utf8');

console.log('.env.local created successfully');
console.log('File size:', fs.statSync(envPath).size, 'bytes');

const content = fs.readFileSync(envPath, 'utf8');
const lines = content.split('\n');
for (var i = 0; i &lt; 2 &amp;&amp; i &lt; lines.length; i++) {
  console.log('Line ' + (i + 1) + ':', lines[i].substring(0, 35));
}
