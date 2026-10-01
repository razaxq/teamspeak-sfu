import { issueToken } from '../src/auth.js';
const [room, peer, role = 'view', ttl = '3600'] = process.argv.slice(2);
try { console.log(issueToken(process.env.SFU_SECRET, { room, peer, role, ttl: Number(ttl) })); }
catch { console.error('Usage: SFU_SECRET=<32+ bytes> npm run token -- <room> <peer> <publish|view> [ttl_seconds:1..86400]'); process.exitCode = 1; }
