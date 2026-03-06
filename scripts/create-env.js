
const fs = require('fs');
const path = require('path');

const envContent = `VITE_SUPABASE_URL=${process.env.VITE_SUPABASE_URL || ''}
VITE_SUPABASE_ANON_KEY=${process.env.VITE_SUPABASE_ANON_KEY || ''}
`;

const envPath = path.resolve(__dirname, '..', '.env.local');
fs.writeFileSync(envPath, envContent, 'utf8');

console.log('.env.local created successfully');
console.log('File size:', fs.statSync(envPath).size, 'bytes');

const lines = fs.readFileSync(envPath, 'utf8').split('\n').slice(0, 2);
lines.forEach((line, i) =&gt; {
  console.log(`Line ${i + 1}:`, line.substring(0, 35));
});
